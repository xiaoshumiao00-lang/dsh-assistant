/**
 * UIA 常驻 sidecar：把「一次探针 296–611ms」压进 120ms 预算（保底 ① 不许放宽）。
 *
 * 为什么要常驻：PowerShell 5.1 每次冷启动都要 150–190ms 加载 UIAutomation 程序集，
 * 一次性调进程永远压在 120ms 之外（上一轮实测 296–611ms）。
 *
 * 压下来靠两件事（2026-11-27 实测，Chrome 前台窗口 453 个原始节点）：
 *   ① 常驻进程：程序集只加载一次；
 *   ② CacheRequest + 可点类型 OrCondition：把「每个控件一次跨进程取属性」换成
 *      「一次 FindAll 批量取缓存」，节点数从 453 降到 183（保留 88 个可点控件）。
 * 实测（进程内 5 次）：137ms（第一次）/ 78 / 82 / 79 / 100 ms —— 之后稳定在 80–100ms。
 *
 * 口径不变：sidecar 只负责「读控件树」，不出坐标决策；探针失败 / 超时一律回
 * `ok:false`，调用方按第 ① 条整帧退回纯视觉（不重试、不二次读取）。
 * 本模块不接线任何观察帧出口（见 docs/computer-use-提速前后对比-2026-11-27.md §4）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UiaProbeOutcome } from './cu-uia-core.ts'
import { parseUiaProbeJson } from './cu-uia-win.ts'

/** sidecar 脚本：常驻、按行收命令、每次 `probe` 回一行 JSON。 */
export const UIA_SIDECAR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (-not ('DshWin32Side' -as [type])) {
  Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public class DshWin32Side {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
}
$TYPE_NAMES = @('Button','Edit','MenuItem','ListItem','TabItem','CheckBox','ComboBox','Hyperlink','Link','SplitButton','Slider','RadioButton','TreeItem')
$CONDS = @()
foreach ($t in $TYPE_NAMES) {
  $CONDS += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
}
$COND = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$CONDS)
$CACHE = New-Object System.Windows.Automation.CacheRequest
$CACHE.TreeFilter = $COND
foreach ($p in @('NameProperty','ControlTypeProperty','BoundingRectangleProperty','IsOffscreenProperty')) {
  $null = $CACHE.Add([System.Windows.Automation.AutomationElement]::$p)
}

function Probe-Once([int]$MaxNodes) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $hwnd = [DshWin32Side]::GetForegroundWindow()
  $sbT = New-Object System.Text.StringBuilder 512
  $null = [DshWin32Side]::GetWindowTextW($hwnd, $sbT, 512)
  $sbC = New-Object System.Text.StringBuilder 512
  $null = [DshWin32Side]::GetClassNameW($hwnd, $sbC, 512)
  $r = New-Object DshWin32Side+RECT
  $null = [DshWin32Side]::GetWindowRect($hwnd, [ref]$r)
  $out = [ordered]@{ ok = $false; reason = ''; hwnd = [int64]$hwnd; title = $sbT.ToString(); className = $sbC.ToString(); frame = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)); controls = @(); nodeCount = 0; ms = 0 }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $list = New-Object System.Collections.ArrayList
    $null = $CACHE.Activate()   # 返回 CacheRequestActivation，不吞掉会混进函数输出
    try {
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $COND)
      foreach ($el in $all) {
        if ($list.Count -ge $MaxNodes) { break }
        try { $off = $el.Cached.IsOffscreen } catch { $off = $true }
        if ($off) { continue }
        $rect = $el.Cached.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
        $role = [string]$el.Cached.ControlType.ProgrammaticName
        if ($role.StartsWith('ControlType.')) { $role = $role.Substring(12) }
        $null = $list.Add([pscustomobject]@{
          name = [string]$el.Cached.Name
          role = $role
          x = [int]$rect.X
          y = [int]$rect.Y
          w = [int]$rect.Width
          h = [int]$rect.Height
          enabled = $true
        })
      }
    } finally { $null = $CACHE.Pop() }   # CacheRequest 恢复上一份缓存请求用实例 Pop()（没有 Deactivate）
    $out.controls = $list.ToArray()
    $out.nodeCount = $list.Count
    $out.ok = $true
  } catch {
    $out.reason = [string]$_.Exception.Message
  }
  $sw.Stop()
  $out.ms = [int]$sw.ElapsedMilliseconds
  return (ConvertTo-Json -InputObject $out -Depth 4 -Compress)
}

