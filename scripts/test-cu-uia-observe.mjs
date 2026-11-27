/**
 * 单测：观察帧包装（编号图换进工具结果，不动 vendor）。
 *   node scripts/test-cu-uia-observe.mjs
 *
 * 钉死的口径：
 *   - 开关关 / 探针不启动 / 没有可画编号 / 图不是 PNG → **原 value 原样返回**（同一对象引用，不落盘）；
 *   - 换图时只改 `paths` 与 `screens[].path`，**不新增任何字段**（宿主 output.schema 是 additionalProperties:false），
 *     且原帧文件一个字节都不动；
 *   - 包装器里任何异常都退回原 result（通道坏了不许影响 CU 本身）；
 *   - 不产生、不改写任何点击坐标。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  installCuObservationWrapper,
  overlayObservationValue,
  overlayPathFor,
  planObservationOverlay,
} from '../src/cu-uia-observe.ts'
import { decodePng } from '../src/cu-uia-overlay.ts'

const WINDOW = { x: 0, y: 0, w: 900, h: 900 }
const CONTROLS = [
  { name: '更多', role: 'Button', rect: { x: 100, y: 120, w: 80, h: 28 }, enabled: true },
  { name: '复制链接', role: 'Button', rect: { x: 200, y: 120, w: 88, h: 28 }, enabled: true },
  { name: '搜索', role: 'Edit', rect: { x: 320, y: 60, w: 200, h: 30 }, enabled: true },
]
const ON = { enabled: true, reason: 'env-on' }
const OFF = { enabled: false, reason: 'default-off' }
const CH_OK = { enabled: true, reason: 'ok' }
const CH_OFF = { enabled: false, reason: 'few-controls' }

const samplePath = ['tmp-secretary-pager-dom.png', 'tmp-secretary-card.png'].find((name) => existsSync(name))
const cases = []

cases.push(['纯决策：开关关 / 通道不启动 / 没控件 / 没图 四种都不画', async () => {
  assert.equal(planObservationOverlay({ switch: OFF, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, paths: ['a.png'] }).reason, 'switch-off')
  assert.equal(planObservationOverlay({ switch: ON, decision: CH_OFF, controls: CONTROLS, windowRect: WINDOW, paths: ['a.png'] }).reason, 'channel-off')
  assert.equal(planObservationOverlay({ switch: ON, decision: CH_OK, controls: [], windowRect: WINDOW, paths: ['a.png'] }).reason, 'no-marks')
  const noPath = planObservationOverlay({ switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, paths: [] })
  assert.equal(noPath.useOverlay, false)
  assert.equal(noPath.reason, 'no-path')
  const ok = planObservationOverlay({ switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW, paths: ['a.png'] })
  assert.equal(ok.useOverlay, true)
  assert.equal(ok.marks.length, 3)
  assert.ok(ok.hint.includes('#1'))
}])
cases.push(['开关关 / 通道关：原 value 原样返回（同一引用，不落盘）', async () => {
  if (samplePath === undefined) { console.log('    （跳过：没有样本截图）'); return }
  const value = { paths: [samplePath], screens: [{ path: samplePath }] }
  const off = overlayObservationValue(value, { switch: OFF, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW })
  assert.equal(off.value, value, '关着必须返回原对象本体')
  assert.equal(off.replaced, 0)
  const channelOff = overlayObservationValue(value, { switch: ON, decision: CH_OFF, controls: CONTROLS, windowRect: WINDOW })
  assert.equal(channelOff.value, value)
}])
cases.push(['开着：换成编号图（只改路径、不加字段、原帧字节不变、尺寸不变）', async () => {
  if (samplePath === undefined) { console.log('    （跳过：没有样本截图）'); return }
  const originalHash = createHash('sha256').update(readFileSync(samplePath)).digest('hex')
  const value = { paths: [samplePath], screens: [{ path: samplePath, mediaType: 'image/png' }], cursor: { x: 5, y: 6 } }
  const out = overlayObservationValue(value, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW })
  assert.equal(out.replaced, 1, '必须换掉 1 张')
  assert.ok(out.drawn >= 3, `至少要画出 3 个编号（实际 ${out.drawn}）`)
  const newPath = out.value.paths[0]
  assert.notEqual(newPath, samplePath)
  assert.match(newPath, /\.marks\.png$/)
  assert.ok(existsSync(newPath), '编号图必须真的落盘')
  assert.deepEqual(Object.keys(out.value).sort(), Object.keys(value).sort(), '不许新增字段（宿主的 schema 是 additionalProperties:false）')
  assert.deepEqual(out.value.cursor, { x: 5, y: 6 }, '坐标字段一个都不许动')
  assert.equal(out.value.screens[0].path, newPath, 'screens[].path 也要指向编号图')
  assert.equal(createHash('sha256').update(readFileSync(samplePath)).digest('hex'), originalHash, '原帧文件一个字节都不许动')
  const before = decodePng(readFileSync(samplePath))
  const after = decodePng(readFileSync(newPath))
  assert.equal(after.width, before.width)
  assert.equal(after.height, before.height)
  assert.ok(!after.rgba.equals(before.rgba), '编号图必须与原图不同')
}])
cases.push(['不是 PNG / 画不出编号：原样返回（不加开销、不中断）', async () => {
  const fakeJpg = join(tmpdir(), 'dsh-cu-uia-fake-' + process.pid + '.jpg')
  writeFileSync(fakeJpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))
  const value = { paths: [fakeJpg] }
  const out = overlayObservationValue(value, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW })
  assert.equal(out.value, value)
  assert.equal(out.replaced, 0)
  const empty = { paths: [] }
  assert.equal(overlayObservationValue(empty, { switch: ON, decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }).value, empty)
}])
cases.push(['around-dispatch 包装：关着不碰结果、开着换图、探针抛异常也退回原结果', async () => {
  if (samplePath === undefined) { console.log('    （跳过：没有样本截图）'); return }
  const registered = []
  const ctx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  const dispose = installCuObservationWrapper(ctx, {
    readSwitch: () => OFF,
    probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }),
  })
  assert.equal(typeof dispose, 'function')
  assert.equal(registered[0].name, 'tools/execute', '必须挂在 around-dispatch 位')
  const nextValue = { paths: [samplePath] }
  const exec = { tool: { name: 'computer_use' } }
  const closed = await registered[0].handler(exec, async () => nextValue)
  assert.equal(closed, nextValue, '关着必须原样透传（连新对象都不许造）')

  const onCtx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installCuObservationWrapper(onCtx, { readSwitch: () => ON, probe: async () => ({ decision: CH_OK, controls: CONTROLS, windowRect: WINDOW }) })
  const opened = await registered[1].handler(exec, async () => ({ paths: [samplePath] }))
  assert.match(opened.paths[0], /\.marks\.png$/, '开着要把路径换成编号图')

  const throwCtx = { on: (name, handler) => { registered.push({ name, handler }); return () => void 0 } }
  installCuObservationWrapper(throwCtx, { readSwitch: () => ON, probe: async () => { throw new Error('probe boom') } })
  const original = { paths: [samplePath] }
  const survived = await registered[2].handler(exec, async () => original)
  assert.equal(survived, original, '探针炸了也必须原样返回')

  const otherTool = await registered[1].handler({ tool: { name: 'bash' } }, async () => original)
  assert.equal(otherTool, original, '不是 CU 工具就直接透传')
  assert.match(overlayPathFor('/x/y/frame.png', 2), /2-frame\.marks\.png$/)
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
console.log(`\ncu-uia-observe: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
