/**
 * 逐条外科手术式改动（1~5 行的局部修改）。
 * ------------------------------------------------------------------
 * 每一条都必须能命中：`expect` 是硬约束。上游改了那段代码，构建会报
 * 「命中 N 次，期望 M 次」并打印是哪一条、为什么改。**不要为了让构建过而
 * 放宽 expect**，要去读上游的新代码，把 find/replace 更新到新的形状。
 *
 * 超过 5 行、或者涉及结构性改动，就别放这里——走 shell/overlay/ 整文件替换
 * （本项目的 `index.html` / `vite.config.ts` / `vitest.config.ts` / `src/main.ts`
 * 就是这么换掉的）。
 *
 * 这批改动的主题只有一个：**把浏览器下载与 `<input type=file>` 换成本机文件**。
 *
 * 上游 3D 没有 Puter 登录入口（源码里 "puter" 只出现在导出文件头的字符串里），
 * 所以**没有**「摘掉账号 / 云端素材库 / 实时协作」这类改动——ps 那边那一批
 * 在这里一条都不适用，留空比编造更诚实。
 *
 * 它的文件出入口是浏览器原生的两招：`download()`（objectURL + `<a download>`）
 * 与 `pickFile()`（隐藏的 input）。webview 里下载通常是禁的，所以把这两招接到
 * `shell/src/otools/io.js`（→ `local.js` 的 `exportFile` / `importFiles`）：
 * 宿主在就走系统对话框 + 真磁盘，不在就退回原来的浏览器行为。
 */
export const edits = [
  {
    file: 'src/io/native.ts',
    find: `import type { DocumentData } from '../data/types';\n`,
    replace: `import type { DocumentData } from '../data/types';\nimport { pickLocalFile, saveToDevice, usingHostDisk } from '../otools/io.js';\n`,
    expect: 1,
    why: '导入本机文件接缝：这个模块同时是 .p3d 的编解码器和全应用的文件出入口。',
  },
  {
    file: 'src/io/native.ts',
    find: `  const url = URL.createObjectURL(blob);\n`,
    replace: `  if (usingHostDisk()) { void saveToDevice(blob, name); return; } // 移植：宿主在就存到本机目录，不在就照旧走浏览器下载\n  const url = URL.createObjectURL(blob);\n`,
    expect: 1,
    why: 'download()：File ▸ Save / Save As / Export、贴图与脚本的导出都走这里，改成落本机。',
  },
  {
    file: 'src/io/native.ts',
    find: `export function pickFile(accept: string): Promise<File | null> {\n  return new Promise((res) => {`,
    replace: `export function pickFile(accept: string): Promise<File | null> {\n  if (usingHostDisk()) return pickLocalFile(accept); // 移植：走宿主的打开对话框读本机文件\n  return new Promise((res) => {`,
    expect: 1,
    why: 'pickFile()：File ▸ Open / Import、贴图与素材的选择都走这里，改成读本机。',
  },
  {
    file: 'src/render/final/result.ts',
    find: `import { toDisplayRGBA8, displayPixel, type ViewSettings } from './colormanage';\n`,
    replace: `import { toDisplayRGBA8, displayPixel, type ViewSettings } from './colormanage';\nimport { saveToDevice, usingHostDisk } from '../../otools/io.js';\n`,
    expect: 1,
    why: '渲染结果里还有第二份 download()，同样要接到本机文件接缝上。',
  },
  {
    file: 'src/render/final/result.ts',
    find: `  a.href = URL.createObjectURL(blob);\n`,
    replace: `  if (usingHostDisk()) { void saveToDevice(blob, name); return; } // 移植：渲染出的图 / 视频 / 序列存到本机目录\n  a.href = URL.createObjectURL(blob);\n`,
    expect: 1,
    why: '渲染输出（图片编辑器保存、动画的 webm / zip、音频导出）：改走本机保存。',
  },
  {
    file: 'src/io/files.ts',
    find: `description: 'Save the current project (downloads a .p3d file)'`,
    replace: `description: 'Save the current project to this device (a .p3d file)'`,
    expect: 1,
    why: 'Save 命令的说明文：不再是「下载一个文件」，而是存到这台设备上。',
  },
];
