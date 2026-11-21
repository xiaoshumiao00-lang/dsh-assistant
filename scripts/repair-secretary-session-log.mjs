/**
 * 个人秘书 v4 日志修复 CLI（宿主真实解析器校验版）。
 *
 *   node scripts/repair-secretary-session-log.mjs [--dry-run] [--parser <宿主解析器 lib/index.js>] <session 目录 | session.v4.jsonl.zstd>
 *
 * 纪律（2026-11-21 事故后重写）：
 *   1. **不再自己写简化校验器**：合并/重编号后用宿主同一套解析器
 *      `@deepseek-ai/dsh-session-format-v3-to-v4` 的 restoreReleasedV4Artifact 做 dry-run；
 *   2. 写入前先备份 `<file>.bak-<时间戳>`，原子写（tmp + rename）；
 *   3. 写入后再解压回读、再用同一解析器校验一遍；
 *   4. 任何一步失败立即回滚到备份，绝不留下半截轮；
 *   5. 找不到宿主解析器就直接拒绝写入（fail closed），不做"看着差不多"的放行。
 *
 * 解析器位置：--parser > 环境变量 DSH_HOST_PARSER > 本机已知检出目录。
 * 事件词表：环境变量 DSH_HOST_SESSION_MODULE > 由解析器位置推出（packages/core/session/lib/index.js）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.assistantSecretaryTestSurface

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const parserIndex = argv.indexOf('--parser')
const parserPath = parserIndex >= 0 ? String(argv[parserIndex + 1] ?? '') : ''
const positional = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg.startsWith('--')) {
    if (arg === '--parser') index += 1
    continue
  }
  positional.push(arg)
}
const target = positional[0]
  ?? process.env.DSH_ASSISTANT_SECRETARY_SESSION_DIR
  ?? process.env.DSH_ASSISTANT_SESSION_DIR
  ?? ''
if (target === '') {
  throw new Error('usage: node scripts/repair-secretary-session-log.mjs [--dry-run] [--parser <lib/index.js>] <session-dir-or-jsonl-zstd>')
}
const logPath = existsSync(target) && statSync(target).isDirectory() ? join(target, 'session.v4.jsonl.zstd') : target
if (!existsSync(logPath)) throw new Error(`找不到会话日志：${logPath}`)

// fail closed：解析器拿不到就不写。
const parser = lib.loadHostLogParser(parserPath)

const originalText = lib.decompressLogBytes(readFileSync(logPath))
const details = surface.repairSecretaryLogLines(originalText.split(/\r?\n/))

const report = lib.rewriteSessionLogFileSync({
  file: logPath,
  parser,
  dryRun,
  transform: (text) => surface.repairSecretaryLogText(text),
})

console.log(JSON.stringify({
  target: logPath,
  dryRun: report.dryRun,
  parser: parser.source,
  vocabulary: parser.vocabulary,
  beforeEvents: report.beforeEvents,
  afterEvents: report.afterEvents,
  beforeBytes: report.beforeBytes,
  afterBytes: report.afterBytes,
  backupPath: report.backupPath || null,
  droppedOldSeqs: details.droppedOldSeqs,
  staleReferences: details.staleReferences,
  verifiedBy: 'restoreReleasedV4Artifact（宿主解析器，写入前 dry-run + 写入后回读）',
}, null, 2))
console.log(dryRun ? 'dry-run：只校验，没有写盘' : `replaced: ${logPath}`)
