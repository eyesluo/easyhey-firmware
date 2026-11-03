import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { createHash, randomInt } from 'node:crypto';

// Public deployment configuration copied from EasyHey's shipped web client.
export const deployment = Object.freeze({
  api: 'https://easyhey.com/web/api/v1',
  supabase: 'https://clbzimhlpctbbrrbfcjl.supabase.co',
  publishableKey: 'sb_publishable_GdthtOwNK90TOsrgJQUoqQ_n4XO0ztz',
  inspected: '2026-10-28',
});
const MAX_FILE = 50 * 1024 * 1024;
const DETAIL = 'firmware_id,user_id,chip_id,firmware_version,firmware_name,firmware_description,added_time,last_modified_time,file_list,status,flash_config';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const plain = value => {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return JSON.parse(value); } catch { /* ordinary text */ }
  }
  return value;
};
const assert = (test, message) => { if (!test) throw new Error(message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a, b) => JSON.stringify(canonical(plain(a))) === JSON.stringify(canonical(plain(b)));
export const generateShareCode = () => String(randomInt(0, 1000000)).padStart(6, '0');
export function withUpdatedTime(description, now = new Date()) {
  assert(typeof description === 'string', 'Description must be text');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  // Replace only standalone timestamp annotations; preserve the description body.
  const body = description.split(/\r?\n/).filter(line => !/^[ \t]*更新时间[：:][ \t]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?:[ \t]*[（(]北京时间[）)])?[ \t]*$/.test(line)).join('\n').trimEnd();
  const result = `${body ? `${body}\n\n` : ''}更新时间：${stamp}（北京时间）`;
  assert(result.length <= 500, 'Description including update time exceeds 500 characters; shorten the body before uploading');
  return result;
}
function id(value) {
  const s = String(value);
  assert(/^[a-zA-Z0-9_-]+$/.test(s), 'Invalid firmware ID');
  return s;
}
function flash(value) {
  assert(value && ['none', 'first_time', 'always'].includes(value.erase_type), 'Choose an explicit erase_type');
  assert(typeof value.auto_restart === 'boolean', 'Choose an explicit auto_restart');
  return { erase_type: value.erase_type, auto_restart: value.auto_restart };
}
function info(value) {
  assert(typeof value.name === 'string' && value.name.trim() && value.name.length <= 50, 'Name must contain 1–50 characters');
  assert(typeof value.description === 'string' && value.description.trim() && value.description.length <= 500, 'Description must contain 1–500 characters');
  assert(typeof value.version === 'string' && value.version.trim(), 'Version is required');
}
function offset(value) {
  assert(typeof value === 'number' || (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)), 'Offset must be an integer or hexadecimal string');
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32 && n % 4096 === 0, 'Offset must be a nonnegative 4 KiB aligned address');
  return n;
}
function requireExecute(options) {
  assert(options?.execute === true, 'No write performed: execute:true is required after user authorization');
}

export async function inspectFile(path) {
  assert(typeof path === 'string' && isAbsolute(path), 'Use an absolute file path');
  const s = await stat(path);
  assert(s.isFile() && s.size > 0 && s.size <= MAX_FILE && path.toLowerCase().endsWith('.bin'), 'File must be a nonempty .bin no larger than 50 MiB');
  const bytes = await readFile(path);
  return { path: resolve(path), name: basename(path), size: bytes.length, sha256: sha256(bytes) };
}

// Local-only validation. No requests, no uploads and no publication.
export async function inspectManifest(manifest) {
  info(manifest);
  const description = withUpdatedTime(manifest.description);
  assert(manifest.chip_id !== undefined && String(manifest.chip_id).trim(), 'Use chip_id returned by chips()');
  flash(manifest.flash_config);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'Files are required');
  if (manifest.flash_size !== undefined) assert(Number.isSafeInteger(manifest.flash_size) && manifest.flash_size > 0, 'Invalid flash_size');
  const files = [];
  for (const f of manifest.files) {
    const local = await inspectFile(f.path);
    const at = offset(f.offset);
    if (manifest.flash_size !== undefined) assert(at + local.size <= manifest.flash_size, 'File exceeds flash capacity');
    if (f.sha256 !== undefined) assert(local.sha256 === f.sha256, 'File changed since planning');
    files.push({ ...local, offset: at });
  }
  const sorted = [...files].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) assert(sorted[i - 1].offset + sorted[i - 1].size <= sorted[i].offset, 'Overlapping flash ranges');
  return { name: manifest.name, description, version: manifest.version,
    chip_id: String(manifest.chip_id), flash_config: flash(manifest.flash_config), files };
}

