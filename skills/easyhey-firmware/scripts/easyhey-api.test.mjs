import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EasyHeyClient, deployment, inspectManifest, inspectFile, withUpdatedTime } from './easyhey-api.mjs';

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
const jwt = exp => `header.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`;
const access = jwt(Math.floor(Date.now()/1000) + 3600);
function fake(handler, { expired = false } = {}) {
  const calls = [];
  const client = new EasyHeyClient({ fetchImpl: async (url, options) => {
    calls.push({url, ...options});
    if (url.endsWith('/wechat-qr-create')) return reply({data:{qrCodeContent:'https://example.invalid/qr',scene:'test-scene',expiresIn:300}});
    if (url.endsWith('/wechat-login')) return reply({data:{status:'ok',access_token:expired ? jwt(1) : access,refresh_token:'fake-refresh'}});
    if (url.includes('/auth/v1/token')) return reply({access_token:access,refresh_token:'fake-rotated'});
    if (url.endsWith('/wechat-login/me')) return reply({data:{user_id:'test-owner',nick:'Test'}});
    return handler(url, options);
  }});
  return {client,calls};
}
async function login(client) { await client.loginStart(); return client.loginPoll(); }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'easyhey-api-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const file = join(dir,'firmware.bin'); await writeFile(file, Buffer.alloc(4096,3));
  const manifest = { name:'Test Firmware', description:'Test only', version:'1.0', chip_id:'3',
    flash_config:{erase_type:'always',auto_restart:true},flash_size:16*1024*1024,
    share_code:'123456', files:[{path:file,offset:'0x10000'}] };
  return {dir,file,manifest,receipts:[{...await inspectFile(file),etag:'test-etag'}]};
}

test('local preflight rejects overlaps, changed hashes and oversized flash ranges without requests', async t => {
  const {file,manifest}=await fixture(t);
  assert.equal((await inspectManifest(manifest)).files[0].offset,65536);
  await assert.rejects(inspectManifest({...manifest,files:[...manifest.files,{path:file,offset:'0x10000'}]}),/Overlapping/);
  await assert.rejects(inspectManifest({...manifest,files:[{path:file,offset:65536,sha256:'wrong'}]}),/changed/);
  await assert.rejects(inspectManifest({...manifest,flash_size:65536}),/capacity/);
  await assert.rejects(inspectManifest({...manifest,flash_config:{erase_type:'always'}}),/auto_restart/);
  await assert.rejects(inspectManifest({...manifest,description:'x'.repeat(500)}),/including update time/);
});

test('description time uses Shanghai across date boundaries and replaces old annotations without losing content', () => {
  const now = new Date('2026-11-02T16:00:05Z');
  const expected = '正文\n兼容说明\n\n更新时间：2026-11-03 00:00:05（北京时间）';
  assert.equal(withUpdatedTime('正文\n兼容说明',now),expected);
  assert.equal(withUpdatedTime('正文\n兼容说明\n\n更新时间：2026-10-28 12:30:00（北京时间）\n更新时间: 2026-11-01 01:02',now),expected);
  assert.equal(withUpdatedTime(expected,now),expected);
  assert.equal(withUpdatedTime('a'.repeat(500-withUpdatedTime('',now).length-2),now).length,500);
  assert.throws(()=>withUpdatedTime('a'.repeat(500),now),/exceeds 500/);
});

test('authentication is internal, verifies identity and refreshes expired tokens', async () => {
  const {client,calls}=fake(()=>{throw new Error('Unexpected request')},{expired:true});
  const result=await login(client);
  assert.deepEqual(result,{status:'authenticated',user:{user_id:'test-owner',nick:'Test'}});
  assert(!JSON.stringify(client).includes('fake-refresh'));
  assert(!JSON.stringify(result).includes('access_token'));
  assert(calls.some(c=>c.url.includes('grant_type=refresh_token')));
  client.forgetSession(); await assert.rejects(client.list(),/Scan/);
});

