// 组合（含手机输入法的实时语音转写）期间的「输入框 DOM 变更账本」。
//
// 现象：手机上语音说半句就自己停，且**时好时坏**、换个会话又正常——典型的中断竞争：
// 组合进行中有人改了输入框那一棵树的 DOM（宿主重投影 / 插件补丁 / 布局变化），
// 安卓输入法的 InputConnection 当场被判失效，实时转写就断了。
//
// 本模块只做取证：组合期间观察 [data-composer-card] 子树，记下变更的签名与毫秒偏移，
// 并判断两件最关键的事——变更有没有落进编辑器本体、编辑器本体有没有被换掉/脱离文档。
// 全程只读：不改任何 DOM、不发网络（上报由调用方决定）。
//
// 成本边界：只在组合进行时挂观察者（几百毫秒到几十秒、几十个节点），组合一结束立刻断开。

/** 一次组合的现场摘要（给诊断流水用，字段都压短）。 */
export interface LedgerSummary {
  /** 去重后最多 cap 条：「12ms kids div.editor +span」。 */
  muts: string[]
  /** 是否有变更落进编辑器本体（Lexical 的 contenteditable）——最可疑的一类。 */
  touched: boolean
  /** 编辑器本体在组合期间被换掉或脱离文档——几乎必然中断输入法会话。 */
  replaced: boolean
  /** 组合开始时宿主把 [data-phase] 改掉了（hero → 普通）——整页重排的经典时机。 */
  phaseChanged: boolean
  /** 组合开始时的 data-phase（hero / 普通）。 */
  phase: string
}

const CARD_SELECTOR = '[data-composer-card]'
const EDITOR_SELECTOR = '[data-lexical-editor="true"], [contenteditable="true"]'
/** 宿主切换「新建页 → 普通会话」时改的就是这两个属性。 */
const PHASE_ATTRS = ['data-phase', 'data-content-phase']
/** 最多记这么多条（去重后）：再多的细节上报里也放不下。 */
export const LEDGER_CAP = 8
const MAX_PIECE = 48

