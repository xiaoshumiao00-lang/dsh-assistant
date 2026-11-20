/**
 * 手机端「不自动弹输入法」闸门（2026-11-05 起，2026-11-19 收紧口径）。
 *
 * 【现象】
 *   1) 手机点进任意会话，光标立刻落进输入框，系统输入法跟着顶起来；
 *   2) 点输入框左侧那颗「＋」出命令菜单，输入法语境同时弹起来；
 *   3) 2026-11-19 在**有历史记录的会话**里点「＋」，输入法又弹了 —— 新开会话里
 *      第一次点「＋」是不弹的。
 *
 * 【根因（app.asar 取证，见 scripts/test-composer-focus-gate.mjs 的 2.6 段）】
 *   宿主 dsh-client-ui-conversation 把光标送回输入框的路子不止「挂载/切会话」那一条：
 *     - `useEffect(..., [locked, sessionId, editor]) → focusDraftEditor(editor, revealSelection)`
 *       （asar 24987689 定义 / 25018553 挂载与切会话）—— 历史会话的 `editor` 是尾快照
 *       加载完才造出来的，所以这条会在“会话早就开好了”的时刻再补一次；
 *     - 输入卡片自身的 mousedown 处理器（asar 25022700-25023287）：
 *       `target.closest("button, a, input, select, textarea, [role="button"],
 *       [contenteditable], [tabindex]")` 没命中就 `e.preventDefault()` 后
 *       `focusDraftEditor()` —— 落在工具行 / Tooltip 包层 / 胶囊容器这类**非控件容器**
 *       上，宿主就当「用户点进卡片了」；
 *     - 那颗「＋」自己（asar 25028800-25029100）：`onMouseDown: keepFocus` →
 *       `keepDraftFocus` → `editor?.getRootElement()?.focus({preventScroll:true})`，
 *       `onClick: onToggleCommandMenu` → `focusDraftEditor(...)` 又聚焦一次；
 *     - Lexical 的选区同步（asar 24613063/24613408）：`skip-selection-focus` 没设时
 *       `rootElement.focus({preventScroll:true})`，草稿恢复 / 尾快照 / 挑完命令都会走到。
 *   安卓 WebView 里 DOM focus 一落到 contenteditable 上就 `showSoftInput`，程序化聚焦
 *   不需要用户手势，键盘照弹。
 *
 * 【为什么新开会话看着是好的、历史会话就不好】
 *   hero（`sessionId === void 0`）变体的 composer 里，会话作用域那些座位全都不渲染
 *   （asar 25029886/25030098/25030589：`sessionId === void 0 ? null :
 *   renderSlot("conversation.input.permission" / "plan" / "left" / "right" / "model" / "activity")`，
 *   连 `conversation.input.dock` 的队列/目标/上行历史 chip 也是 `zone !== void 0` 才渲染，asar 24960746）。
 *   那一行于是只剩「＋」与发送钮，手指很容易命中 `button[aria-haspopup="listbox"]` 本体 →
 *   旧口径认成了「挑菜单」→ 挡。会话里那一行拥挤得多（权限/计划/模型/托管/麦克风 五个胶囊），
 *   360px 手机布局上点「＋」很容易落在按钮外面的 `_tools` 行、Tooltip 包层或某个胶囊容器上 ——
 *   旧口径把「输入区里的任意落点」都当成「要打字」，于是这一下把 1.2 s 放行窗口刷新活，
 *   上面那四条 focus 随便哪条都放行 → 键盘弹起。
 *
 * 【口径（本轮收紧）】默认全挡 + 窄白名单：
 *   只有真实落点在下列元素上才算「用户要打字」，其余一律挡（菜单落点、容器空白、
 *   胶囊、面板、区外落点都算 block 落点，谁更晚就压住谁）：
 *     - 输入框本体：`[data-composer-input]` / `[data-lexical-editor="true"]` / `[contenteditable]`；
 *     - 发送与停止那颗：`[class$="_primary"]`；
 *     - 语音输入那颗：`[data-voice-activity]` / `[class$="_activity"]`；
 *     - 输入卡片里、控件行以外的空白（`[data-composer-card]` 内且不在 `_row/_tools/_modes/
 *       _trailing/_standardControls/_dock/[data-composer-overlay]/[data-trigger-menu]` 里，
 *       也不是控件）——这条保住「点卡片空白就能打字」的原有手感。
 *   时钟不可靠（`performance.now` 倒退或读不到）一律按挡处理：用户的手指落点本来就走
 *   浏览器原生聚焦，不经过这里的补丁，被挡的只是宿主自己那几次程序化 focus。
 *
 * 只挡 `[data-composer-input]` 这一个元素（宿主 Lexical 的 contenteditable 本体）。
 * 插件自己的输入框（`[data-pocket-orb="textarea"]`）、文件选择框、搜索框、重命名框
 * 一律不碰 —— 那些地方的自动聚焦是用户按出来的，本来就该弹键盘。
 * 闸门只在窄布局（手机端）装，桌面布局不受影响（接线在 mobile-apply.tsx）。
 *
 * 【取证开关（默认关）】手机侧看不到日志，所以留了一条决策记录：把 pocket 页面的 URL 加
 *   `?composerFocusLog=1`，或 `localStorage.setItem('dsh-assistant.composerFocusLog','1')`，
 *   或 `window.__DSH_COMPOSER_FOCUS_GATE_LOG = true`，开关一开，每次聚焦判定都会走
 *   `onDecision`（mobile-apply 拿它发 `mobile-stage` 信标，落进宿主 diag.jsonl）。
 *
 * 纯判定（createComposerFocusGate）与 DOM 挂载（installComposerFocusGate）分开，
 * 单测走假 DOM 直接验「挡 / 放行 / 卸载还原」，见 scripts/test-composer-focus-gate.mjs。
 */

