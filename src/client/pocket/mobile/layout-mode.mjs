// 布局模式判定（issue #74：宽屏手机/Pad 可选电脑布局；本次补上"卡死自救"）
//
// 优先级：URL 参数 (?dsh-layout=desktop|mobile|auto) > localStorage > 默认 auto(=matchMedia)。
//   - URL 带 'desktop' / 'mobile' → 照做，并同步进 localStorage（issue #74 的语义）；
//   - URL 带 'auto' → 显式清除 localStorage；
//   - URL 不带参数 → **不干涉** localStorage（那是用户的持久偏好，见 persistLayoutFromUrl）。
//
// 卡死自救（P0，手机截图实证）：手机上 'desktop' 这个值一旦被写进 localStorage
// （旧版只能从 ?dsh-layout=desktop 来，微信内置浏览器会连查询参数一起恢复上次访问；
// 新版则是人在设置页/徽章上误选），此后手机上再没有任何 UI 能切回来 ——
// mobileApply 直接 early-return，抽屉不存在、backdrop 不存在，官方侧栏变成
// 常驻 48px 图标 rail，会话详情被挤掉 13% 宽。
// 所以：没有 URL 参数、没有 user 主动标记、stored==='desktop'、而视口宽度
// < PHONE_STUCK_VIEWPORT（= 官方 SIDEBAR_AUTO_COLLAPSE 那条 1024 线）时，判定为
// "残留的旧值" → 清掉 localStorage，本次按手机抽屉走，并给用户一次性提示 + 常驻布局徽章。
// 阈值取 1024 而不是更小的数：用户已确认手机是**普通直板机**（不是折叠屏、不是 Pad），
// 直板机横屏 innerWidth 约 740-900，取 700 会漏掉横屏那条；而 issue #74 的「电脑布局」
// 选项本就是为 ≥1024 的宽屏手机/Pad 设计的，<1024 还存着 desktop 一定是残留。
// 反过来，人在徽章/设置页上主动选「电脑」（<1024 时先二次确认）会写
// dsh-pocket.layout.user='1'，此后 heal 不再挡他 —— 两个语义不打架。
// URL 上真带参数时不 heal（那是人此刻的表态），但徽章/设置页会顺手把参数摘掉
// （stripLayoutParamFromHref），否则刷新又被 URL 压回去。
//
// 与抽屉自持状态（drawer-state.mjs）的分工：这里决定"走不走手机抽屉布局"，
// drawer-state 决定"抽屉本身开没开"。
//
// 纯函数，便于单测；mobile-apply.tsx / 设置页读 DOM + localStorage 喂进来。

/** @typedef {'mobile' | 'desktop'} ForcedLayout */

/** 与 mobile.css.ts 的强制手机布局前缀、设置页分段控件、布局徽章共用同一个 key。 */
export const LAYOUT_STORAGE_KEY = 'dsh-pocket.layout'

/** mobileApply 写在 body 上的当前生效布局；强制手机布局的 CSS 前缀就认它。 */
export const LAYOUT_ATTR = 'data-dsh-pocket-layout'

/** 诊断用：生效布局是哪条路径来的（'url' | 'storage' | 'auto-media' | 'auto-healed'）。 */
export const LAYOUT_SRC_ATTR = 'data-dsh-pocket-layout-src'

/** 官方 SIDEBAR_AUTO_COLLAPSE 断点：窄于它才算手机视口。 */
export const NARROW_MEDIA = '(max-width: 1023px)'

/**
 * 卡死自救的视口阈值 = 官方 SIDEBAR_AUTO_COLLAPSE 那条线（1024）。
 * 为什么不是 700（上一版的取值）：用户已确认手机是**普通直板机**，不是折叠屏也不是 Pad，
 * 直板机横屏时 innerWidth 约 740-900，阈值 700 会正好漏掉"横屏的残留 desktop"；
 * 而 issue #74 的「电脑布局」本来就是给 ≥1024 的宽屏手机/Pad 设计的 ——
 * <1024 还存着 desktop 只能是残留值，除非人显式确认过（见 LAYOUT_USER_KEY）。
 */
