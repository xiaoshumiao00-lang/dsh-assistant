/**
 * 真机探针演练：读一次**当前前台窗口**的控件树，打印真实耗时 / 控件数 / 通道判定 / 候选清单体积。
 *   node scripts/cu-uia-live-probe.mjs                 # 单次（含进程启动）
 *   node scripts/cu-uia-live-probe.mjs --repeat 3      # 同进程跑 3 次（看程序集加载后的稳定耗时）
 *   node scripts/cu-uia-live-probe.mjs --find 更多      # 看某个按钮是否在候选里（读得到 rect 就算命中）
 *
 * 只读演练：不点击、不输入、不改任何页面状态；拿不到树就如实打印「读不出」并给出退回原因。
 */
import { probeForeground, UIA_PS1_SCRIPT } from '../src/cu-uia-win.ts'
import { createUiaSidecar } from '../src/cu-uia-sidecar.ts'
import { decideControlChannel, pageCacheKey, planChannelFrame, planMarks, resolveChannelSwitch } from '../src/cu-uia-core.ts'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
function argOf(name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  const next = argv[index + 1]
  return next === undefined ? fallback : next
}
const repeat = Math.max(1, Math.min(10, Number(argOf('--repeat', '1')) || 1))
// --sidecar：走常驻 sidecar（42–48ms/次）；不加则走一次性进程（296–611ms/次，超 120ms 预算）
const useSidecar = argv.includes('--sidecar')
const find = String(argOf('--find', '') ?? '').trim()

const stamp = new Date().toISOString()

// 同进程重复：把脚本落盘一次，连跑 N 次（第二次起不再付程序集冷启动）
const dir = mkdtempSync(join(tmpdir(), 'dsh-cu-uia-live-'))
const file = join(dir, 'probe.ps1')
writeFileSync(file, UIA_PS1_SCRIPT, 'utf8')
const sidecar = useSidecar ? createUiaSidecar() : null
const runOnce = (script, args) => new Promise((resolve) => {
  const started = Date.now()
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, out) => {
    resolve({ stdout: String(out ?? ''), ms: Date.now() - started, error: error === null ? undefined : String(error?.message ?? error) })
  })
})

console.log(`时间戳 ${stamp}`)
const records = []
for (let i = 0; i < repeat; i += 1) {
  const outcome = sidecar !== null ? await sidecar.probe(200) : await probeForeground({ run: runOnce })
  const decision = decideControlChannel(outcome)
  const sw = resolveChannelSwitch({ env: process.env.DSH_CU_UIA })
  const marks = decision.enabled ? planMarks(outcome.controls, outcome.window?.rect ?? null) : []
  const plan = planChannelFrame({ switch: sw, decision, marks })
  records.push({ i: i + 1, ms: outcome.ms, ok: outcome.ok, error: outcome.error ?? '', controls: outcome.controls.length, enabled: decision.enabled, reason: decision.reason, switch: sw.reason, useMarks: plan.useMarks, copyFrame: plan.copyFrame, marks: plan.marks.length, hintChars: plan.hint.length })
  console.log(`  第 ${i + 1} 次：${outcome.ms} ms，控件 ${outcome.controls.length} 个，ok=${outcome.ok}${outcome.error === undefined ? '' : '，error=' + outcome.error}，探针判定=${decision.enabled ? '可用' : '不启动(' + decision.reason + ')'}，开关=${sw.enabled ? '开(' + sw.reason + ')' : '关(' + sw.reason + ')'}，编号 ${plan.marks.length} 个，清单 ${plan.hint.length} 字符，复制帧=${plan.copyFrame}`)
  if (i === 0) {
    const win = outcome.window
    console.log(`  窗口：class=${win?.className ?? ''} rect=${win === null ? '' : `${win.rect.w}x${win.rect.h}@(${win.rect.x},${win.rect.y})`}`)
    console.log(`  标题：${String(win?.title ?? '').slice(0, 80)}`)
    console.log(`  页面缓存键：${pageCacheKey(win)}`)
    if (plan.useMarks) {
      console.log('  前 8 个候选：')
      for (const line of plan.hint.split('\n').slice(0, 8)) console.log('    ' + line)
    } else {
      console.log('  这一帧不画编号、不返清单：帧原样交给模型（改动前行为）')
    }
    if (find !== '') {
      const hit = outcome.controls.filter((control) => String(control.name ?? '').includes(find))
      if (hit.length === 0) console.log(`  --find ${find}：控件树里没有（= 只能靠视觉）`)
      for (const control of hit.slice(0, 5)) {
        const cx = control.rect.x + Math.round(control.rect.w / 2)
        const cy = control.rect.y + Math.round(control.rect.h / 2)
        console.log(`  --find ${find}：命中 ${control.role} "${control.name}" rect=(${control.rect.x},${control.rect.y},${control.rect.w},${control.rect.h}) 中心=(${cx},${cy})`)
      }
    }
  }
}
const typical = records.slice(1).length > 0 ? records.slice(1) : records
const avg = typical.reduce((sum, r) => sum + r.ms, 0) / typical.length
console.log(`\n结论：探针 ${avg.toFixed(0)} ms/次（${typical.length} 次平均，${records[0].ms} ms 那次含程序集冷启动）；探针判定 = ${typical[0].enabled ? '可用' : '不启动(' + typical[0].reason + ')'}；开关 = ${typical[0].switch}`)
if (typical[0].useMarks === false) console.log('按第 ① / ③ 条硬约束：这一帧整段跳过候选清单与编号框，退回纯视觉（零开销，点击参数与改动前逐字节相同）。')
try { sidecar?.close() } catch {}
try { rmSync(dir, { recursive: true, force: true }) } catch {}
