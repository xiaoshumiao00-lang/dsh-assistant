package com.chenpan.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 1.4.10「检查更新」的逻辑壳（与 MainActivity 里的界面接线分开写，便于逐条守逻辑）。
 *
 * 三条硬口径（照插件侧 src/client/updateCheck.ts 的口径来）：
 *   1. 默认关闭、默认源为空：`update_check_enabled` 默认 false、`update_source` 默认 ""。
 *      源留空 = 完全不联网（这个类里连一个连接对象都不会建）。
 *   2. 只允许 https 且 host 必须恰好是 api.github.com：不许 http、不许任何其它 host、
 *      不许带端口、不许带 userinfo、不许自行拼 IP——owner/repo 形态校验先把路径段钉死，
 *      再把拼好的整条地址重新解析一遍，两条校验都过才允许发请求。
 *   3. 只有用户主动按「检查更新」才发 1 次请求：24 小时节流一次（存时间戳，24*3600*1000 口径），
 *      没有定时器、没有后台唤醒、没有遥测。「这版不装」= skipVersion，持久化后同一版本不再提示。
 *
 * 不预置任何人的仓库：这里没有任何真实 owner/repo 字面值，设置页让用户填自己的。
 */
public final class UpdateCheck {

    /** 与 MainActivity / KeepAliveService 同一份 SharedPreferences 文件。 */
    public static final String PREFS = "dsh_assistant";

    /** 更新检查开关：默认关闭（false）。 */
    public static final String KEY_ENABLED = "update_check_enabled";
    /** 更新源：`owner/repo` 形态，默认空串（空 = 不查、不联网）。 */
    public static final String KEY_SOURCE = "update_source";
    /** 上次检查的时间戳（毫秒）。节流靠它，24 小时一次。 */
    public static final String KEY_LAST_AT = "update_check_last_at";
    /** 「这版不装」的版本号（与插件侧 skipVersion 同语义，持久化）。 */
    public static final String KEY_SKIP = "skip_version";
    /** 上一次查到的结果缓存（JSON），节流命中时用它，不再联网。 */
    public static final String KEY_CACHE = "update_check_result";

    /** 节流口径：24 小时一次（与插件侧 `24 * 3600 * 1000` 同口径）。 */
    public static final long THROTTLE_MS = 24 * 3600 * 1000L;

    /** 唯一允许的更新查询 host：必须恰好等于它（不 startsWith、不拼 IP）。 */
    public static final String ALLOWED_API_HOST = "api.github.com";

    /** APK 下载地址允许的 host（公开 release 的真实落点在 GitHub 主站与它的资产 CDN）。
     *  注意：查询请求只打 ALLOWED_API_HOST，这一组只用于「下载」那条，且必须 https、必须带 .apk。 */
    private static final String[] ALLOWED_DOWNLOAD_HOSTS =
            {"github.com", "objects.githubusercontent.com"};

    /** owner/repo 形态：与插件侧 assistant-config.ts 的校验同一套字面规则。 */
    private static final Pattern OWNER_REPO = Pattern.compile("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$");

    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;

    /** 六态：与插件侧 UpdateStatus 对齐，另加壳里需要的三种细分。 */
    public static final String RESULT_DISABLED = "disabled";
    public static final String RESULT_UPTODATE = "uptodate";
    public static final String RESULT_FAILED = "failed";
    public static final String RESULT_INVALID_SOURCE = "invalid_source";
    public static final String RESULT_THROTTLED = "throttled";
    public static final String RESULT_SKIPPED = "skipped";
    public static final String RESULT_NEW = "new";

    private UpdateCheck() {
    }

    /** 一次检查的结果。message 是给用户看的一句中文（失败也照实说，不许把失败伪装成「没有新版本」）。 */
    public static final class Result {
        public final String status;
        public final String message;
        public final String localVersion;
        public final String latest;
        public final String apkUrl;
        public final String apkName;
        public final String notes;

        Result(String status, String message, String localVersion, String latest,
               String apkUrl, String apkName, String notes) {
            this.status = status;
            this.message = message;
            this.localVersion = localVersion;
            this.latest = latest;
            this.apkUrl = apkUrl;
            this.apkName = apkName;
            this.notes = notes;
        }

