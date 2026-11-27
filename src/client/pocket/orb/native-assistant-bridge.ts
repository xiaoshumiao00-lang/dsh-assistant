/**
 * 安卓原生桥「DshAssistantNative」的页面侧胶水（2026-11-27「后台收任务完成 + 语音播报」）。
 *
 * 桥本体在 android/.../NativeBridge.java（@JavascriptInterface），这里只做判定与转发：
 *   - 什么时候该走原生：页面不可见（document.hidden）**或**原生标记后台
 *     （isAppInBackground()——个别 ROM 的 WebView 后台不报 hidden，原生标记是权威判据），
 *     且桥存在（只有安卓外壳里有；桌面/浏览器没有，自动落回页面朗读老路）；
 *   - 走原生做什么：speakNative(key, text) 原生 TextToSpeech 播报（后台 WebAudio 被挂起，
 *     页面那套微软 TTS + WebAudio 在后台不可靠）+ notifyTaskDone 发系统通知
 *     （点通知回到会话）；
 *   - 「已播报」标记：__dshNativeSpokenKeys（globalThis 上的 Set，模块被再次求值也共享），
 *     同一张卡片只播一次——回到前台后卡片重挂载不会把同一条再读一遍；
 *     Java 侧 spokenKeys 还有一份 10 分钟窗口的去重，双保险。
 *
 * 纯判定函数都可 node 单测；桥不存在/方法缺失时一律返回 false（调用方落回老路）。
 */

/** 原生桥的方法面（与 NativeBridge.java 的 @JavascriptInterface 一一对应）。 */
export interface NativeAssistantBridge {
  isAppInBackground?: () => boolean
  notifyTaskDone?: (title: string, text: string) => void
  speakNative?: (key: string, text: string) => boolean
  isKeepAliveEnabled?: () => boolean
  setKeepAliveEnabled?: (enabled: boolean) => void
}

/** 桥在 window 上的名字（与 MainActivity.addJavascriptInterface 的第二个参数一致）。 */
export const NATIVE_BRIDGE_NAME = 'DshAssistantNative'

/** 任务完成通知标题（正文由 notificationTextOf 从朗读文本压出来）。 */
export const NOTIFY_TITLE = '个人秘书 · 任务完成'
/** 通知正文最长 80 字：通知栏是扫一眼的地方，不是读正文的地方。 */
export const NOTIFY_TEXT_MAX = 80

/** 取原生桥：只在安卓外壳里存在；缺任何一个关键方法都视为没有桥。 */
export function getNativeAssistantBridge(root: unknown = globalThis): NativeAssistantBridge | null {
  const bridge = (root as Record<string, unknown> | null | undefined)?.[NATIVE_BRIDGE_NAME] as
    NativeAssistantBridge | undefined
  if (bridge === undefined || bridge === null) return null
  if (typeof bridge.speakNative !== 'function' || typeof bridge.notifyTaskDone !== 'function') return null
  return bridge
}

/**
 * 该不该走原生播报：页面不可见，或原生标记在后台（WebView 可见性在个别 ROM 上不可信，
 * 两个判据是「或」——宁可多走一次原生，也不在后台指望 WebAudio）。
 */
export function shouldUseNativeSpeech(root: unknown = globalThis): boolean {
  const bridge = getNativeAssistantBridge(root)
  if (bridge === null) return false
  const doc = (root as { document?: { hidden?: boolean } } | null | undefined)?.document
  if (doc?.hidden === true) return true
  try {
    return bridge.isAppInBackground?.() === true
  } catch {
    return false
  }
}

/** 通知正文：压掉换行与多余空白（TTS 稿是多行口播体），超 80 字截断加省略号。 */
export function notificationTextOf(text: string, max: number = NOTIFY_TEXT_MAX): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** 「已播报」去重表：挂 globalThis，同一 realm 里模块重求值/卡片重挂载都看到同一份。 */
const SPOKEN_KEY = '__dshNativeSpokenKeys'
const SPOKEN_CAP = 400

function spokenSeen(root: unknown): Set<string> {
  const host = root as Record<string, unknown>
  let seen = host[SPOKEN_KEY] as Set<string> | undefined
  if (!(seen instanceof Set)) {
    seen = new Set<string>()
    try { host[SPOKEN_KEY] = seen } catch { /* 只读全局就退回本实例 */ }
  }
  return seen
}

/**
 * 后台任务完成的原生播报 + 通知。返回 true = 已按原生路径处理（调用方不得再走
 * WebAudio 朗读，否则回前台两路叠声）；返回 false = 不满足原生条件，走老路。
 *
 * 注意：桥在、该走原生时**恒返回 true**——即使原生 TTS 当场不可用（speakNative 回 false，
 * 原生会补一条「语音不可用」通知），后台的 WebAudio 也播不出声，不能把文本再塞回老路。
 */
export function nativeBackgroundSpeak(root: unknown, key: string, text: string): boolean {
  if (String(text ?? '') === '') return false
  const bridge = getNativeAssistantBridge(root)
  if (bridge === null || !shouldUseNativeSpeech(root)) return false
  const k = String(key ?? '')
  const seen = spokenSeen(root)
  if (!seen.has(k)) {
    seen.add(k)
    if (seen.size > SPOKEN_CAP) {
      for (const oldest of seen) { if (seen.size <= SPOKEN_CAP) break; seen.delete(oldest) }
    }
    try { bridge.speakNative?.(k, text) } catch { /* 原生播报失败不阻断通知 */ }
  }
  // 通知每次都发（同 key 重播被去重跳过，但「任务完成」这条提醒不该被吞）
  try { bridge.notifyTaskDone?.(NOTIFY_TITLE, notificationTextOf(text)) } catch { /* 通知失败不阻断 */ }
  return true
}
