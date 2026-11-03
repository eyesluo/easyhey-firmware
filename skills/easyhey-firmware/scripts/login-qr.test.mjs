import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkQrRenderer, renderLoginQr, verifyQrPng } from './login-qr.mjs';

const pythonExecutable = process.env.EASYHEY_TEST_PYTHON;
const qr = () => ({qrCodeContent:'https://example.invalid/easyhey-qr-test',expiresAt:Date.now()+300000});
const real = {skip:!pythonExecutable && 'Set EASYHEY_TEST_PYTHON to test real rendering'};
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(),'easyhey qr 测试 '));
  t.after(()=>rm(dir,{recursive:true,force:true})); return dir;
}

test('expired or missing login content is rejected before rendering',async()=>{
  await assert.rejects(renderLoginQr({}),/未提供二维码内容/);
  await assert.rejects(renderLoginQr({...qr(),expiresAt:Date.now()-1}),/过期/);
  await assert.rejects(renderLoginQr({...qr(),expiresAt:Date.now()+1000}),/过期/);
  await assert.rejects(renderLoginQr({...qr(),expiresAt:undefined}),/过期/);
  await assert.rejects(renderLoginQr(qr(),{outputDir:'relative'}),/绝对路径/);
});

test('missing Python has an actionable error without echoing login content',async t=>{
  const dir=await directory(t);
  await assert.rejects(renderLoginQr(qr(),{pythonExecutable:join(dir,'missing-python.exe'),outputDir:dir}),/无法启动指定 Python/);
});

test('invalid and truncated PNG data cannot be reported as ready',()=>{
  assert.throws(()=>verifyQrPng(Buffer.from('not a PNG')),/PNG 校验失败/);
  assert.throws(()=>verifyQrPng(Buffer.alloc(100)),/PNG 校验失败/);
});

test('real renderer produces readable images and fallback links with unique paths',real,async t=>{
  const dir=await directory(t);
  assert.deepEqual(await checkQrRenderer({pythonExecutable}),{ready:true});
  const first=await renderLoginQr(qr(),{pythonExecutable,outputDir:dir});
  const second=await renderLoginQr(qr(),{pythonExecutable,outputDir:dir});
  assert.notEqual(first.path,second.path);
  const bytes=await readFile(first.path);
  assert.deepEqual(verifyQrPng(bytes),{width:first.width,height:first.height});
  assert(first.imageMarkdown.startsWith('![微信登录二维码](<'));
  assert(first.linkMarkdown.startsWith('[打开二维码图片](<'));
  assert(first.linkMarkdown.includes('easyhey qr 测试 '));
  const corrupt=Buffer.from(bytes); corrupt[40]^=1;
  assert.throws(()=>verifyQrPng(corrupt),/PNG 校验失败/);
  assert.throws(()=>verifyQrPng(bytes.subarray(0,bytes.length-12)),/PNG 校验失败/);
});

test('unencodable content yields a sanitized diagnosis',real,async t=>{
  const dir=await directory(t);
  await assert.rejects(renderLoginQr({...qr(),qrCodeContent:'secret-'.repeat(1000)},
    {pythonExecutable,outputDir:dir}),error=>error.message.includes('编码失败')&&!error.message.includes('secret-'));
});

test('missing reportlab is distinguished from other rendering failures',real,async()=>{
  const script=fileURLToPath(new URL('./render_qr.py',import.meta.url));
  await assert.rejects(promisify(execFile)(pythonExecutable,['-S','-X','utf8',script,'--check'],{windowsHide:true}),
    error=>error.code===2&&error.stderr.trim()==='QR_DEPENDENCY_MISSING');
});
