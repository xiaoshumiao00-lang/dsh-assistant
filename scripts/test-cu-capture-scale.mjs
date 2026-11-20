/**
 * 单测：Computer Use 每步观察截图的降尺寸（vendor/computer-use/windows-native 的抓屏缩放）。
 *   node scripts/test-cu-capture-scale.mjs
 *
 * 对着 2026-11-20「录入店铺到轰趴后台」那次实录立的规矩：124 步回喂了 58 张全尺寸 PNG
 * （中位 157 KB、最大 652 KB），每步的 prefill 都按原始分辨率算 token。
 * 现在按长边上限降采样（`captureMaxEdgePx`，默认 1280，0 = 关掉）。
 *
 * 固定这几条边界：
 *   - 尺寸已经小于上限时一帧都不动（`fitCaptureSize` 返回 undefined，走原来的全尺寸编码）；
 *   - `captureMaxEdgePx: 0` 是「不缩放」，不是「缩到 0」；
 *   - 缩放保持宽高比、只按长边收，短边不会被打爆；
 *   - 盒式平均是整数级像素平均，alpha 取采样里的最大值（透明像素不会被平均抹平）；
 *   - 目标是 `dstWidth * dstHeight * 4` 字节，不越界。
 * 点击映射仍走 `screen.bounds`，`0–1000` 坐标空间不变 —— 这条改的是回喂成本，不是点击语义。
 * 另外固定三条真机上踩过的边界：截图基准与点击基准必须是同一个 rect（抓屏矩形 = 映射矩形）；
 * down 与 up 必须同一个坐标、中间不许插入移动；本来就在前台的窗口不该被抢焦点、抢不到前台也不许堵死热键。
 */
import assert from 'node:assert/strict'
import {
  createWindowsDesktopBackend,
  mapFractionToGlobal,
  selectWindowsObservation,
  windowSurfaceRect
} from '../vendor/computer-use/backend-18yEf5Jq.js'
import { downscaleBgra, fitCaptureSize, resolveCaptureMaxEdge } from '../vendor/computer-use/windows-native-B7Ig34Q0.js'

/**
 * 一台左屏负原点的双屏机：主屏 0..1920，左屏 -1920..0，任务栏在左屏底部（工作区矮 48）。
 * 窗口故意比工作区高，好让「frame ∩ workArea」真的截短一截。
 */
const MONITOR = { x: -1920, y: 0, width: 1920, height: 1080 }
const WORK_AREA = { x: -1920, y: 0, width: 1920, height: 1032 }

function windowFact(options) {
  const { hwnd, x, y, width, height } = options
  return {
    hwnd,
    pid: 4242,
    ownerHwnd: 0,
    className: 'Notepad',
    appName: 'notepad',
    title: '无标题 - 记事本',
    visible: true,
    iconic: false,
    cloaked: false,
    toolWindow: false,
    popup: false,
    topmost: false,
    noActivate: false,
    clickThrough: false,
    frame: { x, y, width, height },
    monitor: MONITOR,
    workArea: WORK_AREA,
    monitorDpi: 96
  }
}

/** 记录型宿主：抓屏、摆指针、按键全部落日志，前台判定与窗口快照都可中途替换。 */
function recordingHost(snapshot) {
  const log = []
  const state = { snapshot }
  let cursor = { x: 0, y: 0 }
  return {
    log,
    setSnapshot(next) {
      state.snapshot = next
    },
    listWindows: () => state.snapshot,
    foregroundWindowId: () => state.snapshot.foregroundHwnd,
    focusWindow: (hwnd) => {
      log.push({ kind: 'focusWindow', hwnd })
      return false
    },
    targetBlocksInput: () => false,
    capturePng: (bounds) => {
      log.push({ kind: 'capturePng', bounds })
      return Buffer.from([137, 80, 78, 71])
    },
    movePointer: (x, y) => {
      cursor = { x, y }
      log.push({ kind: 'movePointer', x, y })
    },
    mouseButton: (button, down, point) => {
      log.push({ kind: 'mouseButton', button, down, point: point === undefined ? undefined : { ...point } })
    },
    cursorPosition: () => ({ ...cursor }),
    key: (virtualKey, down, extended) => {
      log.push({ kind: 'key', virtualKey, down, extended })
    },
    scrollWheel: () => {},
    virtualScreen: () => ({ x: -1920, y: 0, width: 3840, height: 1080 })
  }
}

