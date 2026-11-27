/**
 * 实测：常驻 sidecar 能不能把「单页探针」压进 **120ms** 预算（保底 ① 不许放宽）。
 *   node scripts/cu-uia-sidecar-bench.mjs            # 默认 10 次
 *   node scripts/cu-uia-sidecar-bench.mjs --runs 20
 *
 * 输出：ready 时间、每次往返毫秒（含 sidecar 内部枚举毫秒）、p50/p95/max、控件数、
 * 以及「按 120ms 预算这一帧是启动还是退回」。p95 ≥ 120ms → 退出码 1（= 不许接后续步骤）。
 */
import { createUiaSidecar } from '../src/cu-uia-sidecar.ts'
import { decideControlChannel, pageCacheKey, planChannelFrame, planMarks, resolveChannelSwitch, UIA_PROBE_BUDGET_MS } from '../src/cu-uia-core.ts'

const argv = process.argv.slice(2)
const runsArg = argv.indexOf('--runs')
const runs = Math.max(3, Math.min(50, Number(runsArg === -1 ? '10' : argv[runsArg + 1]) || 10))

const sidecar = createUiaSidecar()
const samples = []
let first = null
let lastWindow = null
let controls = 0
try {
  for (let i = 0; i < runs; i += 1) {
    const outcome = await sidecar.probe(200)
    samples.push(outcome.ms)
    if (i === 0) first = outcome
    if (outcome.ok && outcome.window !== null) lastWindow = outcome.window
    controls = outcome.controls.length
  }
  const stats = sidecar.stats()
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
  const p50 = pick(0.5)
  const p95 = pick(0.95)
  const max = sorted[sorted.length - 1]
  const min = sorted[0]
  console.log('== 常驻 sidecar 探针实测（' + new Date().toISOString() + '）==')
  console.log(`  sidecar ready：${stats.readyMs} ms（程序集只加载这一次）`)
  console.log(`  请求 ${stats.requests} 次，超时 ${stats.timeouts} 次；每次往返：${samples.join(' / ')} ms`)
  console.log(`  p50 ${p50} ms，p95 ${p95} ms，min ${min} ms，max ${max} ms，预算 ${UIA_PROBE_BUDGET_MS} ms`)
  console.log(`  前台窗口：${lastWindow === null ? '(未读到)' : lastWindow.className + ' ' + lastWindow.rect.w + 'x' + lastWindow.rect.h}`)
  console.log(`  可点控件：${controls} 个；页面缓存键：${pageCacheKey(lastWindow)}`)

  const decision = decideControlChannel(first)
  const sw = resolveChannelSwitch({ env: process.env.DSH_CU_UIA })
  const marks = decision.enabled ? planMarks(first.controls, first.window?.rect ?? null) : []
  const plan = planChannelFrame({ switch: sw, decision, marks })
  console.log(`  最近一帧：探针判定=${decision.enabled ? '可用' : '不启动(' + decision.reason + ')'}，开关=${sw.enabled ? '开(' + sw.reason + ')' : '关(' + sw.reason + ')'}，编号 ${plan.marks.length} 个，清单 ${plan.hint.length} 字符，复制帧=${plan.copyFrame}`)
  console.log(p95 < UIA_PROBE_BUDGET_MS
    ? `RESULT: PASS（p95 ${p95} ms < 预算 ${UIA_PROBE_BUDGET_MS} ms，sidecar 站得住）`
    : `RESULT: FAIL（p95 ${p95} ms ≥ 预算 ${UIA_PROBE_BUDGET_MS} ms，按口径不许接后续步骤）`)
  if (p95 >= UIA_PROBE_BUDGET_MS) process.exitCode = 1
} finally {
  sidecar.close()
}
