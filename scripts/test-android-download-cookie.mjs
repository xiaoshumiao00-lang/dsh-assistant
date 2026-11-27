/**
 * 安卓下载链路「带上登录态 + 失败可见」的源码守卫（2026-11-26 真机 bug）。
 *
 * 背景（真机现象）：手机点秘书回复卡里的 Word 附件后，通知栏出现一条「正在下载」，
 * 永远下载不下来、也打不开。离线取证结论：DownloadManager 不继承 WebView 的 cookie，
 * pocket 代理对无凭证请求回 401 `{"error":"unauthorized"}`（24 字节、chunked、无 content-length），
 * 于是下载器既拿不到文件也拿不到大小，通知栏停在 0%。
 *
 * 这条链路的修复只能落在 Java（android/app/src/main/java/com/chenpan/assistant/MainActivity.java），
 * 本机没有 Android 运行时，所以这里做**源码守卫**：把「必须存在的那几行」钉住，
 * 防止以后重构 MainActivity 时又把 Cookie 头 / 文件名解析 / 失败提示静默删掉。
 * 它不替代真机验证，真机步骤见 docs/安卓附件下载-401-根因-20261126.md。
 *
 *   node scripts/test-android-download-cookie.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const javaPath = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', '<NAME-PINYIN>', 'assistant', 'MainActivity.java')
const java = readFileSync(javaPath, 'utf8')
const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')

let failures = 0
function case_(name, fn) {
  try { fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

/** 取某个方法的源码块（到下一个同级方法签名/类尾为止）：按大括号配平截取，别用正则截一半。 */
function methodBody(name) {
  const decl = new RegExp(`(?:private|public|protected)[^\\n]*\\b${name}\\s*\\(`)
  const m = decl.exec(java)
  assert.notEqual(m, null, `MainActivity 里必须还有 ${name}() 方法`)
  const open = java.indexOf('{', m.index)
  assert.notEqual(open, -1, `${name}() 找不到方法体`)
  let depth = 0
  for (let i = open; i < java.length; i++) {
    const ch = java[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return java.slice(open, i + 1)
    }
  }
  throw new Error(`${name}() 大括号不配平`)
}

/* ---------- 1. DownloadListener 仍然接到 startDownload ---------- */

