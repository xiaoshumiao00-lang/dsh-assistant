/**
 * Windows 侧 UIA 探针桥：把「前台窗口的控件树」读成纯数据（{ name, role, rect }）。
 *
 * 为什么要落成一个独立脚本：Node 侧没有 UIA 客户端，PowerShell 5.1 的
 * `System.Windows.Automation`（.NET Framework）是现成、无依赖、可一次性调起的最小通路；
 * PowerShell 7（.NET Core）加载不了这两个程序集，所以显式调 `powershell.exe`。
 *
 * 实测（2026-11-27，本机 1920×1032，Chrome PDF 文档页）：
 *   程序集冷启动 ~187ms；一次枚举（深度 ≤12、节点 ≤400）**470–522ms**，读到 123 个控件。
 * 由此得到两条硬结论（写进清单文档）：
 *   a. 探针**必须按页面缓存**（第 ② 条硬约束）——每帧重探会被 500ms 拖死；
 *   b. 探针**不能阻塞观察**：超预算就整帧退回纯视觉（第 ① 条），本模块只负责如实带回耗时。
 *
 * 本模块不接线任何现成管线（vendor/computer-use 的观察环不许改），只对外提供
 * `probeForeground()` 与 `parseUiaProbeJson()`，接线点见 docs/ComputerUse-优化-只增不减-改动清单-20261127.md。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UIA_MARK_MAX } from './cu-uia-core.ts'
import type { UiaControl, UiaProbeOutcome, UiaRect, UiaWindow } from './cu-uia-core.ts'

/** 探针脚本（PowerShell 5.1）：前台窗口 + 控件树（ControlViewWalker，跳过 offscreen 与 0 尺寸）。 */
export const UIA_PS1_SCRIPT = String.raw`
param([int]$MaxNodes = 400, [int]$MaxDepth = 12)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
if (-not ('DshWin32' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$hwnd = [DshWin32]::GetForegroundWindow()
$sbT = New-Object System.Text.StringBuilder 512
$null = [DshWin32]::GetWindowTextW($hwnd, $sbT, 512)
$sbC = New-Object System.Text.StringBuilder 512
$null = [DshWin32]::GetClassNameW($hwnd, $sbC, 512)
$r = New-Object DshWin32+RECT
$null = [DshWin32]::GetWindowRect($hwnd, [ref]$r)
$out = [ordered]@{ ok = $false; reason = ''; hwnd = [int64]$hwnd; title = $sbT.ToString(); className = $sbC.ToString(); frame = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)); controls = @(); nodeCount = 0; ms = 0 }
try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $list = New-Object System.Collections.ArrayList
  function Walk([object]$el, [int]$depth) {
    if ($null -eq $el) { return }
    if ($list.Count -ge $MaxNodes) { return }
    if ($depth -gt $MaxDepth) { return }
    try { $off = $el.Current.IsOffscreen } catch { $off = $true }
    if (-not $off) {
      $rect = $el.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        $role = [string]$el.Current.ControlType.ProgrammaticName
        if ($role.StartsWith('ControlType.')) { $role = $role.Substring(12) }
        $null = $list.Add([pscustomobject]@{
          name = [string]$el.Current.Name
          role = $role
          id = [string]$el.Current.AutomationId
          x = [int]$rect.X
          y = [int]$rect.Y
          w = [int]$rect.Width
          h = [int]$rect.Height
          enabled = [bool]$el.Current.IsEnabled
        })
      }
    }
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      if ($list.Count -ge $MaxNodes) { return }
      Walk $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  Walk $root 0
  $out.controls = $list.ToArray()
  $out.nodeCount = $list.Count
  $out.ok = $true
} catch {
  $out.reason = [string]$_.Exception.Message
}
$sw.Stop()
$out.ms = [int]$sw.ElapsedMilliseconds
$out | ConvertTo-Json -Depth 4 -Compress
`

/** 单个前台探针的默认超时：超时不是错误，按「读不出」处理（第 ① 条）。 */
export const UIA_PROBE_TIMEOUT_MS = 1500

