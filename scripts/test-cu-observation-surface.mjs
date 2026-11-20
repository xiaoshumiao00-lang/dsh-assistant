/**
 * 单测：Computer Use 观察面挑选（vendor/computer-use 的 selectWindowsObservation）。
 *   node scripts/test-cu-observation-surface.mjs
 *
 * 对着 2026-11-20「录入店铺到轰趴后台」那次实录立的规矩：前台会话 124 步里有 44 步的
 * `<frontmost_window>` 是助手自己那颗 72x72 悬浮球（`dsh-assistant-ball`，
 * `alwaysOnTop:'screen-saver'` + `focusable:false` + `transparent:true`），于是整张观察
 * 截图就是那颗球，模型每个 `position` 都按球的面板换算 —— 11 次点击反复打在同一个位置。
 *
 * 固定这几条边界：
 *   - 覆盖层窗口（恒置顶 / 不可激活 / 带助手自身标题标记）一律抢不到观察面；
 *   - 前台窗口真是顶置应用时照旧保留它，不许换成后面某个窗口；
 *   - 桌面只剩悬浮球时兜底仍能观察它（旧行为，不把工具饿死）；
 *   - 宿主 cloak 的覆盖层 id、`selfWindowTitles` 追加标记、`ownerMinEdgePx` 照旧生效；
 *   - 同进程 owned/popup 的 transient 合并与跨进程系统菜单合并都没被改动。
 *   - 观察面 rect 就是抓屏矩形、也是点击映射矩形；前台已经是观察面时一次 focusWindow 都不该发生。
 */
import assert from 'node:assert/strict'
import { createWindowsDesktopBackend, isSelfUiWindow, selectWindowsObservation, selfUiTitlePatterns, windowSurfaceRect } from '../vendor/computer-use/backend-18yEf5Jq.js'

const MONITOR = { x: 0, y: 0, width: 1920, height: 1080 }

function fact(options) {
  const [x, y, width, height] = options.frame
  return {
    hwnd: options.hwnd,
    pid: options.pid ?? 1,
    ownerHwnd: options.ownerHwnd ?? 0,
    className: options.className ?? 'Chrome_WidgetWin_1',
    appName: options.appName ?? 'electron',
    title: options.title ?? '',
    visible: options.visible ?? true,
    iconic: options.iconic ?? false,
    cloaked: options.cloaked ?? false,
    toolWindow: options.toolWindow ?? false,
    popup: options.popup ?? false,
    topmost: options.topmost ?? false,
    noActivate: options.noActivate ?? false,
    clickThrough: options.clickThrough ?? false,
    frame: { x, y, width, height },
    monitor: options.monitor ?? MONITOR,
    monitorDpi: options.monitorDpi ?? 96
  }
}

/** 实测过的那颗球：72x72、恒置顶、不可激活、点击穿透。 */
const orb = fact({ hwnd: 100, title: 'dsh-assistant-ball', pid: 48424, frame: [1824, 732, 72, 72], topmost: true, noActivate: true, clickThrough: true })
/** 微信主窗口：Qt 类、1644x773、不顶置。 */
const wechat = fact({ hwnd: 200, title: '微信', className: 'Qt51514QWindowIcon', appName: 'WeChat', pid: 28788, frame: [223, 66, 1644, 773] })
/** 抢不到观察面的系统小窗（1x1 辅助窗）。 */
const helper = fact({ hwnd: 300, title: '', className: 'ThumbnailDeviceHelperWnd', pid: 12188, frame: [0, 0, 1, 1] })

const cases = []

cases.push(['前台只有系统辅助窗时，观察面是微信，不是悬浮球', () => {
  const observation = selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [orb, helper, wechat] }, [], {})
  assert.equal(observation.windowId, wechat.hwnd)
  assert.equal(observation.appName, 'WeChat')
  assert.equal(observation.windowTitle, '微信')
  assert.equal(observation.bounds.width, 1644, '观察面就是微信那一块，不是球的 72x72')
  assert.equal(observation.focused, false, '前台在辅助窗，键盘焦点不在观察面上')
}])

cases.push(['球不在列表里也算覆盖层：恒置顶 + 不可激活一律跳过（标题标记只是 belt-and-braces）', () => {
  const anonymousOverlay = fact({ hwnd: 140, title: '', pid: 48424, frame: [1824, 732, 72, 72], topmost: true, noActivate: true })
  const observation = selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [anonymousOverlay, helper, wechat] }, [], {})
  assert.equal(observation.windowId, wechat.hwnd)
}])

