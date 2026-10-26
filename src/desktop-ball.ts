/**
 * 桌面级悬浮球（Electron 原生小窗，可拖到 DSH 窗口之外）。
 *
 * 网页里的悬浮球只能待在页面视口内；要拖到桌面上必须开一个始终置顶的透明小窗。
 * 仅在 Electron 宿主里启用（`dsh web` CLI 没有 Electron 就自动跳过，不影响网页球）。
 * 点击小窗 → 在主窗口执行 `window.__dshAssistantOpenControlRoom()` 打开控制室。
 *
 * 位置保存在 <profile>/dsh-assistant-ball.json，下次启动还原。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const requireCjs = createRequire(import.meta.url)

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

const BALL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none}
#b{position:absolute;left:6px;top:6px;width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;
background:radial-gradient(circle at 32% 28%,#fff 0%,#eef2ff 24%,#c7d2fe 55%,#8b5cf6 100%);
box-shadow:0 6px 20px rgba(76,29,149,.45),0 2px 6px rgba(0,0,0,.25),inset 0 2px 6px rgba(255,255,255,.9);
cursor:grab;transition:transform .12s ease}
#b:active{cursor:grabbing;transform:scale(.92)}
</style></head><body><div id="b">🔮</div><script>
const { ipcRenderer } = require('electron')
const b = document.getElementById('b')
let down = false, sx = 0, sy = 0, moved = 0
b.addEventListener('mousedown', (e) => { if (e.button !== 0) return; down = true; moved = 0; sx = e.screenX; sy = e.screenY; ipcRenderer.send('dsh-assistant-ball-down', { x: sx, y: sy }) })
window.addEventListener('mousemove', (e) => { if (!down) return; moved = Math.max(moved, Math.hypot(e.screenX - sx, e.screenY - sy)); ipcRenderer.send('dsh-assistant-ball-move', { x: e.screenX, y: e.screenY }) })
window.addEventListener('mouseup', () => { if (!down) return; down = false; ipcRenderer.send('dsh-assistant-ball-up', { moved }) })
</script></body></html>`

export function startDesktopBall(ctx: any): (() => void) | null {
  let electron: any = null
  try {
    if (!process.versions.electron) return null
    electron = requireCjs('electron')
  } catch { return null }
  const { BrowserWindow, ipcMain, screen } = electron ?? {}
  if (!BrowserWindow || !ipcMain || !screen) return null
  // 同一进程内只允许一个球（插件卸载/重载时先收掉旧的）
  const scope = globalThis as any
  try { scope.__dshAssistantBallDispose?.() } catch {}

  let win: any = null
  try {
    const area = screen.getPrimaryDisplay().workAreaSize
    let x = Math.max(0, area.width - 96)
    let y = Math.max(0, area.height - 260)
    const file = join(profileDir(ctx), 'dsh-assistant-ball.json')
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) { x = saved.x; y = saved.y }
    } catch {}
    win = new BrowserWindow({
      width: 72, height: 72, x, y,
      frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
      focusable: true, show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, devTools: false },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
    // 用临时 HTML 文件而不是 data: URL —— 透明窗 + nodeIntegration 在 data URL 下
    // 某些 Electron 版本会拒绝 require('electron')，小球就拖不动/点不了。
    let htmlPath = ''
    try {
      const dir = profileDir(ctx)
      mkdirSync(dir, { recursive: true })
      htmlPath = join(dir, 'dsh-assistant-ball.html')
      writeFileSync(htmlPath, BALL_HTML, 'utf8')
    } catch {}
    if (htmlPath) void win.loadFile(htmlPath)
    else void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BALL_HTML))
    win.once('ready-to-show', () => { try { win.showInactive() } catch { try { win.show() } catch {} } })

    let startX = x, startY = y, startCursor = { x: 0, y: 0 }, moved = 0
    const onDown = (_e: any, p: any) => {
      startCursor = { x: Number(p?.x) || 0, y: Number(p?.y) || 0 }
      try { const pos = win.getPosition(); startX = pos[0]; startY = pos[1] } catch {}
      moved = 0
    }
    const onMove = (_e: any, p: any) => {
      if (!startCursor) return
      const dx = (Number(p?.x) || 0) - startCursor.x
      const dy = (Number(p?.y) || 0) - startCursor.y
      moved = Math.max(moved, Math.hypot(dx, dy))
      try { win.setPosition(Math.round(startX + dx), Math.round(startY + dy)) } catch {}
    }
    const onUp = () => {
      const wasClick = moved < 5
      try {
        const pos = win.getPosition()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ x: pos[0], y: pos[1] }), 'utf8')
      } catch {}
      if (!wasClick) return
      // 点击：在 DSH 主窗口里打开控制室
      try {
        const main = BrowserWindow.getAllWindows()
          .filter((w: any) => w !== win && !w.isDestroyed() && w.isVisible())
          .sort((a: any, b: any) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0]
        if (main) void main.webContents.executeJavaScript('window.__dshAssistantOpenControlRoom?.(); true').catch(() => {})
      } catch {}
    }
    ipcMain.on('dsh-assistant-ball-down', onDown)
    ipcMain.on('dsh-assistant-ball-move', onMove)
    ipcMain.on('dsh-assistant-ball-up', onUp)

    const dispose = () => {
      try { ipcMain.removeListener('dsh-assistant-ball-down', onDown) } catch {}
      try { ipcMain.removeListener('dsh-assistant-ball-move', onMove) } catch {}
      try { ipcMain.removeListener('dsh-assistant-ball-up', onUp) } catch {}
      try { if (win && !win.isDestroyed()) win.destroy() } catch {}
      win = null
      try { delete scope.__dshAssistantBallDispose } catch {}
    }
    scope.__dshAssistantBallDispose = dispose
    scope.__dshAssistantNativeBall = true
    return dispose
  } catch (err) {
    try { console.error('[dsh-assistant] 桌面悬浮球启动失败：', err) } catch {}
    try { if (win && !win.isDestroyed()) win.destroy() } catch {}
    return null
  }
}