test('list traverses pagination; detail refuses non-owned firmware', async () => {
  const {client,calls}=fake(url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('get_my_firmware_list')) return reply(u.searchParams.get('offset')==='0'
      ? Array.from({length:100},(_,i)=>({firmware_id:i+1})) : [{firmware_id:101}]);
    throw new Error('Unexpected endpoint');
  });
  await login(client); assert.equal((await client.list()).length,101);
  await assert.rejects(client.detail(999),/current account/);
  assert(!calls.some(c=>c.url.includes('/firmware_info?')));
});

test('writes require explicit execute and safe empty/unknown patches fail locally', async () => {
  const {client,calls}=fake(()=>{throw new Error('Unexpected request')});
  await assert.rejects(client.uploadFile('/not-read.bin'),/execute:true/);
  await assert.rejects(client.setPublished(1,true),/execute:true/);
  await assert.rejects(client.updateInfo(1,{password:'secret'},{execute:true}),/Only/);
  await assert.rejects(client.publish({},[],{}),/execute:true/);
  await assert.rejects(client.deleteFirmware(1),/execute:true/);
  assert.equal(calls.length,0);
});

test('upload uses discovered Qiniu host, isolates credentials, and retains a local hash receipt', async t => {
  const {file}=await fixture(t);
  const policy=Buffer.from(JSON.stringify({scope:'test-bucket',deadline:Date.now()/1000+3600})).toString('base64url');
  const {client,calls}=fake((url,o)=>{
    if(url.endsWith('/misc/uploadToken')) return reply({code:200,data:{token:`test-ak:signature:${policy}`}});
    if(url.startsWith('https://api.qiniu.com/v4/query?')) return reply({hosts:[{up:{domains:['upload.qiniup.com']}}]});
    if(url==='https://upload.qiniup.com') {
      assert(o.body instanceof FormData); assert.equal(o.body.get('key'),'firmware.bin');
      assert.equal(o.headers.Authorization,undefined); assert.equal(o.headers.apikey,undefined);
      assert.equal(o.body.get('file').size,4096);
      return reply({data:{etag:'received-etag'}});
    }
    throw new Error('Unexpected endpoint');
  });
  await login(client); const receipt=await client.uploadFile(file,{execute:true});
  assert.equal(receipt.etag,'received-etag'); assert.equal(receipt.sha256,(await inspectFile(file)).sha256);
  assert.equal(calls.filter(c=>c.url==='https://upload.qiniup.com').length,1);
});

test('publish builds numeric offsets and stringified file_list, verifies saved state, prevents duplicate journal use',async t=>{
  const {dir,manifest,receipts}=await fixture(t); let payload; let created=false;
  const {client,calls}=fake((url,o)=>{
    if(url.includes('/chip_list?'))return reply([{chip_id:3,chip_name:'ESP32-S3'}]);
    if(url.includes('get_my_firmware_list')) return reply(created?[{firmware_id:7,firmware_name:manifest.name,firmware_version:manifest.version,share_code:'123456'}]:[]);
    if(url===`${deployment.api}/firmware`) {payload=JSON.parse(o.body);created=true;return reply({data:{firmware_id:7}});}
    if(url.includes('/firmware_info?'))return reply([{firmware_id:7,chip_id:3,firmware_name:payload.name,firmware_description:payload.description,
      firmware_version:payload.version,file_list:payload.file_list,flash_config:JSON.stringify(payload.flash_config),status:1}]);
    throw new Error('Unexpected endpoint');
  });
  await login(client);
  const operationFile=join(dir,'publish.json');
  const result=await client.publish(manifest,receipts,{execute:true,operationFile});
  assert.equal(result.state,'published_verified'); assert.equal(typeof payload.file_list,'string');
  assert.match(payload.description,/^Test only\n\n更新时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（北京时间）$/);
  assert.deepEqual(JSON.parse(payload.file_list),[{etag:'test-etag',offset:65536}]);
  assert.equal(JSON.parse(await readFile(operationFile)).firmware_id,7);
  await assert.rejects(client.publish(manifest,receipts,{execute:true,operationFile}),/already exists|EEXIST/);
  assert.equal(calls.filter(c=>c.url===`${deployment.api}/firmware`).length,1);
});