export const PHONE_STUCK_VIEWPORT = 1024

/** 分段控件的三态取值：'' = 自动（按屏宽），'mobile' = 抽屉，'desktop' = 电脑。 */
export const LAYOUT_VALUES = ['', 'mobile', 'desktop']

/** URL 参数名（issue #74：?dsh-layout=desktop|mobile|auto）。 */
export const LAYOUT_URL_PARAM = 'dsh-layout'

/**
 * 'dsh-pocket.layout.user' = '1'：**用户主动**选过电脑布局的标记。
 * auto-heal 只清没有这个标记的残留值 —— 两条路径的分工：
 *   - 徽章 / 设置页在 innerWidth < 1024 上选「电脑」→ 必须先二次确认，确认后才写标记；
 *   - 选「自动」/「抽屉」→ 连标记一起清掉（下次残留值又能被 heal 兜住）；
 *   - 地址上带 ?dsh-layout=desktop → 人在 URL 里当场表态，视为主动，也写标记。
 * 这样"用户主动要电脑布局"和"卡死自救"就不会互相打架。
 */
export const LAYOUT_USER_KEY = 'dsh-pocket.layout.user'

/** 用户标记的写入值（只认这一个值）。 */
export const LAYOUT_USER_VALUE = '1'

/**
 * 纯函数：这个宽度上选「电脑」布局要不要先二次确认。
 * @param {number} width - window.innerWidth。
 * @param {number} [stuckViewport] - 阈值（默认 PHONE_STUCK_VIEWPORT = 官方 1024 那条线）。
 */
export function needsNarrowDesktopConfirm(width, stuckViewport = PHONE_STUCK_VIEWPORT) {
  const w = Number(width)
  return Number.isFinite(w) && w > 0 && w < Number(stuckViewport)
}

/**
 * 触屏判据：`(pointer: coarse)`。
 * 实测口径：微信 XWEB（Chrome/150 wv UA）与小米浏览器（Chrome/135）都是 true。
 * 反面教材：不要用 `hover: hover` 去反推 —— 手机 WebView 里 hover 能力报得五花八门，
 * 某些 XWEB 版本还会报 hover:hover，于是胶囊在手机上消失，逃生舱就白做了。
 */
export const COARSE_POINTER_MEDIA = '(pointer: coarse)'

/**
 * 纯函数：这次加载算不算"手机端"。
 * 名字沿用上一轮（当时它决定常驻「布局」胶囊要不要出现；那颗胶囊按用户要求已删掉，
 * 三态开关只剩 pocket 设置页「手机访问」分区）。现在它只有一个用途：
 * 决定 **auto-heal 的短暂提示**要不要出现 —— 真桌面（≥1024 + fine pointer，
 * DSH Desktop 本体 / 电脑浏览器）上不必打扰，手机端才需要知道布局被自救过。
 * 判定顺序（前一条命中即返回）：
 *   1. layout === 'mobile'（本次生效的是抽屉，含人强制的抽屉）→ true
 *      —— 宽屏折叠机 / Pad 强制了抽屉，也得看到提示与后续入口；
 *   2. innerWidth < 1024（与 needsNarrowDesktopConfirm 同一条线）→ true；
 *   3. coarsePointer === true（触屏手机 / 平板，即便横屏宽屏）→ true；
 *   4. 其余（真桌面）→ false。
 * 只吃纯值，不碰 DOM：调用方（mobile-apply）负责把三个值读出来当普通 prop 传下去。
 * @param {{ innerWidth?: number, coarsePointer?: boolean, layout?: string }} input
 * @returns {boolean}
 */
export function shouldShowLayoutBadge({ innerWidth, coarsePointer, layout } = {}) {
  if (normalizeLayout(layout) === 'mobile') return true
  if (needsNarrowDesktopConfirm(innerWidth)) return true
  return coarsePointer === true
}

