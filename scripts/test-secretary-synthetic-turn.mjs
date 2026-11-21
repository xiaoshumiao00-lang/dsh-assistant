/** 合成秘书完成轮回归：必须完整落盘、不得在已有开轮时留下半截事件。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.assistantCuWatchTestSurface

class HostLikeSession {
  #maxClosedTurn = 0
  #openTurn = 0
  #openStep = 0
  events = []

  constructor(open = false) {
    const seed = open ? 'open' : 'closed'
    if (seed === 'closed') {
      this.#appendKnown('turn/start', { turn: 8 })
      this.#appendKnown('step/start', { turn: 8, step: 1 })
      this.#appendKnown('assistant/message', {
        turn: 8, step: 1,
        message: makeAssistantMessage('old'),
        stream: [{ type: 'chunk', chunk: { type: 'text', text: 'old' } }],
      }, { surfaceOp: 'append' })
      this.#appendKnown('step/end', { turn: 8, step: 1 })
      this.#appendKnown('turn/end', { turn: 8, reason: { kind: 'completed' } })
    } else {
      this.#appendKnown('turn/start', { turn: 9 })
      this.#appendKnown('step/start', { turn: 9, step: 1 })
    }
  }

  snapshotEvents() { return [...this.events] }
  append(type, data, opts) {
    this.#validate(type, data, opts)
    return this.#appendKnown(type, data, opts)
  }

  #appendKnown(type, data, opts) {
    const event = {
      seq: this.events.length + 1,
      time: Date.now(),
      type,
      ...(opts ? { surfaceOp: opts.surfaceOp } : {}),
      data,
    }
    this.events.push(event)
    if (type === 'turn/start') this.#openTurn = Number(data.turn)
    if (type === 'step/start') this.#openStep = Number(data.step)
    if (type === 'step/end') this.#openStep = 0
    if (type === 'turn/end') {
      this.#maxClosedTurn = Number(data.turn)
      this.#openTurn = 0
    }
    return event
  }

  #validate(type, data, opts) {
    if (type === 'turn/start') {
      const expectedTurn = this.#openTurn === 0 ? this.#maxClosedTurn + 1 : this.#maxClosedTurn + 1
      if (this.#openTurn !== 0 || Number(data.turn) !== expectedTurn) {
        throw new Error('turn/start does not open the expected turn')
      }
    }
    if (type === 'assistant/message') {
      if (opts?.surfaceOp !== 'append') throw new Error('assistant/message requires surfaceOp')
      const keys = Object.keys(data ?? {}).sort()
      const required = ['message', 'step', 'stream', 'turn']
      for (const key of required) if (!keys.includes(key)) throw new Error(`assistant/message missing ${key}`)
      if (keys.some((key) => !required.includes(key) && key !== 'usage' && key !== 'interrupted')) {
        throw new Error('assistant/message has unknown key')
      }
      validateAssistantMessage(data.message)
      if (!Array.isArray(data.stream)) throw new Error('assistant/message stream must be array')
    }
  }
}

function makeAssistantMessage(text) {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'dsh-assistant', model: 'seed' },
  }
}

function validateAssistantMessage(value) {
  const required = ['content', 'id', 'role', 'source']
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('assistant message must be object')
  const keys = Object.keys(value).sort()
  for (const key of required) if (!keys.includes(key)) throw new Error(`assistant message missing ${key}`)
  if (keys.some((key) => !required.includes(key) && key !== 'replayState')) throw new Error('assistant message has unknown key')
  if (value.role !== 'assistant') throw new Error('assistant message role must be assistant')
  if (value.source?.kind !== 'model') throw new Error('assistant message source kind must be model')
  if (!Array.isArray(value.content)) throw new Error('assistant message content must be array')
}


let failures = 0
async function run(name, fn) {
  try {
    await fn()
    console.log('PASS', name)
  } catch (error) {
    failures++
    console.error('FAIL', name, error?.message ?? error)
  }
}

await run('complete synthetic assistant notice uses host append options', async () => {
  assert.equal(typeof surface.postSecretaryNotice, 'function')
  const session = new HostLikeSession(false)
  const before = session.events.length
  const ok = surface.postSecretaryNotice(session, { sessionId: 'cu-1', title: '任务', summary: '完成' })
  assert.equal(ok, true, 'postSecretaryNotice should succeed with a valid host append contract')
  assert.equal(session.events.length, before + 5, 'complete notice writes five events')
  assert.deepEqual(session.events.slice(-5).map((event) => event.type), [
    'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.equal(session.events.at(-3).surfaceOp, 'append', 'assistant event must declare surfaceOp append')
  assert.deepEqual(session.events.at(-1).data.reason, { kind: 'completed' })
})

await run('open secretary turn is rejected without partial journal append', async () => {
  assert.equal(typeof surface.secretaryTurnState, 'function')
  const session = new HostLikeSession(true)
  const before = session.events.length
  const ok = surface.postSecretaryNotice(session, { sessionId: 'cu-2', title: '任务', summary: '完成' })
  assert.equal(ok, false)
  assert.equal(session.events.length, before, 'busy session must not append anything')
  assert.equal(surface.secretaryTurnState(session.snapshotEvents()).openTurn, 9)
})

await run('next expected turn comes from closed max turn plus one', async () => {
  assert.equal(typeof surface.secretaryTurnState, 'function')
  const events = [{ type: 'turn/end', data: { turn: 12, reason: { kind: 'completed' } } }]
  assert.deepEqual(surface.secretaryTurnState(events), { openTurn: 0, nextTurn: 13 })
})

process.exit(failures === 0 ? 0 : 1)