/** 宿主输入框本体：dsh-client-ui-conversation 的 ComposerContentEditable 渲染的 div。 */
export const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

/** 宿主给 composerSeat 打的区域标记（输入卡片 / 发送钮 / 命令菜单 / 附件都在这一棵树里）。 */
export const COMPOSER_SEAT_SELECTOR = '[data-conversation-region="composer"]'

/** 输入卡片本体；「卡片空白」这条放行判定只在这棵树里、控件行之外才成立。 */
export const COMPOSER_CARD_SELECTOR = '[data-composer-card]'

/**
 * 输入框左侧那颗「＋」（宿主 InputBar 的命令按钮，`aria-haspopup="listbox"`）。
 * 点它只开菜单，不该把输入法顶起来。
 */
export const COMPOSER_COMMAND_BUTTON_SELECTOR = 'button[aria-haspopup="listbox"]'

/** 命令菜单本体（宿主的 MenuSurface，选项行 / 面包屑都在它里面）；菜单里的点击不算要打字。 */
export const COMPOSER_MENU_SELECTOR = '[data-trigger-menu]'

/** 菜单 / 面板 / 吐司都挂在卡片里那个 0 高锚点上（`_overlayAnchor`）：那里的落点一律是挑东西，不是打字。 */
export const COMPOSER_OVERLAY_SELECTOR = '[data-composer-overlay]'

/** 真正的输入框本体：Lexical 的 contenteditable（含里面的 chip / 文本节点）。 */
export const COMPOSER_EDITOR_BODY_SELECTOR = '[data-composer-input], [data-lexical-editor="true"], [contenteditable]'

/** 白名单控件：发送 / 停止那颗，语音输入那颗。 */
export const COMPOSER_TYPING_CONTROL_SELECTOR = '[class$="_primary"], [data-voice-activity], [class$="_activity"]'

/** 控件行与容器区：「＋」所在的 _tools、权限/计划的 _modes、模型/发送的 _trailing/_standardControls、_row、会话 dock chips。 */
export const COMPOSER_BLOCK_AREA_SELECTOR = [
  '[class$="_tools"]',
  '[class$="_modes"]',
  '[class$="_trailing"]',
  '[class$="_standardControls"]',
  '[class$="_row"]',
  '[class$="_dock"]',
  // slot 渲染层自己写的锚点 div（app.asar 26818562：`"data-slot": slotKey`），
  // 会话作用域的那几颗胶囊与 chip 都在这里，不写出来就只能靠按钮本体命中控件列表。
  // 注意「conversation.input.activity」不在这一列里：语音那颗算打字意图（白名单先判）。
  '[data-slot="conversation.input.dock"]',
  '[data-slot="conversation.composer.dock"]',
  '[data-slot="conversation.input.permission"]',
  '[data-slot="conversation.input.plan"]',
  '[data-slot="conversation.input.model"]',
  '[data-slot="conversation.input.left"]',
  '[data-slot="conversation.input.right"]',
  '[data-slot="conversation.input.attachments"]',
].join(', ')

