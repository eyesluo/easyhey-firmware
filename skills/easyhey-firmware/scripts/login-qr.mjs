import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const script = fileURLToPath(new URL('./render_qr.py', import.meta.url));
const messages = {
  QR_DEPENDENCY_MISSING: 'Python 缺少 reportlab，尚未生成二维码；请安装依赖或选择包含该依赖的 Python。',
  QR_INPUT_INVALID: '二维码内容或输出路径无效，尚未生成图片。',
  QR_WRITE_FAILED: '二维码图片无法写入，请检查临时目录权限与磁盘空间。',
  QR_ENCODING_FAILED: '二维码编码失败，尚未生成图片；请检查登录接口返回格式。',
};
function runPython(pythonExecutable, args, input = '') {
  if (typeof pythonExecutable !== 'string' || !isAbsolute(pythonExecutable)) {
    throw new Error('请先确定 Python 可执行文件的绝对路径。');
  }
  return new Promise((resolveResult, reject) => {
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolveResult(result);
    };
    const child = spawn(pythonExecutable, ['-X', 'utf8', script, ...args], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill(); finish(new Error('二维码生成超时，进程已停止；请检查 Python 环境。'));
    }, 20000);
    child.on('error', () => finish(new Error('无法启动指定 Python，请检查路径与运行权限。')));
    child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-8192); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    child.stdin.on('error', () => {}); // close/error supplies a sanitized diagnosis.
    child.on('close', code => {
      if (code !== 0) {
        const marker = Object.keys(messages).find(key => stderr.split(/\r?\n/).includes(key));
        finish(new Error(marker ? messages[marker] : '二维码生成程序失败，未显示图片；请检查 Python 环境。'));
        return;
      }
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error('二维码生成程序未返回有效结果。')); }
    });
    child.stdin.end(input);
  });
}

export async function checkQrRenderer({ pythonExecutable }) {
  const result = await runPython(pythonExecutable, ['--check']);
  if (result.ready !== true) throw new Error('二维码运行环境检查未通过。');
  return { ready: true };
}

export function verifyQrPng(bytes) {
  const fail = () => { throw new Error('二维码 PNG 校验失败，不能提示用户扫码。'); };
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail();
  let at = 8, width, height, ended = false;
  const data = [];
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (at + 12 + length > bytes.length) fail();
    const body = bytes.subarray(at + 8, at + 8 + length);
    // Check every chunk CRC, including PNG headers.
    let crc = 0xffffffff;
    for (const b of bytes.subarray(at + 4, at + 8 + length)) {
      crc ^= b;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(at + 8 + length)) fail();
    if (type === 'IHDR') {
      if (at !== 8 || length !== 13) fail();
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (width < 64 || width > 2048 || width !== height || body[8] !== 8 || body[9] !== 0 || body[10] || body[11] || body[12]) fail();
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') { if (length !== 0 || at + 12 !== bytes.length) fail(); ended = true; }
    at += length + 12;
  }
  if (!ended || !width || !data.length || at !== bytes.length) fail();
  let pixels;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: (width + 1) * height }); }
  catch { fail(); }
  if (pixels.length !== (width + 1) * height) fail();
  return { width, height };
}

export async function renderLoginQr(qr, { pythonExecutable, outputDir = tmpdir() } = {}) {
  if (!qr || typeof qr.qrCodeContent !== 'string' || !qr.qrCodeContent.trim()) throw new Error('登录 API 未提供二维码内容。');
  if (!Number.isFinite(qr.expiresAt) || qr.expiresAt <= Date.now() + 15000) {
    throw new Error('二维码已过期或即将过期，请获取新二维码后再展示。');
  }
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)) throw new Error('请使用可访问的临时目录绝对路径。');
  let path;
  try {
    await mkdir(outputDir, { recursive: true });
    path = join(await mkdtemp(join(outputDir, 'easyhey-qr-')), 'login.png');
  } catch { throw new Error('无法创建二维码临时目录，请检查写入权限。'); }
  const result = await runPython(pythonExecutable, ['--output', path], qr.qrCodeContent);
  if (typeof result.path !== 'string' || resolve(result.path) !== resolve(path)) throw new Error('二维码输出路径与预期不符。');
  let bytes;
  try { bytes = await readFile(path); } catch { throw new Error('二维码图片生成后无法读取。'); }
  const size = verifyQrPng(bytes);
  if (size.width !== result.width || size.height !== result.height || bytes.length !== result.size) throw new Error('二维码图片生成结果不完整。');
  if (qr.expiresAt <= Date.now() + 15000) throw new Error('二维码生成后已临近过期，请获取新码。');
  // Unique directories prevent the UI from reusing a cached image from an older login.
  const displayPath = path.replaceAll('\\', '/').replaceAll('<', '%3C').replaceAll('>', '%3E');
  return { path, ...size, size: bytes.length, expiresAt: qr.expiresAt,
    imageMarkdown: `![微信登录二维码](<${displayPath}>)`,
    linkMarkdown: `[打开二维码图片](<${displayPath}>)` };
}
