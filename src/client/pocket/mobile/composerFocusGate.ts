/**
 * 手机端「进入会话不自动弹输入法」（2026-11-05）。
 *
 * 【现象】手机上点进任意一个会话，光标立刻落进输入框，系统默认输入法跟着顶起来；
 * 想先读两条历史消息也得先按一次返回键收键盘。
 *
 * 【根因】宿主的输入框在挂载/切会话时会主动抢焦点（dsh-client-ui-conversation 的
 * InputBar：`useEffect(..., [locked, sessionId, editor]) → focusDraftEditor()`，
 * 注释写明 "Unlock (mount / session switch) returns focus to the box"）。桌面端这是
 * 对的：切过去就能直接打字。但安卓 WebView 里 DOM focus 一落到 contenteditable 上，
 * 系统就会 `showSoftInput` —— 程序化聚焦不需要用户手势，键盘照样弹。
 *
 * 【做法】不去改宿主（宿主在 app.asar / profile node_modules 里，改了一升级就没了）。
 * 在客户端插件这一层把「不是用户点进去的」那类程序化聚焦挡掉：
 *
 *   判据只有一条 —— **这一次聚焦之前的一小段时间（默认 1.2 s）内，用户的
 *   pointerdown 是不是落在输入区里**（`[data-conversation-region="composer"]`，
 *   宿主给 composerSeat 打的标记，输入卡片 / 发送钮 / 菜单 / 附件都在这一棵树里）。
 *
 *   - 切会话 / 启动恢复上一个会话：最近一次点击在侧栏会话行、悬浮球、控制台卡片上
 *     → 挡，键盘不弹，界面照常渲染；
 *   - 用户点输入框（含卡片空白、发送钮、命令菜单）：pointerdown 就在输入区里
 *     → 放行，键盘正常弹出；
 *   - 正在打字：编辑器本来就有焦点，挡与不挡都没差别（挡只是不做无效聚焦，
 *     不会把已有焦点弄丢）。
 *
 * 只挡 `[data-composer-input]` 这一个元素（宿主 Lexical 的 contenteditable 本体）。
 * 插件自己的输入框（`[data-pocket-orb="textarea"]`）、文件选择框、搜索框、重命名框
 * 一律不碰 —— 那些地方的自动聚焦是用户按出来的，本来就该弹键盘。
 *
 * 纯判定（createComposerFocusGate）与 DOM 挂载（installComposerFocusGate）分开，
 * 单测走假 DOM 直接验「挡 / 放行 / 卸载还原」，见 scripts/test-composer-focus-gate.mjs。
 */

/** 宿主输入框本体：dsh-client-ui-conversation 的 ComposerContentEditable 渲染的 div。 */
export const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

/** 宿主给 composerSeat 打的区域标记；输入区里的一切点击都算「用户要打字」。 */
export const COMPOSER_SEAT_SELECTOR = '[data-conversation-region="composer"]'

/**
 * 「点进输入区」之后多久内的程序化聚焦仍算用户主动。
 * 发送后回填光标、按钮 mousedown 保焦点都发生在几毫秒内；1.2 s 足够宽，
 * 又不会宽到「点一下输入框、再切个会话」还被当成用户在打字。
 */
export const SEAT_GRACE_MS = 1200

/** 只在宿主输入区里「最近点过」时放行；其余一律挡。 */
export interface ComposerFocusGate {
  /** 记录一次 pointerdown：只有落在输入区里才算「用户要打字」。 */
  notePointer(inSeat: boolean, now: number): void
  /** now 时刻的这一次程序化聚焦要不要挡。 */
  shouldBlock(now: number): boolean
  /** 只读快照（单测 / 诊断用）。 */
  inspect(): { lastSeatPointerAt: number | null; graceMs: number }
}

/**
 * 纯判定：没有 DOM、没有时钟，now 由调用方给（performance.now 标度）。
 * @param graceMs - 放行窗口，非法值回落成 SEAT_GRACE_MS。
 * @returns 判定器。
 */
export function createComposerFocusGate(graceMs: number = SEAT_GRACE_MS): ComposerFocusGate {
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : SEAT_GRACE_MS
  let lastSeatPointerAt: number | null = null
  return {
    notePointer(inSeat: boolean, now: number): void {
      // 区外点击不刷新时间戳：点了会话列表不等于用户要打字。
      if (!inSeat || !Number.isFinite(now)) return
      lastSeatPointerAt = now
    },
    shouldBlock(now: number): boolean {
      if (lastSeatPointerAt === null) return true
      if (!Number.isFinite(now)) return true
      const elapsed = now - lastSeatPointerAt
      // 时钟倒退（页面被挂起后 performance.now 异常）按「刚点过」放行：
      // 宁可弹键盘，也不能把用户点输入框这一下也挡掉。
      if (elapsed < 0) return false
      return elapsed > grace
    },
    inspect(): { lastSeatPointerAt: number | null; graceMs: number } {
      return { lastSeatPointerAt, graceMs: grace }
    },
  }
}

/** 挂在 prototype 上的幂等标记：同一页面重复 install 只装一次。 */
const INSTALLED_KEY = '__dshAssistantComposerFocusGate'

/** 安装器可注入的依赖（单测传假 DOM；真机全部走默认值）。 */
export interface ComposerFocusGateHost {
  /** 默认 document。 */
  document?: Document | null
  /** 默认 performance.now（拿不到回落 Date.now）。 */
  now?: () => number
  /** 挡下时的回调（mobile-apply 拿它发一条诊断 beacon，便于在手机上远程确认生效）。 */
  onBlocked?: (count: number) => void
}

/**
 * 把「非用户点入的程序化聚焦」挡在宿主的 contenteditable 之外。
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
  const originalFocus = proto.focus
  let blocked = 0

  /** 这一次 pointerdown 是不是落在宿主输入区里。读不到就当区外（保守：不弹键盘）。 */
  const isSeatTarget = (event: Event): boolean => {
    try {
      const target = event.target as (Element | null)
      if (target === null || typeof target.closest !== 'function') return false
      return target.closest(COMPOSER_SEAT_SELECTOR) !== null
    } catch {
      return false
    }
  }

  const onPointerDown = (event: Event): void => {
    gate.notePointer(isSeatTarget(event), clock())
  }

  const patchedFocus = function focus(this: HTMLElement, ...args: unknown[]): void {
    try {
      if (
        HTMLElementCtor !== undefined
        && this instanceof HTMLElementCtor
        && gate.shouldBlock(clock())
        && typeof this.matches === 'function'
        && this.matches(COMPOSER_INPUT_SELECTOR)
      ) {
        blocked += 1
        // 每条都发 beacon 会刷爆 diag：第 1 次 + 之后每 30 次一条，够证明「真的挡了」。
        if (blocked === 1 || blocked % 30 === 0) {
          try {
            host.onBlocked?.(blocked)
          } catch {
            /* 打点失败不影响挡 */
          }
        }
        return
      }
    } catch {
      /* 判据异常按放行处理：宁可弹键盘，也不能把聚焦弄坏 */
    }
    return (originalFocus as (...a: unknown[]) => void).apply(this, args)
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