/** 宿主自己认定「不是要打字」的那一撮控件（照抄 app.asar 25022700 的 closest 列表，contenteditable 由本体那条放行）。 */
export const COMPOSER_CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]'

/**
 * 「点过输入框」之后多久内的程序化聚焦仍算用户主动。
 * 发送后回填光标、按钮 mousedown 保焦点都发生在几毫秒内；1.2 s 足够宽，
 * 又不会宽到「点一下输入框、再切个会话」还被当成用户在打字。
 * 放行窗口只由「白名单落点」开启，任何 block 落点（菜单 / 容器 / 区外）都压过它。
 */
export const SEAT_GRACE_MS = 1200

/** 落点意图：只有 'typing' 会开启放行窗口，其余三种一律算 block 落点。 */
export type ComposerTapKind = 'typing' | 'menu' | 'other' | 'outside'

/** 判定快照（单测 / 诊断用）。 */
export interface ComposerGateSnapshot {
  lastTypingTapAt: number | null
  lastBlockTapAt: number | null
  graceMs: number
}

/**
 * 纯判定：没有 DOM、没有时钟，now 由调用方给（performance.now 标度）。
 * 默认全挡：只有最近一次 'typing' 落点（输入框本体 / 卡片空白 / 发送钮 / 麦克风）
 * 之后的那次聚焦才放行，且必须比最近一次 block 落点更晚、且还在窗口内。
 */
export interface ComposerFocusGate {
  /** 记一次落点意图。区外落点也记账：换会话那一下不该借到上一次打字的放行窗口。 */
  notePointer(kind: ComposerTapKind, now: number): void
  /** now 时刻的这一次程序化聚焦要不要挡。 */
  shouldBlock(now: number): boolean
  inspect(): ComposerGateSnapshot
}

/**
 * @param graceMs - 放行窗口，非法值回落成 SEAT_GRACE_MS。
 * @returns 判定器。
 */
export function createComposerFocusGate(graceMs: number = SEAT_GRACE_MS): ComposerFocusGate {
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : SEAT_GRACE_MS
  let lastTypingTapAt: number | null = null
  let lastBlockTapAt: number | null = null
  return {
    notePointer(kind: ComposerTapKind, now: number): void {
      if (!Number.isFinite(now)) return
      if (kind === 'typing') {
        lastTypingTapAt = now
        return
      }
      lastBlockTapAt = now
    },
    shouldBlock(now: number): boolean {
      if (!Number.isFinite(now)) return true
      if (lastTypingTapAt === null) return true
      // 谁更晚听谁的：菜单 / 容器 / 区外落点比输入落点更晚 → 这一次聚焦是顺手带出来的，挡。
      if (lastBlockTapAt !== null && lastBlockTapAt >= lastTypingTapAt) return true
      const elapsed = now - lastTypingTapAt
      // 时钟倒退（页面被挂起过、或读不到 performance.now）一律挡：
      // 用户真要点输入框，浏览器自己就会把焦点给过去，不经过这里。
      if (elapsed < 0) return true
      return elapsed > grace
    },
    inspect(): ComposerGateSnapshot {
      return { lastTypingTapAt, lastBlockTapAt, graceMs: grace }
    },
  }
}

/** 挂在 prototype 上的幂等标记：同一页面重复 install 只装一次。 */
const INSTALLED_KEY = '__dshAssistantComposerFocusGate'

/** 决策日志开关：URL query / localStorage / window 全局，三处任一为真就开。 */
export const COMPOSER_FOCUS_LOG_QUERY = 'composerFocusLog'
export const COMPOSER_FOCUS_LOG_STORAGE = 'dsh-assistant.composerFocusLog'
export const COMPOSER_FOCUS_LOG_WINDOW_FLAG = '__DSH_COMPOSER_FOCUS_GATE_LOG'