const cases = []

function bgra(width, height, perPixel) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const [blue, green, red, alpha] = perPixel(row, column)
      const at = (row * width + column) * 4
      pixels[at] = blue
      pixels[at + 1] = green
      pixels[at + 2] = red
      pixels[at + 3] = alpha
    }
  }
  return pixels
}

function readPixel(buffer, width, row, column) {
  const at = (row * width + column) * 4
  return [buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3]
  ]
}

cases.push(['默认上限是 1280；0 表示关掉缩放；非数字与负数都回默认', () => {
  assert.equal(resolveCaptureMaxEdge(undefined), 1280)
  assert.equal(resolveCaptureMaxEdge(0), 0, '0 是「不缩放」，不是「缩成 0 像素」')
  assert.equal(resolveCaptureMaxEdge(1600), 1600)
  assert.equal(resolveCaptureMaxEdge(1920.6), 1921, '取整')
  assert.equal(resolveCaptureMaxEdge(-3), 1280)
  assert.equal(resolveCaptureMaxEdge(Number.NaN), 1280)
  assert.equal(resolveCaptureMaxEdge(Number.POSITIVEInfinity), 1280)
  assert.equal(resolveCaptureMaxEdge('1280'), 1280)
}])

cases.push(['已经小于上限的面板一帧都不动（不重编码）', () => {
  assert.equal(fitCaptureSize(1000, 700, 1280), undefined)
  assert.equal(fitCaptureSize(1280, 1280, 1280), undefined)
  assert.equal(fitCaptureSize(72, 72, 1280), undefined, '悬浮球那种小面板根本不值得缩')
  assert.equal(fitCaptureSize(1644, 773, 0), undefined, '关掉缩放时一律不动')
  assert.equal(fitCaptureSize(1644, 773, undefined), undefined, '没传上限时不动')
}])

cases.push(['按长边收，宽高比保持不变（实测微信那块 1644x773）', () => {
  const fit = fitCaptureSize(1644, 773, 1280)
  assert.equal(fit.width, 1280)
  assert.ok(Math.abs(fit.width / fit.height - 1644 / 773) < 0.01, '宽高比：' + fit.width + 'x' + fit.height)
  assert.ok(fit.height <= 1280 && fit.width <= 1280)
  const tall = fitCaptureSize(900, 2400, 1280)
  assert.equal(tall.height, 1280, '长边在高的方向时按高收')
  assert.ok(Math.abs(tall.width / tall.height - 900 / 2400) < 0.01)
  assert.deepEqual(fitCaptureSize(2560, 1440, 1280), { width: 1280, height: 720 })
  assert.deepEqual(fitCaptureSize(3000, 200, 1000), { width: 1000, height: 67 })
  assert.deepEqual(fitCaptureSize(1000, 1, 1), { width: 1, height: 1 }, '极窄的面板也不许缩成 0 像素')
}])

cases.push(['盒式平均：4x4 → 2x2 取块平均，alpha 取块内最大值', () => {
  const source = bgra(4, 4, (row, column) => [row * 4 + column, 100, 50, row * 10])
  const out = downscaleBgra(source, 4, 4, 2, 2)
  assert.equal(out.length, 2 * 2 * 4)
  assert.deepEqual(readPixel(out, 2, 0, 0), [3, 100, 50, 10], '块 (0,0) 平均 0,1,4,5 → 2.5 进 3')
  assert.deepEqual(readPixel(out, 2, 0, 1), [5, 100, 50, 10])
  assert.deepEqual(readPixel(out, 2, 1, 0), [11, 100, 50, 30], 'alpha 不会被平均抹平')
  assert.deepEqual(readPixel(out, 2, 1, 1), [13, 100, 50, 30])
}])

cases.push(['尺寸不变时逐像素原样搬（1:1 不引入误差）', () => {
  const source = bgra(2, 2, (row, column) => [row * 10 + column, 7, 9, 255])
  const out = downscaleBgra(source, 2, 2, 2, 2)
  assert.deepEqual([...out], [...source])
}])