test('ambiguous create failure is journaled and never automatically retried',async t=>{
  const {dir,manifest,receipts}=await fixture(t);
  const {client,calls}=fake(url=>{
    if(url.includes('/chip_list?'))return reply([{chip_id:3}]);
    if(url.includes('get_my_firmware_list'))return reply([]);
    throw new Error('SECRET BODY MUST NOT LEAK');
  });
  await login(client);const operationFile=join(dir,'unknown.json');
  await assert.rejects(client.publish(manifest,receipts,{execute:true,operationFile}),/Transport failure/);
  assert.equal(JSON.parse(await readFile(operationFile)).state,'outcome_unknown');
  await assert.rejects(client.publish(manifest,receipts,{execute:true,operationFile}),/EEXIST/);
  assert.equal(calls.filter(c=>c.url===`${deployment.api}/firmware`).length,1);
});

test('new unpublished records are bound once and verified without creating a second firmware',async t=>{
  const {dir,manifest,receipts}=await fixture(t); let payload; let created=false; let bound=false;
  const {client,calls}=fake((url,o)=>{
    if(url.includes('/chip_list?')) return reply([{chip_id:3}]);
    if(url.includes('get_my_firmware_list')) return reply(created ? [{firmware_id:7,status:bound?1:0,share_code:bound?'123456':null}] : []);
    if(url===`${deployment.api}/firmware`) { created=true; payload=JSON.parse(o.body); return reply({data:{firmware_id:7}}); }
    if(url===`${deployment.api}/firmware/share/bind`) {
      assert.deepEqual(JSON.parse(o.body),{firmwareId:7,shareCode:'123456'}); bound=true; return reply({data:{shareCode:'123456'}});
    }
    if(url.includes('/firmware_info?')) return reply([{firmware_id:7,chip_id:3,firmware_name:payload.name,firmware_description:payload.description,
      firmware_version:payload.version,file_list:payload.file_list,flash_config:payload.flash_config,status:bound?1:0}]);
    throw new Error('Unexpected request');
  });
  await login(client);
  const operationFile=join(dir,'two-step.json');
  assert.equal((await client.publish(manifest,receipts,{execute:true,operationFile})).state,'published_verified');
  await client.bindShareCode(7,'123456',{execute:true,operationFile:operationFile+'.bind.json'});
  assert.equal(calls.filter(c=>c.url===`${deployment.api}/firmware`).length,1);
  assert.equal(calls.filter(c=>c.url===`${deployment.api}/firmware/share/bind`).length,1);
});

test('ambiguous binding is journaled, not replayed, and cannot replace an existing code',async t=>{
  const {dir}=await fixture(t); let code=null;
  const {client,calls}=fake(url=>{
    if(url.includes('get_my_firmware_list')) return reply([{firmware_id:7,status:code?1:0,share_code:code}]);
    throw new Error('network failed');
  });
  await login(client); const options={execute:true,operationFile:join(dir,'bind.json')};
  await assert.rejects(client.bindShareCode(7,'123456',options),/Transport/);
  assert.equal(JSON.parse(await readFile(options.operationFile)).state,'binding_outcome_unknown');
  await assert.rejects(client.bindShareCode(7,'123456',options),/EEXIST/);
  code='999999'; await assert.rejects(client.bindShareCode(7,'123456',options),/Only an unpublished/);
  assert.equal(calls.filter(c=>c.url.endsWith('/firmware/share/bind')).length,1);
});

test('name-only update preserves description and adds time in the same revision-guarded patch',async()=>{
  let row={firmware_id:1,firmware_name:'Old',firmware_version:'1',firmware_description:'Existing description',status:1,last_modified_time:'2026-10-28T00:00:00Z'};
  const {client}=fake((url,o)=>{
    if(url.includes('get_my_firmware_list'))return reply([{firmware_id:1}]);
    if(o.method==='PATCH'){
      const patch = JSON.parse(o.body);
      assert.deepEqual(Object.keys(patch).sort(),['firmware_description','firmware_name']);
      assert.equal(patch.firmware_name,'New');
      assert.match(patch.firmware_description,/^Existing description\n\n更新时间：.*（北京时间）$/);
      assert.equal(new URL(url).searchParams.get('last_modified_time'),'eq.2026-10-28T00:00:00Z');
      row={...row,...patch};return reply([{firmware_id:1}]);
    }
    if(url.includes('/firmware_info?'))return reply([row]);
    throw new Error('Unexpected endpoint');
  });
  await login(client);assert.equal((await client.updateInfo(1,{name:'New'},{execute:true})).firmware_name,'New');
});

