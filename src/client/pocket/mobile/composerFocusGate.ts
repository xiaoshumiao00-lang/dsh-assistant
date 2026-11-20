/**
 * 手机端「不自动弹输入法」闸门（2026-11-05 起，2026-11-20 定稿口径）。
 *
 * 【现象】
 *   1) 手机点进任意会话，光标立刻落进输入框，系统输入法跟着顶起来；
 *   2) 点输入框左侧那颗「＋」出命令菜单（添加 / 指令 / 电脑文件 / 文件 / 反馈 /
 *      压缩 / 权限 / 模型 / 下载日志），输入法同时弹起来；
 *   3) 0.2.33 与 0.2.34 两轮「挡 focus()」都修不掉 —— 用户实测 0.2.34 仍然弹。
 *
 * 【宿主代码（活代码取证：profile node_modules 里 @deepseek-ai/dsh-client-ui-conversation
 *  /lib/client.js，2026-10-27 构建，未压缩，与 app.asar 同源）】
 *   - focusDraftEditor(editor, reveal) → `editor.getRootElement()?.focus({preventScroll:true})`
 *     再 `editor.focus(cb)`（lib 716067）；
 *   - keepDraftFocus(event, editor) → `event.preventDefault()` 后同样 focus 一次（lib 719256）；
 *   - 「＋」按钮：`onMouseDown: keepFocus`、`onClick: onToggleCommandMenu`（lib ~751516），
 *     onToggleCommandMenu 里先 focusDraftEditor 再 toggleCommandMenu(caretSpan())；
 *   - 输入卡片 onMouseDown：落点不是控件、也不在 overlay / scrollport 里时
 *     `e.preventDefault()` + focusDraftEditor（同上）；
 *   - `[data-composer-input]` 就是 Lexical 的 contenteditable 本体
 *     （ComposerContentEditable.tsx:46），DOM focus 一落上去，安卓 WebView 就 showSoftInput。
 *
 * 【为什么「挡 focus()」两轮都没修好（Chromium 真页面实测，不是猜）】
 *   用 Playwright（Chrome 156 / 390×844 / 触屏）打开真实 pocket 页面、进一条有历史记录的会话，
 *   给 HTMLElement.prototype.focus / Selection.* / mousedown / focusin 都挂了探针：
 *     · 点「＋」时宿主确实调了三次 focus({preventScroll:true})（mousedown 一次、click 两次），
 *       全被闸门挡掉，且没有任何 Selection.* 调用、activeElement 始终是 body；
 *     · 也就是说：**闸门挡的那条路本来就没让键盘弹起来**。真正弹键盘的前提是输入框在点「＋」
 *       之前就已经持有 DOM 焦点 —— 宿主所有工具按钮的 mousedown 都 `preventDefault()` 把焦点
 *       锁在输入框里（keepDraftFocus 的设计目的），用户先前点过输入框 / 打过一个字之后，
 *       输入框一直是 activeElement；安卓把输入法收起来（返回键）之后，下一次手势落下时
 *       WebView 会把仍然聚焦着的 contenteditable 的 IME 重新顶起来。挡「新聚焦」与
 *       「已有焦点」互不相干，所以 0.2.33/0.2.34 都白挡。
 *     · 同一份探针里把输入框 blur 掉再点「＋」：activeElement=body、命令菜单 5 行全在，
 *       1.6 s 后仍然开着（菜单不依赖焦点，吃的是 caretSpan() 那一刻的草稿坐标）；
 *       之后再点输入框、打字、发送都正常。
 *
 * 【口径（本轮定稿）】
 *   A. 默认不聚焦 + 窄白名单：只有真实落点在输入框本体（`[data-composer-input]` /
 *      `[data-lexical-editor]` / `[contenteditable]`）、卡片控件行以外的空白、发送/停止那颗、
 *      语音那颗，才算「用户要打字」；落在「＋」本体与它所在的整组工具按钮（权限 / 计划 / 模型 /
 *      托管胶囊、Tooltip 包层、_tools / _modes / _trailing / _standardControls / _row、
 *      命令菜单与电脑文件面板所在的 `[data-composer-overlay]`、`[data-trigger-menu]` 选项行、
 *      dock chips）或输入区之外（换会话、侧栏、悬浮球）一律是「挑东西」的落点。
 *      「工具按钮那一组」不再只靠 _x 类名后缀认：**谁在 DOM 里包着那颗「＋」，谁就是工具按钮组**
 *      （宿主换类名哈希也照样认得出来）。
 *   B. 面板类落点把「已有焦点」收掉：pointerdown 那一刻如果输入框正持有焦点 → blur。
 *      安卓上「不聚焦」才真等于「不弹输入法」，而且点「＋」出面板本来就不该继续挂着一个
 *      会被手势重新顶起来的输入框（微信也是这个手感）。
 *   C. 兜底反聚焦：任何**不经过 `.focus()`** 的聚焦（Lexical 的选区副作用 `setBaseAndExtent`、
 *      宿主在别处直接摸 activeElement）都会走 focusin，闸门在 focusin 捕获阶段再 blur 一次；
 *      `HTMLElement.prototype.focus` 的拦截保留（少一次闪一下的聚焦）。
 *   D. 用户手指点输入框本体走的是浏览器原生聚焦，不经过这里，照常弹键盘、照常打字。
 *
 * 【真机取证】手机上看不到日志，所以留了两条信标（`~/.dsh/dsh-pocket/diagnostic.jsonl`
 *  的 mobile-stage）：
 *   · `composer-focus-blocked` / `composer-focus-blurred`：挡下 / 收掉焦点的次数；
 *   · `composer-ime-open`：visualViewport 高度阶跃下跌 > 120px（= 输入法真的弹了）时报一条，
 *    带当时的 activeElement 摘要与最近一次落点意图 —— 下次再复发，直接看这条就知道
 *     是哪条路把键盘顶起来的（每次页面最多 3 条）。
 *  详细判定日志仍可开：URL 加 `?composerFocusLog=1` / localStorage
 *  `dsh-assistant.composerFocusLog` = '1' / `window.__DSH_COMPOSER_FOCUS_GATE_LOG = true`。
 *
 * 只碰宿主那一个 `[data-composer-input]`：插件自己的输入框（`data-pocket-orb`）、文件选择框、
 * 搜索框、重命名框一律不动；闸门只在窄布局（手机端）装（接线在 mobile-apply.tsx）。
 *
 * 纯判定（createComposerFocusGate）与 DOM 挂载（installComposerFocusGate）分开，
 * 单测走假 DOM 直接验「挡 / 收焦点 / 兜底反聚焦 / 卸载还原」，
 * 见 scripts/test-composer-focus-gate.mjs。
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

/** 宿主自己认定「不是要打字」的那一撮控件（照抄活代码 lib 751516 那句 closest 列表，contenteditable 由本体那条放行）。 */
export const COMPOSER_CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]'