/**
 * 纯函数：把 href 上的 dsh-layout 参数摘掉，返回新 href（没有该参数就原样返回）。
 * 布局徽章选完三态必须走这一步：URL 的优先级高于 localStorage，不摘参数的话
 * 刷新后又被 URL 压回原布局 —— 手机上「带 ?dsh-layout=desktop 的书签 / 二维码
 * 链接」就是卡死的另一种形态（localStorage 那条由 resolveLayoutMode 的 heal 兜）。
 * @param {string} href
 * @returns {string}
 */
export function stripLayoutParamFromHref(href) {
  try {
    const url = new URL(String(href))
    if (!url.searchParams.has(LAYOUT_URL_PARAM)) return String(href)
    url.searchParams.delete(LAYOUT_URL_PARAM)
    return url.toString()
  } catch {
    return String(href ?? '')
  }
}

/** 归一化任意输入为 '' | 'mobile' | 'desktop'。 */
export function normalizeLayout(value) {
  const v = String(value ?? '').trim();
  if (v === 'mobile' || v === 'desktop') return v;
  return '';
}

/**
 * 完整判定（新入口）：把 urlValue / stored / userMarked / narrowMatch / viewportWidth 分开喂进来，
 * 返回生效布局 + 来源 + 是否触发了卡死自救。纯函数，不碰 DOM / localStorage。
 *
 * @param {object} input
 * @param {string} [input.urlValue] - URL 上的 ?dsh-layout（'desktop'|'mobile'|'auto'|''）。
 * @param {string} [input.stored] - localStorage 里的值（'desktop'|'mobile'|''）。
 * @param {boolean} [input.userMarked] - 用户主动选过电脑布局（dsh-pocket.layout.user==='1'）。
 *   auto-heal 的前置条件之一：有标记就不清，那是人自己的选择。
 * @param {boolean} [input.narrowMatch] - matchMedia(NARROW_MEDIA).matches。
 * @param {number} [input.viewportWidth] - window.innerWidth（自救判据）。
 * @param {number} [input.stuckViewport] - 自救阈值（默认可注入便于测试）。
 * @returns {{ layout: ForcedLayout, source: 'url' | 'storage' | 'auto-media' | 'auto-healed', healed: boolean, stored: string }}
 */
export function resolveLayoutMode({
  urlValue,
  stored,
  userMarked,
  narrowMatch,
  viewportWidth,
  stuckViewport = PHONE_STUCK_VIEWPORT,
} = {}) {
  const url = String(urlValue ?? '').trim();
  const saved = normalizeLayout(stored);
  const narrow = narrowMatch === true;
  const width = Number(viewportWidth);
  const marked = userMarked === true;

  // URL 参数优先（用户此刻的主动行为），并且照旧持久化 —— 不做任何越权改写。
  if (url === 'desktop' || url === 'mobile') return { layout: url, source: 'url', healed: false, stored: url };
  if (url === 'auto') {
    const layout = narrow ? 'mobile' : 'desktop';
    return { layout, source: 'url', healed: false, stored: '' };
  }

  // 残留 desktop + 视口窄于官方 1024 那条线 + 人没主动选过 → 卡死：清掉旧值，本次走抽屉。
  // 用户已确认是普通直板机，所以 <1024 的 desktop 一律按残留处理（横屏 740-900 也在内）；
  // 真想要电脑布局的人在徽章/设置页里确认一次，标记落 dsh-pocket.layout.user。
  if (saved === 'desktop' && !marked && Number.isFinite(width) && width > 0 && width < stuckViewport) {
    return { layout: 'mobile', source: 'auto-healed', healed: true, stored: '' };
  }

  if (saved === 'desktop') return { layout: 'desktop', source: 'storage', healed: false, stored: saved };
  if (saved === 'mobile') return { layout: 'mobile', source: 'storage', healed: false, stored: saved };

  return { layout: narrow ? 'mobile' : 'desktop', source: 'auto-media', healed: false, stored: '' };
}

