import { androidPackageSegment as PACKAGE_SEGMENT } from './personal-context-lib.mjs'
/**
 * 安卓「后台保活 + 切回秒恢复 + 后台任务完成播报」源码守卫（2026-11-27 需求）。
 *
 * 需求原话：切后台（看微信）过一会再打开，不要重新连接白等；常驻后台保持在线，
 * 后台任务完成时语音播报要及时收到。
 *
 * 方案（四件套，缺一件这条链就断）：
 *   A. 原生前台服务 KeepAliveService：常驻低优先级通知「个人助手常驻连接中」，
 *      START_STICKY + onTaskRemoved 闹钟兜底 + Doze 周期闹钟（setAndAllowWhileIdle），
 *      Android 12+ 后台起服务被 ForegroundServiceStartNotAllowedException 拦住时吞掉等回前台；
 *   B. 切后台不丢连接：MainActivity.onPause 不再调 web.onPause()（JS 定时器/WebSocket/媒体
 *      继续在跑）；onResume 只做健康探测（渲染进程卡死才重建），连接恢复交给页面侧
 *      foreground-nudge：可见时 state!=='connected' 立刻 connection.reconnect() 并按
 *      NUDGE_RETRY_MS 阶梯补刀；协议层心跳仍是代理的 30s ping（proxy.mjs）；
 *   C. 后台收任务完成 + TTS：秘书回复自动朗读的唯一入口 requestAutoReadOnce 在
 *      「页面不可见/原生标记后台」且安卓桥在时改走原生：DshAssistantNative.speakNative
 *      （原生 TextToSpeech，key 去重 = 已播报标记，回来不重读）+ notifyTaskDone
 *      （系统通知，点击回会话）；
 *   D. 省电策略：设置页给「电池优化白名单」入口（ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS），
 *      给开关不强弹；POST_NOTIFICATIONS 运行时权限 Android 13+ 启动时申请一次。
 *
 * 本机没有 Android 运行时，这里做源码守卫：把「必须存在的那几行」钉住，防止以后重构
 * 静默删掉。它不替代真机验证，真机步骤见 docs/安卓后台保活-秒恢复-20261127.md。
 *
 *   node scripts/test-android-background-keepalive.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', PACKAGE_SEGMENT(), 'assistant')

function readOrEmpty(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

const manifest = readOrEmpty(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
const mainActivity = readOrEmpty(join(JAVA_DIR, 'MainActivity.java'))
const keepAliveService = readOrEmpty(join(JAVA_DIR, 'KeepAliveService.java'))
const nativeBridge = readOrEmpty(join(JAVA_DIR, 'NativeBridge.java'))
const foregroundNudge = readOrEmpty(join(ROOT, 'src', 'client', 'pocket', 'orb', 'foreground-nudge.ts'))
const nativeBridgeTs = readOrEmpty(join(ROOT, 'src', 'client', 'pocket', 'orb', 'native-assistant-bridge.ts'))
const secretarySpeech = readOrEmpty(join(ROOT, 'src', 'client', 'pocket', 'orb', 'secretary-speech.ts'))
const pocketIndex = readOrEmpty(join(ROOT, 'src', 'client', 'pocket', 'index.jsx'))
const proxy = readOrEmpty(join(ROOT, 'src', 'pocket-host', 'proxy.mjs'))

let failures = 0
function case_(name, fn) {
  try { fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

/** 取某个方法/函数的源码块（大括号配平）：Java 方法或 TS 的 export function 都认。 */
function methodBody(src, name, owner = '源码') {
  const decl = new RegExp(`(?:private|public|protected|static|export\\s+function|function)[^\\n]*\\b${name}\\s*\\(`)
  const m = decl.exec(src)
  assert.notEqual(m, null, `${owner} 里必须还有 ${name}() 方法`)
  const open = src.indexOf('{', m.index)
  assert.notEqual(open, -1, `${name}() 找不到方法体`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${name}() 大括号不配平`)
}

/* ==================== 1. Manifest：权限与服务声明 ==================== */

case_('manifest：前台服务三件套权限（FOREGROUND_SERVICE / DATA_SYNC / POST_NOTIFICATIONS）', () => {
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE"'), '缺 FOREGROUND_SERVICE')
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC"'), 'targetSdk 34 起 dataSync 类型必须单独声明')
  assert.ok(manifest.includes('android.permission.POST_NOTIFICATIONS"'), 'Android 13+ 常驻通知/任务通知都要它')
})

case_('manifest：WAKE_LOCK 与 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限', () => {
  assert.ok(manifest.includes('android.permission.WAKE_LOCK"'), 'Doze 兜底闹钟续唤醒锁要 WAKE_LOCK')
  assert.ok(manifest.includes('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"'), '电池优化白名单引导要这条权限')
})

case_('manifest：声明 .KeepAliveService，foregroundServiceType=dataSync，不导出', () => {
  assert.match(manifest, /<service[^>]*android:name="\.KeepAliveService"/s, '缺 KeepAliveService 声明')
  assert.match(manifest, /android:foregroundServiceType="dataSync"/, 'Android 14 必须声明前台服务类型')
  assert.match(manifest, /<service[^>]*android:exported="false"/s, '保活服务不许导出')
})

/* ==================== 2. KeepAliveService：前台服务 + 兜底 ==================== */

case_('KeepAliveService：startForeground 在 API29+ 带 dataSync 类型（AOSP 值 1）', () => {
  assert.match(keepAliveService, /class KeepAliveService extends Service/, '必须是框架 Service（无 androidx 依赖）')
  assert.match(keepAliveService, /FGS_TYPE_DATA_SYNC\s*=\s*1/, '本机 android.jar 桩缺 Service 常量，必须钉 AOSP 值 1')
  assert.match(keepAliveService, /startForeground\(NOTIF_ID,\s*notification,\s*FGS_TYPE_DATA_SYNC\)/,
    'API29+ 必须三参 startForeground 并钉 dataSync 类型（targetSdk 34 的硬要求）')
  assert.match(keepAliveService, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q/, '三参重载要按 Q(29) 分流')
})

case_('KeepAliveService：常驻通知渠道 dsh_keepalive + 低优先级 + 「常驻连接中」文案', () => {
  assert.match(keepAliveService, /CHANNEL_ID\s*=\s*"dsh_keepalive"/, '缺 keepalive 通知渠道常量')
  assert.match(keepAliveService, /new NotificationChannel\(/, '必须真的建通知渠道（API26+）')
  assert.match(keepAliveService, /IMPORTANCE_MIN/, '常驻通知必须最低优先级（不打扰）')
  assert.ok(keepAliveService.includes('常驻连接中'), '常驻通知文案必须说明「常驻连接中」')
  assert.match(keepAliveService, /setOngoing\(true\)/, '常驻通知不许被划掉')
})

case_('KeepAliveService：START_STICKY + onTaskRemoved 闹钟兜底重启', () => {
  assert.match(keepAliveService, /return START_STICKY/, '服务被回收后要粘住重启')
  const body = methodBody(keepAliveService, 'onTaskRemoved', 'KeepAliveService')
  assert.match(body, /scheduleRestart\(/, '最近任务划掉后必须约一次重启闹钟')
})

case_('KeepAliveService：Doze 兜底——setAndAllowWhileIdle 周期闹钟 + 部分唤醒锁', () => {
  assert.match(keepAliveService, /setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP/, 'Doze 下只能用 setAndAllowWhileIdle 兜底')
  assert.match(keepAliveService, /TICK_MS\s*=\s*9 \* 60 \* 1000/, '周期兜底节拍约 9 分钟（Doze 维护窗口会再合并）')
  assert.match(keepAliveService, /PARTIAL_WAKE_LOCK/, '兜底节拍要续部分唤醒锁，让 WebView 的 WS 收发有机会跑')
})

case_('KeepAliveService：startForegroundService 调用兜住 ForegroundServiceStartNotAllowedException（Android 12+）', () => {
  assert.match(keepAliveService, /startForegroundService\(intent\)/, 'API26+ 必须走 startForegroundService')
  assert.ok(keepAliveService.includes('ForegroundServiceStartNotAllowedException'),
    '注释/处理里必须点名 Android 12+ 的后台启动限制，防止后人删掉 try/catch')
  const body = methodBody(keepAliveService, 'start', 'KeepAliveService')
  assert.match(body, /catch \(Throwable/, '后台起服务被拦时不许把异常抛给调用方（Activity 会崩）')
})

case_('KeepAliveService：电池优化白名单助手（状态查询 + 引导 Intent）', () => {
  assert.match(keepAliveService, /isIgnoringBatteryOptimizations\(/, '必须能查白名单状态（设置页显示用）')
  assert.ok(keepAliveService.includes('Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'),
    '必须提供跳系统白名单授权的 Intent（用户手动点，不强弹）')
})

/* ==================== 3. MainActivity：切后台不丢连接 ==================== */

case_('MainActivity：onPause 不再暂停 WebView（JS/WS/媒体后台继续跑）', () => {
  const body = methodBody(mainActivity, 'onPause', 'MainActivity')
  assert.equal(body.includes('web.onPause()'), false,
    'onPause 里调 web.onPause() 会暂停 WebView 处理，后台保活必须去掉（Cookie flush 保留）')
  assert.ok(body.includes('CookieManager.getInstance().flush()'), 'cookie 落盘保留，别误删')
  assert.ok(body.includes('NativeBridge.setAppInBackground(true)'), 'onPause 必须更新原生后台标记（页面据此走原生播报）')
})

case_('MainActivity：onStop/onDestroy 之外不重建 WebView；onDestroy 才 destroy', () => {
  assert.equal(mainActivity.includes('void onStop('), false, '不许重写 onStop 去动 WebView（后台不重建）')
  const destroy = methodBody(mainActivity, 'onDestroy', 'MainActivity')
  assert.ok(destroy.includes('web.destroy()'), '真正销毁只在 onDestroy')
})

case_('MainActivity：onResume 只做健康探测（渲染卡死才重建），不无条件 reload', () => {
  const body = methodBody(mainActivity, 'onResume', 'MainActivity')
  assert.equal(body.includes('loadUrl('), false, 'onResume 不许无条件 loadUrl（那就是用户骂的「重连白等」）')
  assert.ok(body.includes('NativeBridge.setAppInBackground(false)'), 'onResume 必须清原生后台标记')
  assert.ok(body.includes('probePageAlive()'), 'onResume 必须探活：渲染进程卡死才 recoverWebView')
  const probe = methodBody(mainActivity, 'probePageAlive', 'MainActivity')
  assert.match(probe, /evaluateJavascript\(/, '探活走 evaluateJavascript（渲染卡死时回调永远不会来）')
  assert.match(probe, /recoverWebView\(\)/, '探活超时必须重建 WebView（等同于刷新一次）')
})

case_('MainActivity：WebView 注册 DshAssistantNative JS 桥（含 recoverWebView 重建路径）', () => {
  assert.match(mainActivity, /addJavascriptInterface\(new NativeBridge\(this\),\s*"DshAssistantNative"\)/,
    '桥必须在 buildWebView 里注册，渲染进程重建后桥才还在')
})

case_('MainActivity：Android 13+ 启动时申请 POST_NOTIFICATIONS 运行时权限', () => {
  assert.match(mainActivity, /Build\.VERSION\.SDK_INT >= 33/, 'POST_NOTIFICATIONS 是 API33 的运行时权限')
  assert.ok(mainActivity.includes('Manifest.permission.POST_NOTIFICATIONS'), '必须申请 POST_NOTIFICATIONS')
  assert.match(mainActivity, /requestPermissions\(/, '必须真的发起运行时申请')
})

case_('MainActivity：设置页有「后台保活」开关与「电池优化白名单」入口（给开关不强弹）', () => {
  assert.ok(mainActivity.includes('后台常驻保活'), '设置页必须有保活开关行')
  assert.ok(mainActivity.includes('KeepAliveService.setEnabled('), '开关必须落到 KeepAliveService')
  assert.ok(mainActivity.includes('电池优化白名单'), '设置页必须有白名单入口行')
  assert.ok(mainActivity.includes('KeepAliveService.batteryWhitelistIntent('), '白名单按钮必须跳系统授权页')
})

/* ==================== 4. NativeBridge：通知 + 原生 TTS ==================== */

case_('NativeBridge：@JavascriptInterface 四件套（后台标记/通知/原生播报/保活开关）', () => {
  for (const m of ['isAppInBackground', 'notifyTaskDone', 'speakNative', 'setKeepAliveEnabled']) {
    assert.match(nativeBridge, new RegExp(`@JavascriptInterface[\\s\\S]*?\\b${m}\\s*\\(`), `缺 @JavascriptInterface ${m}()`)
  }
})

case_('NativeBridge：原生 TextToSpeech 播报 + 按 key 去重（已播报标记，回来不重读）', () => {
  assert.match(nativeBridge, /new TextToSpeech\(/, '必须用原生 TextToSpeech（后台 WebAudio 不可靠）')
  assert.match(nativeBridge, /Locale\.CHINESE/, '默认中文播报')
  assert.match(nativeBridge, /spokenKeys/, '必须按卡片 key 去重（与页面 autoReadSeen 双保险）')
  const body = methodBody(nativeBridge, 'speakNative', 'NativeBridge')
  assert.match(body, /spokenKeys/, 'speakNative 里必须先查去重表再播报')
})

case_('NativeBridge：任务完成系统通知（独立高优先级渠道，点击回 MainActivity）', () => {
  assert.match(nativeBridge, /CHANNEL_TASK_DONE\s*=\s*"dsh_task_done"/, '缺任务完成通知渠道常量')
  assert.match(nativeBridge, /new NotificationChannel\(/, '必须真的建通知渠道（API26+）')
  assert.match(nativeBridge, /IMPORTANCE_HIGH/, '任务完成通知必须高优先级（后台要看得见）')
  const body = methodBody(nativeBridge, 'postTaskDoneNotification', 'NativeBridge')
  assert.match(body, /MainActivity\.class/, '点通知必须回到 MainActivity（singleTask 直接回前台）')
  assert.match(body, /setAutoCancel\(true\)/, '点完通知要自动消掉')
})

/* ==================== 5. 页面侧：可见即重连（退避阶梯） ==================== */

case_('foreground-nudge：可见时 state!==connected 立即 reconnect()，并按阶梯补刀', () => {
  assert.match(foregroundNudge, /visibilitychange/, '必须挂 visibilitychange')
  assert.match(foregroundNudge, /getSnapshot\?\.\(\)|getSnapshot\(\)/, '必须读 DSH 连接层 state.getSnapshot()')
  assert.match(foregroundNudge, /reconnect\?\.\(\)|reconnect\(\)/, '必须调 DSH 连接层 reconnect()（清零退避立即重试）')
  assert.match(foregroundNudge, /NUDGE_RETRY_MS\s*=\s*\[2000,\s*4000,\s*8000,\s*15000,\s*30000\]/,
    '可见期间补刀阶梯必须钉死：2s→4s→8s→15s→30s 封顶')
  assert.match(foregroundNudge, /if \(doc\.hidden\) clearAll\(\)/, '页面重新隐藏时必须停止补刀')
})

case_('foreground-nudge：暴露 __dshAssistantConnState 给原生探活读取', () => {
  assert.ok(foregroundNudge.includes('__dshAssistantConnState'), '原生 onResume 探活要读这个全局')
})

case_('pocket/index.jsx：apply 里安装前台即重连（installForegroundNudge）', () => {
  assert.match(pocketIndex, /import \{ installForegroundNudge \} from '\.\/orb\/foreground-nudge\.ts'/, '缺 import')
  assert.match(pocketIndex, /installForegroundNudge\(ctx\)/, 'apply(ctx) 必须安装')
})

/* ==================== 6. 页面侧：后台任务完成 → 原生播报 + 通知 ==================== */

case_('secretary-speech：自动朗读唯一入口 requestAutoReadOnce 有后台原生分支', () => {
  const body = methodBody(secretarySpeech, 'requestAutoReadOnce', 'secretary-speech')
  assert.match(body, /nativeBackgroundSpeak\(globalThis,\s*key,\s*text\)/,
    '后台必须改走原生播报（WebAudio 在后台被挂起，JS 播报不可靠）')
  assert.match(body, /if \(nativeBackgroundSpeak[\s\S]*?return true/, '原生接住后必须 return true（不再走 WebAudio，防止两路叠声）')
  const speechIdx = body.indexOf('nativeBackgroundSpeak(')
  const requestIdx = body.indexOf('secretarySpeech.request(')
  assert.ok(speechIdx !== -1 && requestIdx !== -1 && speechIdx < requestIdx, '原生分支必须挡在 secretarySpeech.request 之前')
})

case_('native-assistant-bridge：页面不可见或原生后台标记才走原生，且按 key 去重', () => {
  assert.match(nativeBridgeTs, /\.hidden === true/, '页面可见性判据必须是 document.hidden')
  assert.match(nativeBridgeTs, /isAppInBackground/, '原生后台标记必须参与判定（WebView 可见性在个别 ROM 上不可信）')
  assert.match(nativeBridgeTs, /DshAssistantNative/, '桥对象名必须钉死 DshAssistantNative（与 Java 侧一致）')
  assert.match(nativeBridgeTs, /__dshNativeSpokenKeys/, '去重表必须挂 globalThis（模块重求值也不重播）')
  assert.match(nativeBridgeTs, /notifyTaskDone\?\.\(|notifyTaskDone\(/, '播报的同时必须出系统通知')
})

case_('native-assistant-bridge：通知正文压空白并截断（通知栏不是正文阅读器）', () => {
  assert.match(nativeBridgeTs, /NOTIFY_TEXT_MAX\s*=\s*80/, '通知正文截断长度钉在 80 字')
  assert.match(nativeBridgeTs, /replace\(\/\\s\+\/g/, '多行/多余空白必须压成一行')
})

/* ==================== 7. 既有心跳不回退（代理 30s 协议层 ping） ==================== */

case_('proxy：WebSocket 协议层心跳仍是 30s ping、容忍 2 个静默周期', () => {
  assert.match(proxy, /attachWebSocketHeartbeat\(socket, \{ intervalMs = 30_000, missLimit = 2 \}/,
    '代理注入的 30s 协议层 ping 是后台保活的另一半，不许动')
  assert.match(proxy, /socket\.write\(WS_PING_FRAME\)/, '心跳帧必须真的写出去')
})

process.exit(failures === 0 ? 0 : 1)
