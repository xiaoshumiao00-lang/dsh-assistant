/**
 * 单测：内容块层改写 + BOM 回归（这两条是 2026-11-27 §12 实测出来的真 bug）。
 *   node scripts/test-cu-uia-content.mjs
 *
 * 钉死的口径：
 *   ① 开关关 / 探针不启动 / 没有可画编号 / 读不到附件 / 存不进附件 / 工具名不在集合 → **原 decision 原样返回**（同一引用，
 *      readImage/saveImage 一次都不许被调用 = 零开销）；
 *   ② 开着且能画 → image 块的 attachment 换成新 ref、追加候选清单 text 块，**其它块与坐标字段不动**；
 *   ③ 关通道时 post-execute 包装不触发任何 IO（用计数器断言）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CU_OBSERVATION_TOOLS,
  installContentWrapper,
  rewriteContentBlocks,
} from '../src/cu-uia-content.ts'
import { decodePng, encodePngRgba } from '../src/cu-uia-overlay.ts'
import { readCuUiaFileEnabled, installCuObservationWrapper } from '../src/cu-uia-observe.ts'

const WINDOW = { x: 0, y: 0, w: 400, h: 300 }
const CONTROLS = [
  { name: '更多', role: 'Button', rect: { x: 10, y: 20, w: 60, h: 24 }, enabled: true },
  { name: '复制链接', role: 'Button', rect: { x: 100, y: 140, w: 80, h: 28 }, enabled: true },
  { name: '搜索', role: 'Edit', rect: { x: 200, y: 40, w: 160, h: 30 }, enabled: true },
]
const ON = { enabled: true, reason: 'file-on' }
const OFF = { enabled: false, reason: 'default-off' }
const CH_OK = { enabled: true, reason: 'ok' }
const CH_OFF = { enabled: false, reason: 'few-controls' }

function makePng(width = 400, height = 300) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 20; rgba[i + 1] = 20; rgba[i + 2] = 24; rgba[i + 3] = 255 }
  return encodePngRgba({ width, height, rgba })
}
const REF = { attachmentId: 'sha256:orig', mediaType: 'image/png', bytes: 0, width: 400, height: 300 }
const NEW_REF = { attachmentId: 'sha256:marks', mediaType: 'image/png', bytes: 1, width: 400, height: 300 }

function makeIo() {
  const calls = { read: 0, save: 0 }
  const saved = []
  return {
    calls,
    saved,
    io: {
      async readImage() { calls.read += 1; return makePng() },
      async saveImage(png, name) { calls.save += 1; saved.push({ png, name }); return NEW_REF },
    },
  }
}

const cases = []

cases.push(['开关关：零 IO、原 decision 同一引用返回', async () => {
  const { calls, io } = makeIo()
  const blocks = [{ type: 'text', text: 'foreground' }, { type: 'image', attachment: REF }]
  const decision = { kind: 'accept' }
  const registered = []
  const ctx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installContentWrapper(ctx, { readSwitch: () => OFF, probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }), io })
  assert.equal(registered[0].name, 'tools/post-execute', '必须挂在 post-execute（能改 content 的那层）')
  const out = await registered[0].handler({ name: 'click' }, { content: blocks }, async () => decision)
  assert.equal(out, decision, '关着必须原样返回同一对象')
  assert.deepEqual(calls, { read: 0, save: 0 }, '关着一次 IO 都不许发生')
}])
cases.push(['开着：image 块的 attachment 换成编号图，追加候选清单 text 块，其余块不动', async () => {
  const { calls, io, saved } = makeIo()
  const blocks = [
    { type: 'text', text: 'foreground' },
    { type: 'image', attachment: REF },
    { type: 'text', text: 'screens' },
  ]
  const decision = { kind: 'accept' }
  const registered = []
  const ctx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installContentWrapper(ctx, { readSwitch: () => ON, probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }), io })
  const out = await registered[0].handler({ name: 'click' }, { content: blocks }, async () => decision)
  assert.notEqual(out, decision, '开着必须换新 decision')
  assert.equal(out.kind, 'accept')
  assert.equal(calls.read, 1, '读一次原附件')
  assert.equal(calls.save, 1, '存一次编号图')
  assert.equal(out.content.length, blocks.length + 1, '末尾多一个候选清单 text 块')
  assert.deepEqual(out.content[0], blocks[0], '前面的 text 块原样保留')
  assert.equal(out.content[1].type, 'image')
  assert.deepEqual(out.content[1].attachment, NEW_REF, 'attachment 必须换成新 ref')
  assert.deepEqual(out.content[2], blocks[2], '后面的 text 块原样保留')
  assert.equal(out.content[3].type, 'text')
  assert.match(out.content[3].text, /^#1 Button "更多"/m, '候选清单内容对得上')
  const magenta = (() => {
    const image = decodePng(saved[0].png)
    let count = 0
    for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i] === 255 && image.rgba[i + 1] === 43 && image.rgba[i + 2] === 214) count += 1
    return count
  })()
  assert.ok(magenta > 0, '存下来的图里必须有洋红编号框像素')
}])
cases.push(['探针不启动 / 没控件 / 没有 image 块 / 附件读不出 / 存不进：全部原样返回', async () => {
  const blocks = [{ type: 'image', attachment: REF }]
  const decision = { kind: 'accept' }
  assert.equal(await rewriteContentBlocks(blocks, { switch: ON, decision: CH_OFF, controls: CONTROLS, windowRect: WINDOW, io: makeIo().io }), null, '探针不启动 → null')
  assert.equal(await rewriteContentBlocks(blocks, { switch: ON, decision: CH_OK, controls: [], windowRect: WINDOW, io: makeIo().io }), null, '没控件 → null')
  assert.equal(await rewriteContentBlocks([{ type: 'text', text: 'x' }], { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, io: makeIo().io }), null, '没有 image 块 → null')
  const brokenRead = { readImage: async () => null, saveImage: async () => NEW_REF }
  assert.equal(await rewriteContentBlocks(blocks, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, io: brokenRead }), null, '读不出附件 → null')
  const brokenSave = { readImage: async () => makePng(), saveImage: async () => null }
  assert.equal(await rewriteContentBlocks(blocks, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, io: brokenSave }), null, '存不进附件 → null')
  const notPng = { readImage: async () => Buffer.from('not a png'), saveImage: async () => NEW_REF }
  assert.equal(await rewriteContentBlocks(blocks, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, io: notPng }), null, '不是 PNG → null（不中断）')
  // 包装器层面：不是 CU 工具名 → 原样
  const registered = []
  const ctx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installContentWrapper(ctx, { readSwitch: () => ON, probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }), io: makeIo().io })
  const out = await registered[0].handler({ name: 'bash' }, { content: blocks }, async () => decision)
  assert.equal(out, decision, '非 CU 工具一律透传')
}])
cases.push(['逐步工具名集合已扩到 click/open_app/type 等（只在开通道时匹配）', async () => {
  for (const name of ['click', 'open_app', 'type', 'screenshot', 'computer_use', 'key']) {
    assert.ok(CU_OBSERVATION_TOOLS.includes(name), name + ' 应在拦截集里')
  }
  const { calls, io } = makeIo()
  const registered = []
  const ctx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installContentWrapper(ctx, { readSwitch: () => ON, probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }), io })
  await registered[0].handler({ name: 'open_app' }, { content: [{ type: 'image', attachment: REF }] }, async () => ({ kind: 'accept' }))
  assert.equal(calls.save, 1, 'open_app 也要走内容块改写')
}])
cases.push(['BOM 回归：带 UTF-8 BOM 的开关文件必须能读出来（§12.5 的坑）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-bom-'))
  const file = join(dir, 'dsh-assistant-cu-uia.json')
  const ctx = { get: (name) => (name === 'profileContext' ? { dir } : undefined) }
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"enabled": true}', 'utf8')]))
  assert.equal(readFileSync(file)[0], 0xef, '样本必须以 BOM 开头')
  assert.equal(readCuUiaFileEnabled(ctx), true, '带 BOM 也必须读出 true（旧实现返回 undefined）')
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"enabled": false}', 'utf8')]))
  assert.equal(readCuUiaFileEnabled(ctx), false)
  writeFileSync(file, '{"enabled": true}', 'utf8')
  assert.equal(readCuUiaFileEnabled(ctx), true, '无 BOM 照常')
  writeFileSync(file, '{"enabled": "yes"}', 'utf8')
  assert.equal(readCuUiaFileEnabled(ctx), undefined, '不是布尔 → undefined（交给缺省关）')
}])
cases.push(['装两处包装：execute（改 value）与 post-execute（改 content）都挂上，卸载函数两者都拆', async () => {
  const registered = []
  const disposed = []
  const ctx = { on: (name) => { registered.push(name); return () => disposed.push(name) } }
  const dispose = installCuObservationWrapper(ctx, { readSwitch: () => OFF, probe: async () => ({ decision: CH_OFF, controls: [], windowRect: null }) })
  assert.deepEqual(registered, ['tools/execute', 'tools/post-execute'], '两处都要注册')
  dispose()
  assert.deepEqual(disposed, ['tools/execute', 'tools/post-execute'], '卸载要两处都拆')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log('ok  ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name + ' :: ' + (error?.stack ?? error))
  }
}
console.log(`\ncu-uia-content: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
