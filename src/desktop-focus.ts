/** Windows 桌面主窗口唤醒：桌面球 helper 是独立进程，不能直接操作 DSH 的 BrowserWindow。
 *  DSH Desktop 的插件宿主由桌面主进程启动，因此主窗口属于 process.ppid；
 *  同时核对窗口标题，避免 CLI/网页宿主误聚焦父终端。 */
import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import koffi from 'koffi'

/** 托盘隐藏的窗口不能用 Win32 ShowWindow 直接“显示”：
 *  Electron 会把渲染器留在 hidden 状态，窗口虽然出现，但不收鼠标、也不重绘。
 *  这里改为再启动一次 DSH，让主进程的 second-instance → show()/focus() 走官方恢复路径。 */
let lastWakeAt = 0
let wakePending = false

function desktopAppExecutable(): string {
  if (process.platform !== 'win32') return ''
  // 只有 DSH Desktop 的 Electron 宿主才能用“再启动一次”唤回主窗；
  // CLI/网页宿主的 execPath 是 node.exe，启动它只会开一个 Node 进程。
  if (!process.versions.electron) return ''
  // 源码/开发模式下的 process.execPath 是 electron.exe，直接启动只会开默认空应用。
  if ((process as any).defaultApp === true) return ''
  const exe = process.execPath
  if (!exe || basename(exe).toLowerCase() === 'electron.exe') return ''
  return exe
}

function wakeDesktopApp(): boolean {
  const exe = desktopAppExecutable()
  if (!exe) return false
  const now = Date.now()
  // 连续点击时只允许一个激活进程；给 second-instance 留出完成时间。
  if (wakePending || now - lastWakeAt < 1500) return true
  lastWakeAt = now
  wakePending = true
  try {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RUN_AS_NODE_OPTIONS
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    const child = spawn(exe, [], {
      cwd: dirname(exe), windowsHide: true, stdio: 'ignore', detached: false, env,
    })
    const release = (): void => { wakePending = false }
    child.once('error', release)
    child.once('exit', release)
    const timer = setTimeout(release, 3000)
    timer.unref?.()
    return true
  } catch {
    wakePending = false
    return false
  }
}

type User32Api = {
  FindWindowExW: (parent: any, after: any, className: string | null, title: string | null) => any
  GetWindowThreadProcessId: (hwnd: any, pid: number[]) => number
  GetWindowTextLengthW: (hwnd: any) => number
  GetWindowTextW: (hwnd: any, buffer: Buffer, count: number) => number
  IsIconic: (hwnd: any) => number
  IsWindowVisible: (hwnd: any) => number
  ShowWindow: (hwnd: any, command: number) => number
  SwitchToThisWindow: (hwnd: any, altTab: boolean) => void
  GetForegroundWindow: () => any
}

let cached: User32Api | null = null

function user32(): User32Api {
  if (cached) return cached
  const lib = koffi.load('user32.dll')
  cached = {
    FindWindowExW: lib.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *className, const char16_t *title)'),
    GetWindowThreadProcessId: lib.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    GetWindowTextLengthW: lib.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
    GetWindowTextW: lib.func('int __stdcall GetWindowTextW(void *hwnd, uint16_t *buffer, int count)'),
    IsIconic: lib.func('int __stdcall IsIconic(void *hwnd)'),
    IsWindowVisible: lib.func('int __stdcall IsWindowVisible(void *hwnd)'),
    ShowWindow: lib.func('int __stdcall ShowWindow(void *hwnd, int command)'),
    SwitchToThisWindow: lib.func('void __stdcall SwitchToThisWindow(void *hwnd, bool altTab)'),
    GetForegroundWindow: lib.func('void * __stdcall GetForegroundWindow()'),
  }
  return cached
}

function titleOf(api: User32Api, hwnd: any): string {
  const length = api.GetWindowTextLengthW(hwnd)
  if (length <= 0) return ''
  const buffer = Buffer.alloc((length + 1) * 2)
  api.GetWindowTextW(hwnd, buffer, length + 1)
  return buffer.toString('utf16le', 0, length * 2)
}

/** 恢复最小化/托盘中的 DSH，并把它切到前台。非 Windows 或找不到主窗口时返回 false。 */
export function focusDesktopMainWindow(): boolean {
  if (process.platform !== 'win32' || !process.ppid) return false
  try {
    const api = user32()
    let hwnd: any = null
    let fallback: any = null
    while ((hwnd = api.FindWindowExW(null, hwnd, null, null))) {
      const pid = [0]
      api.GetWindowThreadProcessId(hwnd, pid)
      if (pid[0] !== process.ppid) continue
      const title = titleOf(api, hwnd)
      if (!title.includes('DeepSeek Harness')) continue
      if (api.IsWindowVisible(hwnd)) { fallback = hwnd; break }
      fallback ??= hwnd
    }
    if (!fallback) return false
    // 最小化：实测 ShowWindow(SW_RESTORE) 恢复后页面仍可点击。
    // 托盘隐藏：绝不能走 ShowWindow，否则得到“看得见但点不动”的僵尸窗口。
    if (!api.IsWindowVisible(fallback)) return wakeDesktopApp()
    if (api.IsIconic(fallback)) api.ShowWindow(fallback, 9)
    // SwitchToThisWindow 是任务栏切换使用的同一入口，不需要先注入 Alt 键盘事件，
    // 因而不会把主窗留在菜单模式或吞掉后续鼠标点击。
    api.SwitchToThisWindow(fallback, true)
    const foreground = api.GetForegroundWindow()
    return typeof foreground === 'bigint' && typeof fallback === 'bigint'
      ? foreground === fallback
      : Number(foreground) === Number(fallback)
  } catch {
    return false
  }
}
