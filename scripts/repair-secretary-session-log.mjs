/**
 * 个人秘书 v4 日志修复 CLI：
 *   node scripts/repair-secretary-session-log.mjs [--dry-run] <session-dir-or-jsonl-zstd>
 * 默认目标来自环境变量 DSH_ASSISTANT_SECRETARY_SESSION_DIR（或 DSH_ASSISTANT_SESSION_DIR），脚本本身不写死个人目录。
 */
import { createRequire } from 'node:module'
import { renameSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.assistantSecretaryTestSurface

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const target = args[0] ?? process.env.DSH_ASSISTANT_SECRETARY_SESSION_DIR ?? process.env.DSH_ASSISTANT_SESSION_DIR ?? ''
if (target === '') throw new Error('usage: node scripts/repair-secretary-session-log.mjs [--dry-run] <session-dir-or-jsonl-zstd>')
const dryRun = process.argv.includes('--dry-run')
const logPath = existsSync(target) && statSync(target).isDirectory() ? join(target, 'session.v4.jsonl.zstd') : target
const dir = dirname(logPath)

const original = readFileSync(logPath)
const decompressed = surface.decompressSessionLogBytes(original)
const repaired = surface.repairSecretaryLogText(decompressed)
const compressed = surface.compressSessionLogText(repaired)
const roundtrip = surface.decompressSessionLogBytes(compressed)
if (roundtrip !== repaired) throw new Error('round trip mismatch')

function validate(text) {
  let openTurn = 0
  let openStep = 0
  let nextTurn = 1
  let nextStep = 1
  let seq = 0
  let sawHeader = false
  for (const line of text.trimEnd().split(/\r?\n/)) {
    if (line.trim() === '') continue
    const event = JSON.parse(line)
    if (!sawHeader) {
      if (event.type !== 'session' || event.seq !== undefined) throw new Error('missing v4 header line')
      sawHeader = true
      seq = -1
      continue
    }
    if (Number(event.seq) !== ++seq) throw new Error(`event ${event.type} has bad seq ${event.seq}, expected ${seq}`)
    const data = event.data ?? {}
    const turn = Number(data.turn ?? 0)
    const step = Number(data.step ?? 0)
    if (event.type === 'turn/start') {
      if (openTurn !== 0 || turn !== nextTurn) throw new Error(`turn/start ${event.seq} opens ${turn} but expects ${nextTurn} open=${openTurn}`)
      openTurn = turn
      openStep = 0
      nextStep = 1
    }
    if (event.type === 'step/start') {
      if (openTurn === 0 || openTurn !== turn || openStep !== 0 || step !== nextStep) throw new Error(`step/start ${event.seq} invalid open=${openTurn}/${openStep} step=${step} expected=${nextStep}`)
      openStep = step
    }
    if (event.type === 'step/end') {
      if (openTurn === 0 || openTurn !== turn || openStep !== step) throw new Error(`step/end ${event.seq} invalid open=${openTurn}/${openStep}`)
      openStep = 0
      nextStep = step + 1
    }
    if (event.type === 'turn/end') {
      if (openTurn === 0 || openTurn !== turn || openStep !== 0) throw new Error(`turn/end ${event.seq} invalid open=${openTurn}/${openStep}`)
      openTurn = 0
      nextTurn = turn + 1
      nextStep = 1
    }
    if (['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type)) {
      if (openTurn === 0 || openTurn !== turn || openStep !== step) throw new Error(`${event.type} ${event.seq} invalid open=${openTurn}/${openStep}`)
    }
  }
  if (!sawHeader) throw new Error('empty repaired log')
  if (openTurn !== 0 || openStep !== 0) throw new Error('repaired log ends with open turn/step')
}

validate(roundtrip)
const repairedLines = repaired.trimEnd().split(/\r?\n/)
const originalLines = decompressed.trimEnd().split(/\r?\n/)
const result = surface.repairSecretaryLogLines(originalLines)
console.log(JSON.stringify({
  target: logPath,
  dryRun,
  originalBytes: original.length,
  originalLines: originalLines.length,
  repairedLines: repairedLines.length,
  droppedOldSeqs: result.droppedOldSeqs,
  staleReferences: result.staleReferences,
}, null, 2))

if (dryRun) {
  const out = join(dir, 'session.v4.jsonl.zstd.repaired-preview.jsonl')
  writeFileSync(out, repaired, 'utf8')
  const outZstd = join(dir, 'session.v4.jsonl.zstd.repaired-preview.jsonl.zstd')
  writeFileSync(outZstd, compressed)
  console.log('preview:', out)
  console.log('preview:', outZstd)
} else {
  const tmp = join(dir, `session.v4.jsonl.zstd.repairing-${Date.now()}`)
  writeFileSync(tmp, compressed)
  validate(surface.decompressSessionLogBytes(readFileSync(tmp)))
  renameSync(tmp, logPath)
  const decompressedOut = join(dir, 'session.v4.jsonl.zstd.decompressed.jsonl')
  if (existsSync(decompressedOut)) writeFileSync(decompressedOut, repaired, 'utf8')
  console.log('replaced:', logPath)
}