case_('DownloadListener 仍然回调 startDownload(url, contentDisposition, mimeType)', () => {
  assert.match(java, /setDownloadListener\(new android\.webkit\.DownloadListener\(\)/)
  assert.match(java, /onDownloadStart\(String url, String userAgent, String contentDisposition,\s*\n?\s*String mimeType, long contentLength\)/)
  assert.match(java, /startDownload\(url, contentDisposition, mimeType\)/)
})

/* ---------- 2. 核心：下载请求必须带 WebView 的 cookie ---------- */

case_('startDownload 从 CookieManager 取 cookie 并塞进下载请求（缺这条就会 401）', () => {
  const body = methodBody('startDownload')
  assert.match(body, /CookieManager\.getInstance\(\)\.getCookie\(url\)/, '必须按下载 URL 取 WebView 的 cookie')
  assert.match(body, /addRequestHeader\("Cookie",\s*cookies\)/, '必须 addRequestHeader("Cookie", …)，否则系统下载器裸奔')
  // 取到 cookie 才加头：空 cookie 时不要发一个空 Cookie 头
  assert.match(body, /if \(!TextUtils\.isEmpty\(cookies\)\)/, 'cookie 为空时不该硬加一个空头')
})

case_('startDownload 不再出现「裸 Request」：Cookie 头在 enqueue 之前加上', () => {
  const body = methodBody('startDownload')
  const cookieAt = body.indexOf('addRequestHeader("Cookie"')
  const enqueueAt = body.indexOf('dm.enqueue(')
  assert.notEqual(enqueueAt, -1, 'startDownload 必须 enqueue')
  assert.equal(cookieAt !== -1 && cookieAt < enqueueAt, true, 'Cookie 头必须在 enqueue 之前')
  assert.match(body, /new DownloadManager\.Request\(Uri\.parse\(url\)\)/, 'URL 走 Uri.parse，保持原样（WebView 给的已是绝对地址）')
})

/* ---------- 3. 落盘文件名：RFC 5987 的中文名不要被 ________ 顶掉 ---------- */

case_('fileNameFor 优先解析 filename*=UTF-8\'\'，并退回 URLUtil.guessFileName', () => {
  const body = methodBody('fileNameFor')
  // Java 源码里的正则字面量是 filename\\*\\s*=\\s*UTF-8''（转义过的反斜杠），用 String.raw 逐字比对
  assert.equal(body.includes(String.raw`filename\\*\\s*=\\s*UTF-8''`), true, '必须认 RFC 5987 的 filename*')
  assert.match(body, /URLDecoder\.decode\([^\n]*?"UTF-8"\)/, 'filename* 是百分号编码，必须解码')
  assert.match(body, /URLUtil\.guessFileName\(/, '解析不出来要退回 guessFileName')
  assert.match(body, /replace\('\\\\\\\\', '_'\)|replace\('\\\\', '_'\)/, '落盘名不许带路径分隔符（否则 setDestinationInExternalPublicDir 抛异常）')
})

case_('startDownload 用的就是 fileNameFor 的结果', () => {
  assert.match(methodBody('startDownload'), /fileNameFor\(url, contentDisposition, mimeType\)/)
  assert.match(methodBody('startDownload'), /setDestinationInExternalPublicDir\(Environment\.DIRECTORY_DOWNLOADS,\s*name\)/)
})

/* ---------- 4. 下载结果要看得见：成功/失败都提示 ---------- */

case_('下载完成广播注册在案，且只认自己 enqueue 的 id', () => {
  const body = methodBody('watchDownload')
  assert.match(body, /new BroadcastReceiver\(\)/)
  assert.match(body, /DownloadManager\.ACTION_DOWNLOAD_COMPLETE/)
  assert.match(body, /EXTRA_DOWNLOAD_ID/)
  assert.match(body, /if \(done != pendingDownloadId\) return/, '别去处理系统里别人的下载')
  assert.match(body, /Context\.RECEIVER_NOT_EXPORTED/, 'Android 13+ 必须显式声明不导出')
  assert.match(body, /Build\.VERSION\.SDK_INT >= 33/)
})

case_('成功与失败都有 toast（旧版失败时一声不响，通知栏永远转圈）', () => {
  const body = methodBody('reportDownload')
  assert.match(body, /STATUS_SUCCESSFUL/)
  assert.match(body, /toast\("已下载到/)
  assert.match(body, /toast\("下载失败（/)
  const text = methodBody('downloadFailureText')
  for (const key of ['ERROR_INSUFFICIENT_SPACE', 'ERROR_UNHANDLED_HTTP_CODE', 'ERROR_HTTP_DATA_ERROR']) {
    assert.equal(text.includes(key), true, `downloadFailureText 要翻 ${key}`)
  }
})

/* ---------- 5. 图片下载完成 → 系统看图应用（2026-11-27 需求） ---------- */

case_('reportDownload 成功分支：图片走 openDownloadedImage，其余保持原 toast', () => {
  const body = methodBody('reportDownload')
  assert.match(body, /STATUS_SUCCESSFUL/, '成功分支还在')
  assert.match(body, /isImageDownload\(id, name\)/, '成功时必须先判是不是图片')
  assert.match(body, /openDownloadedImage\(id, name\)/, '图片必须尝试拉起看图应用')
  assert.match(body, /toast\("已下载到「下载」：" \+ name \+ "\\n点通知栏那条可以直接打开"\)/,
    '非图片的成功提示一字不许动（文件仍保持通知 + toast）')
})

case_('openDownloadedImage：ACTION_VIEW + content Uri + 读权限授权，不许 file://', () => {
  const body = methodBody('openDownloadedImage')
  assert.match(body, /Intent\.ACTION_VIEW/, '必须用 ACTION_VIEW 拉起系统看图应用')
  assert.match(body, /setDataAndType\(uri, mime\)/, '必须 setDataAndType（图片 MIME）')
  assert.match(body, /getUriForDownloadedFile\(id\)/, '必须用 DownloadManager 的 content:// Uri')
  assert.match(body, /FLAG_GRANT_READ_URI_PERMISSION/, 'content Uri 必须临时授权给看图应用')
  assert.match(body, /FLAG_ACTIVITY_NEW_TASK/, '广播回调里起 Activity 必须 NEW_TASK')
  assert.equal(body.includes('"file://'), false, 'Android 7+ 直接 file:// 会 FileUriExposedException')
  assert.match(body, /ActivityNotFoundException/, '没装看图应用要接得住（退回 toast）')
})

case_('isImageDownload：MIME image/ 优先，扩展名兜底', () => {
  const body = methodBody('isImageDownload')
  assert.match(body, /getMimeTypeForDownloadedFile\(id\)/, '先查系统下载器记的 MIME')
  assert.match(body, /startsWith\("image\/"\)/, 'image/* 即算图片')
  for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']) {
    assert.equal(body.includes(`"${ext}"`), true, `扩展名兜底要认 ${ext}`)
  }
})

/* ---------- 6. 生命周期与清单不变式 ---------- */

case_('onDestroy 注销下载广播（不泄漏 receiver）', () => {
  const body = methodBody('onDestroy')
  assert.match(body, /unregisterReceiver\(downloadReceiver\)/)
})

case_('清单仍然允许明文 http（手机入口是 http://IP:7080，没有它下载直接连不上）', () => {
  assert.match(manifest, /android:usesCleartextTraffic="true"/)
  assert.match(manifest, /android\.permission\.INTERNET/)
  // WRITE_EXTERNAL_STORAGE 只对 API<=28 需要；写死 maxSdkVersion=28 是有意为之
  assert.match(manifest, /WRITE_EXTERNAL_STORAGE[^>]*android:maxSdkVersion="28"/)
})

process.exit(failures === 0 ? 0 : 1)