cases.push(['前台窗口真是顶置应用时保留它（用户在操作它，不许被后面的窗口换掉）', () => {
  const player = fact({ hwnd: 210, title: 'PotPlayer 播放中', appName: 'PotPlayerMini64', pid: 999, frame: [100, 100, 900, 500], topmost: true })
  const observation = selectWindowsObservation({ foregroundHwnd: player.hwnd, windows: [player, orb, wechat] }, [], {})
  assert.equal(observation.windowId, player.hwnd, 'tier 1 允许恒置顶的前台窗口当观察面')
  assert.equal(observation.focused, true)
}])

cases.push(['桌面上只剩悬浮球时兜底仍能观察它（不把 Computer Use 饿死）', () => {
  const observation = selectWindowsObservation({ foregroundHwnd: orb.hwnd, windows: [orb] }, [], {})
  assert.equal(observation.windowId, orb.hwnd, '最后一轮保持旧行为：唯一窗口照样观察')
  assert.equal(observation.bounds.width, 72)
}])

cases.push(['助手窗口没有标记时仍可正常操作（排除只认覆盖层与自身标记）', () => {
  const controlRoom = fact({ hwnd: 220, title: 'dsh-assistant-control-room 控制室', pid: 48424, frame: [300, 200, 800, 600] })
  const observation = selectWindowsObservation({ foregroundHwnd: controlRoom.hwnd, windows: [controlRoom, orb, wechat] }, [], {})
  assert.equal(observation.windowId, controlRoom.hwnd, '可激活、不顶置、无标记 → 就是一个普通应用窗口')
}])

cases.push(['selfWindowTitles 追加标记后，那窗口在前三轮里被跳过', () => {
  const controlRoom = fact({ hwnd: 220, title: 'dsh-assistant-control-room 控制室', pid: 48424, frame: [300, 200, 800, 600] })
  const observation = selectWindowsObservation(
    { foregroundHwnd: helper.hwnd, windows: [controlRoom, helper, wechat] },
    [],
    { selfWindowTitles: ['dsh-assistant-control-room'] },
  )
  assert.equal(observation.windowId, wechat.hwnd)
}])

cases.push(['宿主 cloak 给的覆盖层 id 照旧被跳过', () => {
  const observation = selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [orb, helper, wechat] }, [wechat.hwnd], {})
  assert.equal(observation.windowId, orb.hwnd, '微信被 cloak 掉之后只剩球：最后一轮兜底')
  assert.equal(selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [helper] }, [helper.hwnd], undefined), undefined)
}])

cases.push(['ownerMinEdgePx 是 tunable：默认 64 时小窗可用，调到 100 时让位给大窗', () => {
  const tinyApp = fact({ hwnd: 230, title: '一个小工具', appName: 'tinyapp', pid: 4242, frame: [900, 900, 70, 70] })
  assert.equal(selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [tinyApp, helper, wechat] }, [], {}).windowId, tinyApp.hwnd)
  assert.equal(selectWindowsObservation({ foregroundHwnd: helper.hwnd, windows: [tinyApp, helper, wechat] }, [], { ownerMinEdgePx: 100 }).windowId, wechat.hwnd)
}])

cases.push(['标题标记不看大小写，也不看前后缀', () => {
  assert.equal(isSelfUiWindow('DSH-Assistant-BALL', selfUiTitlePatterns(undefined)), true)
  assert.equal(isSelfUiWindow('鹈鹕 · dsh-assistant-ribbon 条带', selfUiTitlePatterns(undefined)), true)
  assert.equal(isSelfUiWindow('微信', selfUiTitlePatterns(undefined)), false)
  assert.equal(isSelfUiWindow(undefined, selfUiTitlePatterns(undefined)), false)
  assert.deepEqual(selfUiTitlePatterns(['自定义覆盖层']).slice(-1)[0], '自定义覆盖层')
}])

cases.push(['同进程 owned 与 intersecting popup 的 transient 合并照旧（观察面 union 不变）', () => {
  const tray = fact({ hwnd: 240, title: '微信截图工具', className: 'Qt51514QWindowIcon', appName: 'WeChat', pid: 28788, popup: true, frame: [1400, 600, 500, 240] })
  const observation = selectWindowsObservation({ foregroundHwnd: wechat.hwnd, windows: [wechat, orb, tray] }, [], {})
  assert.equal(observation.windowId, wechat.hwnd)
  assert.deepEqual(observation.transientWindowIds, [tray.hwnd])
  assert.equal(observation.bounds.x + observation.bounds.width, 1900, 'union 把同进程 popup 也算进观察面')
  assert.equal(selectWindowsObservation({ foregroundHwnd: wechat.hwnd, windows: [wechat, orb] }, [], {}).transientWindowIds.length, 0, '不相交的球不合并')
}])

