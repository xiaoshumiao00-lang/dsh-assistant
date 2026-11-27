/**
 * 秘书回复卡「所有附件点击走原生下载」离线单测（2026-11-27 需求，由「图片下载」扩到全类型）。
 *
 * 真机 bug：点回复卡里的图片缩略图 → openAttachFile → window.open(url, '_blank')，
 * APK 的 WebView setSupportMultipleWindows(false) → 同页导航到 /api/worktable/file，
 * 服务端对图片回 inline → WebView 在当前页渲染图片，卡片页被整个刷掉
 * （用户看到的就是「APK 重新刷新、重新进」）。
 *
 * 修法（与文件同一条原生下载链路，不新造 JS 桥——App 里本来就没有 @JavascriptInterface，
 * 事实上的桥是 WebView 的 DownloadListener）：
 *   1. 安卓端（UA 带 Android）**任何附件**点击都改用 attachDownloadUrl：同一条只读路由加 download=1
 *      （图片缩略图与文件条收敛成同一个 openAttach，不再两套 handler）；
 *   2. 宿主路由认 download=1，把 content-disposition 对**所有类型**强制成 attachment，
 *      content-type 不动（apk 必须回 application/vnd.android.package-archive）；
 *   3. WebView 渲染不了 attachment → 回调 DownloadListener → MainActivity.startDownload
 *     （带 cookie 的那条链路，f86751b 已修），页面全程不动；
 *   4. 下载完成由 MainActivity 按 MIME 分流拉起系统应用（看图 / pdf·office·txt·音频 / apk 安装，
 *      安卓侧断言在 scripts/test-android-download-cookie.mjs）。
 *   桌面/其余浏览器 attachOpenViaDownload 为 false，保持 window.open 新标签页。
 *
 *   node scripts/test-secretary-attach-image-download.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
const disposition = lib.fileDispositionTestSurface
const { createLocalFileHandler } = lib.localFileRouteTestSurface

let failures = 0
function case_(name, fn) {
  try { fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}
async function caseAsync(name, fn) {
  try { await fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

/* ---------- 1. 分支选择：安卓走下载、非安卓保持 window.open ---------- */

case_('surface 导出 attachDownloadUrl / attachOpenViaDownload', () => {
  assert.equal(typeof surface.attachDownloadUrl, 'function', 'secretaryCardsTestSurface 必须有 attachDownloadUrl')
  assert.equal(typeof surface.attachOpenViaDownload, 'function', 'secretaryCardsTestSurface 必须有 attachOpenViaDownload')
})

case_('attachOpenViaDownload：安卓（APK WebView / 安卓浏览器）走下载', () => {
  const androidWebView = 'Mozilla/5.0 (Linux; Android 13; 2304FPN6DC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36'
  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36'
  assert.equal(surface.attachOpenViaDownload(androidWebView), true, 'APK 的 WebView UA 必须命中下载分支')
  assert.equal(surface.attachOpenViaDownload(androidChrome), true, '安卓手机浏览器与文件口径一致：也走下载')
})

case_('attachOpenViaDownload：桌面/其余浏览器保持 window.open 新标签页', () => {
  const cases = [
    ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
    ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'],
    ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'],
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'],
    ['空 UA', ''],
  ]
  for (const [label, ua] of cases) {
    assert.equal(surface.attachOpenViaDownload(ua), false, `${label} 不该走下载分支`)
  }
})

case_('attachDownloadUrl：同一条只读路由追加 download=1，路径照旧整体编码', () => {
  const path = 'D:\\dsh-assistant\\docs\\截图 1.png'
  const plain = surface.attachFileUrl(path)
  const download = surface.attachDownloadUrl(path)
  assert.equal(download, `${plain}&download=1`)
  assert.equal(download.startsWith('/api/worktable/file?path='), true)
  assert.equal(download.includes(encodeURIComponent(path)), true, '中文与反斜杠必须编码')
  assert.equal(download.includes(' '), false, '查询串里不许出现裸空格')
})

