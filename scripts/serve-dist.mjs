/**
 * 把 dist/ 当静态站点跑起来（本地试 dist/ 用；不进插件分发）。
 * ------------------------------------------------------------------
 *   node scripts/serve-dist.mjs [端口]
 *
 * 这条路径下宿主不在，应用会退回上游的浏览器本地存储（OPFS）：
 * 导入走浏览器文件选择器，导出走浏览器下载。想看宿主的真实行为，
 * 用 deploy-to-otools 装进 OTools。
 *
 * 注意：WebCodecs 的硬件解码 / 编码（预览与导出都靠它）需要 secure context。
 * 127.0.0.1 算 secure context，所以本地能跑；局域网 IP 访问会退化。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repoRoot, 'dist');
const port = Number(process.argv[2] || 5518);

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 node scripts/build.mjs');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 需要 SharedArrayBuffer 的实验性路径时可以用这两个头（默认关掉）。
      // 'cross-origin-opener-policy': 'same-origin',
      // 'cross-origin-embedder-policy': 'require-corp',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}/  （Ctrl+C 结束）`);
    console.log('宿主不在时：工程存在浏览器 OPFS 里，导入/导出走浏览器自己的对话框。');
  });
