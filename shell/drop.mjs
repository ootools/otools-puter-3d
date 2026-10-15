/**
 * 从构建树里删掉的路径：只服务 Puter 云 / 在线协作 / 需要登录的功能。
 * ------------------------------------------------------------------
 * 删完之后的 `keep` 是断言：这些文件必须还在，否则说明删过头了
 * （上游改了路径、或者 drop 列表写宽了）。
 *
 * 上游 3D 没有任何 Puter 相关的目录：文件读写全靠浏览器下载与 `<input type=file>`
 * （见 shell/edits.mjs 改的那两处），autosave 落在 IndexedDB（浏览器本地，
 * 不是云），偏好设置落在 localStorage。没有可删的东西，所以 `drops` 是空的——
 * 这里不放任何「顺手删掉」的条目。
 *
 * `keep` 里列的是**移植改动依赖的那几个上游文件**：它们一旦改名或移动，
 * shell/edits.mjs 的 6 条改动会先报「命中 0 次」，这里再兜一道。
 */
export const drops = [];

export const keep = [
  'index.html',
  'src/main.ts',
  'src/io/native.ts',
  'src/io/files.ts',
  'src/render/final/result.ts',
];
