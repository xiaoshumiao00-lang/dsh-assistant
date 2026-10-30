/**
 * 一次性首启引导（P0-6）：三屏说清「悬浮球是干什么的 / 单击与长按的区别 / 记忆在哪看怎么删」。
 *
 * 实现选择：纯 DOM 覆盖层（不是 React 槽位）——引导只在第一次用得上，
 * 用 DOM 挂载入点能从设置页「重新看一遍」直接调起，不必和宿主槽位注册顺序较劲。
 * 文案集中在 zh / en 字典里（不在组件里硬编码），语言按 <html lang> 与 navigator.language 判定。
 *
 * 状态存在 localStorage：dsh.assistant.firstRunGuide.v1
 *   'never'（没显示过，会自动弹一次）→ 'seen'（走完三屏）| 'skipped'（后一跳）
 * 从设置页「重新看一遍」不会改状态，只是强制显示一次。
 */

export const GUIDE_STATE_KEY = 'dsh.assistant.firstRunGuide.v1'
export type GuideStatus = 'never' | 'seen' | 'skipped'

export type GuideText = {
  id: string
  title: string
  body: string[]
  primary: string
  secondary: string
  skip: string
}

export type GuideScreenSet = { lang: 'zh' | 'en'; screens: GuideText[] }

const ZH: GuideText[] = [
  {
    id: 'orb',
    title: '这个悬浮球是干什么的',
    body: [
      '球 = 你的助手入口，不是聊天窗。它背后是同一个常驻会话（家目录 ~/.dsh/assistant）。',
      '会话里有固定人设（AGENTS.md）、按天日志（journal/）、长期档案（notes/）、杂物间（outputs/）。',
      '长按 600ms 或 Ctrl+Alt+A 才是找助手做事；单击球只是开控制室。',
    ],
    primary: '下一步', secondary: '后一跳', skip: '关闭',
  },
  {
    id: 'click',
    title: '单击球 = 控制室，长按球 = 助手',
    body: [
      '单击：控制室（项目卡片、会话、模板流程、新建会话）。',
      '长按 600ms：直接进助手会话；控制室顶栏也有「🤖 私人助手」按钮，网页地址加 ?assistant=chat 也能直达。',
      '助手在控制室里就是一张普通项目卡（排在最前）；你删了它不会再自动重建（尊重你的删除）。',
    ],
    primary: '下一步', secondary: '后一跳', skip: '关闭',
  },
  {
    id: 'memory',
    title: '它记下了什么，在哪看、怎么删',
    body: [
      '记忆分两侧：USER.md（他是谁、偏好、雷区）与 MEMORY.md（项目与环境的硬事实），每轮自动注入。',
      '看与删都在这里：设置页 → 个人助手 → 「🧠 它记下了什么」。逐条删除、整侧清空、导出 .md。',
      '删之前一定先备份；这些是宿主进程负责的文件，所以删完要重启 DSH Desktop 才生效（面板自己会讲清楚）。',
    ],
    primary: '开始用', secondary: '后一跳', skip: '关闭',
  },
]

const EN: GuideText[] = [
  {
    id: 'orb',
    title: 'What the floating ball is for',
    body: [
      'The ball is your assistant entry point, not a chat window. Behind it sits one resident session (home directory ~/.dsh/assistant).',
      'That session has a fixed persona (AGENTS.md), a per-day log (journal/), long-term notes (notes/) and a scratch bin (outputs/).',
      'Press and hold 600ms (or Ctrl+Alt+A) to work with the assistant; a plain click just opens the control room.',
    ],
    primary: 'Next', secondary: 'Do it later', skip: 'Close',
  },
  {
    id: 'click',
    title: 'Click = control room, press and hold = assistant',
    body: [
      'Click: control room (project cards, sessions, template flows, new session).',
      'Press and hold 600ms: straight into the assistant session. The control room top bar has a "🤖 Private assistant" button, and ?assistant=chat in the address bar goes there directly.',
      'In the control room the assistant is just a normal project card (first in the list). If you delete it, it will not be rebuilt (your delete is respected).',
    ],
    primary: 'Next', secondary: 'Do it later', skip: 'Close',
  },
  {
    id: 'memory',
    title: 'What it remembers, where to look, how to delete',
    body: [
      'Two sides: USER.md (who you are, preferences, landmines) and MEMORY.md (hard facts about projects and environment). Both are injected every turn.',
      'Look and delete in the same place: Settings -> Personal assistant -> "What it remembered" panel. Per-entry delete, clear one side, export .md.',
      'Deletion always backs the files up first. Those are host-owned files, so restart DSH Desktop for the change to take effect (the panel says so).',
    ],
    primary: 'Start using it', secondary: 'Do it later', skip: 'Close',
  },
]

function detectLang(): 'zh' | 'en' {
  try {
    const htmlLang = String(globalThis.document?.documentElement?.lang ?? '').trim().toLowerCase()
    if (htmlLang) return htmlLang.startsWith('zh') ? 'zh' : 'en'
  } catch { /* 非浏览器环境 */ }
  try {
    const nav = String(globalThis.navigator?.language ?? '').toLowerCase()
    if (nav) return nav.startsWith('zh') ? 'zh' : 'en'
  } catch { /* 非浏览器环境 */ }
  return 'zh'
}

/** 三屏文案（按语言）。测试与设置页都从这个出口拿。 */
export function guideScreens(lang: 'zh' | 'en' = detectLang()): GuideScreenSet {
  return { lang, screens: lang === 'en' ? EN : ZH }
}

