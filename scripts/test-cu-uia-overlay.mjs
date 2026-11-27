/**
 * 单测：编号框图像合成器（PNG 解码/编码/画框）——离线可跑，不碰屏幕。
 *   node scripts/test-cu-uia-overlay.mjs
 *
 * 钉死的口径：
 *   - 原帧**不许改**：`overlayPng()` 在画不出任何编号（drawn=0）时返回原 buffer 本体（同一引用）；
 *   - 画得出时返回**新** PNG，尺寸不变，编号框落在按 `windowOrigin/scale` 换算后的像素上；
 *   - 不支持的 PNG 形状（非 8 位 / 隔行 / 未知颜色类型 / 不是 PNG）一律抛 OverlayUnsupportedError，
 *     调用方据此整帧退回原图（保底 ①：不加开销、不改帧）；
 *   - 坐标只用来画框：本模块不产生、不修改任何点击坐标。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  OverlayUnsupportedError,
  decodePng,
  drawMarks,
  encodePngRgba,
  overlayPng,
} from '../src/cu-uia-overlay.ts'

const cases = []

function makeImage(width, height, painter) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y)
      const i = (y * width + x) * 4
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a
    }
  }
  return { width, height, rgba }
}
const pixelAt = (image, x, y) => {
  const i = (y * image.width + x) * 4
  return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]]
}

cases.push(['PNG 编解码闭环：像素逐个一致，尺寸不变', async () => {
  const source = makeImage(37, 23, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x * y) % 256, 255])
  const png = encodePngRgba(source)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名不对')
  const back = decodePng(png)
  assert.equal(back.width, 37)
  assert.equal(back.height, 23)
  assert.ok(back.rgba.equals(source.rgba), '编解码后像素必须逐字节一致')
}])
cases.push(['画编号：框与编号落在正确像素上，远处像素一个不动', async () => {
  const image = makeImage(200, 120, () => [10, 10, 10, 255])
  const before = Buffer.from(image.rgba)
  const marks = [
    { no: 1, rect: { x: 0, y: 0, w: 40, h: 20 } },
    { no: 12, rect: { x: 100, y: 60, w: 60, h: 30 } },
  ]
  const { drawn } = drawMarks(image, marks, { minEdgePx: 6 })
  assert.equal(drawn, 2)
  // 框线（洋红）落在 rect 边界上
  assert.deepEqual(pixelAt(image, 0, 0), [255, 43, 214, 255], '左上角框线像素')
  assert.deepEqual(pixelAt(image, 39, 19), [255, 43, 214, 255], '右下角框线像素')
  // 编号底片在第一格框内左上角
  assert.deepEqual(pixelAt(image, 3, 3), [18, 18, 22, 235], '编号底片像素')
  // 远处像素保持原样
  assert.deepEqual(pixelAt(image, 190, 10), [10, 10, 10, 255], '没画到的地方不许变')
  let changed = 0
  for (let i = 0; i < before.length; i += 1) if (before[i] !== image.rgba[i]) changed += 1
  assert.ok(changed > 0 && changed < before.length / 3, `改动像素应是少数（实际 ${changed}/${before.length}）`)
}])
cases.push(['越界/过小的框：跳过不抛，画几个如实返回', async () => {
  const image = makeImage(50, 40, () => [0, 0, 0, 255])
  const { drawn } = drawMarks(image, [
    { no: 3, rect: { x: -100, y: -100, w: 30, h: 20 } },   // 完全在画面外
    { no: 4, rect: { x: 10, y: 10, w: 3, h: 3 } },          // 太小
    { no: 5, rect: { x: 45, y: 35, w: 40, h: 40 } },        // 部分越界 → 裁剪后画
  ], { minEdgePx: 6 })
  assert.equal(drawn, 1, '只有部分越界那条能画（裁剪）')
  assert.deepEqual(pixelAt(image, 45, 35), [255, 43, 214, 255], '裁剪后的左上角仍要画到')
}])
cases.push(['drawn=0 时原帧原样返回（同一 buffer 引用，不复制不编码）', async () => {
  const source = makeImage(20, 10, () => [7, 7, 7, 255])
  const png = encodePngRgba(source)
  const out = overlayPng(png, [], {})
  assert.equal(out.drawn, 0)
  assert.equal(out.png, png, '没有编号时必须返回原 buffer 本体')
  const small = overlayPng(png, [{ no: 1, rect: { x: 0, y: 0, w: 2, h: 2 } }], { minEdgePx: 6 })
  assert.equal(small.drawn, 0)
  assert.equal(small.png, png, '框太小画不出来也必须是原 buffer')
}])
cases.push(['不支持的形状一律抛错（调用方据此退原帧）', async () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), OverlayUnsupportedError)
  assert.throws(() => decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])), OverlayUnsupportedError)
  // 16 位深：改 IHDR 的 bitDepth
  const png = encodePngRgba(makeImage(4, 4, () => [1, 2, 3, 255]))
  const mutated = Buffer.from(png)
  const ihdrDataStart = 8 + 8
  mutated[ihdrDataStart + 8] = 16
  assert.throws(() => decodePng(mutated), OverlayUnsupportedError, '16 位必须拒绝')
}])
cases.push(['换算口径：windowOrigin + scale（1920 宽窗口缩到 960 图 → 0.5 倍）', async () => {
  const image = makeImage(960, 540, () => [0, 0, 0, 255])
  const { drawn } = drawMarks(image, [{ no: 7, rect: { x: 1000, y: 200, w: 200, h: 100 } }], {
    windowOrigin: { x: 0, y: 0 },
    scale: 0.5,
    minEdgePx: 6,
  })
  assert.equal(drawn, 1)
  assert.deepEqual(pixelAt(image, 500, 100), [255, 43, 214, 255], '(1000,200)×0.5 = (500,100)')
  const offset = drawMarks(makeImage(400, 300, () => [0, 0, 0, 255]), [{ no: 2, rect: { x: 150, y: 120, w: 40, h: 20 } }], {
    windowOrigin: { x: 100, y: 100 },
  })
  assert.equal(offset.drawn, 1)
}])
cases.push(['真实截图：真 PNG 上画 40 个编号（尺寸不变、耗时可控）', async () => {
  const sample = ['tmp-secretary-pager-dom.png', 'tmp-secretary-card.png'].find((name) => existsSync(name))
  if (sample === undefined) { console.log('    （跳过：仓库里没有现成截图样本）'); return }
  const png = readFileSync(sample)
  const decoded = decodePng(png)
  const marks = Array.from({ length: 40 }, (_, i) => ({
    no: i + 1,
    rect: { x: 40 + (i % 8) * 120, y: 60 + Math.floor(i / 8) * 80, w: 90, h: 28 },
  }))
  const started = process.hrtime.bigint()
  const out = overlayPng(png, marks, { windowOrigin: { x: 0, y: 0 }, scale: 1 })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(out.drawn > 0, '真图上至少画出一个编号')
  const back = decodePng(out.png)
  assert.equal(back.width, decoded.width, '尺寸不许变')
  assert.equal(back.height, decoded.height)
  console.log(`    样本 ${sample} ${decoded.width}×${decoded.height}：画 ${out.drawn} 个编号、${ms.toFixed(1)} ms、${(out.png.length / 1024).toFixed(0)} KB`)
  assert.ok(ms < 1500, `一帧合成耗时必须可控（实际 ${ms.toFixed(1)} ms）`)
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
console.log(`\ncu-uia-overlay: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
