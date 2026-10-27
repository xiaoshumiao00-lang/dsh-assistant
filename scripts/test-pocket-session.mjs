/** 登录会话密钥：同一安装多次启动保持一致，不同安装相互独立。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPocketSessionKey } from '../src/pocket-host/index.js'

const homeA = mkdtempSync(join(tmpdir(), 'dsh-pocket-session-a-'))
const homeB = mkdtempSync(join(tmpdir(), 'dsh-pocket-session-b-'))
try {
  const first = getPocketSessionKey(homeA)
  assert.match(first, /^[a-f0-9]{32}$/)
  assert.equal(getPocketSessionKey(homeA), first, 'HMR / 重启后必须沿用同一个 sessionKey')
  const other = getPocketSessionKey(homeB)
  assert.notEqual(other, first, '不同安装不能共用登录会话密钥')
  console.log('pocket-session: persistent across restart + isolated per home OK')
} finally {
  rmSync(homeA, { recursive: true, force: true })
  rmSync(homeB, { recursive: true, force: true })
}