function localStore(): { get: (key: string) => string; set: (key: string, value: string) => void; remove: (key: string) => void } | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return {
      get: (key) => { try { return String(localStorage.getItem(key) ?? '') } catch { return '' } },
      set: (key, value) => { try { localStorage.setItem(key, value) } catch { /* 隐私模式 / 配额满了 */ } },
      remove: (key) => { try { localStorage.removeItem(key) } catch { /* 同上 */ } },
    }
  } catch { return null }
}

/** 引导状态。没写入过一律 'never'（不认识的值也当没显示过，不猜）。 */
export function guideStatus(): GuideStatus {
  const raw = localStore()?.get(GUIDE_STATE_KEY) ?? ''
  return raw === 'seen' || raw === 'skipped' ? raw : 'never'
}

/** 该不该自动弹：只有第一次（状态 'never'）会弹，弹过就不再自动弹。 */
export function shouldAutoShow(status: GuideStatus = guideStatus()): boolean {
  return status === 'never'
}

export function markGuideSeen(): GuideStatus {
  localStore()?.set(GUIDE_STATE_KEY, 'seen')
  return 'seen'
}

export function markGuideSkipped(): GuideStatus {
  localStore()?.set(GUIDE_STATE_KEY, 'skipped')
  return 'skipped'
}

/** 设置页「重新看一遍」前调：清掉状态，让下一次能再自动弹一次。 */
export function resetGuideStatus(): void {
  localStore()?.remove(GUIDE_STATE_KEY)
}

/* ---------------- DOM 覆盖层（浏览器环境） ---------------- */

const ZINDEX = 2147483000

function el(tag: string, style: Record<string, string>, cls = ''): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  Object.assign(node.style, style)
  return node
}

/**
 * 显示引导。返回一个关闭函数。
 * @param opts.auto  自动弹（决定「后一跳」写不写状态）；从设置页手动调起时 auto = false
 */
export function showFirstRunGuide(opts: { auto?: boolean } = {}): () => void {
  if (typeof document === 'undefined') return () => void 0
  const set = guideScreens()
  let index = 0

  const mask = el('div', {
    position: 'fixed', inset: '0', background: 'rgba(15,17,20,.55)', zIndex: String(ZINDEX),
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px',
  }, 'dsh-assistant-guide-mask')
  mask.setAttribute('data-dsh-assistant-guide', 'mask')

  const box = el('div', {
    maxWidth: '520px', width: '100%', background: 'var(--dsw-alias-bg-layer-1, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: '14px',
    padding: '18px 20px', boxShadow: '0 18px 48px rgba(0,0,0,.28)', color: 'var(--dsw-alias-label-primary, inherit)',
  }, 'dsh-assistant-guide-box')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('data-dsh-assistant-guide', 'box')

  const head = el('div', { fontSize: '15px', fontWeight: '600', lineHeight: '1.4' })
  const stepLine = el('div', { fontSize: '12px', opacity: '.65', margin: '4px 0 10px' })
  const bodyWrap = el('div', { fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap' })
  const actions = el('div', { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' })
  const primary = el('button', {
    border: '0', borderRadius: '9px', padding: '8px 14px', cursor: 'pointer', font: 'inherit', fontSize: '13px',
    background: 'var(--dsw-alias-state-accent-primary, #4f8ef7)', color: '#fff',
  })
  primary.type = 'button'
  const later = el('button', {
    border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: '9px', padding: '8px 12px',
    cursor: 'pointer', font: 'inherit', fontSize: '13px', background: 'transparent', color: 'inherit',
  })
  later.type = 'button'
  const dots = el('div', { marginLeft: 'auto', fontSize: '12px', opacity: '.6' })

  const close = (): void => {
    try { mask.remove() } catch { /* 已经不在 DOM 里 */ }
  }

  const render = (): void => {
    const screen = set.screens[index]
    if (!screen) { close(); return }
    head.textContent = screen.title
    stepLine.textContent = `${index + 1} / ${set.screens.length}`
    bodyWrap.textContent = screen.body.join('\n')
    primary.textContent = screen.primary
    later.textContent = screen.secondary
    dots.textContent = set.lang === 'en' ? `Language: ${set.lang}` : ''
    box.replaceChildren(head, stepLine, bodyWrap, actions, skip)
    actions.replaceChildren(primary, later, dots)
  }

  primary.onclick = () => {
    if (index >= set.screens.length - 1) {
      markGuideSeen()
      close()
      return
    }
    index += 1
    render()
  }
  later.onclick = () => {
    if (opts.auto !== false) markGuideSkipped()
    close()
  }

  const skip = el('button', {
    position: 'absolute', top: '8px', right: '10px', border: '0', background: 'transparent',
    color: 'inherit', opacity: '.6', cursor: 'pointer', font: 'inherit', fontSize: '15px',
  })
  skip.type = 'button'
  skip.setAttribute('aria-label', 'close')
  skip.textContent = '×'
  skip.onclick = () => {
    if (opts.auto !== false) markGuideSkipped()
    close()
  }

  box.style.position = 'relative'
  render()
  mask.appendChild(box)
  mask.onclick = (event) => { if (event.target === mask) { if (opts.auto !== false) markGuideSkipped(); close() } }
  document.body.appendChild(mask)

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (opts.auto !== false) markGuideSkipped()
      close()
    }
  }
  document.addEventListener('keydown', onKey)
  return close
}