cases.push(['跨进程系统菜单仍合并，别的跨进程窗口不合并（旧规则没被改动）', () => {
  const menu = fact({ hwnd: 250, title: '', className: '#32768', pid: 777, frame: [300, 300, 200, 120] })
  const foreign = fact({ hwnd: 260, title: '另一个 app', pid: 778, frame: [300, 300, 200, 120] })
  const observation = selectWindowsObservation({ foregroundHwnd: wechat.hwnd, windows: [wechat, menu, foreign] }, [], {})
  assert.deepEqual(observation.transientWindowIds, [menu.hwnd])
}])

cases.push(['不同显示器的窗口不当 transient（多屏边界没动）', () => {
  const secondMonitor = { x: 1920, y: 0, width: 1080, height: 1080 }
  const popupElsewhere = fact({ hwnd: 270, title: '另一个屏的弹窗', pid: 28788, popup: true, frame: [2000, 200, 400, 300], monitor: secondMonitor })
  const observation = selectWindowsObservation({ foregroundHwnd: wechat.hwnd, windows: [wechat, popupElsewhere] }, [], {})
  assert.deepEqual(observation.transientWindowIds, [])
}])

cases.push(['助手自己的窗口与观察面相交时也不并进 transient 集合（同进程 popup 也挡掉）', () => {
  const overlappingOrb = fact({ hwnd: 280, title: 'dsh-assistant-ball', pid: 28788, ownerHwnd: wechat.hwnd, popup: true, topmost: true, noActivate: true, frame: [1500, 700, 72, 72] })
  const observation = selectWindowsObservation({ foregroundHwnd: wechat.hwnd, windows: [wechat, overlappingOrb] }, [], {})
  assert.equal(observation.windowId, wechat.hwnd)
  assert.deepEqual(observation.transientWindowIds, [], '自身标记窗口绝不扩观察面')
  assert.equal(observation.bounds.width, 1644, '观察面边界没有被那颗球撑大')
}])

/** 记录型宿主：抓屏矩形、指针落点、前台判定全部留痕（不碰真机）。 */
function recordingHost(snapshot) {
  const log = []
  let cursor = { x: 0, y: 0 }
  return {
    log,
    listWindows: () => snapshot,
    foregroundWindowId: () => snapshot.foregroundHwnd,
    focusWindow: (hwnd) => {
      log.push({ kind: 'focusWindow', hwnd })
      return hwnd === snapshot.foregroundHwnd
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
      log.push({ kind: 'mouseButton', button, down, point })
    },
    cursorPosition: () => ({ ...cursor }),
    key: (virtualKey, down) => {
      log.push({ kind: 'key', virtualKey, down })
    },
    scrollWheel: () => {},
    virtualScreen: () => ({ x: 0, y: 0, width: 1920, height: 1080 })
  }
}

cases.push(['截图基准与点击基准必须是同一个 rect（微信 1644x773：抓屏矩形 = 点击映射矩形）', async () => {
  const host = recordingHost({ foregroundHwnd: wechat.hwnd, windows: [wechat, orb] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  const grabbed = host.log.filter((entry) => entry.kind === 'capturePng')
  assert.equal(grabbed.length, 1)
  assert.deepEqual(grabbed[0].bounds, screens[0].bounds, 'BitBlt 抓屏矩形必须等于观察面 bounds')
  assert.deepEqual(screens[0].bounds, windowSurfaceRect(wechat), '观察面 bounds 必须等于 frame ∩ workArea')
  assert.deepEqual(screens[0].bounds, { x: 223, y: 66, width: 1644, height: 773 })

  const clicked = await backend.click({ screen: screens[0], position: [500, 500], button: 'left', count: 1 })
  const moved = host.log.filter((entry) => entry.kind === 'movePointer')
  assert.equal(moved.length, 1, '一次点击只摆一次指针')
  assert.deepEqual({ x: moved[0].x, y: moved[0].y }, { x: 1045, y: 452 }, '223+0.5*1644, 66+0.5*773')
  assert.deepEqual(clicked.landed, { x: 1045, y: 452 })
  assert.ok(moved[0].x > grabbed[0].bounds.x && moved[0].x < grabbed[0].bounds.x + grabbed[0].bounds.width)
  assert.ok(moved[0].y > grabbed[0].bounds.y && moved[0].y < grabbed[0].bounds.y + grabbed[0].bounds.height)
}])

cases.push(['本来就在前台时不该去抢焦点（前台就是微信：一次 focusWindow 都不许有）', async () => {
  const host = recordingHost({ foregroundHwnd: wechat.hwnd, windows: [wechat, orb] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  await backend.click({ screen: screens[0], position: [500, 500], button: 'left', count: 1 })
  await backend.hotkey({ keys: ['ctrl', 'w'] })
  assert.deepEqual(host.log.filter((entry) => entry.kind === 'focusWindow'), [], '目标本来就在前台，不许 SetForegroundWindow，连 Alt 都不该按')
  assert.ok(host.log.some((entry) => entry.kind === 'key'), '热键照发')
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    run()
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error && error.message ? error.message : error))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
