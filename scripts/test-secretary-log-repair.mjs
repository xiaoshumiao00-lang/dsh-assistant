/** 秘书 v4 日志损坏修复回归：半截合成轮必须被丢掉，保留真实助手轮且能重开。 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.assistantSecretaryTestSurface

function makeLine(seq, type, data = {}, extra = {}) {
  return JSON.stringify({ type, seq, time: 1000 + seq, data, ...extra })
}

function fixture() {
  const header = JSON.stringify({ type: 'session', version: 4, id: 'secretary', createdAt: 1, cwd: '', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })
  return [
    header,
    makeLine(300, 'turn/start', { turn: 1 }),
    makeLine(301, 'step/start', { turn: 1, step: 1 }),
    makeLine(302, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, stream: [] }, { surfaceOp: 'append' }),
    makeLine(303, 'step/end', { turn: 1, step: 1 }),
    makeLine(304, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    makeLine(305, 'turn/start', { turn: 2 }),
    makeLine(306, 'step/start', { turn: 2, step: 1 }),
    makeLine(307, 'session/title', { title: '个人秘书', messageSeqs: [], source: { kind: 'user' } }),
    makeLine(308, 'turn/start', { turn: 3 }),
    makeLine(309, 'step/start', { turn: 3, step: 1 }),
    makeLine(310, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] }),
    makeLine(311, 'turn/start', { turn: 2 }),
    makeLine(312, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    makeLine(313, 'step/start', { turn: 2, step: 1 }),
    makeLine(314, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '二' }] }, stream: [] }, { surfaceOp: 'append' }),
    makeLine(315, 'step/end', { turn: 2, step: 1 }),
    makeLine(316, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    makeLine(317, 'turn/start', { turn: 4 }),
    makeLine(318, 'step/start', { turn: 4, step: 1 }),
    makeLine(319, 'turn/start', { turn: 5 }),
    makeLine(320, 'step/start', { turn: 5, step: 1 }),
    makeLine(321, 'turn/start', { turn: 3 }),
    makeLine(322, 'step/start', { turn: 3, step: 1 }),
    makeLine(323, 'assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '三' }] }, stream: [] }, { surfaceOp: 'append' }),
    makeLine(324, 'step/end', { turn: 3, step: 1 }),
    makeLine(325, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
}

function validateFold(lines) {
  let openTurn = 0
  let openStep = 0
  let nextTurn = 1
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line)
    const data = event.data ?? {}
    const turn = Number(data.turn ?? 0)
    const step = Number(data.step ?? 0)
    if (event.type === 'turn/start') {
      assert.equal(openTurn, 0, `${event.seq} turn/start while a turn is open`)
      assert.equal(turn, nextTurn, `${event.seq} turn/start opens ${turn} but expects ${nextTurn}`)
      openTurn = turn
    }
    if (event.type === 'step/start') {
      assert.equal(openTurn, turn, `${event.seq} step/start without open turn ${openTurn}/${turn}`)
      assert.notEqual(openStep, step, `${event.seq} duplicate step/start`)
      openStep = step
    }
    if (event.type === 'assistant/message') {
      assert.equal(openTurn, turn, `${event.seq} assistant without open turn`)
      assert.equal(openStep, step, `${event.seq} assistant without open step`)
    }
    if (event.type === 'step/end') {
      assert.equal(openTurn, turn, `${event.seq} step/end without open turn`)
      assert.equal(openStep, step, `${event.seq} step/end without open step`)
      openStep = 0
    }
    if (event.type === 'turn/end') {
      assert.equal(openTurn, turn, `${event.seq} turn/end without open turn`)
      assert.equal(openStep, 0, `${event.seq} turn/end with open step`)
      openTurn = 0
      nextTurn = turn + 1
    }
  }
  assert.equal(openTurn, 0, 'log ends with an open turn')
  assert.equal(openStep, 0, 'log ends with an open step')
}

let failures = 0
async function run(name, fn) {
  try { await fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

await run('repairSecretaryLogLines is exported', () => {
  assert.equal(typeof surface.repairSecretaryLogLines, 'function')
})

await run('secretary log repair drops invalid synthetic fragments and validates', () => {
  const input = fixture()
  const before = input.length
  const result = surface.repairSecretaryLogLines(input)
  assert.ok(Array.isArray(result.lines))
  assert.equal(result.lines[0], input[0], 'header preserved')
  const parsed = result.lines.slice(1).map((line) => JSON.parse(line))
  const droppedSeqs = parsed.map((event) => event.seq)
  const assistantTexts = parsed.filter((event) => event.type === 'assistant/message').map((event) => event.data.message.content[0].text)
  assert.ok(assistantTexts.includes('二'), 'real assistant 2 kept')
  assert.ok(assistantTexts.includes('三'), 'real assistant 3 kept')
  assert.ok(droppedSeqs.length < before - 1, 'some invalid events dropped')
  assert.ok(droppedSeqs.every((seq, index) => seq === index), 'seqs renumbered contiguously')
  validateFold(result.lines)
})

await run('round trip compress and decompress preserves repaired text', () => {
  assert.equal(typeof surface.repairSecretaryLogText, 'function')
  assert.equal(typeof surface.compressSessionLogText, 'function')
  assert.equal(typeof surface.decompressSessionLogBytes, 'function')
  const input = fixture().join('\n') + '\n'
  const repaired = surface.repairSecretaryLogText(input)
  assert.ok(repaired.includes('二') && repaired.includes('三'))
  const compressed = surface.compressSessionLogText(repaired)
  assert.ok(compressed.length > 10)
  const decompressed = surface.decompressSessionLogBytes(compressed)
  assert.equal(decompressed, repaired)
  validateFold(decompressed.trim().split(/\r?\n/))
})

process.exit(failures === 0 ? 0 : 1)
