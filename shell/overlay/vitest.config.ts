/**
 * OTools 插件版的 vitest 配置（覆盖上游同名文件）。
 *
 * 上游这份只收 `tests/unit/**\/*.test.ts`（它自己的测试全是 TS，而且放在
 * `tests/unit/` 下）。Vitest 会**优先**读 vitest.config.ts 而不是 vite.config.ts，
 * 所以不覆盖它的话，`shell/tests/*.test.js`（合成后进 `.build/tests/`）根本
 * 不会被收集——移植层的回归就静悄悄地不跑了。
 *
 * 这里把两种后缀都收进来：上游的回归与移植层的回归跑在同一个 vitest 进程里，
 * `node scripts/test.mjs` 一次跑完两边。
 *
 * 环境默认是 node（几何 / 格式编解码的测试不依赖 DOM）；需要 DOM 的测试各自
 * 在文件头声明——上游那几个用 `// @vitest-environment happy-dom`，移植层那两个
 * 用 `// @vitest-environment jsdom`。
 *
 * `pool: 'threads'`：默认池（forks）在这台机器上跑满 31 个文件时会有个别
 * worker 起不来（`Timeout waiting for worker to respond`），两个 happy-dom 的
 * 文件因此拿不到 worker、整轮退出码变 1。换成 threads 后 31 个文件全跑完，
 * 而且快一倍多（33s vs 88s）。这是本机环境的并发问题，不是上游测试的问题。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/**/*.test.js'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 30_000,
  },
});