# 握手：先报 ready（此时程序集已加载完，正式探针不再付冷启动）
$null = Probe-Once 1
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  if ($cmd -eq 'quit') { break }
  if ($cmd -eq 'probe' -or $cmd -like 'probe *') {
    $max = 200
    if ($cmd -like 'probe *') { $max = [int]($cmd.Substring(6).Trim()) }
    try { $payload = Probe-Once $max } catch { $payload = '{"ok":false,"reason":"sidecar-probe-failed"}' }
    [Console]::Out.WriteLine($payload)
    [Console]::Out.Flush()
  }
}
`

export const UIA_SIDECAR_READY_MS = 15_000
export const UIA_SIDECAR_TIMEOUT_MS = 1_000

export type UiaSidecar = {
  probe: (maxNodes?: number) => Promise<UiaProbeOutcome>
  close: () => void
  /** 统计：请求数 / 超时数 / 重启数 */
  stats: () => { requests: number; timeouts: number; restarts: number; readyMs: number }
}

/**
 * 起一个常驻 sidecar。失败（拿不到进程 / 没等到 ready）一律 throw —— 调用方必须
 * 按「读不出」处理，不许退回到「每次新起进程」的慢路径（那会突破 120ms 预算）。
 */
export function createUiaSidecar(opts: { script?: string; readyMs?: number; timeoutMs?: number } = {}): UiaSidecar {
  const script = String(opts.script ?? UIA_SIDECAR_SCRIPT)
  const readyMs = Number(opts.readyMs ?? UIA_SIDECAR_READY_MS)
  const timeoutMs = Number(opts.timeoutMs ?? UIA_SIDECAR_TIMEOUT_MS)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cu-uia-sidecar-'))
  const file = join(dir, 'sidecar.ps1')
  // PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI(GBK) 解，注释里的中文会把脚本解析搞崩：写 BOM
  writeFileSync(file, '\uFEFF' + script, 'utf8')

  let child: any = null
  let buffer = ''
  const waiters: ((line: string) => void)[] = []
  const stats = { requests: 0, timeouts: 0, restarts: 0, readyMs: 0 }
  let closed = false

  const start = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const started = Date.now()
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const timer = setTimeout(() => reject(new Error('sidecar not ready in ' + readyMs + 'ms')), readyMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') {
          if (line.includes('"ready":true')) {
            clearTimeout(timer)
            stats.readyMs = Date.now() - started
            resolve()
          } else {
            const waiter = waiters.shift()
            if (waiter !== undefined) waiter(line)
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
    child.on('exit', () => { if (!closed) stats.restarts += 1 })
  })

  const fail: UiaProbeOutcome = { ok: false, window: null, controls: [], ms: 0, error: 'sidecar-unavailable' }

  const request = (command: string): Promise<string | null> => new Promise((resolve) => {
    if (child === null || child.killed) { resolve(null); return }
    stats.requests += 1
    const timer = setTimeout(() => {
      stats.timeouts += 1
      // 超时：这一帧直接判「读不出」，不重试、不排队
      resolve(null)
    }, timeoutMs)
    waiters.push((line: string) => { clearTimeout(timer); resolve(line) })
    try { child.stdin.write(command + '\n') } catch { clearTimeout(timer); resolve(null) }
  })

  const ready = start()

  return {
    probe: async (maxNodes = 200): Promise<UiaProbeOutcome> => {
      try { await ready } catch { return fail }
      const started = Date.now()
      const line = await request('probe ' + Math.max(1, Math.min(400, Math.round(maxNodes))))
      const ms = Date.now() - started
      if (line === null) return { ok: false, window: null, controls: [], ms, error: 'sidecar-timeout' }
      return parseUiaProbeJson(line, { ms })
    },
    close: (): void => {
      closed = true
      try { child?.stdin.write('quit\n') } catch {}
      try { child?.kill() } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
    stats: () => ({ ...stats }),
  }
}