        /** 缓存里的结果算「还有新版本可用」：只有 apkUrl 非空才算能一键下载安装。 */
        public boolean hasInstallableNewVersion() {
            return RESULT_NEW.equals(status) && !TextUtils.isEmpty(latest) && !TextUtils.isEmpty(apkUrl);
        }
    }

    // ------------------------------------------------------------ 开关与源

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    /** 本机存的源（原样读，默认空串 = 不查）。 */
    public static String source(Context context) {
        return prefs(context).getString(KEY_SOURCE, "");
    }

    /** 用户输入先裁一遍空白（填「  owner/repo  」也算合法）。 */
    public static String trimSource(String raw) {
        return raw == null ? "" : raw.trim();
    }

    public static boolean isOwnerRepoForm(String raw) {
        String s = trimSource(raw);
        if (s.isEmpty() || !OWNER_REPO.matcher(s).matches()) return false;
        // 一个点/两个点都不许（host 已经钉死，这条只是不让路径段玩 . 与 .. 的花样）
        for (String part : s.split("/", 2)) {
            if (".".equals(part) || "..".equals(part)) return false;
        }
        return true;
    }

    /** 保存更新源：不合规直接拒绝并回一句中文原因（不落盘、不改开关）。 */
    public static String saveSource(Context context, String raw) {
        String s = trimSource(raw);
        if (s.isEmpty()) {
            // 清空是允许的：清空 = 关闭态下的「没有更新源」，绝不因此去联网、也不报错。
            prefs(context).edit().putString(KEY_SOURCE, "").apply();
            return "更新源已清空：清空就是关闭状态，不会联网。";
        }
        if (!isOwnerRepoForm(s)) {
            return "更新源不是 owner/repo 形态，没保存：照「你的GitHub账号名/仓库名」这样填，只能有 1 个斜杠，"
                    + "其余字符只许字母、数字、点、下划线、连字符（不许 http、不许带域名、不许带端口）。";
        }
        prefs(context).edit().putString(KEY_SOURCE, s).apply();
        return "更新源已保存：" + s;
    }

    /** 拼出查询地址并二次校验：不合格返回 null（调用方必须照实提示，不许静默吞）。 */
    public static String validatedApiUrl(String rawSource) {
        String s = trimSource(rawSource);
        if (!isOwnerRepoForm(s)) return null;
        String built = "https://" + ALLOWED_API_HOST + "/repos/" + s + "/releases/latest";
        URL u;
        try {
            u = new URL(built);
        } catch (MalformedURLException e) {
            return null;
        }
        if (!"https".equalsIgnoreCase(u.getProtocol())) return null;
        if (!ALLOWED_API_HOST.equals(u.getHost())) return null;
        if (u.getPort() != -1) return null;
        if (u.getUserInfo() != null) return null;
        if (u.getQuery() != null || u.getRef() != null) return null;
        return built;
    }

    /**
     * 下载那条地址合不合格：必须 https、host 只认 GitHub 主站与它的资产 CDN、
     * 路径必须落在配好的 owner/repo 里、文件名必须是 .apk。不许 http、不许 IP、不许带端口与 userinfo。
     */
    public static boolean isDownloadUrlAllowed(String rawUrl, String rawSource) {
        if (TextUtils.isEmpty(rawUrl)) return false;
        String source = trimSource(rawSource);
        if (!isOwnerRepoForm(source)) return false;
        URL u;
        try {
            u = new URL(rawUrl);
        } catch (MalformedURLException e) {
            return false;
        }
        if (!"https".equalsIgnoreCase(u.getProtocol())) return false;
        if (u.getUserInfo() != null) return false;
        if (u.getPort() != -1) return false;
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
        boolean hostOk = false;
        for (String allowed : ALLOWED_DOWNLOAD_HOSTS) {
            if (allowed.equals(host)) { hostOk = true; break; }
        }
        if (!hostOk) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        if (!path.contains("/" + source + "/")) return false;
        return path.toLowerCase(Locale.US).endsWith(".apk");
    }

    // ------------------------------------------------------- 本机版本与节流

