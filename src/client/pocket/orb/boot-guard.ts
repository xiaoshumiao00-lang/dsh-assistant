// 手机端「会话详情 ↔ 列表」反复跳页的自救守卫（v2）。
//
// 上一版把启动计数放在 **sessionStorage**，并依赖 document.title 的
// 「标题 — 产品名」格式。实测两个前提都会失效：
//   1. 手机 WebView 的渲染进程被系统杀掉后整页重开，sessionStorage 常被清空
//      → 计数永远到不了第 3 次，守卫从不触发；
//   2. 会话标题投影短暂缺失时，title 会回落成产品名，按标题判断会错过。
// 现在改为：
//   - 计数与 selection 存在 localStorage（client/orb/diag.ts，跨进程存活）；
//   - 只认「同一个 sessionId 在 60 秒内第 3 次启动」，不依赖标题；
//   - 判定循环后**立刻**擦掉 dsh.sessions.current 并 clearMain，且在 12 秒内
//     每 400ms 复查（宿主 restoreSelection 是异步的，晚一步就会被重新打开）。
//
// 这不是根因修复（根因是超长会话把手机 WebView 顶崩），而是止血：保证崩了
// 之后停在列表，而不是无限重开。用户随时可以再点一次「查看执行」。

import { clearBootLoop, getBootInfo, scrubSelection } from './diag.ts'

/** 清主面板后最多观察多久（期间宿主可能又恢复一次）。 */
const GUARD_HORIZON_MS = 12_000
const RETRY_MS = 400

/** 清掉主面板选择（宿主会据此把页面停在会话列表，且 reload 后不再自动恢复）。 */
function clearMain(ctx: any): void {
  try {
    ctx?.uiWorkspace?.clearMain?.()
  } catch {
    /* 旧宿主没有该方法 → 放弃（不影响其他功能） */
  }
}

/** 当前持久化的 selection（用于判断用户是否已经手动切走）。 */
function currentSelection(): string {
  try {
    const raw = globalThis.localStorage?.getItem('dsh.sessions.current')
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
  } catch {
    return ''
  }
}

/** 顶部提示条：告诉用户「详情反复重载，已退回列表」。 */
function showNotice(): void {
  try {
    const doc = (globalThis as any).document
    if (!doc?.body) return
    if (doc.querySelector('[data-pocket-guard]')) return
    const bar = doc.createElement('div')
    bar.dataset.pocketGuard = '1'
    bar.textContent = '该会话过大，手机端反复重载，已停在会话列表（可再次点「查看执行」重试）'
    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'top:calc(env(safe-area-inset-top, 0px) + 12px)',
      'z-index:2147483000', 'padding:10px 14px', 'border-radius:12px',
      'background:#1f2937', 'color:#f9fafb', 'font-size:13px', 'line-height:1.45',
      'box-shadow:0 8px 24px rgba(0,0,0,.28)', 'text-align:center',
    ].join(';')
    const hide = (): void => bar.remove()
    bar.addEventListener('click', hide)
    doc.body.appendChild(bar)
    setTimeout(hide, 8000)
  } catch {
    /* 忽略 */
  }
}

/**
 * 安装启动守卫：localStorage 账本判定 reload 循环，必要时把主面板退回列表。
 * @param ctx - 悬浮球上下文（需要 uiWorkspace）。
 */
export function installBootGuard(ctx: any): void {
  const info = getBootInfo()
  if (!info.loop) return
  const culprit = info.sel
  scrubSelection()
  const started = Date.now()
  let noticeShown = false
  const tick = (): void => {
    const sel = currentSelection()
    // 用户已经手动切到别的会话/首页 → 立即停手，不要干扰操作。
    if (sel !== '' && sel !== culprit) {
      clearBootLoop()
      return
    }
    clearMain(ctx)
    scrubSelection()
    if (!noticeShown) {
      noticeShown = true
      showNotice()
    }
    if (Date.now() - started < GUARD_HORIZON_MS) setTimeout(tick, RETRY_MS)
    else clearBootLoop()
  }
  // 第一次同步执行：越早越好，赶在 restoreSelection 之前。
  tick()
}
