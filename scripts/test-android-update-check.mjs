/**
 * 安卓壳 1.4.10「检查更新 + 一键下载安装」的回归守卫。
 *
 *   node scripts/test-android-update-check.mjs
 *
 * 两类断言口径分得很清楚（本轮明确要求）：
 *   【A 运行时断言】= 真把代码跑起来：插件侧/宿主侧的更新源校验与默认值，走编译产物 lib/index.js。
 *   【B 静态守卫】  = 钉 Java 源码 / 钉清单 / 钉构建脚本 的源码守卫（本机没有 Android 运行时，
 *                    Java 侧只能静态钉；每条标题都写清它钉的是哪一类）。
 *                    Java 侧的真跑取证在 outputs/2026-11-28/apk-audit/java-probe（同一份 UpdateCheck
 *                    在 JDK 下逐条跑过，纯函数不依赖 Android 存根）。
 *
 * 覆盖：默认关闭与默认源为空 / owner-repo 形态校验拒绝 / 只允许 https 且 host 恰为 api.github.com /
 * 硬编码 owner-repo 与个人化标识为 0（黑名单来自 personal-context-lib.mjs 的运行时派生） /
 * 24 小时节流常量与 skipVersion 持久化语义 / 复用 DownloadManager + getUriForDownloadedFile + content:// +
 * FLAG_GRANT_READ_URI_PERMISSION + ACTION_VIEW / 清单未新增 FileProvider、权限净新增 0 项 / 后菜单第 4 项存在。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintMarkerClasses, neutralizeProtectedForms, androidPackageSegment } from './personal-context-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', androidPackageSegment(), 'assistant')
const MANIFEST = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
const BUILD_PS = readFileSync(join(ROOT, 'android', 'build.ps1'), 'utf8')
const STRINGS_XML = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8')
const SHORTCUTS_XML = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml'), 'utf8')

function readJava(name) {
  const path = join(JAVA_DIR, name)
  if (!existsSync(path)) throw new Error(`缺少 Java 文件：${name}`)
  return readFileSync(path, 'utf8')
}

const UPDATE = readJava('UpdateCheck.java')
const MAIN = readJava('MainActivity.java')
const PERSONAL = lintMarkerClasses()

let cases = 0
let failures = 0
function case_(name, fn) {
  cases++
  try { fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

/** 大括号配平取方法体（与 test-android-download-cookie.mjs 同一套算法）。 */
function methodBody(source, name, owner = '源码') {
  const decl = new RegExp(`(?:private|public|protected)[^\\n]*\\b${name}\\s*\\(`)
  const m = decl.exec(source)
  assert.notEqual(m, null, `${owner} 里的 ${name}() 必须还在`)
  const open = source.indexOf('{', m.index)
  assert.notEqual(open, -1, `${name}() 找不到方法体`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${name}() 大括号不配平`)
}

/**
 * 把源码/清单里「转义点分形态」还原成点分形态（`com\.a\.b` → `com.a.b`），
 * 再交给 neutralizeProtectedForms 做受保护形态置换。build.ps1 里的包名重写规则就是这个形态，
 * 它属于应用 ID（受保护形态），不该被当成个人化标识。
 */
function unescapeDots(text) { return String(text).replace(/\\\./g, '.') }

function scanMarkers(text) { return neutralizeProtectedForms(unescapeDots(text)) }

/* =====================================================================
 * 【A 运行时断言】插件侧/宿主侧：真的跑配置校验面
 * ===================================================================== */

const hostModule = await import('../lib/index.js')
const surface = hostModule.assistantConfigTestSurface
assert.ok(surface, 'lib/index.js 里没有 assistantConfigTestSurface，插件侧默认值测不了')

process.env.DSH_ASSISTANT_CONFIG = join(ROOT, '.tmp', 'update-check-config-absent.json')
surface.resetAssistantConfigCacheForTests()

case_('【A 运行时】宿主侧默认值：updateCheckEnabled=false、updateSource=""（默认关闭、默认不联网）', () => {
  const cfg = surface.loadAssistantConfig(true)
  assert.equal(cfg.updateCheckEnabled, false, 'updateCheckEnabled 默认必须是 false')
  assert.equal(cfg.updateSource, '', 'updateSource 默认必须是空串')
})

case_('【A 运行时】插件侧 owner/repo 校验：非法形态一律拒（带 expected-owner-repo）', () => {
  const illegal = ['nope', 'a/b/c', 'https://github.com/a/b', 'a b/b', 'a//b', 'github.com:443/a/b', '/a/b', 'a/b/']
  for (const value of illegal) {
    const result = surface.validateAssistantConfigPatch({ updateSource: value })
    assert.equal(result.ok, false, `「${value}」应该被拒`)
    assert.match(String(result.error), /expected-owner-repo/, `「${value}」拒绝原因不对`)
  }
})

case_('【A 运行时】插件侧 owner/repo 校验：合法形态与空串（空=关闭）被接受', () => {
  const legal = surface.validateAssistantConfigPatch({ updateSource: 'my-owner/my_repo.ok-1', updateCheckEnabled: true })
  assert.equal(legal.ok, true, '合法 owner/repo 应该被接受')
  assert.equal(legal.patch.updateSource, 'my-owner/my_repo.ok-1')
  assert.equal(legal.patch.updateCheckEnabled, true)
  const empty = surface.validateAssistantConfigPatch({ updateSource: '' })
  assert.equal(empty.ok, true, '空串（=关闭）应该被接受')
  assert.equal(empty.patch.updateSource, '')
})

/* =====================================================================
 * 【B 静态守卫·钉 Java 源码】UpdateCheck.java：键名/默认值/host 白名单/节流/skipVersion
 * ===================================================================== */

case_('【B 静态·钉 Java】UpdateCheck 存在且 SharedPreferences 键名与默认值写死成关闭态', () => {
  for (const literal of [
    'public static final String KEY_ENABLED = "update_check_enabled";',
    'public static final String KEY_SOURCE = "update_source";',
    'public static final String KEY_LAST_AT = "update_check_last_at";',
    'public static final String KEY_SKIP = "skip_version";',
    'public static final String KEY_CACHE = "update_check_result";',
    'getBoolean(KEY_ENABLED, false)',
    'getString(KEY_SOURCE, "")',
    'getString(KEY_SKIP, "")',
    'getLong(KEY_LAST_AT, 0L)',
  ]) {
    assert.ok(UPDATE.includes(literal), `缺 Java 字面量：${literal}`)
  }
})

case_('【B 静态·钉 Java】owner/repo 形态校验：正则与 . / .. 段拒绝', () => {
  assert.match(UPDATE, /Pattern\.compile\("\^\[A-Za-z0-9_.-\]\+\/\[A-Za-z0-9_.-\]\+\$"\)/, 'owner/repo 正则必须与插件侧同一套')
  const form = methodBody(UPDATE, 'isOwnerRepoForm')
  assert.ok(form.includes('if (s.isEmpty() || !OWNER_REPO.matcher(s).matches()) return false;'), '形态不符必须当场拒')
  assert.ok(form.includes('if (".".equals(part) || "..".equals(part)) return false;'), '点号/双点号段必须拒')
  const save = methodBody(UPDATE, 'saveSource')
  assert.ok(save.includes('更新源不是 owner/repo 形态，没保存'), '不合规必须照实说明原因')
  assert.ok(save.includes('prefs(context).edit().putString(KEY_SOURCE, "").apply();'), '清空源要落盘（清空=关闭）')
  assert.ok(save.includes('更新源已清空：清空就是关闭状态，不会联网。'), '清空必须说清不会联网，不报错')
})

case_('【B 静态·钉 Java】查询地址只允许 https 且 host 恰为 api.github.com（端口/userinfo/查询段一律拒）', () => {
  assert.match(UPDATE, /public static final String ALLOWED_API_HOST = "api\.github\.com";/)
  const guard = methodBody(UPDATE, 'validatedApiUrl')
  assert.ok(guard.includes('String built = "https://" + ALLOWED_API_HOST + "/repos/" + s + "/releases/latest";'),
    '查询地址必须由常量拼出，不许写死具体仓库')
  assert.ok(guard.includes('if (!"https".equalsIgnoreCase(u.getProtocol())) return null;'))
  assert.ok(guard.includes('if (!ALLOWED_API_HOST.equals(u.getHost())) return null;'), 'host 必须恰好等于 api.github.com')
  assert.ok(guard.includes('if (u.getPort() != -1) return null;'), '不许带端口')
  assert.ok(guard.includes('if (u.getUserInfo() != null) return null;'), '不许带 userinfo')
  assert.ok(guard.includes('if (u.getQuery() != null || u.getRef() != null) return null;'), '不许带查询段/片段')
  assert.equal(/"http:\/\//.test(UPDATE), false, 'UpdateCheck.java 不许出现 http 地址')
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(UPDATE), false, '不许出现 IP 字面值（不许自建 IP 入口）')
  assert.match(UPDATE, /conn\.setInstanceFollowRedirects\(false\)/, '不许被重定向带跑到别的 host')
})

case_('【B 静态·钉 Java】下载这条地址同样只认 https + GitHub 主机白名单 + 同一个 owner/repo + .apk', () => {
  const guard = methodBody(UPDATE, 'isDownloadUrlAllowed')
  assert.match(UPDATE, /private static final String\[\] ALLOWED_DOWNLOAD_HOSTS =\s*\{"github\.com", "objects\.githubusercontent\.com"\};/)
  assert.ok(guard.includes('if (!"https".equalsIgnoreCase(u.getProtocol())) return false;'))
  assert.ok(guard.includes('if (u.getUserInfo() != null) return false;'))
  assert.ok(guard.includes('if (u.getPort() != -1) return false;'))
  assert.ok(guard.includes('if (!hostOk) return false;'), 'host 不在白名单必须拒')
  assert.ok(guard.includes('if (!path.contains("/" + source + "/")) return false;'), '路径必须落在配好的 owner/repo 里')
  assert.ok(guard.includes('return path.toLowerCase(Locale.US).endsWith(".apk");'), '文件名必须是 .apk')
  assert.ok(guard.includes('if (!isOwnerRepoForm(source)) return false;'), '更新源不合格就不许下载')
})

case_('【B 静态·钉 Java】24 小时节流常量 + 时间戳先记 + skipVersion 持久化语义（照插件侧口径）', () => {
  assert.match(UPDATE, /public static final long THROTTLE_MS = 24 \* 3600 \* 1000L;/)
  assert.match(UPDATE, /return lastAt > 0L && \(nowMs - lastAt\) < THROTTLE_MS;/)
  const check = methodBody(UPDATE, 'check')
  assert.match(check, /withinThrottle\(lastAt, nowMs\)/, '查之前先过节流')
  const markAt = check.indexOf('markCheckAt(context, nowMs)')
  const fetchAt = check.indexOf('fetchApi(apiUrl, local)')
  assert.ok(markAt > 0 && markAt < fetchAt, '必须在发请求前就写节流时间戳（失败也算这一轮查过）')
  assert.ok(check.includes('RESULT_THROTTLED'), '节流命中要有独立状态')
  assert.ok(check.includes('readCache(context)'), '节流命中只带回缓存结果，不联网')
  assert.match(UPDATE, /prefs\(context\)\.edit\(\)\.putString\(KEY_SKIP, v\)\.apply\(\)/, 'skipVersion 必须持久化')
  assert.match(UPDATE, /prefs\(context\)\.edit\(\)\.putString\(KEY_SKIP, ""\)\.apply\(\)/, '取消忽略也必须持久化')
  assert.ok(check.includes('tag.equals(getSkipVersion(context))'), '同一个版本不再提示')
  assert.ok(check.includes('RESULT_SKIPPED'), '忽略命中要有独立状态')
  assert.ok(UPDATE.includes('setSkipVersion(Context context, String version)'))
  assert.ok(UPDATE.includes('clearSkipVersion(Context context)'))
})

case_('【B 静态·钉 Java】关闭态/空源态/非法源绝不联网；失败绝不伪装成「没有新版本」', () => {
  const check = methodBody(UPDATE, 'check')
  const fetchAt = check.indexOf('fetchApi(apiUrl, local)')
  const disabledAt = check.indexOf('RESULT_DISABLED')
  const invalidAt = check.indexOf('RESULT_INVALID_SOURCE')
  assert.ok(disabledAt >= 0 && invalidAt > disabledAt && invalidAt < fetchAt,
    '关闭/空源/非法源三条分支必须在发请求之前返回')
  assert.ok(check.includes('关闭期间不会联网'), '关闭态文案必须说清不联网')
  assert.ok(check.includes('已拒绝这个源、没有发出任何请求'), '非法源必须照实说明没发请求')
  assert.ok(/throw new Failure\("GitHub API 回了 HTTP/.test(UPDATE), '非 2xx 必须照实失败')
  assert.ok(UPDATE.includes('这次没当成「没有新版本」'), '失败提示不许说成没新版本')
  assert.ok(UPDATE.includes('为了不跳到别的地址，这次直接拒了'), '跳转必须当失败处理')
  assert.ok(check.includes('RESULT_FAILED, f.reason'), '失败必须带上原因')
  assert.ok(check.includes('GitHub 回的内容读不出 JSON'), 'JSON 读不出必须当失败')
  assert.ok(check.includes('没有可用的 APK 资产'), '有新版本但没 APK 必须当失败说清')
  assert.equal(/writeCache\(context, new Result\(RESULT_UPTODATE/.test(check), false, '失败路径不许写「已是最新版」缓存')
})

case_('【B 静态·钉 Java】一次点按只发 1 个请求、跑后台线程、结果回主线程（UI 不被卡住）', () => {
  const body = methodBody(MAIN, 'startUpdateCheck')
  assert.ok(body.includes('if (updateChecking)'), '在飞请求不许叠加第二次')
  assert.match(body, /new Thread\(/, '查询必须后台线程')
  assert.match(body, /UpdateCheck\.check\(MainActivity\.this, System\.currentTimeMillis\(\)\)/)
  assert.match(body, /handler\.post\(/, '结果必须回主线程弹窗')
  assert.equal(/Thread\.sleep|\.get\(\);|waitFor/.test(body), false, '主线程不许等网络')
  const check = methodBody(UPDATE, 'check')
  assert.equal((check.match(/fetchApi\(/g) || []).length, 1, '一次检查只发一个请求（不许照插件侧 3 次重试打爆限流）')
  assert.match(UPDATE, /conn\.setConnectTimeout\(CONNECT_TIMEOUT_MS\)/)
  assert.match(UPDATE, /conn\.setReadTimeout\(READ_TIMEOUT_MS\)/)
})

case_('【B 静态·钉 Java】下载复用既有 DownloadManager 链路；安装走 content:// + ACTION_VIEW + 临时读授权', () => {
  const dl = methodBody(MAIN, 'startUpdateDownload')
  assert.ok(dl.includes('UpdateCheck.isDownloadUrlAllowed(url, UpdateCheck.source(this))'), '下载前必须过地址守卫')
  assert.match(dl, /new DownloadManager\.Request\(Uri\.parse\(url\)\)/)
  assert.ok(dl.includes('req.setMimeType(APK_MIME)'))
  assert.ok(dl.includes('VISIBILITY_VISIBLE_NOTIFY_COMPLETED'))
  assert.ok(dl.includes('req.setVisibleInDownloadsUi(true)'))
  assert.ok(dl.includes('setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)'))
  assert.ok(dl.includes('watchDownload(dm.enqueue(req), name)'), '必须挂到既有的下载监听')
  assert.equal(/addRequestHeader/.test(dl), false, '更新下载这条不许自带 header')
  assert.ok(dl.includes('watchDownload') && MAIN.includes('GitHub 的公开 release 不需要登录态'),
    '更新下载不带 WebView 的 cookie（那是助手入口的访问密码）')
  const opener = methodBody(MAIN, 'openDownloadedFile')
  assert.ok(opener.includes('dm.getUriForDownloadedFile(id)'), '必须拿 DownloadManager 的 content:// Uri')
  assert.ok(opener.includes('new Intent(Intent.ACTION_VIEW)'))
  assert.ok(opener.includes('view.setDataAndType(uri, mime)'))
  assert.ok(opener.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION'), '必须临时授权读权限')
  assert.ok(MAIN.includes('private static final String APK_MIME = "application/vnd.android.package-archive";'))
  const routes = methodBody(MAIN, 'reportDownload')
  assert.ok(routes.includes('APK_MIME.equalsIgnoreCase(mime)'), 'apk 必须走既有的安装分流')
})

case_('【B 静态·钉清单+钉 Java】不许新增 FileProvider、不许静默安装、清单权限净新增 0 项', () => {
  const fpLines = (UPDATE + MAIN).split('\n').filter((line) => line.includes('FileProvider'))
  assert.ok(fpLines.every((line) => /^\s*(\/\/|\*|\/\*)/.test(line)), 'FileProvider 只许待在注释说明里，不许出现在代码里')
  assert.equal(/FileProvider/.test(MANIFEST), false, '清单里不许出现 FileProvider')
  assert.equal(/<provider/.test(MANIFEST), false, '清单不许有 provider 声明')
  assert.equal(/PACKAGE_INSTALL|installPackage|Runtime\.getRuntime|ProcessBuilder/.test(UPDATE + MAIN), false, '不许试图静默安装')
  const perms = [...MANIFEST.matchAll(/android\.permission\.([A-Z_]+)/g)].map((m) => m[1])
  const expected = ['INTERNET', 'ACCESS_NETWORK_STATE', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'CAMERA',
    'WRITE_EXTERNAL_STORAGE', 'REQUEST_INSTALL_PACKAGES', 'POST_NOTIFICATIONS', 'FOREGROUND_SERVICE',
    'FOREGROUND_SERVICE_DATA_SYNC', 'WAKE_LOCK', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']
  assert.equal(perms.length, expected.length, `清单权限数必须还是 ${expected.length} 项（实测 ${perms.length}）`)
  for (const name of expected) assert.ok(perms.includes(name), `清单缺权限 ${name}`)
  for (const name of perms) assert.ok(expected.includes(name), `清单出现未预期的权限 ${name}`)
  assert.match(MANIFEST, /android\.permission\.REQUEST_INSTALL_PACKAGES/, '装应用门票必须已在（本轮不加新权限）')
  assert.match(MANIFEST, /WRITE_EXTERNAL_STORAGE"[\s\S]{0,80}maxSdkVersion="28"/, '下载落盘的权限口径不许动')
})

case_('【B 静态·钉 Java】安装门票没允许时先说清、只给跳系统设置页的入口（绝不自动授权）', () => {
  const gate = methodBody(MAIN, 'tryInstallUpdate')
  assert.ok(gate.includes('要装新版，先允许这个应用装应用'))
  assert.ok(gate.includes('Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES'))
  assert.ok(gate.includes('Uri.parse("package:" + getPackageName())'))
  assert.ok(gate.includes('"只下载"'), '必须保留只下载这条路')
  const probe = methodBody(MAIN, 'installAlreadyPermitted')
  assert.ok(probe.includes('canRequestPackageInstalls()'))
  assert.ok(probe.includes('Build.VERSION.SDK_INT < 26'))
  assert.ok(MAIN.includes('本应用没法自己静默装'), '弹窗文案必须说明要在系统安装界面确认')
})

/* =====================================================================
 * 【B 静态·钉 Java】UI 入口：后菜单第 4 项、设置页版本行与开关/源输入
 * ===================================================================== */

case_('【B 静态·钉 Java】后菜单第 4 项「检查更新」存在并接到 startUpdateCheck', () => {
  const body = methodBody(MAIN, 'showBackMenu')
  const items = /new String\[\]\{([^}]*)\}/.exec(body)
  assert.ok(items, '后菜单的 items 数组没找到')
  const list = items[1].split(',').map((x) => x.trim().replace(/^"|"$/g, ''))
  assert.equal(list.length, 4, `后菜单必须 4 项（实测 ${list.length}）`)
  assert.equal(list[3], '检查更新', '第 4 项必须是检查更新')
  assert.deepEqual(list.slice(0, 3), ['设置地址', '重新加载页面', '退出应用'], '前三项口径不许动')
  assert.match(body, /which == 3/, '第 4 项要有分支')
  assert.ok(/which == 3\)[\s\S]{0,120}startUpdateCheck\(\);/.test(body), '第 4 项必须调用 startUpdateCheck')
})

case_('【B 静态·钉 Java】设置页显示当前版本（versionName+versionCode）与更新开关/源输入/关闭状态文案', () => {
  assert.match(MAIN, /private TextView versionRow;/)
  assert.match(MAIN, /private Button updateCheckToggle;/)
  assert.match(MAIN, /private EditText updateSourceInput;/)
  assert.match(MAIN, /private Button updateSourceSave;/)
  assert.match(MAIN, /private Button updateCheckRun;/)
  assert.match(MAIN, /private TextView updateStatusRow;/)
  assert.match(MAIN, /private Button updateSkipClear;/)
  const rows = methodBody(MAIN, 'refreshUpdateRows')
  assert.ok(rows.includes('UpdateCheck.versionName(this)'))
  assert.ok(rows.includes('UpdateCheck.versionCode(this)'))
  assert.ok(rows.includes('当前版本：'))
  assert.ok(rows.includes('versionCode '))
  assert.ok(rows.includes('已关闭（默认关闭；关闭期间这个应用不会联网查版本）'))
  assert.ok(rows.includes('更新源：空　状态：关闭（不联网）'))
  assert.ok(rows.includes('这个源被拒，不会联网'))
  assert.ok(rows.includes('24 小时只查一次'))
  assert.ok(rows.includes('下次可以再查还差'))
  assert.ok(rows.includes('「这版不装」：v '), '忽略状态要在设置页照实显示')
  assert.match(MAIN, /onResume\(\)[\s\S]{0,400}refreshUpdateRows\(\);/, 'onResume 必须刷新更新区块状态行')
  assert.ok(MAIN.includes('updateSourceInput.setText(UpdateCheck.source(this))'), '设置页必须显示当前保存的源')
})

case_('【B 静态·钉 Java】文案走现有中文口径，不许留占位式英文', () => {
  assert.ok(MAIN.includes('"正在检查更新'), '检查中必须有提示文案')
  for (const phrase of ['下载并安装', '这版不装', '先不弄', '检查更新', '保存更新源', '去设置', '取消']) {
    assert.ok(MAIN.includes(`"${phrase}"`), `缺中文文案「${phrase}」`)
  }
  assert.ok(MAIN.includes('检查更新（默认关闭）'), '设置页标题必须写清默认关闭')
  assert.ok(MAIN.includes('留空就是不联网'), '更新源提示必须写清空=不联网')
  assert.equal(/\b(TODO|placeholder|not implemented|coming soon)\b/i.test(UPDATE + MAIN), false, '不许出现占位式英文')
})

/* =====================================================================
 * 【B 静态·钉 Java+清单+构建脚本】硬编码 owner/repo 与个人化标识 = 0（黑名单运行时派生）
 * ===================================================================== */

case_('【B 静态·派生黑名单】安卓侧所有文件里个人化标识与真实 owner/repo 预置值为 0', () => {
  assert.ok(PERSONAL.personal.length > 0, '派生黑名单是空的，这条守卫等于没测')
  assert.ok(PERSONAL.retired.length > 0, '已作废值类别派生不出条目')
  const files = {
    'UpdateCheck.java': UPDATE,
    'MainActivity.java': MAIN,
    'AndroidManifest.xml': MANIFEST,
    'build.ps1': BUILD_PS,
    'strings.xml': STRINGS_XML,
    'shortcuts.xml': SHORTCUTS_XML,
  }
  for (const [name, raw] of Object.entries(files)) {
    const text = scanMarkers(raw)
    for (const marker of PERSONAL.personal) {
      assert.equal(text.includes(marker), false, `${name}: 出现个人化标识（类别：账户目录路径标识）`)
    }
    for (const marker of PERSONAL.retired) {
      assert.equal(text.includes(marker), false, `${name}: 出现已作废的旧值（类别：已作废仓库标识）`)
    }
  }
  assert.equal(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(UPDATE + MAIN + BUILD_PS), false,
    '安卓侧不许写死任何 owner/repo 预置值')
  assert.equal(/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases/.test(UPDATE), false,
    '查询地址不许带具体仓库段（必须走常量拼接）')
})

case_('【B 静态·钉构建脚本】签名口令只从仓库外经 env 读入，脚本里不出现口令值', () => {
  assert.match(BUILD_PS, /\$KS_PASS\s*=\s*\$env:DSH_ANDROID_KEYSTORE_PASS/)
  assert.match(BUILD_PS, /--ks-pass env:DSH_ANDROID_KEYSTORE_PASS/)
  assert.equal(/--ks-pass "?\?/.test(BUILD_PS), false, '口令不许走命令行')
  assert.match(BUILD_PS, /dsh-assistant-signing/)
  assert.equal(/Get-Content[^\n]*keystore\.pass/.test(BUILD_PS), false,
    'build.ps1 不许自己读口令文件（口令由调用方经 env 注入）')
})

case_('【B 静态·钉构建脚本】出包口径：1.4.10 / 37，minSdk 24 / targetSdk 34 不许动', () => {
  assert.match(BUILD_PS, /\[string\]\$VersionName = '1\.4\.10'/)
  assert.match(BUILD_PS, /\[int\]\$VersionCode = 37/)
  assert.match(BUILD_PS, /MIN_SDK\s*=\s*24/)
  assert.match(BUILD_PS, /TARGET\s*=\s*34/)
  assert.match(BUILD_PS, /--min-sdk-version \$MIN_SDK/)
  assert.match(BUILD_PS, /--target-sdk-version \$TARGET/)
})

/* =====================================================================
 * 【B 静态·钉 package.json】测试链接入：97 -> 98
 * ===================================================================== */

case_('【B 静态·钉 package.json】本脚本已接入 test 链且总数为 98', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const chain = pkg.scripts.test.split('node scripts/').slice(1).map((x) => x.split(' ')[0].trim())
  assert.ok(chain.includes('test-android-update-check.mjs'), '本脚本没进 test 链')
  assert.equal(chain.length, 98, `test 链应为 98 条（实测 ${chain.length}）`)
  assert.equal(new Set(chain).size, chain.length, 'test 链里有重复条目')
})

console.log(`\ntest-android-update-check: ${cases - failures}/${cases} 通过，失败 ${failures}`)
process.exit(failures === 0 ? 0 : 1)