cases.push(['非整数倍率取整不越界（3x3 → 1x1 平均全部 9 个像素）', () => {
  const source = bgra(3, 3, (row, column) => [row * 3 + column, 0, 0, 0])
  const out = downscaleBgra(source, 3, 3, 1, 1)
  assert.equal(out.length, 4)
  assert.deepEqual(readPixel(out, 1, 0, 0), [4, 0, 0, 0], '0..8 平均 4')
}])

cases.push(['源比目标更小时也照搬（不许读越界的字节）', () => {
  const source = bgra(2, 1, (row, column) => [column, column, column, 255])
  const out = downscaleBgra(source, 2, 1, 4, 1)
  assert.equal(out.length, 16)
  assert.equal(readPixel(out, 4, 0, 3)[0], 1, '最后一列仍是源的第 1 列')
  assert.equal(readPixel(out, 4, 0, 0)[0], 0)
}])

cases.push(['1280 上限实测把 1644x773 的光栅省到合理字节数', () => {
  const fit = fitCaptureSize(1644, 773, 1280)
  const source = Buffer.alloc(1644 * 773 * 4, 7)
  const scaled = downscaleBgra(source, 1644, 773, fit.width, fit.height)
  assert.ok(scaled.length < source.length * 0.61, '光栅字节数：' + scaled.length + ' vs ' + source.length)
  assert.ok(scaled.length > source.length * 0.6, '按长边 1644→1280 收，面积只该少约 39%')
  assert.equal(scaled.length, fit.width * fit.height * 4)
  assert.equal(readPixel(scaled, fit.width, 0, 0)[0], 7)
  assert.equal(readPixel(scaled, fit.width, fit.height - 1, fit.width - 1)[0], 7, '最后一像素仍写满整块光栅')
}])

cases.push(['截图基准与点击基准必须是同一个 rect（左屏负原点、窗口比工作区高）', async () => {
  const target = windowFact({ hwnd: 4000470, x: -1700, y: 220, width: 710, height: 900 })
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  const capture = await backend.capture(screens[0])

  assert.deepEqual(screens[0].bounds, windowSurfaceRect(target), '观察面必须就是 windowSurfaceRect(frame ∩ workArea)')
  assert.deepEqual(screens[0].bounds, { x: -1700, y: 220, width: 710, height: 812 }, '工作区把窗口截短到 1032-220')
  assert.ok(capture.data.length > 0)

  const grabbed = host.log.filter((entry) => entry.kind === 'capturePng')
  assert.equal(grabbed.length, 1)
  assert.deepEqual(grabbed[0].bounds, screens[0].bounds, 'BitBlt 抓屏用的矩形必须就是观察面 bounds')

  const clicked = await backend.click({ screen: screens[0], position: [450, 19], button: 'left', count: 1 })
  const moved = host.log.filter((entry) => entry.kind === 'movePointer')
  assert.equal(moved.length, 1, '一次点击只摆一次指针')
  const expected = mapFractionToGlobal([0.45, 0.019], { bounds: grabbed[0].bounds })
  assert.deepEqual({ x: moved[0].x, y: moved[0].y }, { x: Math.round(expected.x), y: Math.round(expected.y) })
  assert.deepEqual({ x: moved[0].x, y: moved[0].y }, { x: -1380, y: 235 }, '450/1000 是分数不是像素：-1700+0.45*710, 220+0.019*812')
  assert.ok(moved[0].x > grabbed[0].bounds.x && moved[0].x < grabbed[0].bounds.x + grabbed[0].bounds.width)
  assert.ok(moved[0].y > grabbed[0].bounds.y && moved[0].y < grabbed[0].bounds.y + grabbed[0].bounds.height)
  assert.deepEqual(clicked.landed, { x: -1380, y: 235 }, '落点要回读出来给调用方自证')
}])

