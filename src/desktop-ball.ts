/**
 * 桌面级悬浮球：用 dsh-orb 已下载的 Electron 运行时启动一个独立的透明小窗，
 * 可拖到 DSH 窗口之外、始终置顶；点击通过本地 socket 通知宿主，宿主再让网页打开控制室。
 *
 * 为什么不在宿主进程里 new BrowserWindow：DSH Desktop 的插件宿主是以
 * ELECTRON_RUN_AS_NODE 跑的 Node 进程，没有 Electron API（实测 ball.html 未生成）。
 * 独立 Electron helper 才能稳定拿到窗口能力；找不到 Electron 时自动回退网页球。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { focusDesktopMainWindow } from './desktop-focus'

const DESKTOP_BALL_SINGLETON = '__dshAssistantDesktopBallSingleton'
type DesktopBallSingleton = { generation: number; handle: DesktopBallHandle | null }

/** 插件热重载会创建新模块实例；注册表放在 globalThis 上，确保新实例接管前停掉旧桌面球。 */
function desktopBallSingleton(): DesktopBallSingleton {
  const root = globalThis as any
  if (!root[DESKTOP_BALL_SINGLETON]) root[DESKTOP_BALL_SINGLETON] = { generation: 0, handle: null }
  return root[DESKTOP_BALL_SINGLETON]
}

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return dshHome()
}

/** 悬浮球状态/头像所在的 profile 子目录（宿主侧与设置页共用）。 */
export function ballProfileDir(ctx: any): string {
  return join(profileDir(ctx), 'dsh-assistant-ball')
}

/** 找一个可用的 Electron 可执行文件（优先复用 dsh-orb 已下载的运行时）。 */
function findElectron(): string | null {
  const candidates = [
    join(dshHome(), 'dsh-orb', 'electron-runtime', 'electron.exe'),
    join(dshHome(), 'dsh-assistant', 'electron', 'electron.exe'),
    process.env.DSH_ASSISTANT_ELECTRON || '',
  ].filter(Boolean)
  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch {}
  }
  return null
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
b.addEventListener('mousedown', (e) => { if (e.button !== 0) return; down = true; moved = 0; sx = e.screenX; sy = e.screenY; ipcRenderer.send('ball-down', { x: sx, y: sy }) })
window.addEventListener('mousemove', (e) => { if (!down) return; moved = Math.max(moved, Math.hypot(e.screenX - sx, e.screenY - sy)); ipcRenderer.send('ball-move', { x: e.screenX, y: e.screenY }) })
window.addEventListener('mouseup', () => { if (!down) return; down = false; ipcRenderer.send('ball-up', { moved }) })
</script></body></html>`

const HELPER_MAIN = `const { app, BrowserWindow, ipcMain, screen } = require('electron')
const net = require('net')
const fs = require('fs')
const path = require('path')
const dir = __dirname
const args = process.argv.slice(2)
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const port = Number(arg('port', '0'))
const token = arg('token', '')
let win = null
let sock = null
let startCursor = null
let startPos = null

function connect() {
  try {
    sock = net.connect(port, '127.0.0.1', () => { try { sock.write(token + '\\n') } catch {} })
    sock.on('error', () => {})
    sock.on('close', () => { try { app.quit() } catch {} })
  } catch { setTimeout(connect, 1500) }
}
function send(msg) { try { sock && sock.write(msg + '\\n') } catch {} }