/* ---------- 2. 服务端：download=1 → 全类型 attachment；不带参数 → 图片仍 inline ---------- */

case_('content-disposition：forceAttachment 对图片/文档/压缩包一律 attachment', () => {
  assert.equal(disposition.fileDispositionType('png'), 'inline', '不带下载意图时图片仍 inline（桌面内联看图靠它）')
  assert.equal(disposition.fileDispositionType('png', true), 'attachment', '显式下载意图必须 attachment')
  assert.equal(disposition.fileDispositionType('docx', true), 'attachment')
  assert.equal(disposition.fileDispositionType('apk', true), 'attachment')
  assert.equal(disposition.fileDispositionType('zip', true), 'attachment')
  assert.equal(disposition.fileDispositionType('mp3', true), 'attachment')
  const forced = disposition.contentDispositionHeaderFor('D:\\x\\图 1.png', { forceAttachment: true })
  assert.match(forced, /^attachment; filename="[^"]+"; filename\*=UTF-8''/, '图片 + download=1 必须回 attachment')
  assert.equal(forced.endsWith("filename*=UTF-8''" + encodeURIComponent('图 1.png')), true, '中文名照旧走 RFC 5987')
  const apkForced = disposition.contentDispositionHeaderFor('D:\\x\\助手 1.4.7.apk', { forceAttachment: true })
  assert.equal(apkForced.endsWith("filename*=UTF-8''" + encodeURIComponent('助手 1.4.7.apk')), true, 'apk 中文名照旧 RFC 5987')
  const normal = disposition.contentDispositionHeaderFor('D:\\x\\图 1.png')
  assert.match(normal, /^inline;/, '不带下载意图时图片仍 inline')
})

case_('服务端 FILE_TYPES：apk 必须回 application/vnd.android.package-archive', () => {
  const index = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
  assert.equal(index.includes("apk: 'application/vnd.android.package-archive'"), true,
    'apk 的 MIME 不许落成 application/octet-stream（DownloadManager 与安装分流都靠它）')
})

/* ---------- 3. 路由级：真文件过一遍 createLocalFileHandler ---------- */

const root = await mkdtemp(join(tmpdir(), 'attach-download-all-'))
// 最小合法 PNG（1x1 透明），路由不校验内容，只要字节原样进出
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')

function fakeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb() },
  })
  res.status = 0
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? null }
  res.body = () => Buffer.concat(chunks)
  return res
}

async function callRoute(url) {
  const handler = createLocalFileHandler({ denyOutside: () => false, logger: { warn: () => {} } })
  const req = Readable.from([])
  req.method = 'GET'
  req.url = url
  const res = fakeRes()
  const done = new Promise((resolve) => { res.on('finish', resolve); res.on('close', resolve) })
  await handler(req, res)
  await done
  return res
}

await caseAsync('路由：图片不带参数 → inline；带 download=1 → attachment，content-type 与字节都不变', async () => {
  const file = join(root, '现场照片.png')
  await writeFile(file, PNG_BYTES)
  const query = `path=${encodeURIComponent(file)}`

  const inline = await callRoute(`/api/worktable/file?${query}`)
  assert.equal(inline.status, 200)
  assert.match(String(inline.headers['content-disposition']), /^inline;/, '不带参数：图片照旧 inline')
  assert.equal(inline.headers['content-type'], 'image/png')

  const forced = await callRoute(`/api/worktable/file?${query}&download=1`)
  assert.equal(forced.status, 200)
  assert.match(String(forced.headers['content-disposition']), /^attachment;/, 'download=1：必须 attachment（WebView 才会交给系统下载器）')
  assert.equal(forced.headers['content-type'], 'image/png', 'content-type 不许动：DownloadManager 靠它认图片')
  assert.equal(String(forced.headers['content-disposition']).includes("filename*=UTF-8''" + encodeURIComponent('现场照片.png')), true, '中文落盘名照旧 RFC 5987')
  assert.equal(forced.body().equals(PNG_BYTES), true, '字节必须原样完整')
})

