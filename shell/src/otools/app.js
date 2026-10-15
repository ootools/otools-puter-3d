/**
 * 本插件的身份配置——五个 puter-* 插件之间**唯一**有差异的通用模块。
 * ------------------------------------------------------------------
 * `host.js` / `i18n.js` / `dom-i18n.js` / `theme-sync.js` / `local.js` 都是
 * 与业务无关的通用实现，它们的「项目个性」全部从这里读。这样做的原因很直白：
 * 五个仓库共用同一套宿主桥与多语言层，如果每个仓库都在自己的副本里散着
 * `otools-puter-ps`、`Photo Studio` 这类常量，改一次就得改五遍，而且迟早漏。
 *
 * 改这个文件就够了，其它通用模块一行都不用动。
 */

export const APP = {
  /** 插件包 id：`plugin.json` 的 `packid`/`uuid`，也是宿主侧识别用的名字。 */
  id: 'otools-puter-3d',

  /**
   * 宿主桥挂到 window 上的全局名。
   * 刻意不与上游的 `window.puter` 撞名——排查时在 console 里敲它，
   * 一眼能分清「这是我们自己的桥」还是「上游遗留」。
   */
  bridge: 'otoolsPuter3d',

  /** 英文产品名（界面上会被本地化成 productCN，错误提示里保留原文）。 */
  product: '3D',

  /** 简体中文产品名。 */
  productCN: '三维工作室',

  /** 本机默认库目录名（放在宿主的「文档」目录下）。 */
  folder: '3D Models',

  /** 库目录的标记文件名：有它才算「这是本插件的库」，避免误认用户目录。 */
  marker: '3d.json',

  /**
   * 上游自己写主题的 storage key。
   * `theme-sync.js` 靠它把宿主主题写进上游的设置里，实现「跟随宿主」。
   */
  themeKey: 'p3d.theme',

  /**
   * 找库目录时问宿主要哪些已知路径，按顺序试第一个存在的。
   * 文档类插件一律「文档 → 主目录」，不碰 videos/downloads。
   */
  rootKeys: ['documents', 'home'],

  /** 本插件的主格式扩展名（打开/保存对话框的过滤器、另存的默认后缀）。 */
  extensions: ["glb","gltf","usd","usda","usdz","obj"],

  /**
   * 用户内容区的选择器——DOM 翻译层**整棵跳过**这些节点。
   *
   * 只写**叶子**，不写容器：写容器会把里面的「删除」「重命名」这类按钮
   * 一起跳过，界面上就永远留着英文。这里放的是用户自己起的文档名、
   * 单元格内容、幻灯片文本这类东西，翻译它们等于改用户的数据。
   */
  i18nSkip: [".scene-name",".object-name",".material-name"],
};

export default APP;