/** 落点意图：只有 'typing' 放行聚焦，其余三种一律算「挑东西」。 */
export type ComposerTapKind = 'typing' | 'menu' | 'other' | 'outside'

/** 判定快照（单测 / 诊断用）。 */
export interface ComposerGateSnapshot {
  /** 当前意图：'typing' 才允许输入框拿焦点。 */
  intent: 'typing' | 'picker'
  /** 最近一次落点的意图分类。 */
  kind: ComposerTapKind
  /** 为什么算这一类（白名单里的哪一条 / 哪一条阻断规则）。 */
  reason: string
}

/**
 * 纯判定：没有 DOM、没有时钟。
 * 默认不聚焦；只有最近一次落点被判成 'typing' 才放行，下一次非 typing 落点立刻收回。
 * 不再有「点过输入框后 N 毫秒内都算主动」的时间窗 —— 那种启发式正是 0.2.33/0.2.34
 * 「偶尔放行、看不出为什么」的来源。
 */
export interface ComposerFocusGate {
  /** 记一次落点意图。 */
  notePointer(kind: ComposerTapKind, reason?: string): void
  /** 这一次聚焦要不要挡。 */
  shouldBlock(): boolean
  /** 当前判定状态。 */
  inspect(): ComposerGateSnapshot
}

/**
 * @returns 判定器。
 */