/** 一次判定记录（取证用）。 */
export interface ComposerFocusDecision {
  /** 判定发生的时刻。 */
  at: number
  /** 最近一次落点的意图。 */
  kind: ComposerTapKind
  /** 为什么算这类落点（白名单里的哪一条）。 */
  reason: string
  /** 这一次程序化聚焦到底挡没挡。 */
  blocked: boolean
  /** 落点摘要：tag.class[attr] 形式，短字段纪律。 */
  target: string
  /** 挡下的次数（累计）。 */
  count: number
}

/** 安装器可注入的依赖（单测传假 DOM；真机全部走默认值）。 */
export interface ComposerFocusGateHost {
  /** 默认 document。 */
  document?: Document | null
  /** 默认 performance.now（拿不到回落 Date.now）。 */
  now?: () => number
  /** 挡下时的回调（mobile-apply 拿它发一条诊断 beacon，便于在手机上远程确认生效）。 */
  onBlocked?: (count: number, decision: ComposerFocusDecision) => void
  /** 决策记录回调：只有开关打开（见文件顶部的取证开关）才会被调，放行与挡下都报。 */
  onDecision?: (decision: ComposerFocusDecision) => void
}

/**
 * 把「不是用户点进输入框」的程序化聚焦挡在宿主的 contenteditable 之外。
 * @param host - 可注入的 document / 时钟 / 打点回调。
 * @returns 卸载函数：还原 prototype.focus、摘掉 pointerdown 监听。
 */
