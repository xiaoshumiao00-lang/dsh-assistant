/**
 * 更新公告：正文与版本都由构建时注入（build.mjs 读 CHANGELOG.md 当前版本那一节 + package.json 版本号）。
 *
 * 这里以前是手写死的常量（'v0.2.5' 一整段公告），而发布版本早已走到 0.2.10：
 * 公告与实现对不上就是误导。现在 CHANGELOG.md 是唯一版本源，缺当前版本那一节直接构建失败。
 */
declare const __WT_VERSION__: string
declare const __WT_ANNOUNCE__: string

/** 当前插件版本（与 package.json / dsh.plugin.json 一致） */
export const ANNOUNCE_VERSION = typeof __WT_VERSION__ === 'undefined' ? 'dev' : __WT_VERSION__

/** 公告正文（CHANGELOG.md 里当前版本那一节） */
export const ANNOUNCE_BODY = typeof __WT_ANNOUNCE__ === 'undefined' ? '' : String(__WT_ANNOUNCE__)

/** 公告标题行，控制室直接照用 */
export const ANNOUNCE_HEAD = `更新公告 · v${ANNOUNCE_VERSION}`

/** 旧名兼容：曾经这里是手写死的一整段公告，保留名字避免外部引用编译失败 */
export const CHANGELOG_V030 = ANNOUNCE_BODY
/** 旧名兼容：版本号现在跟版本源走 */
export const CHANGELOG_VERSION = ANNOUNCE_VERSION
