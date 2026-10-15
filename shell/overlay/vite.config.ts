/**
 * OTools 插件版的 Vite 配置（覆盖上游同名文件）。
 *
 * 与上游的两处差别：
 *   1. **不再引入 `../../dev/puter-localhost.mjs`**（以及 documents 的
 *      `./dev/collab-dev-server.mjs`）。上游那个插件把开发服务器挂在
 *      `<name>.puter.localhost`，是因为 Puter 的应用沙箱按子域名区分账号；
 *      插件版没有 Puter，直接跑 127.0.0.1 即可。而且 `dev/` 不在上游快照里
 *      （我们只快照 `src/3d`），留着这行会直接构建失败。
 *   2. **产物落到仓库根的 `dist/`**（`plugin.json` 的 `entry: dist/index.html`）。
 *      构建根目录是 `.build/`（upstream + 移植层的合成树），所以这里写 `../dist`。
 *
 * `base: './'` 是必须的：宿主用 `otools-plugin://<uuid>/dist/index.html` 提供
 * 插件，相对路径是唯一能同时适配「宿主加载」和「dist 拖进浏览器」的写法。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari16',
    chunkSizeWarningLimit: 1200,
    outDir: '../dist',
    // dist/ 的清扫交给 scripts/tree.mjs 的 sweepDist()：拿 Vite JS API 报回来的
    // 「本次产出了哪些文件」做差集，只删几个带哈希的旧 chunk，
    // 而不是把整个目录删掉重来。
    emptyOutDir: false,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5519,
    strictPort: true,
    fs: {
      // 构建根是 `.build/`，而 node_modules 在仓库根（上一级）。不显式放行的话，
      // dev / vitest 会以 `Denied ID …/node_modules/…?url` 拒掉包内资源。
      allow: ['..'],
    },
  },
  worker: { format: 'es' },
  test: {
    // 上游的测试大多跑在 node 环境（文档/表格引擎不依赖 DOM），
    // 移植层自己的测试用文件头的 `// @vitest-environment jsdom` 单独声明。
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30_000,
  },
});
