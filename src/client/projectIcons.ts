/**
 * 项目图标（控制室卡片 / 侧栏卡片共用）：内置 emoji 集合，不依赖任何网络图片。
 *
 * 三个用途：
 *   1. 新建项目时随机分配一个「当前项目都没用过」的图标（同批项目尽量不撞）；
 *   2. 老存档没有图标字段时，按项目 id 派生一个**固定**图标（同一项目每次都一样，刷新不会变）；
 *   3. 手动更换图标时从同一集合里挑（index.tsx 的图标选择器直接用它）。
 *
 * 纯函数、零依赖，可 node 单测。
 */

/** 内置图标集：彩色 emoji，深色/浅色主题下都能读，体积为零（系统字体渲染）。 */
export const ICON_CHOICES: readonly string[] = [
  '🧱', '🏠', '🏗️', '🏛️', '📚', '📖', '📝', '✏️',
  '📐', '📏', '🧮', '🧪', '⚗️', '🔬', '🧬', '🔭',
  '⚙️', '🛠️', '🔧', '🧰', '🤖', '💡', '🧠', '🕹️',
  '🎨', '🎬', '🎧', '📷', '🌍', '🗺️', '🚗', '🚀',
  '📈', '📊', '💰', '🏥', '🎓', '🏆', '🕒', '🗂️',
  '📦', '💬', '⚡', '🌱',
]

/** 图标兜底（集合为空/取不到时）。 */
export const FALLBACK_ICON = '🧱'

/** 旧存档里的「默认占位图标」：等同没有图标，允许按 id 派生。 */
const LEGACY_PLACEHOLDER = '🧱'

/** 字符串 → 32 位 FNV-1a（稳定、无依赖；只用于取图标下标，不做安全性用途）。 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 按项目 id 派生固定图标：同一个 id 永远同一个图标（老存档兼容用）。 */
export function stableIconForId(id: string): string {
  if (ICON_CHOICES.length === 0) return FALLBACK_ICON
  return ICON_CHOICES[hashString(id) % ICON_CHOICES.length]
}

/**
 * 取一个当前没被占用的图标（新建项目用）。
 * @param used - 现有项目已使用的图标
 * @param random - 随机源（0..1），注入以便单测
 * @returns 未被占用的图标；全被占用时退化为按随机源挑一个（不会返回空）
 */
export function pickUnusedIcon(used: readonly string[], random: () => number = Math.random): string {
  const taken = new Set((used ?? []).filter((x) => typeof x === 'string' && x))
  const free = ICON_CHOICES.filter((icon) => !taken.has(icon))
  const pool = free.length > 0 ? free : ICON_CHOICES
  if (pool.length === 0) return FALLBACK_ICON
  const r = Number(random())
  const i = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0
  return pool[i]
}

/**
 * 解析某个项目「该显示什么图标」（单一真源，卡片与选择器都用它）：
 *   1. 显式设置过（手动换过 / 新建时随机写入）→ 用它；
 *   2. 宿主注册的入驻项目自带 icon → 用它；
 *   3. 布局自带的非占位图标（模板项目等）→ 用它；
 *   4. 都没有 → 按 id 派生固定图标（老存档不再一律显示同一块砖）。
 */
export function resolveProjectIcon(id: string, explicit?: string | null, registered?: string | null, layoutIcon?: string | null): string {
  const pick = (v?: string | null): string => (typeof v === 'string' ? v.trim() : '')
  const a = pick(explicit)
  if (a) return a
  const b = pick(registered)
  if (b) return b
  const c = pick(layoutIcon)
  if (c && c !== LEGACY_PLACEHOLDER) return c
  return stableIconForId(id)
}
