/**
 * 现场验证（只读）：用改过的 vendor 代码枚举这台机器上真实的窗口，
 * 看助手悬浮球的事实（恒置顶 / 不可激活 / 自身标题）与新的四轮观察面挑选。
 *   node scripts/verify-cu-observation-live.mjs
 * 不落任何文件、不动输入，只 EnumWindows + GetWindowLong + DWM 边界。
 */
import { eligibleOwner as eligibleOwnerOf, selectWindowsObservation, selfUiTitlePatterns } from '../vendor/computer-use/backend-18yEf5Jq.js'
import { createProductionWindowsOps } from '../vendor/computer-use/windows-native-B7Ig34Q0.js'

const patterns = selfUiTitlePatterns(undefined)
const minEdge = 64

const log = (line) => {
  process.stdout.write(line + '\n')
}

const ops = createProductionWindowsOps({ captureMaxEdgePx: 1280 })
const snapshot = ops.listWindows()
const foreground = snapshot.windows.find((window) => window.hwnd === snapshot.foregroundHwnd)

log('窗口总数: ' + snapshot.windows.length)
log('前台窗口: ' + (foreground ? `${foreground.title} / ${foreground.className} / ${foreground.frame.width}x${foreground.frame.height}` : '无')
	+ ` (topmost=${Boolean(foreground?.topmost)} noActivate=${Boolean(foreground?.noActivate)})`)

const self = snapshot.windows.filter((window) => /dsh-assistant|dsh-orb/i.test(window.title ?? ''))
log('助手自身窗口 ' + self.length + ' 个:')
for (const window of self) {
  log(`  hwnd=${window.hwnd} title=${JSON.stringify(window.title)} class=${window.className} ${window.frame.width}x${window.frame.height} topmost=${window.topmost} noActivate=${window.noActivate} clickThrough=${window.clickThrough} popup=${window.popup} toolWindow=${window.toolWindow}`)
}

for (const tier of [1, 2, 3, 4]) {
  const candidates = tier === 1 ? [foreground].filter(Boolean) : snapshot.windows
  const hit = candidates.find((window) => eligibleOwnerOf(window, new Set(), tier, patterns, minEdge))
  log('tier ' + tier + ' 首个可当选: ' + (hit ? `${hit.title || hit.className} ${hit.frame.width}x${hit.frame.height}${hit.topmost ? ' 顶置' : ''}${hit.noActivate ? ' 不可激活' : ''}` : '无'))
}

const observation = selectWindowsObservation(snapshot, [], {})
log('新观察面: ' + (observation
	? `hwnd=${observation.windowId} app=${observation.appName} title=${JSON.stringify(observation.windowTitle)} bounds=${observation.bounds.width}x${observation.bounds.height}@${observation.bounds.x},${observation.bounds.y} focused=${observation.focused} transient=${observation.transientWindowIds.length}`
	: '无'))

const firstOverlapping = snapshot.windows.find((window) => /dsh-assistant-ball/i.test(window.title ?? ''))
if (firstOverlapping !== void 0 && observation !== void 0) {
  log('球是否当上观察面: ' + (observation.windowId === firstOverlapping.hwnd ? '是（不该）' : '否（已被跳过）'))
  log('观察窗口列表里还有没有助手窗口: ' + (observation.transientWindowIds.includes(firstOverlapping.hwnd) ? '有（不该）' : '否'))
}