    public static String versionName(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return TextUtils.isEmpty(info.versionName) ? "" : info.versionName;
        } catch (Throwable t) {
            return "";
        }
    }

    /** 与插件侧口径一致：minSdk 24 只能用 PackageInfo.versionCode（getLongVersionCode 要 API 28）。
     *  @SuppressWarnings 是给 javac 消掉「已过时 API」提示用——PowerShell 5.1 下本机命令的 stderr
     *  一行就会被 EAP=Stop 变成终止错误，整条 build.ps1 会被打断（本轮实测）。 */
    @SuppressWarnings("deprecation")
    public static int versionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return info.versionCode;
        } catch (Throwable t) {
            return -1;
        }
    }

    public static long lastCheckAt(Context context) {
        return prefs(context).getLong(KEY_LAST_AT, 0L);
    }

    public static void markCheckAt(Context context, long atMs) {
        prefs(context).edit().putLong(KEY_LAST_AT, atMs).apply();
    }

    /** 「这版不装」：与插件侧 getSkipVersion/setSkipVersion 同语义（空串 = 没忽略任何版本）。 */
    public static String getSkipVersion(Context context) {
        String v = prefs(context).getString(KEY_SKIP, "");
        return v == null ? "" : v;
    }

    public static void setSkipVersion(Context context, String version) {
        String v = version == null ? "" : version.trim();
        if (v.isEmpty()) return;
        prefs(context).edit().putString(KEY_SKIP, v).apply();
    }

    public static void clearSkipVersion(Context context) {
        prefs(context).edit().putString(KEY_SKIP, "").apply();
    }

    private static boolean withinThrottle(long lastAt, long nowMs) {
        return lastAt > 0L && (nowMs - lastAt) < THROTTLE_MS;
    }

    /** 现在能不能查（24 小时口径的公开问法，设置页状态行要用）。 */
    public static boolean checkAllowedNow(long lastAt, long nowMs) {
        return !withinThrottle(lastAt, nowMs);
    }

    /** 距下次能查还有多久（给用户看的中文；24 小时口径的另一种说法）。 */
    public static String throttleLeftText(long lastAt, long nowMs) {
        long left = THROTTLE_MS - (nowMs - lastAt);
        if (left < 0L) left = 0L;
        long minutes = left / 60000L;
        if (minutes < 1L) return "不到 1 分钟";
        if (minutes < 60L) return minutes + " 分钟";
        long hours = minutes / 60L;
        long restMinutes = minutes % 60L;
        return restMinutes > 0L ? (hours + " 小时 " + restMinutes + " 分钟") : (hours + " 小时");
    }

    // ------------------------------------------------------------- 查询本体

    /**
     * 检查更新：开关关着 / 源空着 → 直接返回 disabled，**一个请求都不发**。
     * 24 小时内查过 → 返回 throttled（带缓存结果，不联网）。
     * 网络失败 / 状态码非 2xx / JSON 解析不了 → failed，message 照实说明原因。
     */
    public static Result check(Context context, long nowMs) {
        String local = versionName(context);
        if (!isEnabled(context)) {
            return new Result(RESULT_DISABLED,
                    "更新检查是关闭的（默认就关）：要检查就在设置页打开开关并填你自己的 owner/repo。关闭期间不会联网。",
                    local, "", "", "", "");
        }
        String raw = source(context);
        if (TextUtils.isEmpty(trimSource(raw))) {
            return new Result(RESULT_DISABLED,
                    "更新检查开着但更新源空着：请照「你的GitHub账号名/仓库名」填一个 owner/repo；空着就是不联网。",
                    local, "", "", "", "");
        }
        String apiUrl = validatedApiUrl(raw);
        if (apiUrl == null) {
            return new Result(RESULT_INVALID_SOURCE,
                    "更新源不是 owner/repo 形态，已拒绝这个源、没有发出任何请求：只许「你的GitHub账号名/仓库名」这种写法。",
                    local, "", "", "", "");
        }

        long lastAt = lastCheckAt(context);
        if (withinThrottle(lastAt, nowMs)) {
            Result cached = readCache(context);
            String extra = cached == null ? "" : cached.message;
            String base = "24 小时内已经查过一次，这次没再联网（下次可以再查：还差 "
                    + throttleLeftText(lastAt, nowMs) + "）";
            if (cached != null && cached.hasInstallableNewVersion()) {
                Result th = new Result(RESULT_THROTTLED,
                        base + "\n上一次查到的结果还在：新版本 " + cached.latest + " 可以下载安装。",
                        local, cached.latest, cached.apkUrl, cached.apkName, cached.notes);
                return th;
            }
            return new Result(RESULT_THROTTLED,
                    base + (TextUtils.isEmpty(extra) ? "" : "\n上一次：" + extra),
                    local, cached == null ? "" : cached.latest, "", "", "");
        }

        // 时间戳先记下：与插件侧同一口径——发出请求前就写节流时间，失败也算这一轮查过了。
        markCheckAt(context, nowMs);

        String body;
        try {
            body = fetchApi(apiUrl, local);
        } catch (Failure f) {
            Result failed = new Result(RESULT_FAILED, f.reason, local, "", "", "", "");
            writeCache(context, failed);
            return failed;
        } catch (Throwable t) {
            String why = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            Result failed = new Result(RESULT_FAILED,
                    "检查更新没成功：" + why + "（没当成「没有新版本」，可以过一忽再点一次）", local, "", "", "", "");
            writeCache(context, failed);
            return failed;
        }

        JSONObject json;
        try {
            json = new JSONObject(body);
        } catch (Throwable t) {
            Result failed = new Result(RESULT_FAILED,
                    "GitHub 回的内容读不出 JSON：多半是网络被中途切断或这个仓库不公开", local, "", "", "", "");
            writeCache(context, failed);
            return failed;
        }

        String tag = stripTag(json.optString("tag_name", ""));
        if (TextUtils.isEmpty(tag)) {
            Result failed = new Result(RESULT_FAILED,
                    "这个 release 里没有版本号（tag_name 是空的），没法比对版本", local, "", "", "", "");
            writeCache(context, failed);
            return failed;
        }
        String notes = json.optString("body", "");
        if (notes.length() > 800) notes = notes.substring(0, 800);

        if (!TextUtils.isEmpty(local) && cmpVer(tag, local) <= 0) {
            Result ok = new Result(RESULT_UPTODATE,
                    "已经是最新版：本机 " + local + "，最新的 release " + tag + "。", local, tag, "", "", "");
            writeCache(context, ok);
            return ok;
        }
        if (tag.equals(getSkipVersion(context))) {
            Result ok = new Result(RESULT_SKIPPED,
                    "v " + tag + " 你之前选了「这版不装」，这个版本不再提示（要恢复就在设置页清掉这个忽略）。",
                    local, tag, "", "", "");
            writeCache(context, ok);
            return ok;
        }

        String[] pick = pickApkAsset(json, raw);
        if (pick == null) {
            Result noApk = new Result(RESULT_FAILED,
                    "发现新版本 " + tag + "，但这个 release 里没有可用的 APK 资产（只认 https、只认同一个 owner/repo 下的 .apk）。",
                    local, tag, "", "", notes);
            writeCache(context, noApk);
            return noApk;
        }
        Result fresh = new Result(RESULT_NEW,
                TextUtils.isEmpty(local) ? "发现新版本 " + tag : "本机 " + local + " → 新版本 " + tag,
                local, tag, pick[0], pick[1], notes);
        writeCache(context, fresh);
        return fresh;
    }

    /** 失败原因（照插件侧口径：403/404 单独说明，不重试打爆别人的限流）。 */
    private static final class Failure extends Exception {
        final String reason;

        Failure(String reasonText) {
            super(reasonText);
            this.reason = reasonText;
        }
    }

    private static String fetchApi(String apiUrl, String localVersion) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(apiUrl).openConnection();
            // 不许被重定向带跑到别的 host 去（GitHub API 正常不会 302 到别的域）
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/vnd.github+json");
            conn.setRequestProperty("User-Agent", "dsh-assistant-android/" + (TextUtils.isEmpty(localVersion) ? "dev" : localVersion));
            conn.setUseCaches(false);

            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                throw new Failure("GitHub API 要求跳转（HTTP " + code + "），为了不跳到别的地址，这次直接拒了");
            }
            if (code == 404) {
                throw new Failure("这个仓库没有 release（GitHub 回 404）：先核对更新源填对没有，或先在 GitHub 上发布带 APK 的 release");
            }
            if (code == 403) {
                throw new Failure("GitHub 说限流或要登录（HTTP 403）：过一两个钟头再点一次，不要连续猛点");
            }
            if (code < 200 || code >= 300) {
                throw new Failure("GitHub API 回了 HTTP " + code + "，这次没当成「没有新版本」");
            }
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return new String(out.toByteArray(), Charset.forName("UTF-8"));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 从这个 release 里挑一个可用的 APK 资产：name 或 browser_download_url 认 .apk，地址必须过下载校验。 */
    private static String[] pickApkAsset(JSONObject json, String source) {
        JSONArray assets = json.optJSONArray("assets");
        if (assets == null) return null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null) continue;
            String name = asset.optString("name", "");
            String url = asset.optString("browser_download_url", "");
            String contentType = asset.optString("content_type", "");
            boolean looksLikeApk = (name != null && name.toLowerCase(Locale.US).endsWith(".apk"))
                    || (url != null && url.toLowerCase(Locale.US).endsWith(".apk"))
                    || APK_CONTENT_TYPE.equalsIgnoreCase(contentType);
            if (!looksLikeApk) continue;
            if (!isDownloadUrlAllowed(url, source)) continue;
            return new String[]{url, TextUtils.isEmpty(name) ? "update.apk" : name};
        }
        return null;
    }

    private static final String APK_CONTENT_TYPE = "application/vnd.android.package-archive";

    /** tag 前缀的 v/V 去掉（与插件侧 `replace(/^v/, '')` 同口径，GitHub 常写 v1.4.10）。 */
    public static String stripTag(String tag) {
        String s = tag == null ? "" : tag.trim();
        if (s.length() > 1 && (s.charAt(0) == 'v' || s.charAt(0) == 'V')) {
            String rest = s.substring(1);
            // 只剥一个 v：版本号本身不许带字母，剥完仍是数字打头才算 v 前缀
            if (rest.charAt(0) >= '0' && rest.charAt(0) <= '9') return rest;
        }
        return s;
    }

    /**
     * 逐段 parseInt 比版本（与插件侧 cmpVer 一字不差）：段数不足按 0 补，非数字段按 0。
     * 返回 >0 表示 a 比 b 新。
     */
    public static int cmpVer(String a, String b) {
        String[] pa = splitVer(a);
        String[] pb = splitVer(b);
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            int x = i < pa.length ? numOr0(pa[i]) : 0;
            int y = i < pb.length ? numOr0(pb[i]) : 0;
            if (x != y) return x > y ? 1 : -1;
        }
        return 0;
    }

    private static String[] splitVer(String v) {
        return (v == null ? "" : v.trim()).split("\\.");
    }

    private static int numOr0(String segment) {
        try {
            return Integer.parseInt(segment.trim());
        } catch (Throwable t) {
            return 0;
        }
    }

    // --------------------------------------------------------------- 缓存

    private static void writeCache(Context context, Result r) {
        try {
            JSONObject json = new JSONObject();
            json.put("status", r.status);
            json.put("message", r.message);
            json.put("latest", r.latest);
            json.put("apkUrl", r.apkUrl);
            json.put("apkName", r.apkName);
            json.put("notes", r.notes);
            prefs(context).edit().putString(KEY_CACHE, json.toString()).apply();
        } catch (Throwable ignored) {
            // 缓存只是省一次网络，写不上不影响下一次查询
        }
    }

    private static Result readCache(Context context) {
        String raw = prefs(context).getString(KEY_CACHE, "");
        if (TextUtils.isEmpty(raw)) return null;
        try {
            JSONObject json = new JSONObject(raw);
            String status = json.optString("status", "");
            if (!RESULT_NEW.equals(status)) return null;
            String latest = json.optString("latest", "");
            String url = json.optString("apkUrl", "");
            String name = json.optString("apkName", "");
            if (TextUtils.isEmpty(latest) || !isDownloadUrlAllowed(url, source(context))) return null;
            return new Result(RESULT_NEW, json.optString("message", ""), versionName(context),
                    latest, url, name, json.optString("notes", ""));
        } catch (Throwable t) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