test('editing description replaces the old timestamp; oversized existing text prevents a version update',async()=>{
  let row={firmware_id:1,firmware_name:'Name',firmware_version:'1',firmware_description:'Old',last_modified_time:'2026-10-28T00:00:00Z'};
  const {client,calls}=fake((url,o)=>{
    if(url.includes('get_my_firmware_list')) return reply([{firmware_id:1}]);
    if(o.method==='PATCH') { row={...row,...JSON.parse(o.body)}; return reply([{firmware_id:1}]); }
    return reply([row]);
  });
  await login(client);
  const after=await client.updateInfo(1,{description:'New body\n\n更新时间：2000-01-01 00:00:00（北京时间）'},{execute:true});
  assert.match(after.firmware_description,/^New body\n\n更新时间：/);
  assert(!after.firmware_description.includes('2000-01-01'));
  assert.equal(after.firmware_description.match(/更新时间/g).length,1);
  row.firmware_description='x'.repeat(500);
  await assert.rejects(client.updateInfo(1,{version:'2'},{execute:true}),/including update time/);
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
});

test('an empty conditional patch result is treated as a conflict',async()=>{
  const {client,calls}=fake((url,o)=>{
    if(url.includes('get_my_firmware_list'))return reply([{firmware_id:1}]);
    if(o.method==='PATCH')return reply([]);
    return reply([{firmware_id:1,status:1,last_modified_time:'2026-10-28T00:00:00Z'}]);
  });
  await login(client);await assert.rejects(client.setPublished(1,false,{execute:true}),/conflict/);
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
});

test('deletion checks identity and revision, deletes only one target and verifies absence',async t=>{
  const {dir}=await fixture(t); let removed=false;
  const {client,calls}=fake((url,o)=>{
    if(url.includes('get_my_firmware_list'))return reply(removed?[{firmware_id:2}]:[{firmware_id:1},{firmware_id:2}]);
    if(o.method==='DELETE') {
      const q=new URL(url).searchParams;
      assert.equal(q.get('firmware_id'),'eq.1');
      assert.equal(q.get('firmware_name'),'eq.Test');
      assert.equal(q.get('firmware_version'),'eq.1.0');
      assert.equal(q.get('last_modified_time'),'eq.2026-11-02T00:00:00Z');
      assert.equal(o.headers.Prefer,'return=representation');
      removed=true; return reply([{firmware_id:1}]);
    }
    return reply([{firmware_id:1,firmware_name:'Test',firmware_version:'1.0',last_modified_time:'2026-11-02T00:00:00Z'}]);
  });
  await login(client);
  const options={execute:true,expectedName:'Test',expectedVersion:'1.0',operationFile:join(dir,'delete.json')};
  await assert.rejects(client.deleteFirmware(1,{...options,expectedName:'Wrong'}),/target name/);
  const result=await client.deleteFirmware(1,options);
  assert.equal(result.state,'deleted_verified');
  assert.equal(JSON.parse(await readFile(options.operationFile)).state,'deleted_verified');
  assert.deepEqual(await client.list(),[{firmware_id:2}]);
  assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
});

test('ambiguous deletion is recorded and never replayed',async t=>{
  const {dir}=await fixture(t);
  const {client,calls}=fake((url,o)=>{
    if(url.includes('get_my_firmware_list')) return reply([{firmware_id:1}]);
    if(o.method==='DELETE') throw new Error('network failed');
    return reply([{firmware_id:1,firmware_name:'Test',firmware_version:'1.0',last_modified_time:'2026-11-02T00:00:00Z'}]);
  });
  await login(client);
  const options={execute:true,expectedName:'Test',expectedVersion:'1.0',operationFile:join(dir,'delete.json')};
  await assert.rejects(client.deleteFirmware(1,options),/Transport failure/);
  assert.equal(JSON.parse(await readFile(options.operationFile)).state,'deletion_outcome_unknown');
  await assert.rejects(client.deleteFirmware(1,options),/EEXIST/);
  assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
});