/**
 * 旧签名：只要生效布局（effectiveLayout / 老调用方还在用，别破坏）。
 * @param {{urlValue?: string, stored?: string, narrowMatch?: boolean}} input
 * @returns {ForcedLayout}
 */
export function resolveLayout(input) {
  return resolveLayoutMode(input).layout;
}

/**
 * 同步 localStorage 的副作用（在 mobileApply 入口跑一次）。返回最终存储值。
 *
 * 语义修正（重要）：**只有 URL 上真的带了参数才动 storage**。
 * 旧实现把"没有参数"也当成"清除"，于是在只有 URL 能改布局的年代无害；
 * 现在 localStorage 是用户的一等偏好（设置页三态、布局徽章、抽屉快切都写它），
 * 无参数就抹键会让"我选了电脑布局"下一次加载被自动打回 auto —— 三态开关等于失效。
 * 想显式清除请用 ?dsh-layout=auto。
 * @param {string} urlValue - URL 上的 dsh-layout（缺省 = 空串 = 不干涉）。
 */
export function persistLayoutFromUrl(urlValue) {
  if (typeof localStorage === 'undefined') return '';
  const v = String(urlValue ?? '').trim();
  try {
    if (v === 'desktop' || v === 'mobile') localStorage.setItem(LAYOUT_STORAGE_KEY, v);
    else if (v === 'auto') localStorage.removeItem(LAYOUT_STORAGE_KEY);
    // v === '' → 完全不碰：那是"用户没在地址里表态"，不是"用户要求清除"
  } catch { /* 隐私模式/无 storage → 静默 */ }
  // 地址里带 desktop = 人在 URL 上当场表态（issue #74 的链接形态），算主动选择：
  // 写 user 标记，auto-heal 之后就不会再把他切回去（否则两边永远打架）。
  // 带 mobile / auto = 主动否掉电脑布局 → 顺手清掉标记。
  try {
    if (typeof localStorage === 'undefined') return '';
    if (v === 'desktop') localStorage.setItem(LAYOUT_USER_KEY, LAYOUT_USER_VALUE);
    else if (v === 'mobile' || v === 'auto') localStorage.removeItem(LAYOUT_USER_KEY);
  } catch { /* 忽略 */ }
  try {
    const s = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return s === 'desktop' || s === 'mobile' ? s : '';
  } catch {
    return '';
  }
}

/** 读用户主动选择标记（'dsh-pocket.layout.user' === '1'）。 */
export function readLayoutUserMark() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LAYOUT_USER_KEY) === LAYOUT_USER_VALUE;
  } catch {
    return false;
  }
}

/**
 * 写/清用户主动选择标记。徽章与设置页的「电脑」走的就是它（在 <1024 上必须先过
 * 二次确认），选「自动」/「抽屉」时清掉，好让下一次的残留值还能被 heal 兜住。
 * @param {boolean} marked
 */
export function writeLayoutUserMark(marked) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (marked === true) localStorage.setItem(LAYOUT_USER_KEY, LAYOUT_USER_VALUE);
    else localStorage.removeItem(LAYOUT_USER_KEY);
  } catch { /* 忽略 */ }
}

/** 读 localStorage 当前的 layout 值（'desktop' | 'mobile' | ''）。 */
export function readStoredLayout() {
  if (typeof localStorage === 'undefined') return '';
  try {
    const v = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return v === 'desktop' || v === 'mobile' ? v : '';
  } catch {
    return '';
  }
}

/**
 * 清掉存储值（卡死自救用；本次会话仍按 mobile 走，见 resolveLayoutMode）。
 * user 标记一并清：heal 只在"没有标记"时才触发，所以这里正常情况下就是空操作，
 * 但留着孤儿标记日后会把自救永久挡住，索性一次擦干净。
 */
export function clearStoredLayout() {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch { /* 忽略 */ }
  try { localStorage.removeItem(LAYOUT_USER_KEY); } catch { /* 忽略 */ }
}

