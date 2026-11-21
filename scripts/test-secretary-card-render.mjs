/** 卡片规范纯渲染回归：标题/正文拆分、加粗与模型标签。 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.secretaryCardsTestSurface

let failures = 0
async function run(name, fn) {
  try { await fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

await run('exports answer body renderer', () => {
  assert.equal(typeof surface.parseAnswerBody, 'function')
  assert.equal(typeof surface.answerInlineTokens, 'function')
})

await run('parseAnswerBody keeps one conclusion title and later paragraphs', () => {
  const parsed = surface.parseAnswerBody('我目前无法查看你打开的 QQ 页面\n\n第一段正文\n第二段正文')
  assert.equal(parsed.title, '我目前无法查看你打开的 QQ 页面')
  assert.deepEqual(parsed.paragraphs, ['第一段正文', '第二段正文'])
})

await run('answerInlineTokens marks strong and model code labels', () => {
  const tokens = surface.answerInlineTokens('型号是 qwen3.8-flash-next，量化版本是 IQ3_XXS。**关键句**')
  const models = tokens.filter((token) => token.kind === 'model').map((token) => token.value)
  const strong = tokens.filter((token) => token.kind === 'strong').map((token) => token.value)
  assert.deepEqual(models, ['qwen3.8-flash-next', 'IQ3_XXS'])
  assert.deepEqual(strong, ['关键句'])
  assert.equal(tokens.some((token) => token.kind === 'strong' && token.value === '关键句'), true)
})

process.exit(failures === 0 ? 0 : 1)