app.whenReady().then(() => {
  let x = 80, y = 160
  try {
    const area = screen.getPrimaryDisplay().workAreaSize
    x = Math.max(0, area.width - 96)
    y = Math.max(0, area.height - 300)
  } catch {}
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'pos.json'), 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) { x = p.x; y = p.y }
  } catch {}
  win = new BrowserWindow({
    width: 72, height: 72, x, y, frame: false, transparent: true, resizable: false,
    // 不能聚焦：否则 Windows 会在第一次点击时先激活小球，Chromium 不派发 mousedown，
    // 表现为“点一下没反应/只停在会话详情”，第二下才打开控制室。
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, devTools: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(dir, 'index.html'))
  win.once('ready-to-show', () => { try { win.showInactive() } catch { try { win.show() } catch {} } })
  const persist = () => { try { const p = win.getPosition(); fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify({ x: p[0], y: p[1] })) } catch {} }
  win.on('moved', persist)
  win.on('closed', () => { try { app.quit() } catch {} })
  ipcMain.on('ball-down', (_e, p) => { startCursor = { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }; try { startPos = win.getPosition() } catch {} })
  ipcMain.on('ball-move', (_e, p) => {
    if (!startCursor || !startPos) return
    const dx = (Number(p && p.x) || 0) - startCursor.x
    const dy = (Number(p && p.y) || 0) - startCursor.y
    try { win.setPosition(Math.round(startPos[0] + dx), Math.round(startPos[1] + dy)) } catch {}
  })
  ipcMain.on('ball-up', (_e, p) => {
    const moved = Number(p && p.moved) || 0
    if (moved < 5) send('click')
  })
  connect()
})
app.on('window-all-closed', () => { try { app.quit() } catch {} })
`

export interface DesktopBallHandle {
  dispose: () => void
  takeClick: () => boolean
  /** 点击发生时即时唤醒长轮询；pendingClick 仍保留，兼顾尚未等待的客户端。 */
  onClick: (listener: () => void) => () => void
}

export async function startDesktopBall(ctx: any, opts: { avatar?: string } = {}): Promise<DesktopBallHandle | null> {
  // 非 Windows 暂不提供（路径/打包未验证）；Electron 渲染器内也不需要（有页面球）
  if (process.platform !== 'win32') return null
  const exe = findElectron()
  if (!exe) {
    try { console.error('[dsh-assistant] 桌面悬浮球：未找到 Electron 运行时（跳过）') } catch {}
    return null
  }
  const singleton = desktopBallSingleton()
  const generation = ++singleton.generation
  try { singleton.handle?.dispose() } catch {}
  singleton.handle = null
  try { console.error('[dsh-assistant] 桌面悬浮球：使用', exe) } catch {}

  const dir = join(profileDir(ctx), 'dsh-assistant-ball')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-assistant-ball', version: '1.0.0', main: 'main.js' }), 'utf8')
    writeFileSync(join(dir, 'main.js'), HELPER_MAIN, 'utf8')
    // 头像：把 data URL 塞进球体的 DOM（只认 data:image/*，避免把奇怪内容写进 HTML）
    const avatar = String(opts.avatar ?? '').trim()
    const safeAvatar = avatar.startsWith('data:image/') ? avatar.replace(/"/g, '&quot;') : ''
    const avatarScript = safeAvatar
      ? `<script>document.getElementById('b').innerHTML=${JSON.stringify(`<img src="${safeAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none" alt="">`)}</script>`
      : ''
    writeFileSync(join(dir, 'index.html'), BALL_HTML.replace('</body>', `${avatarScript}</body>`), 'utf8')
  } catch (err) {
    try { console.error('[dsh-assistant] 写悬浮球 helper 失败：', err) } catch {}
    return null
  }

  const token = randomBytes(16).toString('hex')
  let pendingClick = false
  const clickListeners = new Set<() => void>()
  let child: any = null
  const authSockets = new Set<any>()

  const server = createServer((sock) => {
    let authed = false
    let buf = ''
    authSockets.add(sock)
    sock.setTimeout(4000)
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        if (!authed) {
          if (text === token) { authed = true; try { sock.write('ok\n') } catch {} }
          else { try { sock.destroy() } catch {} }
          continue
        }
        if (text === 'click') {
          // 先让长轮询把“打开控制室”送到页面，再在下一拍恢复主窗焦点；
          // 即使 Win32 聚焦调用很慢，也不会把这次点击卡在宿主事件循环里。
          pendingClick = true
          for (const listener of [...clickListeners]) { try { listener() } catch {} }
          setImmediate(() => { try { focusDesktopMainWindow() } catch {} })
        }
      }
    })
    sock.on('timeout', () => { if (!authed) { try { sock.destroy() } catch {} } })
    sock.on('error', () => {})
    sock.on('close', () => { authSockets.delete(sock) })
  })
  let port = 0
  try {
    // listen 是异步的：必须等 'listening' 之后再取 address，否则立刻读到 null
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      server.once('error', (e: any) => reject(e))
      server.listen(0, '127.0.0.1')
    })
    port = Number((server.address() as any)?.port) || 0
  } catch { try { server.close() } catch {} return null }
  if (!port) { try { server.close() } catch {} return null }
  // 多次设置保存/热重载可能并发进入；等待监听期间若已有更新请求，本次直接取消。
  if (generation !== singleton.generation) { try { server.close() } catch {} return null }

  try {
    // 关键：DSH Desktop 的宿主进程带 ELECTRON_RUN_AS_NODE=1，直接继承会让 electron.exe
    // 以纯 Node 模式启动、不开窗口（表现为 helper 进程立刻退出）。这里剥掉再启动。
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RUN_AS_NODE_OPTIONS
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    let logFd: number | 'ignore' = 'ignore'
    try { logFd = openSync(join(dir, 'helper.log'), 'a') } catch {}
    child = spawn(exe, [dir, '--port', String(port), '--token', token], {
      windowsHide: true, stdio: ['ignore', logFd, logFd], detached: false,
      env,
    })
    try { console.error('[dsh-assistant] 桌面悬浮球 helper pid =', child.pid, 'port =', port) } catch {}
    child.on('error', (e: any) => { try { console.error('[dsh-assistant] 悬浮球 helper error：', e?.message ?? e) } catch {} })
    child.on('exit', (code: any) => { try { console.error('[dsh-assistant] 悬浮球 helper 退出，code =', code) } catch {} })
  } catch (err) {
    try { console.error('[dsh-assistant] 启动 Electron 悬浮球失败：', err) } catch {}
    try { server.close() } catch {}
    return null
  }

  // 退出清理：helper 的 socket 断开后会自行退出；这里再兜底 kill 一次。
  // 旧上下文的 dispose 只碰自己的 child，不会误停全局注册表中更新的桌面球。
  let disposed = false
  let handle: DesktopBallHandle
  const dispose = () => {
    if (disposed) return
    disposed = true
    pendingClick = false
    clickListeners.clear()
    for (const s of authSockets) { try { s.destroy() } catch {} }
    try { server.close() } catch {}
    try { child?.kill() } catch {}
    child = null
    if (singleton.handle === handle) singleton.handle = null
  }
  handle = {
    dispose,
    takeClick: () => { const v = pendingClick; pendingClick = false; return v },
    onClick: (listener) => {
      clickListeners.add(listener)
      return () => { clickListeners.delete(listener) }
    },
  }
  singleton.handle = handle
  return handle
}

export { BALL_HTML }