/** 自动模式的实际生效值（设置页要拿它判断"要不要刷新"）。 */
export function effectiveLayout({ stored = readStoredLayout(), narrowMatch = false } = {}) {
  return resolveLayout({ urlValue: '', stored, narrowMatch });
}

/**
 * 抽屉里的快速切换：自动 → 抽屉 → 电脑 → 自动。
 * @param {string} current - 当前存储值（'' = 自动）。
 * @returns {'' | 'mobile' | 'desktop'}
 */
export function nextLayout(current) {
  const i = LAYOUT_VALUES.indexOf(normalizeLayout(current));
  return LAYOUT_VALUES[((i < 0 ? 0 : i) + 1) % LAYOUT_VALUES.length] ?? '';
}

/**
 * 带视口感知的快切：窄于官方 1024 那条线时**跳过「电脑」这一档**（自动 ↔ 抽屉）。
 * 抽屉底部这颗钮就在抽屉里，手机用户误触两下就会把布局换成常驻 48px 图标 rail，
 * 而这一轮的前提是"普通直板机必须永远能拿到抽屉"。真想要电脑布局的人在右下角
 * 常驻徽章 / 设置页里选，那里有 <1024 的二次确认（并且会写 user 标记）。
 * @param {string} current - 当前存储值（'' = 自动）。
 * @param {number} width - window.innerWidth。
 * @returns {'' | 'mobile' | 'desktop'}
 */
export function nextLayoutOnWidth(current, width) {
  const next = nextLayout(current);
  if (next === 'desktop' && needsNarrowDesktopConfirm(width)) return '';
  return next;
}

/**
 * 设置页 / 徽章 / 抽屉底座的写入口：落 localStorage，并把 body 上的 marker 同步成
 * **实际生效**的布局（auto 时按当前屏宽解析），这样 CSS 前缀不会在刷新前
 * 就出现"JS 挂了抽屉、CSS 却不认"的半截状态。
 * @param {'' | 'mobile' | 'desktop' | 'auto'} value - 用户选择（'auto' 等价 ''）。
 * @param {object} [env] - 注入的 window / document（浏览器里跑时用默认值）。
 * @returns {'' | 'mobile' | 'desktop'} 存下的值。
 */
export function writeLayout(value, { win = globalThis.window, doc = globalThis.document } = {}) {
  const stored = normalizeLayout(value === 'auto' ? '' : value);
  if (typeof localStorage !== 'undefined') {
    try {
      if (stored === 'mobile' || stored === 'desktop') localStorage.setItem(LAYOUT_STORAGE_KEY, stored);
      else localStorage.removeItem(LAYOUT_STORAGE_KEY);
    } catch { /* 隐私模式 → 只同步本次会话的 marker */ }
  }
  // 能走到这里 = 人刚刚显式选过（徽章 / 设置页 / 抽屉快切）。所以 desktop 落 user 标记，
  // auto-heal 就不会把他刚选的东西当残留清掉；选自动或抽屉则把标记擦掉，
  // 让"下一次又冒出个没来由的 desktop"还能被自救兜住。
  // 窄屏上「电脑」这一档的二次确认由调用方先把关（needsNarrowDesktopConfirm）。
  writeLayoutUserMark(stored === 'desktop');
  const narrow = typeof win?.matchMedia === 'function'
    ? win.matchMedia(NARROW_MEDIA).matches === true
    : (typeof win?.innerWidth === 'number' && win.innerWidth < 1024)
  const effective = resolveLayout({ urlValue: '', stored, narrowMatch: narrow });
  doc?.body?.setAttribute(LAYOUT_ATTR, effective);
  return stored;
}

/** 读 body 上"当前生效"的布局值（'mobile' | 'desktop' | ''）。 */
export function readAppliedLayout(doc = globalThis.document) {
  if (doc?.body == null || typeof doc.body.getAttribute !== 'function') return '';
  const v = doc.body.getAttribute(LAYOUT_ATTR);
  return v === 'mobile' || v === 'desktop' ? v : '';
}