export class EasyHeyClient {
  #fetch; #session = null; #login = null; #lastPoll = 0;
  constructor({ fetchImpl = globalThis.fetch } = {}) { this.#fetch = fetchImpl; }

  async #request(url, { method = 'GET', body, headers = {}, timeout = 30000 } = {}) {
    let response;
    try {
      response = await this.#fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch {
      // Never echo request headers, token-bearing bodies or provider exception text.
      throw new Error(`Transport failure during ${method}; outcome may be unknown. Do not automatically retry writes.`);
    }
    if (!response.ok) throw new Error(`API HTTP ${response.status}; no automatic retry. Reauthenticate on 401; check permissions on 403.`);
    let data;
    try { data = await response.json(); } catch { throw new Error('API returned non-JSON data; verify the endpoint contract'); }
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'number' && data.code !== 200) {
      throw new Error(`API application error code ${data.code}; check state before retrying`);
    }
    return data;
  }
  async #json(url, method = 'GET', data, { auth = true, headers = {} } = {}) {
    const h = { apikey: deployment.publishableKey, ...headers };
    if (auth) { await this.#refresh(); h.Authorization = `Bearer ${this.#session.access_token}`; }
    if (data !== undefined) h['Content-Type'] = 'application/json';
    return this.#request(url, { method, headers: h, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  #setSession(s) {
    assert(typeof s?.access_token === 'string' && typeof s?.refresh_token === 'string', 'Login returned no usable session');
    let exp;
    try { exp = JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64url')).exp; } catch { /* expires_in fallback */ }
    this.#session = { access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: Number(exp) || Date.now() / 1000 + Number(s.expires_in || 3600) };
  }
  async #refresh() {
    assert(this.#session, 'Scan a new QR code using loginStart() and loginPoll() first');
    if (this.#session.expires_at > Date.now() / 1000 + 60) return;
    try {
      const s = await this.#json(`${deployment.supabase}/auth/v1/token?grant_type=refresh_token`, 'POST',
        { refresh_token: this.#session.refresh_token }, { auth: false });
      this.#setSession(s);
    } catch { this.#session = null; throw new Error('Session refresh failed; perform QR login again'); }
  }
  async loginStart() {
    assert(!this.#session, 'Already authenticated; use forgetSession() only if a different login is intended');
    const r = await this.#json(`${deployment.api}/wechat-qr-create`, 'POST', {}, { auth: false });
    const d = r?.data;
    assert(typeof d?.qrCodeContent === 'string' && typeof d?.scene === 'string' && d.scene, 'Unexpected QR response');
    this.#login = { scene: d.scene, deadline: Date.now() + Number(d.expiresIn || 300) * 1000 };
    this.#lastPoll = 0;
    return { qrCodeContent: d.qrCodeContent, expiresIn: Number(d.expiresIn || 300), expiresAt: this.#login.deadline };
  }
  async loginPoll() {
    assert(this.#login && Date.now() < this.#login.deadline, 'QR session missing or expired; start a new login');
    if (Date.now() - this.#lastPoll < 5000) return { status: 'pending', retryAfterSeconds: 5 };
    this.#lastPoll = Date.now();
    const r = await this.#json(`${deployment.api}/wechat-login`, 'POST', { scene: this.#login.scene }, { auth: false });
    if (r?.data?.status === 'pending') return { status: 'pending', retryAfterSeconds: 5 };
    assert(r?.data?.status === 'ok', 'Unexpected login state; do not assume authentication succeeded');
    this.#setSession(r.data);
    try {
      const user = await this.me();
      this.#login = null;
      return { status: 'authenticated', user };
    } catch { this.#session = null; throw new Error('Login identity verification failed; start a new QR login'); }
  }
  forgetSession() { this.#session = null; this.#login = null; }
  async me() {
    const r = await this.#json(`${deployment.api}/wechat-login/me`);
    assert(r?.data?.user_id !== undefined, 'Unexpected identity response');
    return { user_id: r.data.user_id, nick: r.data.nick };
  }
  async chips() {
    const r = await this.#json(`${deployment.supabase}/rest/v1/chip_list?select=chip_id,chip_name,description`, 'GET', undefined, { auth: false });
    assert(Array.isArray(r), 'Unexpected chip list');
    return r;
  }
  async list() {
    const rows = [], seen = new Set();
    for (let start = 0; start < 100000; start += 100) {
      const data = await this.#json(`${deployment.supabase}/rest/v1/rpc/get_my_firmware_list?limit=100&offset=${start}&order=firmware_id.asc`, 'POST', {});
      assert(Array.isArray(data), 'Unexpected firmware list');
      for (const row of data) {
        const key = id(row.firmware_id);
        assert(!seen.has(key), 'Pagination repeated an ID; list completeness is unverified');
        seen.add(key); rows.push(row);
      }
      if (data.length < 100) return rows;
    }
    throw new Error('List safety limit reached; do not report results as complete');
  }
  async detail(firmwareId) {
    const key = id(firmwareId);
    assert((await this.list()).some(r => String(r.firmware_id) === key), 'Firmware is not in the current account list');
    const q = new URLSearchParams({ select: DETAIL, firmware_id: `eq.${key}` });
    const rows = await this.#json(`${deployment.supabase}/rest/v1/firmware_info?${q}`);
    assert(Array.isArray(rows) && rows.length === 1, 'Expected exactly one owned firmware');
    return rows[0];
  }

  async uploadFile(path, options = {}) {
    requireExecute(options);
    const file = await inspectFile(path);
    const bytes = await readFile(path);
    assert(sha256(bytes) === file.sha256, 'File changed during upload preparation');
    const t = await this.#json(`${deployment.api}/misc/uploadToken`);
    const token = t?.data?.token;
    assert(typeof token === 'string', 'Unexpected upload token response');
    let policy, ak;
    try {
      const parts = token.split(':'); ak = parts.length > 3 ? parts[1] : parts[0];
      policy = JSON.parse(Buffer.from(parts.at(-1), 'base64url'));
    } catch { throw new Error('Upload token format changed'); }
    assert(typeof policy.scope === 'string' && policy.deadline > Date.now() / 1000, 'Upload token has expired or lacks scope');
    const bucket = policy.scope.split(':')[0];
    const query = new URLSearchParams({ ak, bucket });
    // No EasyHey session headers are sent to Qiniu. Discover the bucket's own host.
    const region = await this.#request(`https://api.qiniu.com/v4/query?${query}`);
    const host = region?.hosts?.[0]?.up?.domains?.[0];
    assert(typeof host === 'string' && /^[a-z0-9.-]+$/i.test(host) &&
      ['qiniup.com', 'qbox.me', 'qiniu.com', 'qiniuapi.com', 'qnup.com'].some(d => host.endsWith(`.${d}`)), 'Unrecognized Qiniu upload host; review current configuration');
    const form = new FormData();
    form.set('token', token); form.set('key', file.name);
    form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), file.name);
    const result = await this.#request(`https://${host}`, { method: 'POST', body: form, timeout: 120000 });
    assert(typeof result?.data?.etag === 'string' && result.data.etag, 'Upload result lacks EasyHey callback data.etag; upload outcome needs investigation');
    return { ...file, etag: result.data.etag };
  }

  async preparePublish(manifest, receipts) {
    const plan = await inspectManifest(manifest);
    assert(Array.isArray(receipts), 'Upload receipts required');
    const files = plan.files.map(f => {
      const r = receipts.find(x => x.path === f.path && x.sha256 === f.sha256 && x.size === f.size);
      assert(typeof r?.etag === 'string' && r.etag, `Missing matching upload receipt for ${f.name}`);
      return { etag: r.etag, offset: f.offset };
    });
    const code = manifest.share_code;
    assert(/^(?:[A-Z]{3}|[0-9]{3})[0-9]{3}$/.test(code), 'Use a website-format share code');
    return { name: plan.name, description: plan.description, version: plan.version, chip_id: plan.chip_id,
      share_code: code, file_list: JSON.stringify(files), flash_config: plan.flash_config };
  }
  async publish(manifest, receipts, options = {}) {
    requireExecute(options);
    assert(isAbsolute(options.operationFile || ''), 'An absolute operationFile is required to prevent duplicate publication');
    const payload = await this.preparePublish(manifest, receipts);
    const chips = await this.chips();
    assert(chips.some(c => String(c.chip_id) === payload.chip_id), 'Unknown chip_id');
    const before = await this.list();
    assert(!before.some(r => r.share_code === payload.share_code || (r.firmware_name === payload.name && r.firmware_version === payload.version)), 'Matching name/version or share code already exists; inspect before creating another record');
    const journal = { state: 'prepared', name: payload.name, version: payload.version,
      share_code: payload.share_code, payload_sha256: sha256(JSON.stringify(payload)), started_at: new Date().toISOString() };
    await writeFile(options.operationFile, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
    try {
      const r = await this.#json(`${deployment.api}/firmware`, 'POST', payload);
      assert(r?.data?.firmware_id !== undefined, 'Create response missing firmware_id');
      journal.firmware_id = r.data.firmware_id; journal.state = 'created_unverified';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      let current = await this.detail(journal.firmware_id);
      assert(current.firmware_name === payload.name && current.firmware_version === payload.version &&
        current.firmware_description === payload.description && String(current.chip_id) === payload.chip_id &&
        same(current.file_list, payload.file_list) && same(current.flash_config, payload.flash_config), 'Created firmware does not match submitted fields; do not submit again');
      let row = (await this.list()).find(x => String(x.firmware_id) === String(journal.firmware_id));
      if (row && !row.share_code && Number(current.status) === 0) {
        await this.bindShareCode(journal.firmware_id, payload.share_code,
          { execute: true, operationFile: `${options.operationFile}.bind.json` });
        current = await this.detail(journal.firmware_id);
        row = (await this.list()).find(x => String(x.firmware_id) === String(journal.firmware_id));
      }
      assert(row && row.share_code === payload.share_code, 'Created share code not yet verified; do not submit again');
      journal.state = Number(current.status) === 1 ? 'published_verified' : 'created_not_published';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      return { ...journal, status: current.status };
    } catch (error) {
      journal.state = journal.firmware_id !== undefined ? 'created_unverified' : 'outcome_unknown';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      throw error;
    }
  }
  // Initial publication of an existing, unbound record. Never exchanges a code.
  async bindShareCode(firmwareId, shareCode, options = {}) {
    requireExecute(options);
    const key = id(firmwareId);
    assert(typeof shareCode === 'string' && /^(?:[A-Z]{3}|[0-9]{3})[0-9]{3}$/.test(shareCode), 'Invalid share code');
    assert(isAbsolute(options.operationFile || ''), 'An absolute operationFile is required for initial publication');
    const rows = await this.list();
    const row = rows.find(x => String(x.firmware_id) === key);
    assert(row, 'Firmware is not in the current account list');
    if (row.share_code === shareCode && Number(row.status) === 1) {
      return { state: 'published_verified', firmware_id: key, share_code: shareCode, status: 1 };
    }
    assert(!row.share_code && Number(row.status) === 0, 'Only an unpublished record without a share code can be bound');
    assert(!rows.some(x => x.share_code === shareCode), 'Share code already exists in this account');
    const journal = { state: 'binding_prepared', firmware_id: key, share_code: shareCode, started_at: new Date().toISOString() };
    await writeFile(options.operationFile, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
    try {
      const r = await this.#json(`${deployment.api}/firmware/share/bind`, 'POST', { firmwareId: firmwareId, shareCode });
      assert(r?.data?.shareCode === shareCode, 'Binding response did not confirm the requested share code; do not retry');
      const after = (await this.list()).find(x => String(x.firmware_id) === key);
      assert(after?.share_code === shareCode && Number(after.status) === 1, 'Publication not yet verified; query this ID before retrying');
      journal.state = 'published_verified'; journal.status = 1;
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      return journal;
    } catch (error) {
      journal.state = 'binding_outcome_unknown';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      throw error;
    }
  }
  async #patch(firmwareId, changes, options, stampUpdatedTime = false) {
    requireExecute(options);
    const current = await this.detail(firmwareId);
    if (stampUpdatedTime) changes = { ...changes,
      firmware_description: withUpdatedTime(changes.firmware_description ?? current.firmware_description ?? '') };
    if (Object.entries(changes).every(([k, v]) => same(current[k], v))) return current;
    assert(current.last_modified_time, 'Missing revision timestamp; cannot safely update');
    const query = new URLSearchParams({ firmware_id: `eq.${id(firmwareId)}`,
      last_modified_time: `eq.${current.last_modified_time}`, select: 'firmware_id' });
    const rows = await this.#json(`${deployment.supabase}/rest/v1/firmware_info?${query}`, 'PATCH', changes,
      { headers: { Prefer: 'return=representation' } });
    assert(Array.isArray(rows) && rows.length === 1, 'Update conflict, denied access or missing row; no blind retry');
    const after = await this.detail(firmwareId);
    assert(Object.entries(changes).every(([k, v]) => same(after[k], v)), 'Update not verified; inspect before retrying');
    return after;
  }
  async updateInfo(firmwareId, changes, options = {}) {
    assert(changes && Object.keys(changes).length, 'No changes specified');
    const map = { name: 'firmware_name', description: 'firmware_description', version: 'firmware_version' }, patch = {};
    for (const [key, value] of Object.entries(changes)) {
      assert(map[key] && typeof value === 'string' && value.trim(), 'Only nonempty name, description and version changes are supported');
      assert(key !== 'name' || value.length <= 50, 'Name exceeds 50 characters');
      assert(key !== 'description' || value.length <= 500, 'Description exceeds 500 characters');
      patch[map[key]] = value;
    }
    return this.#patch(firmwareId, patch, options, true);
  }
  async setPublished(firmwareId, published, options = {}) {
    assert(typeof published === 'boolean', 'published must be boolean');
    return this.#patch(firmwareId, { status: published ? 1 : 2 }, options);
  }
  async deleteFirmware(firmwareId, options = {}) {
    requireExecute(options);
    const key = id(firmwareId);
    assert(typeof options.expectedName === 'string' && options.expectedName.trim() &&
      typeof options.expectedVersion === 'string' && options.expectedVersion.trim(), 'Confirm the target name and version before deletion');
    assert(isAbsolute(options.operationFile || ''), 'An absolute operationFile is required for deletion');
    const current = await this.detail(key);
    assert(current.firmware_name === options.expectedName && current.firmware_version === options.expectedVersion,
      'Deletion target name/version changed; no deletion performed');
    assert(current.last_modified_time, 'Missing revision timestamp; cannot safely delete');
    const journal = { state: 'deletion_prepared', firmware_id: key, name: current.firmware_name,
      version: current.firmware_version, revision: current.last_modified_time, started_at: new Date().toISOString() };
    await writeFile(options.operationFile, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
    try {
      const query = new URLSearchParams({ firmware_id: `eq.${key}`, last_modified_time: `eq.${current.last_modified_time}`,
        firmware_name: `eq.${current.firmware_name}`, firmware_version: `eq.${current.firmware_version}`, select: 'firmware_id' });
      const rows = await this.#json(`${deployment.supabase}/rest/v1/firmware_info?${query}`, 'DELETE', undefined,
        { headers: { Prefer: 'return=representation' } });
      assert(Array.isArray(rows) && rows.length === 1 && String(rows[0].firmware_id) === key,
        'Deletion conflict, denied access or missing row; no blind retry');
      assert(!(await this.list()).some(x => String(x.firmware_id) === key), 'Deletion not yet verified; query before retrying');
      journal.state = 'deleted_verified';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      return journal;
    } catch (error) {
      journal.state = 'deletion_outcome_unknown';
      await writeFile(options.operationFile, JSON.stringify(journal, null, 2));
      throw error;
    }
  }
}