export function createComposerFocusGate(): ComposerFocusGate {
  let intent: 'typing' | 'picker' = 'picker'
  let lastKind: ComposerTapKind = 'outside'
  let lastReason = 'no-tap'
  return {
    notePointer(kind: ComposerTapKind, reason = ''): void {
      lastKind = kind
      lastReason = reason
      intent = kind === 'typing' ? 'typing' : 'picker'
    },
    shouldBlock(): boolean {
      return intent !== 'typing'
    },
    inspect(): ComposerGateSnapshot {
      return { intent, kind: lastKind, reason: lastReason }
    },
  }
}

/** 挂在 prototype 上的幂等标记：同一页面重复 install 只装一次。 */
const INSTALLED_KEY = '__dshAssistantComposerFocusGate'

/** 决策日志开关：URL query / localStorage / window 全局，三处任一为真就开。 */
export const COMPOSER_FOCUS_LOG_QUERY = 'composerFocusLog'
export const COMPOSER_FOCUS_LOG_STORAGE = 'dsh-assistant.composerFocusLog'
export const COMPOSER_FOCUS_LOG_WINDOW_FLAG = '__DSH_COMPOSER_FOCUS_GATE_LOG'

/** 输入法观测：visualViewport 高度比基线矮这么多像素 = 软键盘弹起来了。 */
export const IME_SHRINK_THRESHOLD_PX = 120

/** 一次判定记录（取证用）。 */
export interface ComposerFocusDecision {
  /** 判定发生的时刻。 */
  at: number
  /** 最近一次落点的意图。 */
  kind: ComposerTapKind
  /** 为什么算这类落点。 */
  reason: string
  /** 这一次聚焦是被挡下（'block'）、被反聚焦收掉（'blur'），还是放行（'allow'）。 */
  action: 'block' | 'blur' | 'allow'
  /** 落点摘要：tag.class[attr] 形式，短字段纪律。 */
  target: string
  /** 同类动作的累计次数。 */
  count: number
}

/** 输入法弹起现场（visualViewport 观测）。 */
export interface ComposerImeEvent {
  /** 视口比基线矮了多少像素。 */
  shrink: number
  /** 那一刻输入框是否持有焦点（true = 就是它把键盘顶起来的）。 */
  editorFocused: boolean
  /** 那一刻 activeElement 的摘要。 */
  active: string
  /** 最近一次落点意图。 */
  kind: ComposerTapKind
}

/** 安装器可注入的依赖（单测传假 DOM；真机全部走默认值）。 */
export interface ComposerFocusGateHost {
  /** 默认 document。 */
  document?: Document | null
  /** 默认 performance.now（拿不到回落 Date.now）。 */
  now?: () => number
  /** 挡下 / 收焦点时的回调（mobile-apply 拿它发一条诊断 beacon，便于在手机上远程确认生效）。 */
  onBlocked?: (count: number, decision: ComposerFocusDecision) => void
  /** 决策记录回调：只有开关打开（见文件顶部的取证开关）才会被调，挡下 / 收焦点 / 放行都报。 */
  onDecision?: (decision: ComposerFocusDecision) => void
  /** 输入法真的弹起来时回调（visualViewport 阶跃下跌）。 */
  onImeOpen?: (event: ComposerImeEvent) => void
}