await caseAsync('路由：apk 带 download=1 → attachment + 安装 MIME；docx 带 download=1 → attachment', async () => {
  const apk = join(root, '个人助手 1.4.7.apk')
  const apkBytes = Buffer.from('PKfake-apk-bytes')
  await writeFile(apk, apkBytes)
  const apkRes = await callRoute(`/api/worktable/file?path=${encodeURIComponent(apk)}&download=1`)
  assert.equal(apkRes.status, 200)
  assert.match(String(apkRes.headers['content-disposition']), /^attachment;/, 'apk + download=1 必须 attachment')
  assert.equal(apkRes.headers['content-type'], 'application/vnd.android.package-archive', 'apk 的 MIME 必须正确（安装界面靠它）')
  assert.equal(String(apkRes.headers['content-disposition']).includes("filename*=UTF-8''" + encodeURIComponent('个人助手 1.4.7.apk')), true, 'apk 中文名照旧 RFC 5987')
  assert.equal(apkRes.body().equals(apkBytes), true, 'apk 字节必须原样完整')

  const docx = join(root, '报告.docx')
  await writeFile(docx, Buffer.from('PKfake-docx'))
  const docxRes = await callRoute(`/api/worktable/file?path=${encodeURIComponent(docx)}&download=1`)
  assert.equal(docxRes.status, 200)
  assert.match(String(docxRes.headers['content-disposition']), /^attachment;/, 'download=1 对 docx 同样强制 attachment')
})

await caseAsync('路由：download 参数只认「=1」，别的值不触发强制下载', async () => {
  const file = join(root, '图.png')
  await writeFile(file, PNG_BYTES)
  const res = await callRoute(`/api/worktable/file?path=${encodeURIComponent(file)}&download=0`)
  assert.match(String(res.headers['content-disposition']), /^inline;/, 'download=0 不该强制 attachment')
})

/* ---------- 4. 渲染层源码守卫：图片与文件收敛成同一个 openAttach，桌面行为不变 ---------- */

case_('SecretaryReplyCard：图片与文件条都走同一个 openAttach（安卓下载/桌面新标签页分流）', () => {
  const card = readFileSync(join(ROOT, 'src/client/pocket/orb/SecretaryReplyCard.tsx'), 'utf8')
  const clicks = card.match(/onClick=\{\(event: any\) => openAttach\(event, attachment\.path\)\}/g) ?? []
  assert.equal(clicks.length, 2, '图片缩略图与文件条都必须走同一个 openAttach')
  assert.match(card, /function openAttach\(event: any, path: string\)/, '必须有统一的 openAttach')
  assert.match(card, /attachOpenViaDownload\(ua\) \? attachDownloadUrl\(path\) : attachFileUrl\(path\)/,
    '安卓 → attachDownloadUrl（download=1 原生下载）；其余 → attachFileUrl（window.open 新标签页）')
  assert.equal(card.includes("window.open(url, '_blank')"), true, '桌面端 window.open 行为必须原样保留')
  assert.equal(card.includes('openAttachFile'), false, '旧的 openAttachFile 必须收敛掉，不许留两套')
  assert.equal(card.includes('openAttachImage'), false, '旧的 openAttachImage 必须收敛掉，不许留两套')
})

case_('secretary-cards：download=1 与 Android UA 判定就在 attachFileUrl 旁边', () => {
  const cards = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.ts'), 'utf8')
  assert.match(cards, /export function attachDownloadUrl\(path: string\)/)
  assert.equal(cards.includes("`${attachFileUrl(path)}&download=1`"), true, '下载地址 = 只读路由 + download=1')
  assert.match(cards, /export function attachOpenViaDownload\(userAgent: string\)/)
  assert.match(cards, /\\bAndroid\\b/i, 'UA 判定只认 Android')
})

await rm(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
