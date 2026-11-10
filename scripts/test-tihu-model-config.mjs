/**
 * 鹈鹕端「默认前台/后台模型 + 默认云音色」的契约测试：
 *   node scripts/test-tihu-model-config.mjs
 *
 * 覆盖三条链路，缺一条这项设置就是「看着生效、其实没接」：
 *   1. 云音色清单（设置页下拉 / 校验白名单 / 设备默认值 / 试听句）是同一份数据；
 *   2. 配置值 → `resolveTihuModel()` 的解析（环境变量最高优先，其次 config.json）；
 *   3. 配置值 → 会话的最后一跳 `selectModelKeepingDefault()`：
 *      必须调宿主的 `sessionController.selectModel`，且**把全局默认模型放回去**。
 *
 * 说明：宿主 `session.create` 没有 model 字段（见 src/tihu/model-select.ts 顶部），
 * 所以这里不验「create 带模型」，只验「create 之后 selectModel」这条真实通路。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cloud = await import('../src/tihu/cloud-voices.ts')
const models = await import('../src/tihu/model-select.ts')

const tempHome = mkdtempSync(join(tmpdir(), 'tihu-model-config-'))
const configFile = join(tempHome, 'config.json')

const cases = []
const test = (name, run) => cases.push([name, run])

/* ─────────────── 1. 云音色清单 ─────────────── */

test('云端音色清单：4 个 zh-CN-*Neural，默认云健，本地 Kokoro 一律不算', () => {
  assert.deepEqual(cloud.TIHU_CLOUD_VOICES.map((voice) => voice.id), [
    'zh-CN-YunjianNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunyangNeural',
  ], '清单与设备页写死的那 4 项 + 顺序必须一致（别悄悄改默认声音）')
  assert.equal(cloud.TIHU_CLOUD_VOICE_DEFAULT, 'zh-CN-YunjianNeural', '默认云音色必须还是云健')
  assert.equal(cloud.isTihuCloudVoice('zh-CN-XiaoxiaoNeural'), true)
  for (const bad of ['zf_060', 'zm_100', '35', 'sid35', '', 'zh-CN-Yunjian', 'kokoro']) {
    assert.equal(cloud.isTihuCloudVoice(bad), false, `${bad} 不该被当成云端音色`)
  }
  assert.equal(cloud.tihuCloudVoiceLabel('zh-CN-XiaoxiaoNeural'), '晓晓 Xiaoxiao（女声）')
  assert.equal(cloud.tihuCloudVoiceShortName('zh-CN-XiaoxiaoNeural'), '晓晓')
  assert.equal(cloud.tihuCloudVoiceShortName('unknown-id'), '云健', '未知 id 退回默认音色的短名')
})

test('试听句跟着云端音色走（设了晓晓就别念「我是云健」）', async () => {
  const { tihuSampleTextOf } = await import('../src/tihu/lane.ts')
  assert.equal(tihuSampleTextOf('zh-CN-YunjianNeural'), '试听：我是云健，声音正常吗？', '没配置时逐字保持原句')
  assert.equal(tihuSampleTextOf(''), '试听：我是云健，声音正常吗？')
  assert.equal(tihuSampleTextOf('zh-CN-XiaoxiaoNeural'), '试听：我是晓晓，声音正常吗？')
})

/* ─────────────── 2. 配置值解析（环境变量 > config.json） ─────────────── */

