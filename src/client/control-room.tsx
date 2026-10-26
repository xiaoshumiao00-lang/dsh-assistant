// 悬浮球 → 全屏控制室。
//
// 直接复用工作台的控制室面板（ConsolePane：模板库 / 项目卡片 / 卡片会话列表 /
// 新建会话 / 添加项目 / 主题与背景 dock），所以两套 UI 的数据与操作完全同源——
// 在控制室里点开的项目、会话、模板，与侧栏工作台里是同一份。
//
// 入口：手机/电脑上的悬浮球（dsh-pocket 那颗）现在打开这里，而不再打开快捷输入页；
// 快捷输入页仍保留在抽屉底部入口里，功能不删。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ConsolePane, consoleEnvReady, subscribeSplitEnv } from './split'
import { controlRoomStore } from './orb-bridge'

const CR_CSS = `
.dsh-assistant-cr{position:fixed;left:0;right:0;bottom:0;top:var(--dsh-frame-top-clearance,0px);width:auto;max-width:none !important;max-height:none !important;z-index:10070;display:flex;flex-direction:column;background:#0a0d13;padding:0;overflow:hidden}
.dsh-assistant-crInner{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.dsh-assistant-crInner>.dsh-wt_console{flex:1;min-height:0;border-radius:0;padding:14px 14px calc(14px + env(safe-area-inset-bottom))}
.dsh-assistant-crClose{position:absolute;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:5;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(20,26,36,.72);color:#e6e8eb;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(8px)}
.dsh-assistant-crClose:hover{background:rgba(40,50,66,.85)}
/* 电脑端：右上角避开 Windows 窗口的 最小化/最大化/关闭（标题栏高度已由 top 让出） */
@media (min-width:1024px){.dsh-assistant-crClose{top:calc(14px + env(safe-area-inset-top));right:14px}}
.dsh-assistant-crWait{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#9aa4b2;font-size:13px;padding:24px;text-align:center}
.dsh-assistant-crWait button{padding:8px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(79,142,247,.18);color:#e6e8eb;font:inherit;font-size:12px;cursor:pointer}
@media (max-width:640px){
  .dsh-assistant-crInner>.dsh-wt_console{padding:10px 10px calc(10px + env(safe-area-inset-bottom))}
  .dsh-assistant-crClose{top:calc(8px + env(safe-area-inset-top));right:10px}
}
`

export function ControlRoomOverlay() {
  const open = useSyncExternalStore(controlRoomStore.subscribe, controlRoomStore.getSnapshot)
  const [ready, setReady] = useState(() => consoleEnvReady())

  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-assistant-control-room'
    tag.textContent = CR_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') controlRoomStore.setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // 工作台环境注入时立即就绪；不再用 700ms 轮询给首次打开额外加一拍。
  useEffect(() => {
    if (!open || ready) return
    const check = (): void => { if (consoleEnvReady()) setReady(true) }
    check()
    return subscribeSplitEnv(check)
  }, [open, ready])

  if (!open) return null
  return (
    <div className="dsh-assistant-cr" role="region" aria-label="控制室">
      <div className="dsh-assistant-crInner">
        {ready ? (
          <ConsolePane />
        ) : (
          <div className="dsh-assistant-crWait">
            <div>控制室组件还没挂载（侧栏工作台区块未就绪）</div>
            <button
              type="button"
              onClick={() => {
                try { (window as any).__dshAssistantToggleSidebar?.() } catch {}
                window.setTimeout(() => { if (consoleEnvReady()) setReady(true) }, 400)
              }}
            >
              打开侧栏后重试
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="dsh-assistant-crClose"
        title="关闭控制室"
        aria-label="关闭控制室"
        onClick={() => controlRoomStore.setOpen(false)}
      >
        ✕
      </button>
    </div>
  )
}
