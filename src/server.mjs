// 可配置宿主端口的 Compose Web 服务：
//   提供复核页静态资源与 /health、/healthz 健康响应。
// 环境变量：
//   HOST  默认 0.0.0.0
//   PORT  默认 8080
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function json(res, code, body, method = 'GET') {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : data);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    return json(res, 403, { status: 'error', error: 'forbidden' }, req.method);
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('is directory');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'content-length': data.length,
      // 模块与页面不缓存，确保返航重开拿到最新前端
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    json(res, 404, { status: 'error', error: 'not found', path: pathname }, req.method);
  }
}

export const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { status: 'error', error: 'method not allowed' });
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    return json(res, 200, {
      status: 'ok',
      service: 'deepspace-attestation-vault',
      host: HOST,
      port: PORT,
      uptimeMs: Date.now() - STARTED_AT,
      time: new Date().toISOString(),
    }, req.method);
  }
  if (url.pathname === '/ready') {
    return stat(join(ROOT, 'vendor', 'core', 'vault.mjs'))
      .then(() => json(res, 200, { status: 'ready', webBuilt: true }, req.method))
      .catch(() => json(res, 503, { status: 'not-ready', webBuilt: false }, req.method));
  }
  return serveStatic(req, res);
});

export function start() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(() => {
    const addr = server.address();
    // eslint-disable-next-line no-console
    console.log(`[server] 深空封存复核页已启动：http://${HOST}:${addr.port} （健康检查 /health）`);
  });
}