test('resolveTihuModel：环境变量最高优先，其次 config.json 的 tihu 段', () => {
  const tihu = { model: { foreground: { provider: 'p1', model: 'm1' }, background: { provider: 'p2', model: 'm2', reasoningEffort: 'high' } } }
  assert.deepEqual(models.resolveTihuModel('foreground', tihu, {}), { provider: 'p1', model: 'm1' })
  assert.deepEqual(models.resolveTihuModel('background', tihu, {}), { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
  // 环境变量覆盖（临时排障用）
  assert.deepEqual(
    models.resolveTihuModel('foreground', tihu, { TIHU_MODEL_FOREGROUND: 'envprov/envmodel' }),
    { provider: 'envprov', model: 'envmodel' },
  )
  assert.deepEqual(
    models.resolveTihuModel('background', tihu, { TIHU_MODEL_BACKGROUND: 'x/y' }),
    { provider: 'x', model: 'y' },
  )
  // 没配 = null（跟随宿主默认，行为与改动前一致）
  assert.equal(models.resolveTihuModel('foreground', undefined, {}), null)
  assert.equal(models.resolveTihuModel('background', { model: { background: null } }, {}), null)
  // 坏形状一律当没配，不抛
  assert.equal(models.resolveTihuModel('foreground', { model: { foreground: { provider: '', model: 'm' } } }, {}), null)
  assert.equal(models.resolveTihuModel('foreground', { model: { foreground: 'nope' } }, {}), null)
  assert.equal(models.tihuModelEnvOverride('foreground', { TIHU_MODEL_FOREGROUND: 'no-slash' }), null)
})

/* ─────────────── 3. 会话最后一跳：selectModel + 还原全局默认 ─────────────── */

function fakeHost(options = {}) {
  const calls = { select: [], saved: [], inflight: 0, maxInflight: 0 }
  const previous = options.previous === undefined ? { provider: 'base', model: 'base-model' } : options.previous
  const ctx = {
    get(id) {
      if (id === 'sessionController') {
        if (options.noSelectModel === true) return {}
        return {
          async selectModel(request) {
            calls.select.push(request)
            calls.inflight += 1
            calls.maxInflight = Math.max(calls.maxInflight, calls.inflight)
            await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0))
            calls.inflight -= 1
            if (options.throwOnSelect === true) throw new Error('session/model-unavailable')
            return { selected: { provider: request.provider, model: request.model } }
          },
        }
      }
      if (id === 'agentDefaultModel') {
        if (options.noDefaults === true) return { currentSelection: () => previous }
        return {
          currentSelection: () => previous,
          async saveSelection(next) { calls.saved.push(next) },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('selectModelKeepingDefault：调宿主的 selectModel，并把全局默认模型放回去', async () => {
  const { ctx, calls } = fakeHost()
  const result = await models.selectModelKeepingDefault(ctx, {
    sessionId: 'session-1',
    selection: { provider: 'stub', model: 'fg-model', reasoningEffort: 'high' },
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.select.length, 1, '必须调用宿主的 sessionController.selectModel')
  assert.equal(calls.select[0].sessionId, 'session-1')
  assert.equal(calls.select[0].provider, 'stub')
  assert.equal(calls.select[0].model, 'fg-model')
  assert.equal(calls.select[0].reasoningEffort, 'high')
  assert.deepEqual(calls.saved, [{ provider: 'base', model: 'base-model' }],
    '官方 selectModel 会把选择写成全局默认，必须还原（否则每派一次单就改掉用户的默认模型）')
})

test('selectModelKeepingDefault：选的就是当前默认时不多写一次', async () => {
  const { ctx, calls } = fakeHost({ previous: { provider: 'stub', model: 'fg-model' } })
  const result = await models.selectModelKeepingDefault(ctx, {
    sessionId: 'session-2', selection: { provider: 'stub', model: 'fg-model' },
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.saved, [], '默认没变就不该再写一次配置')
})

test('selectModelKeepingDefault：宿主拒绝/不支持时只降级，不抛', async () => {
  const failing = fakeHost({ throwOnSelect: true })
  const rejected = await models.selectModelKeepingDefault(failing.ctx, {
    sessionId: 's', selection: { provider: 'p', model: 'm' },
  })
  assert.equal(rejected.ok, false, 'selectModel 抛错要变成 ok:false')
  assert.match(String(rejected.error), /model-unavailable/)
  assert.deepEqual(failing.calls.saved, [], '选不上就别去恢复默认（免得白写一次）')

  const legacy = fakeHost({ noSelectModel: true })
  const unsupported = await models.selectModelKeepingDefault(legacy.ctx, {
    sessionId: 's', selection: { provider: 'p', model: 'm' },
  })
  assert.equal(unsupported.ok, false)
  assert.match(String(unsupported.error), /selectModel/, '要明确说宿主没有这条通路')
})

test('selectModelKeepingDefault：并发调用被串行化（不会交错 select 与 restore）', async () => {
  const { ctx, calls } = fakeHost({ delayMs: 5 })
  await Promise.all([
    models.selectModelKeepingDefault(ctx, { sessionId: 'a', selection: { provider: 'p', model: 'm1' } }),
    models.selectModelKeepingDefault(ctx, { sessionId: 'b', selection: { provider: 'p', model: 'm2' } }),
  ])
  assert.equal(calls.select.length, 2)
  assert.equal(calls.maxInflight, 1, '两次模型选择不许并发（会被全局默认的写入/还原交错）')
})

/* ─────────────── 4. 从 config.json 一路读到设备默认音色 ─────────────── */

test('tihuEdgeVoiceDefault：环境变量 > config.json 的 tihu.voice.edge > 云健', async () => {
  process.env.DSH_ASSISTANT_CONFIG = configFile
  delete process.env.TIHU_EDGE_VOICE
  writeFileSync(configFile, JSON.stringify({ tihu: { voice: { edge: 'zh-CN-XiaoxiaoNeural' } } }), 'utf8')
  const { tihuEdgeVoiceDefault } = await import('../src/tihu/lane.ts')
  assert.equal(tihuEdgeVoiceDefault(), 'zh-CN-XiaoxiaoNeural', '配置里的默认云音色要真的被设备用上')

  process.env.TIHU_EDGE_VOICE = 'zh-CN-YunxiNeural'
  assert.equal(tihuEdgeVoiceDefault(), 'zh-CN-YunxiNeural', '环境变量是临时覆盖，优先级最高')

  delete process.env.TIHU_EDGE_VOICE
  writeFileSync(configFile, JSON.stringify({ tihu: { voice: { edge: 'zf_060' } } }), 'utf8')
  assert.equal(tihuEdgeVoiceDefault(), 'zh-CN-YunjianNeural', '本地 Kokoro 音色不能被当成默认云音色（退回云健）')

  writeFileSync(configFile, JSON.stringify({}), 'utf8')
  assert.equal(tihuEdgeVoiceDefault(), 'zh-CN-YunjianNeural', '没配置时保持历史默认（云健）')

  rmSync(configFile, { force: true })
  assert.equal(tihuEdgeVoiceDefault(), 'zh-CN-YunjianNeural', '连配置文件都没有也要有默认值')
})

/* ─────────────── 5. 接线位置（源码级）：两条建会话路径都接上了、且顺序对 ─────────────── */

test('lane.ts：派单（前台）与指挥台（后台）两条建会话路径都接模型，且都在投消息之前', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/tihu/lane.ts', import.meta.url), 'utf8')
  assert.match(source, /await ensureCommanderModel\(created\)/, '新建指挥台后没接默认后台模型')
  assert.match(source, /await ensureCommanderModel\(commanderSessionId\)/, '复用回来的指挥台没补默认后台模型（它几乎永远不新建）')
  assert.match(source, /await applyTihuModel\(sessionId, 'foreground', '派单'\)/, '派单建会话后没接默认前台模型')

  const foregroundAt = source.indexOf("await applyTihuModel(sessionId, 'foreground', '派单')")
  const promptAt = source.indexOf('const sent = await promptSession(sessionId, blocks)')
  assert.ok(foregroundAt > 0 && promptAt > 0, '派单路径的标记没找到（代码结构变了就同步改这条断言）')
  assert.ok(foregroundAt < promptAt, '必须在 promptSession 之前选模型，否则第一轮还是旧模型')

  // 设备默认云音色必须走 tihuEdgeVoiceDefault()，不能再写死一个字面量
  assert.match(source, /edgeVoice: tihuEdgeVoiceDefault\(\)/, '新建设备时没读默认云音色')
  assert.equal(source.includes("edgeVoice: process.env.TIHU_EDGE_VOICE ?? 'zh-CN-YunjianNeural'"), false,
    '旧的写死兜底还在（会把设置项压掉）')
})

test('page.ts：连上设备时不再把本页写死的云音色推给宿主（否则设置项永远被压掉）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/tihu/page.ts', import.meta.url), 'utf8')
  const connect = source.indexOf("sendHello('', false);")
  assert.ok(connect > 0, '没找到 connect() 里的 hello')
  const window = source.slice(connect, connect + 1400)
  assert.equal(window.includes("edgeVoice: $('edgeVoiceSelect').value"), false,
    '连上就上行本页音色 = 宿主的「默认云音色」被覆盖')
  assert.ok(window.includes("localStorage.getItem('tihu.edgeVoice')"), '应改成「只有本页手工改过才上行」')
  assert.ok(source.includes('payload.edgeVoice'), 'voice.list 回显宿主实际音色')
})

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}
delete process.env.DSH_ASSISTANT_CONFIG
delete process.env.TIHU_EDGE_VOICE
rmSync(tempHome, { recursive: true, force: true })
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