/**
 * 把「不是用户点进输入框」的聚焦挡在宿主的 contenteditable 之外，
 * 并且把点面板那一刻仍然挂在输入框上的焦点收掉。
 * @param host - 可注入的 document / 时钟 / 打点回调。
 * @returns 卸载函数：还原 prototype.focus、摘掉 pointerdown / touchstart / focusin 监听。
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
  let blurred = 0
  let lastTap: { kind: ComposerTapKind; reason: string; target: string } = {
    kind: 'outside',
    reason: 'no-tap',
    target: '',
  }

  /** 落点元素（文本节点没有 `closest`，从 parentElement 起）。 */
  const elementOf = (event: Event | null): Element | null => {
    if (event === null) return null
    const target = (event as Event).target as (Element | (Node & { parentElement?: Element | null }) | null)
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

  const hits = (el: Element | null, selector: string): boolean => {
    if (el === null) return false
    try {
      return el.closest(selector) !== null
    } catch {
      return false
    }
  }

  /**
   * 工具按钮组：谁的 DOM 子树里包着那颗「＋」，谁就是「挑东西」的容器。
   * 宿主每个构建都会改 CSS-module 的哈希前缀（`_7tt59G_` 之类），只认 `[class$="_tools"]`
   * 这类后缀在换布局时就会漏；这条结构判据跟着「＋」自己走，与类名无关。
   */
  const insideCommandToolGroup = (el: Element | null): boolean => {
    if (el === null) return false
    try {
      const card = el.closest(COMPOSER_CARD_SELECTOR)
      if (card === null) return false
      const plus = card.querySelector(COMPOSER_COMMAND_BUTTON_SELECTOR)
      if (plus === null) return false
      let node: Element | null = el
      while (node !== null && node !== card) {
        if (typeof node.contains === 'function' && node.contains(plus)) return true
        node = node.parentElement
      }
    } catch {
      /* 结构判据异常 → 交给类名那条 */
    }
    return false
  }

  /** 这一次落点的意图：默认 'other'，只有白名单里的落点才算 'typing'。 */
  const classifyTap = (event: Event): { kind: ComposerTapKind; reason: string } => {
    const el = elementOf(event)
    if (el === null) return { kind: 'outside', reason: 'no-target' }
    if (!hits(el, COMPOSER_SEAT_SELECTOR)) return { kind: 'outside', reason: 'out-of-seat' }
    if (hits(el, COMPOSER_MENU_SELECTOR)) return { kind: 'menu', reason: 'menu-item' }
    if (hits(el, COMPOSER_COMMAND_BUTTON_SELECTOR)) return { kind: 'menu', reason: 'command-button' }
    if (hits(el, COMPOSER_OVERLAY_SELECTOR)) return { kind: 'menu', reason: 'composer-overlay' }
    if (hits(el, COMPOSER_EDITOR_BODY_SELECTOR)) return { kind: 'typing', reason: 'editor-body' }
    if (hits(el, COMPOSER_TYPING_CONTROL_SELECTOR)) return { kind: 'typing', reason: 'typing-control' }
    if (hits(el, COMPOSER_BLOCK_AREA_SELECTOR)) return { kind: 'other', reason: 'controls-area' }
    if (insideCommandToolGroup(el)) return { kind: 'other', reason: 'command-tool-group' }
    if (hits(el, COMPOSER_CONTROL_SELECTOR)) return { kind: 'other', reason: 'control' }
    if (hits(el, COMPOSER_CARD_SELECTOR)) return { kind: 'typing', reason: 'card-whitespace' }
    return { kind: 'other', reason: 'seat-not-card' }
  }

  /** 输入框本体（焦点是不是落在它上面）。 */
  const editorOf = (node: Element | null): Element | null => {
    if (node === null || typeof node.closest !== 'function') return null
    try {
      return node.closest(COMPOSER_INPUT_SELECTOR)
    } catch {
      return null
    }
  }

  /** 当前持有焦点的输入框（没有焦点 / 焦点在别处 → null）。 */
  const activeEditor = (): Element | null => {
    const active = (doc as Document).activeElement as Element | null
    return editorOf(active)
  }

  const report = (decision: ComposerFocusDecision): void => {
    if (!logEnabled()) return
    try {
      host.onDecision?.(decision)
    } catch {
      /* 取证不能反过来打断闸门 */
    }
  }

  /**
   * 把输入框上的焦点收掉（blur 是安卓收输入法的唯一可靠手段）。
   * @param action - 'block'（新的聚焦被挡）或 'blur'（已有焦点被收）。
   * @returns 真的收掉了没有。
   */
  const dismissEditorFocus = (action: 'block' | 'blur'): boolean => {
    const editor = activeEditor()
    if (editor === null) return false
    try {
      (editor as HTMLElement).blur()
    } catch {
      return false
    }
    blurred += 1
    const decision: ComposerFocusDecision = {
      at: clock(),
      kind: lastTap.kind,
      reason: lastTap.reason,
      action: 'blur',
      target: describe(editor),
      count: blurred,
    }
    report(decision)
    // 每条都发 beacon 会刷爆 diag：第 1 次 + 之后每 10 次一条，够证明「真的收掉了」。
    if (blurred === 1 || blurred % 10 === 0) {
      try {
        host.onBlocked?.(blurred, decision)
      } catch {
        /* 打点失败不影响收焦点 */
      }
    }
    return true
  }

  const onPointerDown = (event: Event): void => {
    const { kind, reason } = classifyTap(event)
    lastTap = { kind, reason, target: describe(elementOf(event)) }
    gate.notePointer(kind, reason)
    if (kind === 'typing') return
    // 菜单里的选项行不算「开面板」：宿主的 / 命令面板就是在输入框有焦点的情况下挑的，
    // 挑完还要接着打字（插进来的命令参数），这时候把焦点收掉反而要用户再点一次输入框。
    if (hits(elementOf(event), COMPOSER_MENU_SELECTOR)) return
    // 面板类落点：输入框里如果还挂着焦点，这一下就收掉 —— 否则安卓会在这次手势里
    // 把仍然聚焦的 contenteditable 的输入法重新顶起来（本轮根因）。
    dismissEditorFocus('blur')
  }

  /**
   * focusin 兜底：Lexical 提交 DOM 选区（`setBaseAndExtent`）时会给 contenteditable
   * 附送一个焦点，这条路不经过 `prototype.focus`，只能在这里收掉。
   */
  const onFocusIn = (event: Event): void => {
    if (!gate.shouldBlock()) return
    const el = elementOf(event)
    if (editorOf(el) === null) return
    dismissEditorFocus('block')
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
      if (gate.shouldBlock()) {
        blocked += 1
        const decision: ComposerFocusDecision = {
          at,
          kind: lastTap.kind,
          reason: lastTap.reason,
          action: 'block',
          target: lastTap.target,
          count: blocked,
        }
        report(decision)
        // 每条都发 beacon 会刷爆 diag：第 1 次 + 之后每 30 次一条。
        if (blocked === 1 || blocked % 30 === 0) {
          try {
            host.onBlocked?.(blocked, decision)
          } catch {
            /* 打点失败不影响挡 */
          }
        }
        return
      }
      report({
        at, kind: lastTap.kind, reason: lastTap.reason, action: 'allow', target: lastTap.target, count: blocked,
      })
    }
    originalFocus.apply(this, args)
  }

  /**
   * 输入法观测：安卓软键盘一弹，visualViewport 高度阶跃下跌。
   * 这是手机上唯一能直接确认「键盘到底弹没弹、弹的那刻谁持有焦点」的信号。
   */
  const visualViewport = (view as unknown as {
    visualViewport?: { height: number; addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void }
  } | null)?.visualViewport
  let imeBaseline = typeof visualViewport?.height === 'number' ? visualViewport.height : 0
  let imeReported = 0
  const onViewportResize = (): void => {
    const height = Number(visualViewport?.height)
    if (!Number.isFinite(height) || height <= 0) return
    if (height > imeBaseline) imeBaseline = height
    const shrink = imeBaseline - height
    if (shrink <= IME_SHRINK_THRESHOLD_PX || imeReported >= 3) return
    imeReported += 1
    imeBaseline = height
    try {
      host.onImeOpen?.({
        shrink: Math.round(shrink),
        editorFocused: activeEditor() !== null,
        active: describe((doc as Document).activeElement as Element | null),
        kind: lastTap.kind,
      })
    } catch {
      /* 观测失败不影响闸门 */
    }
  }

  proto.focus = patchedFocus as unknown as HTMLElement['focus']
  proto[INSTALLED_KEY] = true
  // pointerdown 是主路；老 WebView 没有 PointerEvent 时靠 touchstart 兜底
  // （两者都收到也只是写同一个时间戳并复核一次焦点，无副作用）。
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  doc.addEventListener('touchstart', onPointerDown, { capture: true, passive: true })
  doc.addEventListener('focusin', onFocusIn, true)
  try {
    visualViewport?.addEventListener?.('resize', onViewportResize)
  } catch {
    /* 老 WebView 没有 visualViewport → 少一条观测，闸门照常 */
  }

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
      doc.removeEventListener('focusin', onFocusIn, true)
      visualViewport?.removeEventListener?.('resize', onViewportResize)
    } catch {
      /* ignore */
    }
  }
}