/** 压短一段文字（诊断字段纪律：短、UTF-16 截断不留半截代理对风险由调用方兜底）。 */
export function clip(value: string, max: number = MAX_PIECE): string {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 节点的短标签：标签名 + 第一个 class（CSS-module 的哈希前缀正好是排查时最需要的那段）。 */
export function nodeLabel(node: any): string {
  if (node === null || node === undefined) return '?'
  const name = String(node.nodeName ?? node.name ?? '?').toLowerCase()
  let cls = ''
  try {
    cls = typeof node.getAttribute === 'function' ? String(node.getAttribute('class') ?? '') : ''
  } catch {
    cls = ''
  }
  if (cls === '') return clip(name, 24)
  return clip(`${name}.${String(cls).split(/\s+/)[0]}`, 32)
}

function containsAny(root: any, node: any): boolean {
  if (root === null || root === undefined || node === null || node === undefined) return false
  if (root === node) return true
  try {
    return typeof root.contains === 'function' ? root.contains(node) === true : false
  } catch {
    return false
  }
}

/**
 * 造一个输入框变更账本。
 * @param options.doc - 注入的 document（测试用）。
 * @param options.clock - 注入的时钟（测试用）。
 * @param options.Observer - 注入的 MutationObserver 构造器（测试用）。
 * @param options.cap - 最多记几条。
 * @returns start / stop / active：start 幂等，stop 断开并给出摘要。
 */
export function createComposerLedger(options: {
  doc?: any
  clock?: () => number
  Observer?: any
  cap?: number
  cardSelector?: string
  editorSelector?: string
} = {}): { start: () => void; stop: () => LedgerSummary; active: () => boolean } {
  const doc = options.doc ?? (globalThis as any).document
  const clock = options.clock ?? (() => Date.now())
  const Observer = options.Observer ?? (globalThis as any).MutationObserver
  const cardSelector = options.cardSelector ?? CARD_SELECTOR
  const editorSelector = options.editorSelector ?? EDITOR_SELECTOR
  const cap = options.cap ?? LEDGER_CAP
  let startedAt = 0
  let phase = ''
  let card: any = null
  let editor: any = null
  let host: any = null
  let observer: any = null
  let hostObserver: any = null
  const seen = new Set<string>()
  const muts: string[] = []
  let touched = false
  let phaseChanged = false

  const signatureOf = (record: any): string => {
    const type = String(record?.type ?? '')
    if (type === 'attributes') {
      return `attr ${nodeLabel(record?.target)} ${clip(String(record?.attributeName ?? ''), 16)}`
    }
    if (type === 'characterData') {
      return `text ${nodeLabel(record?.target?.parentElement ?? record?.target)}`
    }
    const parts: string[] = []
    const added = record?.addedNodes ?? []
    const removed = record?.removedNodes ?? []
    for (let i = 0; i < added.length && i < 3; i += 1) parts.push(`+${nodeLabel(added[i])}`)
    for (let i = 0; i < removed.length && i < 3; i += 1) parts.push(`-${nodeLabel(removed[i])}`)
    return `kids ${nodeLabel(record?.target)} ${parts.join(' ')}`
  }

  const onRecords = (records: any): void => {
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (record?.type === 'attributes' && PHASE_ATTRS.includes(String(record?.attributeName ?? ''))) {
        phaseChanged = true
      }
      if (muts.length >= cap) continue
      const signature = signatureOf(record)
      if (seen.has(signature)) continue
      seen.add(signature)
      const ms = Math.max(0, Math.round(clock() - startedAt))
      muts.push(`${ms}ms ${clip(signature, 64)}`)
      if (!touched && containsAny(editor, record?.target)) touched = true
    }
  }

  const start = (): void => {
    if (observer !== null) return
    if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return
    try {
      card = doc.querySelector(cardSelector)
      editor = doc.querySelector(editorSelector)
    } catch {
      card = null
      editor = null
    }
    if (card === null || card === undefined) return
    startedAt = clock()
    phase = ''
    phaseChanged = false
    try {
      host = card.closest?.('[data-phase]') ?? null
      phase = clip(String(host?.getAttribute?.('data-phase') ?? ''), 16)
    } catch {
      host = null
      phase = ''
    }
    if (typeof Observer !== 'function') return
    try {
      observer = new Observer(onRecords)
      observer.observe(card, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'data-phase', 'aria-hidden'],
        characterData: true,
      })
      // 宿主的 phase 翻转发生在祖先上（hero → 普通）：整页重排的经典时机，必须记下来。
      if (host !== null && host !== undefined) {
        hostObserver = new Observer(onRecords)
        hostObserver.observe(host, { attributes: true, attributeFilter: PHASE_ATTRS })
      }
    } catch {
      observer = null
      hostObserver = null
    }
  }

  const stop = (): LedgerSummary => {
    const replaced = editor !== null && editor !== undefined
      ? editor.isConnected === false || ((): boolean => {
        try {
          return doc.querySelector(editorSelector) !== editor
        } catch {
          return false
        }
      })()
      : false
    if (observer !== null) {
      try { observer.disconnect() } catch { /* 断不掉也不影响结论 */ }
      observer = null
    }
    if (hostObserver !== null) {
      try { hostObserver.disconnect() } catch { /* 同上 */ }
      hostObserver = null
    }
    const summary: LedgerSummary = { muts: muts.slice(), touched, replaced, phaseChanged, phase }
    // 下一次组合重新记账（同样的签名在新一轮里依然有诊断价值）。
    muts.length = 0
    seen.clear()
    touched = false
    phaseChanged = false
    card = null
    editor = null
    host = null
    return summary
  }

  const active = (): boolean => observer !== null

  return { start, stop, active }
}