cases.push(['down 与 up 必须同一个坐标，中间不许插入移动（否则就是拖拽）', async () => {
  const target = windowFact({ hwnd: 4000470, x: 850, y: 110, width: 710, height: 756 })
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  await backend.click({ screen: screens[0], position: [300, 300], button: 'left', count: 1 })

  const sequence = host.log.map((entry) => entry.kind).filter((kind) => kind === 'movePointer' || kind === 'mouseButton')
  assert.deepEqual(sequence, ['movePointer', 'mouseButton', 'mouseButton'], '顺序只能是 移动 → 按下 → 抬起')
  const buttons = host.log.filter((entry) => entry.kind === 'mouseButton')
  assert.deepEqual(
    { down: buttons[0].down, up: buttons[1].down },
    { down: true, up: false },
    '先按下后抬起'
  )
  assert.deepEqual(buttons[0].point, buttons[1].point, 'down 与 up 的坐标必须完全相同')
  assert.deepEqual(buttons[0].point, { x: 1063, y: 337 }, '850+0.3*710, 110+0.3*756')
}])

cases.push(['本来就在前台时不该去抢焦点（目标前台时一次都不许调 focusWindow）', async () => {
  const target = windowFact({ hwnd: 4000470, x: 850, y: 110, width: 710, height: 756 })
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  await backend.click({ screen: screens[0], position: [500, 500], button: 'left', count: 1 })
  assert.deepEqual(host.log.filter((entry) => entry.kind === 'focusWindow'), [], '前台就是目标窗口时不该 SetForegroundWindow')

  await backend.hotkey({ keys: ['ctrl', 'w'] })
  assert.deepEqual(host.log.filter((entry) => entry.kind === 'focusWindow'), [], '热键同样不该抢本来就有的焦点')
}])

cases.push(['抢不到前台时热键照发、点击才拒绝（不许把全局热键整条路堵死）', async () => {
  const target = windowFact({ hwnd: 4000470, x: 850, y: 110, width: 710, height: 756 })
  const snapshot = { foregroundHwnd: 999, windows: [target] }
  const host = recordingHost(snapshot)
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  await backend.hotkey({ keys: ['ctrl', 'w'] })
  const focusAttempts = host.log.filter((entry) => entry.kind === 'focusWindow')
  assert.equal(focusAttempts.length, 1, '不在前台时先尽力抢一次')
  assert.ok(host.log.some((entry) => entry.kind === 'key'), '抢不到也照旧发键：热键本来就是发给系统的')
  await assert.rejects(
    () => backend.click({ screen: screens[0], position: [500, 500], button: 'left', count: 1 }),
    /refusing to click/,
    '点击仍然要拒绝，不能打到覆盖层上'
  )
}])

cases.push(['截图之后冒出一个 transient（气泡/下拉），点击仍按截图那一刻的 rect', async () => {
  const target = windowFact({ hwnd: 4000470, x: 850, y: 110, width: 710, height: 756 })
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  const bubble = {
    ...windowFact({ hwnd: 4000471, x: 1200, y: 600, width: 300, height: 200 }),
    pid: target.pid,
    ownerHwnd: target.hwnd,
    popup: true
  }
  host.setSnapshot({ foregroundHwnd: target.hwnd, windows: [target, bubble] })
  await backend.click({ screen: screens[0], position: [450, 19], button: 'left', count: 1 })
  const moved = host.log.filter((entry) => entry.kind === 'movePointer')[0]
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: 1170, y: 124 }, '850+0.45*710, 110+0.019*756：union 变大也不许挪落点')
}])

cases.push(['窗口真被搬动（owner 矩形变了）时才按新 rect 重算', async () => {
  const target = windowFact({ hwnd: 4000470, x: 850, y: 110, width: 710, height: 756 })
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  const moved = windowFact({ hwnd: 4000470, x: 100, y: 200, width: 710, height: 756 })
  host.setSnapshot({ foregroundHwnd: moved.hwnd, windows: [moved] })
  await backend.click({ screen: screens[0], position: [450, 19], button: 'left', count: 1 })
  const point = host.log.filter((entry) => entry.kind === 'movePointer')[0]
  assert.deepEqual({ x: point.x, y: point.y }, { x: 420, y: 214 }, '100+0.45*710, 200+0.019*756：截图过期就按现在的几何')
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error && error.message ? error.message : error))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
