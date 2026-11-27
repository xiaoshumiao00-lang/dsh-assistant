/**
 * 通道埋点：通道**开**时每次拦截写一行 JSONL（关时一行都不写，零开销）。
 * 目的：让「UIA 探针毫秒」「每帧注入词数」「编号命中/未命中」在 §14 里拿到**实跑数字**，
 * 而不是靠 sidecar 旁证去推。
 *
 * 落盘位置：\`<tmp>/dsh-cu-marks/metrics-<yyyy-mm-dd>.jsonl\`（系统临时目录，不污染仓库与桌面）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type MetricsEntry = {
  /** ISO 时间戳（毫秒） */
  at: string
  /** 工具名（click / screenshot / ...） */
  tool: string
  /** 页面缓存键（窗口类名｜标题｜宽x高） */
  page: string
  /** 这次拦截是否真的发了探针（false = 缓存命中） */
  probed: boolean
  /** 探针往返毫秒（缓存命中记 0） */
  probeMs: number
  /** 候选清单字符数 / 行数 */
  hintChars: number
  hintLines: number
  /** 换掉的 image 块数 / 画上的编号数 */
  replaced: number
  drawn: number
  /** 编号图合成+存取毫秒 */
  overlayMs: number
  /** 通道判定（ok / few-controls / too-slow / low-coverage / error / switch-off ...） */
  decision: string
}

export const METRICS_DIR_NAME = 'dsh-cu-marks'

export function metricsDir(): string {
  const dir = join(tmpdir(), METRICS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

function metricsFile(now = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return join(metricsDir(), 'metrics-' + day + '.jsonl')
}

/** 写一条埋点；任何 IO 异常都吞掉（埋点绝不许影响 CU）。 */
export function recordMetrics(entry: MetricsEntry): void {
  try {
    appendFileSync(metricsFile(), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 埋点失败就算了 */ }
}

export function metricsPath(now = new Date()): string {
  return metricsFile(now)
}