function toRect(x: unknown, y: unknown, w: unknown, h: unknown): UiaRect {
  const num = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  return { x: num(x), y: num(y), w: Math.max(0, num(w)), h: Math.max(0, num(h)) }
}

/**
 * 解析探针 JSON（纯函数：离线单测直接喂样本，不需要真跑 PowerShell）。
 * 形状不对一律回「读不出」，并把原因写进 error——调用方据此整帧退回纯视觉。
 */
export function parseUiaProbeJson(raw: unknown, opts: { ms?: number } = {}): UiaProbeOutcome {
  let data: any = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return { ok: false, window: null, controls: [], ms: Number(opts.ms ?? 0), error: 'empty-output' }
    try { data = JSON.parse(text) } catch { return { ok: false, window: null, controls: [], ms: Number(opts.ms ?? 0), error: 'bad-json' } }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, window: null, controls: [], ms: Number(opts.ms ?? 0), error: 'bad-shape' }
  }
  const frame = Array.isArray(data.frame) ? data.frame : []
  const rect = toRect(frame[0], frame[1], frame[2], frame[3])
  const ms = Number.isFinite(Number(data.ms)) ? Number(data.ms) : Number(opts.ms ?? 0)
  const window: UiaWindow = { title: String(data.title ?? ''), className: String(data.className ?? ''), rect }
  const list = Array.isArray(data.controls) ? data.controls : []
  const controls: UiaControl[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const control: UiaControl = {
      name: String(entry.name ?? '').replace(/\s+/g, ' ').trim(),
      role: String(entry.role ?? '').trim(),
      rect: toRect(entry.x, entry.y, entry.w, entry.h),
      enabled: entry.enabled !== false,
    }
    const automationId = String(entry.id ?? '').trim()
    if (automationId !== '') control.automationId = automationId
    controls.push(control)
  }
  if (data.ok !== true) {
    const reason = String(data.reason ?? '').trim()
    return { ok: false, window, controls, ms, error: reason === '' ? 'probe-failed' : reason }
  }
  return { ok: controls.length > 0, window, controls, ms, ...(controls.length > 0 ? {} : { error: 'no-controls' }) }
}

/** 默认执行器：把脚本落到临时文件，用 powershell.exe 跑一次，量总耗时（含进程启动）。 */
async function runPowerShell(script: string, args: string[]): Promise<{ stdout: string; ms: number; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cu-uia-'))
  const file = join(dir, 'probe.ps1')
  writeFileSync(file, script, 'utf8')
  const started = Date.now()
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
        { timeout: UIA_PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, out) => {
          if (error !== null) reject(error)
          else resolve(String(out ?? ''))
        },
      )
    })
    return { stdout, ms: Date.now() - started }
  } catch (error: any) {
    return { stdout: '', ms: Date.now() - started, error: String(error?.message ?? error) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 读一次前台窗口的控件树。耗时包含进程启动（实测约 187ms 程序集冷启动 + 一次枚举）。
 * `run` 可注入（单测/演练用假执行器；真实接线时换成常驻 sidecar 才不会每帧付进程费）。
 */
export async function probeForeground(opts: {
  run?: (script: string, args: string[]) => Promise<{ stdout: string; ms: number; error?: string }>
  maxNodes?: number
  maxDepth?: number
} = {}): Promise<UiaProbeOutcome> {
  const run = typeof opts.run === 'function' ? opts.run : runPowerShell
  const maxNodes = Math.max(1, Math.min(UIA_MARK_MAX * 10, Number(opts.maxNodes ?? 400)))
  const maxDepth = Math.max(1, Math.min(24, Number(opts.maxDepth ?? 12)))
  const result = await run(UIA_PS1_SCRIPT, ['-MaxNodes', String(maxNodes), '-MaxDepth', String(maxDepth)])
  if (result.error !== undefined && result.error !== '') {
    return { ok: false, window: null, controls: [], ms: result.ms, error: result.error }
  }
  return parseUiaProbeJson(result.stdout, { ms: result.ms })
}