export function installComposerFocusGate(host: ComposerFocusGateHost = {}): () => void {
  const doc = host.document ?? (typeof document === 'undefined' ? null : document)
  const view = (doc as Document | null)?.defaultView ?? (typeof window === 'undefined' ? null : window)
  const HTMLElementCtor = (view as unknown as { HTMLElement?: typeof HTMLElement } | null)?.HTMLElement
  const proto = HTMLElementCtor?.prototype as (HTMLElement & Record<string, unknown>) | undefined
  if (doc === null || proto === undefined || typeof proto.focus !== 'function') return () => {}
  if (proto[INSTALLED_KEY] === true) return () => {}

  const gate = createComposerFocusGate()
  const clock = host.now ?? ((): number => {
    try {
      const perf = (view as unknown as { performance?: { now?: () => number } } | null)?.performance
      if (typeof perf?.now === 'function') return perf.now()
    } catch {
      /* 老 WebView 的 performance 不可用 → 回落 Date.now */
    }
    return Date.now()
  })

  /** 取证开关：默认关，只在 URL 带 ?composerFocusLog=1 / localStorage 设了 / window 置了 时开。 */
  const logEnabled = (): boolean => {
    try {
      const win = view as (Window & Record<string, unknown>) | null
      if (win?.[COMPOSER_FOCUS_LOG_WINDOW_FLAG] === true) return true
      if (String(win?.location?.href ?? '').includes(`${COMPOSER_FOCUS_LOG_QUERY}=1`)) return true
      const stored = String((win as unknown as { localStorage?: { getItem(key: string): unknown } } | null)
        ?.localStorage?.getItem(COMPOSER_FOCUS_LOG_STORAGE) ?? '')
      return stored === '1' || stored === 'true'
    } catch {
      return false
    }
  }

  const originalFocus = proto.focus
  let blocked = 0
  let lastTap: { kind: ComposerTapKind; reason: string; target: string } = {
    kind: 'outside',
    reason: 'no-tap',
    target: '',
  }

  /** 落点元素（文本节点没有 `closest`，从 parentElement 起）。 */
  const elementOf = (event: Event): Element | null => {
    const target = event.target as (Element | (Node & { parentElement?: Element | null }) | null)
    if (target !== null && typeof (target as Element).closest === 'function') return target as Element
    const parent = (target as (Node & { parentElement?: Element | null }) | null)?.parentElement
    return typeof (parent as Element | null)?.closest === 'function' ? (parent as Element) : null
  }

  /** 落点摘要：只留 tag + 类名 + 少数 data-* 键，够在手机上分得清是哪一片被点。 */
  const describe = (el: Element | null): string => {
    if (el === null) return ''
    const tag = String((el as Element).tagName ?? '').toLowerCase()
    const cls = String((el as Element).getAttribute?.('class') ?? '')
    const keys = (() => {
      try {
        return Object.keys((el as Element & { dataset?: Record<string, unknown> }).dataset ?? {}).slice(0, 3)
      } catch {
        return []
      }
    })()
    return `${tag}.${cls.slice(0, 24)}[${keys.join(',')}]`
  }

  /** 这一次落点的意图：默认 'other'，只有白名单里的落点才算 'typing'。 */
  const classifyTap = (event: Event): { kind: ComposerTapKind; reason: string } => {
    const el = elementOf(event)
    if (el === null) return { kind: 'outside', reason: 'no-target' }
    const hits = (selector: string): boolean => {
      try {
        return el.closest(selector) !== null
      } catch {
        return false
      }
    }
    if (!hits(COMPOSER_SEAT_SELECTOR)) return { kind: 'outside', reason: 'out-of-seat' }
    if (hits(COMPOSER_MENU_SELECTOR)) return { kind: 'menu', reason: 'menu-item' }
    if (hits(COMPOSER_COMMAND_BUTTON_SELECTOR)) return { kind: 'menu', reason: 'command-button' }
    if (hits(COMPOSER_OVERLAY_SELECTOR)) return { kind: 'menu', reason: 'composer-overlay' }
    if (hits(COMPOSER_EDITOR_BODY_SELECTOR)) return { kind: 'typing', reason: 'editor-body' }
    if (hits(COMPOSER_TYPING_CONTROL_SELECTOR)) return { kind: 'typing', reason: 'typing-control' }
    if (hits(COMPOSER_BLOCK_AREA_SELECTOR)) return { kind: 'other', reason: 'controls-area' }
    if (hits(COMPOSER_CONTROL_SELECTOR)) return { kind: 'other', reason: 'control' }
    if (hits(COMPOSER_CARD_SELECTOR)) return { kind: 'typing', reason: 'card-whitespace' }
    return { kind: 'other', reason: 'seat-not-card' }
  }

  const onPointerDown = (event: Event): void => {
    const { kind, reason } = classifyTap(event)
    lastTap = { kind, reason, target: describe(elementOf(event)) }
    gate.notePointer(kind, clock())
  }

  const report = (decision: ComposerFocusDecision): void => {
    if (!logEnabled()) return
    try {
      host.onDecision?.(decision)
    } catch {
      /* 取证不能反过来打断闸门 */
    }
  }

  const patchedFocus = function focus(this: HTMLElement, ...args: unknown[]): void {
    let isComposer = false
    try {
      isComposer = HTMLElementCtor !== undefined
        && this instanceof HTMLElementCtor
        && typeof this.matches === 'function'
        && this.matches(COMPOSER_INPUT_SELECTOR)
    } catch {
      /* 判据异常按放行处理：宁可弹键盘，也不能把聚焦弄坏 */
      isComposer = false
    }
    if (isComposer) {
      const at = clock()
      const shouldBlockNow = gate.shouldBlock(at)
      if (shouldBlockNow) {
        blocked += 1
        const decision: ComposerFocusDecision = {
          at,
          kind: lastTap.kind,
          reason: lastTap.reason,
          blocked: true,
          target: lastTap.target,
          count: blocked,
        }
        report(decision)
        // 每条都发 beacon 会刷爆 diag：第 1 次 + 之后每 30 次一条，够证明「真的挡了」。
        if (blocked === 1 || blocked % 30 === 0) {
          try {
            host.onBlocked?.(blocked, decision)
          } catch {
            /* 打点失败不影响挡 */
          }
        }
        return
      }
      report({ at, kind: lastTap.kind, reason: lastTap.reason, blocked: false, target: lastTap.target, count: blocked })
    }
    originalFocus.apply(this, args)
  }

  proto.focus = patchedFocus as unknown as HTMLElement['focus']
  proto[INSTALLED_KEY] = true
  // pointerdown 是主路；老 WebView 没有 PointerEvent 时靠 touchstart 兜底
  // （两者都收到也只是写同一个时间戳，无副作用）。
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  doc.addEventListener('touchstart', onPointerDown, { capture: true, passive: true })

  return (): void => {
    try {
      if (proto.focus === patchedFocus) proto.focus = originalFocus
    } catch {
      /* 原型被别的脚本再次包装过 → 不硬还原，避免把别人的补丁抹掉 */
    }
    try {
      delete proto[INSTALLED_KEY]
    } catch {
      /* ignore */
    }
    try {
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('touchstart', onPointerDown, true)
    } catch {
      /* ignore */
    }
  }
}
