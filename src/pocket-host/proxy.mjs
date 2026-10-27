// dsh-pocket 核心：Host/Origin 改写反向代理
//
// 为什么需要它：DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或
// `--trusted-host` 白名单（且官方禁了 0.0.0.0 绑定，防止把远程执行代码暴露给网络）。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威（127.0.0.1:3080），
// 转发给本机 dsh web——栅栏永远看到 loopback，于是：
//   - 局域网：手机直接访问 http://<电脑IP>:端口
//   - 公网：cloudflared 隧道指到本代理，任意域名都能进
// 都不需要改 dsh 的任何配置。
//
// 同步保证：普通请求与 WebSocket upgrade（/api/events.host 流式推送）都原样透传，
// 手机看到的界面与电脑完全一致、实时。

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendDiagnostic, diagnosticSummary, readDiagnosticTail } from './diagnostics.mjs';
import { attachWsDeflate, negotiatePermessageDeflate } from './ws-deflate.mjs';
import { optimizeMobileBoot } from './mobile-boot.mjs';
import { createMobileBatchStore } from './mobile-batch.mjs';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，由代理注入 polyfill
 * （只在缺少时生效，不覆盖原生实现）：
 *   1. crypto.randomUUID——DSH 连接层 mint RPC id 用，缺失直接抛错；
 *   2. AbortSignal.any（issue #53）——Android 厂商浏览器/WebView（Chrome < 116）
 *      无原生实现，DSH 连接层发送消息会调 AbortSignal.any([...])，缺失则消息发不出。
 * 带 data-dsh-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID"
 * 字样（dsh 页面源码里可能恰好出现该字符串，导致误判为已注入而跳过）。
 */
export const RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* 注：曾用「全局 let location + Proxy」伪装 location.hostname 修 DSH isLoopback 判定
（issue #58：局域网访问模型设置页报 settings unavailable）——但 let location 全局
词法绑定会让任何恰好顶层声明 location 的脚本（DSH 插件经典 script）SyntaxError 崩溃，
导致会话列表不显示（实测 PAGEERROR: Identifier 'location' has already been declared）。
已回退；该问题属 DSH 客户端限制（location.hostname 是 unforgeable 属性）无法安全绕过。*/</script>`;

/**
 * issue #96：dsh 0.1.1-rc.2 起，`@deepseek-ai/dsh-client-connection` 的连接层改成
 *   const api = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
 * 其中 transport = globalThis.__DSH_TRANSPORT__（由 DSH 宿主 web shell 注入，本仓库
 * 全程不创建、不引用这个全局）。桌面直连 127.0.0.1:3080 时宿主给的 transport 带
 * createApiClient；经本代理（局域网 / 隧道域名）访问时宿主给的 transport 不带该方法
 * → 手机上一执行就 TypeError: transport?.createApiClient is not a function，整页崩。
 *
 * 兜底策略：只在该方法缺失时补一个返回 null 的实现。null 会触发宿主自己那条
 * `?? new WebApiClient()` 兜底分支，等于让连接层回到旧版本（0.1.1-rc.2 之前）的
 * 行为。宿主自己有实现时一律不覆盖。
 *
 * 这是 stopgap 不是根治：真正的契约缺口在 DSH 宿主，需上游修复。
 */
export const TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-pocket-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'&&typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}}catch(e){}return t;}if(cur)patch(cur);Object.defineProperty(globalThis,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;

const INJECT_MARK = 'data-dsh-pocket-polyfill="1"';

/**
 * DSH Desktop（桌面版）渲染进程兼容补丁（issue #3/#4，已于 issue #76 停用）。
 *
 * 历史：旧版 dsh-plugin-desktop 的 client 在页面加载时从 URL query 读
 * `dsh-desktop-mode` 与 `dsh-desktop-platform`，缺失即抛
 * "invalid or missing dsh-desktop-mode null" → 页面崩（手机扫码访问桌面版时正是如此）。
 * 本脚本用 history.replaceState 补上这两个参数（无跳转、不重载），取最轻的
 * `compatibility` 模式——不激活桌面布局，避免与移动端适配叠加。
 *
 * @deprecated 不要再注入（issue #76，DSH Desktop 2.0.3 起）：
 *   ① mode 与 platform **同时缺失**时，parseDesktopClientEnvironment 直接返回 undefined
 *      （视作非桌面外壳，跳过全部桌面逻辑），正是手机/浏览器页面需要的效果；
 *   ② 只要 URL 上出现任一 dsh-desktop-* 标记，客户端就强制校验整组（material +
 *      semver version + mica），只补两个必然抛 "invalid or missing
 *      dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
 *   ③ 更糟：decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
 *      普通浏览器判为 denied（403），刷新后直接打不开。
 * lib/index.js 已不再注入本脚本；保留导出仅为兼容旧版本桌面端与既有测试。
 */
export function desktopEnvPatchScript(platform) {
  const p = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'linux';
  return `<script data-dsh-pocket-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 内容哈希命名的构建产物（/assets/index-CN7NIWNw.js 这类）。
 * 文件名里带内容哈希 → 内容一变名字就变，可以放心 immutable 长缓存。
 */
const HASHED_ASSET_RE = /\/(?:assets|static)\/[^/?#]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf)$/;

/**
 * 给内容哈希静态资源补长缓存头（手机端首屏）。
 * 上游 dsh web 对 /assets/* 只回 `vary: accept-encoding`，**没有任何 cache-control /
 * etag / last-modified**（2026-10-25 curl 实测），于是 WebView 既不能启发式缓存也没法
 * 304 校验，每次打开浮窗都得重新拉 index-*.js + vendor-*.js（实测 1.76MB 原始 /
 * 0.55MB 压缩后，@2.7Mbps 约 1.6s）。只补"上游没给 cache-control"的响应：
 * HTML（注入分支强制 no-store）与 API 完全不受影响。
 */
export function staticCacheHeaders(reqUrl, headers) {
  if (!headers || typeof headers !== 'object') return headers;
  if (headers['cache-control']) return headers;
  const pathOnly = String(reqUrl ?? '').split(/[?#]/)[0];
  if (!HASHED_ASSET_RE.test(pathOnly)) return headers;
  return { ...headers, 'cache-control': 'public, max-age=31536000, immutable' };
}

// ---------- permessage-deflate 熔断（失败自动退回明文） ----------
// 压缩层任何异常都会断掉那条 WS（手机端 mux 自动重连）；但如果是我们代码的
// 系统性缺陷，重连还会再压再挂。所以连续失败 N 次后停止协商 10 分钟，期间所有
// WS 连接退回明文——手机能正常用，只是慢，不会白屏。
const WS_DEFLATE_BREAKER_THRESHOLD = 2;
const WS_DEFLATE_COOLDOWN_MS = 10 * 60 * 1000;
const wsDeflateBreaker = { failures: 0, until: 0 };

export function wsDeflateAllowed() {
  return Date.now() >= wsDeflateBreaker.until;
}

function noteWsDeflateFailure() {
  wsDeflateBreaker.failures += 1;
  if (wsDeflateBreaker.failures >= WS_DEFLATE_BREAKER_THRESHOLD) {
    wsDeflateBreaker.failures = 0;
    wsDeflateBreaker.until = Date.now() + WS_DEFLATE_COOLDOWN_MS;
  }
}

/**
 * 默认注入到经代理的 HTML 文档里：crypto.randomUUID / AbortSignal.any polyfill
 * （非安全上下文必需）+ issue #96 的 transport.createApiClient 兜底。
 */
export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM;

/**
 * DSH Desktop advanced 模式不支持的提示覆盖层（issue #19）。
 * advanced 组合会禁用网页版 ui-layout，而桌面 layout 只在 advanced client 提供——
 * 手机页面被注入 compatibility 后无任何 layout 服务 → 启动白屏（Failed to load plugins）。
 * 该脚本在页面上叠加一个固定警告层，让用户明确知道原因（而不是无解白屏）。
 */
export function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH 桌面端处于 advanced 模式，手机访问暂不支持。请在桌面端设置中切回 compatibility 模式后重启。| DSH Desktop is in advanced mode — phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}

// ---------- 可选访问令牌认证（issue #13 + #33） ----------
// 只对受保护 Host（公网隧道 + 局域网按开关）强制。
// 登录成功后种 HttpOnly 持久 cookie（Max-Age 30 天）→ SPA 内部 API/WS 自动携带。
// 会话保持：cookie 值 = sha256(PIN:sessionKey)；sessionKey 由入口安全生成并持久化，
// HMR / dsh web 重启后保持不变，因此手机输一次密码后长期免输（最长 30 天）。
// 修改 PIN 仍会改变 cookie 派生值，使旧登录立即失效。
const TOKEN_COOKIE = 'dsh_pocket_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

/** cookie 校验值：有 sessionKey 时派生，无则退化为 PIN 本身（向后兼容）。 */
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash('sha256').update(`${token}:${sessionKey}`).digest('hex');
}

// ---------- 登录速率限制（issue #40，改进版方案 A） ----------
// 8 位数字密码（10^8 组合）本身可接受，真正风险是「无限制重试」让穷举可行。
// 这里做三层防护（内存态，随进程生命周期，与 sessionKey 一致）：
//   1) 单 IP 滑动窗口：60 秒内失败 ≥5 次 → 锁 60 秒（429）
//   2) 全局滑动窗口：1 分钟全局失败 > 50 次 → 全局锁 30 秒（防分布式扫描换 IP 绕过）
//   3) 成功登录清空该 IP 计数
// IP 识别：优先 cf-connecting-ip（Cloudflare 在隧道入口设置的**真实**客户端 IP，
// 可信）；无则回退 socket remoteAddress。**不信任客户端 x-forwarded-for**（可伪造）。
export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,      // 失败计数滑动窗口
  maxFailures: 5,        // 窗口内失败阈值 → 触发单 IP 锁
  lockMs: 60_000,        // 单 IP 锁定时长
  globalMaxFailures: 50, // 全局失败阈值（同窗口）→ 触发全局锁
  globalLockMs: 30_000,  // 全局锁定时长
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = new Map(); // ip -> { count, windowStart }
  const ipLocks = new Map();    // ip -> lockedUntil
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    /** 该 IP 当前是否被锁；返回 { locked, retryAfter }。 */
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      return { locked: false, retryAfter: 0 };
    },
    /** 记一次失败：维护滑动窗口计数，达阈值触发单 IP / 全局锁。 */
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) { global.count = 0; global.windowStart = now; }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      // 防内存膨胀：超过 2000 条记录时清掉已过窗口期的条目
      if (failCounts.size > 2000) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
    },
    /** 成功登录：清空该 IP 计数与锁。 */
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
    },
  };
}
/**
 * 客户端真实 IP（限速与握手计数的身份键）：
 *   - 来自本机（cloudflared 隧道回连，源地址 loopback）→ 认 cf-connecting-ip（Cloudflare 边缘写的真实客户端 IP）；
 *   - 其余一律用 socket 源地址。
 *
 * 为什么不能无条件信任 cf-connecting-ip：那是**请求头**，能直连代理端口的人可以随手
 * 伪造。隧道流量必经本机 cloudflared（源地址必为 loopback），所以把它限定在 loopback
 * 来源既不影响隧道场景，又让「换头即换身份」的限速绕过失效。XFF 同理，始终不认。
 */
export function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  if (classifySource(addr) === 'loopback') {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (cf) return cf;
  }
  return addr || 'unknown';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 把回带的 query 拼成 HTML 属性片段。query 已由 loginCarryQuery 的白名单过滤，
 * 这里只做出属性所需的转义（`&` → `&amp;`，顺带挡掉引号/尖括号）。 */
function carryAttr(carry) {
  const text = String(carry ?? '');
  if (!text) return '';
  return `?${text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}`;
}

/** 登录页：按访问来源显示提示（局域网 / 公网）；error: false|true|'locked'（locked 带剩余秒数）。
 * carry：当前 URL 上可回带的 query（不含 '?'），让"输入密码这一跳"不再吞掉用户的参数。 */
export function loginPageHtml(error, isPublic, retryAfter = 0, carry = '') {
  const where = isPublic ? '此公网地址' : '此局域网地址';
  const whereEn = isPublic ? 'This public address' : 'This LAN address';
  const errMsg = error === 'locked'
    ? `尝试次数过多，请 ${retryAfter} 秒后再试 | Too many attempts — try again in ${retryAfter}s`
    : error ? '密码错误，请重试 | Wrong PIN, try again' : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 访问验证</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>🔐 DSH Pocket</h1>
<p>${where}受访问密码保护，请输入 8 位密码（英文字母或数字） | ${whereEn} is password-protected — enter the 8-character PIN (letters/digits)</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login${carryAttr(carry)}">
<input name="token" type="password" maxlength="8" autocomplete="one-time-code" autofocus required>
<button type="submit">进入 | Enter</button>
</form>
</div></body></html>`;
}

/**
 * Host 信任边界分类（issue #66：fail closed）。
 *
 * 旧逻辑只认 `*.trycloudflare.com` 后缀为公网，其余一律当局域网——用户自建
 * 命名隧道/反向代理指向本机端口时，固定域名被误判成局域网；若局域网密码又
 * 关着，公网入口就无密码裸奔。现在反转为 fail closed：
 *   - loopback：localhost / 127.x / ::1 / 0.0.0.0（本机与 cloudflared 回连）
 *   - lan：RFC1918 私网 IPv4、CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，
 *     公网不可路由）、IPv6 ULA/link-local、`.local`（mDNS）、无点单标签名（NetBIOS 计算机名等）
 *   - public：其余一切 Host（trycloudflare 或任何陌生域名）→ 强制公网密码
 *
 * @returns {'loopback'|'lan'|'public'}
 */
export function classifyHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end); // [::1]:3081 → ::1
  } else {
    name = name.replace(/:\d+$/, ''); // hostname:3081 / 127.0.0.1:3081 → 去掉端口
  }
  if (name === 'localhost' || name === '0.0.0.0' || name === '::1' || /^127\./.test(name)) return 'loopback';
  // RFC1918 私网 + CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，公网不可路由）
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name) && name.includes(':')) return 'lan'; // IPv6 link-local / ULA
  if (name === '' || name.includes(':')) return 'loopback'; // 裸 IPv6 / 无 Host → 当本机
  if (name.endsWith('.local') || !name.includes('.')) return 'lan'; // mDNS / NetBIOS 单标签名
  return 'public';
}

/** 该 Host 是否受访问密码保护（公网一律要密码；局域网/本机按设置页开关）。 */
function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === 'public';
}

/** 保护强度序：本机最弱（可免密）→ 局域网（按开关）→ 公网（永远要密码）。 */
const HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };

/**
 * 按 TCP 源地址给出来源类别（issue #90）。
 * 与 classifyHost 的区别在**兜底方向**：Host 头里认不出的形态按 loopback 处理
 * （历史行为，避免裸 IPv6 之类把本机访问判成公网）；而源地址认不出时必须按
 * public 处理——源地址是我们唯一不可伪造的信息，兜底方向错了整条防线就白搭。
 * @returns {'loopback'|'lan'|'public'|null} null 表示拿不到源地址（不做任何收紧）
 */
export function classifySource(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6（Node 双栈监听时常见）
  if (a === '::1' || /^127\./.test(a)) return 'loopback';
  // RFC1918 私网 + CGNAT 100.64/10（与 classifyHost 保持同一套网段判定）
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return 'lan';
  if (/^169\.254\./.test(a)) return 'lan';            // IPv4 link-local
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return 'lan'; // IPv6 link-local / ULA
  return 'public';
}

/**
 * 用于策略判定的 Host（issue #90 第 7 条）。
 *
 * Host 头完全由客户端控制：能直连代理端口的人只要写 `Host: 127.0.0.1:3081`
 * 就会被 classifyHost 判成本机，从而绕过局域网开关和局域网密码——用户若按
 * README 关掉了局域网密码，这就是一条零认证通道。TCP 源地址无法伪造，用它给
 * Host 声明设一个下限。
 *
 * **只收紧、绝不放松**：经 cloudflared 隧道进来的公网请求源地址正是 127.0.0.1，
 * 若按源地址覆盖就会把公网访问降级成本机免密，比原来的问题更严重。所以仅当
 * 声明的保护级别**低于**来源真实级别时，才改用源地址参与判定。
 */
export function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  // 用真实源地址替代被伪造的 Host 参与后续全部策略判定（密码归属、局域网开关、
  // 局域网地址覆盖），保证各处判定看到的是同一个来源。
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  return addr;
}

/**
 * 该 Host 是否 loopback（本机 / cloudflared 回环）。
 * 「关闭局域网」只拦截经局域网 IP/主机名访问的请求，loopback 与公网（trycloudflare）放行：
 *   - cloudflared 隧道以 `http://127.0.0.1:<port>` 回连本机代理，必须放行；
 *   - 电脑自己访问 127.0.0.1/localhost 也应放行（仅当用户手动浏览本代理时）。
 */
function isLoopbackHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end); // [::1]:port → ::1
  } else {
    name = name.replace(/:\d+$/, ''); // hostname:port / 127.0.0.1:port → 去掉端口
  }
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

/** 局域网访问已关闭时的提示页（浏览器导航时显示；API/WS 返回 403 JSON/拒绝握手）。 */
function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 局域网访问已关闭</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>🔒 DSH Pocket</h1>
<p>局域网访问已关闭，扫码/链接均不可用。<br>请在电脑上重新开启后再试。<br><br>LAN access is disabled — the QR code and link are unavailable.<br>Re-enable it on the computer to continue.</p>
</div></body></html>`;
}

/** 桌面端浏览器访问门禁提示页（issue #81）：DSH Desktop 未开启「浏览器访问」时，
 * 上游 desktop-browser-access 门禁对普通浏览器（含经本代理转发的手机）返回 403
 * `forbidden`，且本代理无法携带 Electron renderer secret 绕过。对符合该特征的
 * 浏览器导航请求返回此可操作提示页；API/WS 与其余 403 原样透传。 */
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 桌面端未开启浏览器访问</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>🖥️ DSH Pocket</h1>
<p>你已通过访问密码，但页面仍被拦截。<br>因为本机 DSH Desktop 未开启「浏览器访问」，桌面门禁拒绝了普通浏览器（含手机）的页面请求。</p>
<div class="step">
<strong>解决方法（任选其一）：</strong><br>
1. DSH Desktop → 设置 → 窗口 / 模式 → 开启「浏览器访问」（自动切到 compatibility 模式）→ <strong>重启 DSH Desktop</strong>。<br>
2. 或在配置文件中设置：<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
然后重启 DSH Desktop，再刷新本页。
</div>
<p style="margin-top:14px">注意：访问密码登录成功 ≠ 已获得桌面 Web 访问授权。门禁由 DSH Desktop 控制，pocket 无法代为绕过。</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings → window/mode → browser access → restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}

/** 请求是否期望 HTML（浏览器导航 → 返回登录页；API/WS → 401）。 */
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html')) return true;
  const url = String(req.url ?? '');
  // 按 pathname 判断，别用 `url === '/'` 严格比 —— 根路径常带 query
  // （`/?dsh-pocket-auth=1`、`/?dsh-pocket-retry=1`、`/?token=…`），
  // 那些同样是浏览器导航，漏判会让它们拿到 401/303 而不是该给的页面。
  let pathname = url;
  try { pathname = new URL(url || '/', 'http://dsh.invalid').pathname; } catch { /* 用原值兜底 */ }
  return pathname === '/' || /\.html?$/i.test(pathname);
}

/**
 * 常量时间的密码比较（issue #90）：普通 `===` 会在首个不同字节处提前返回，
 * 理论上可被计时侧信道逐字节还原 PIN。长度不同直接判否（PIN 长度固定，
 * 长度本身不是秘密），等长则走 timingSafeEqual。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 请求是否携带 `?token=` —— 用于区分「一次密码尝试」与「普通未认证访问」（issue #90）。
 * 只有前者计入限速失败：普通未认证访问（无 cookie 无 token）本来就该看到登录页，
 * 若也计数，正常用户第一次打开页面就会把自己锁死（子资源还会放大）。
 * cookie 不匹配同样不计数——cookie 值是 sha256(PIN:sessionKey)，攻击者不知道
 * 进程级 sessionKey，这条通道本身不可穷举；而 dsh web 重启后旧 cookie 必然失配，
 * 计数只会误锁老用户。
 */
function hasQueryToken(req) {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams.get('token') != null;
  } catch {
    return false;
  }
}

/** 校验请求是否已认证。返回 { ok, rawQueryToken }：
 *  - ok=true：已认证；rawQueryToken 是 URL `?token=<PIN>` 命中的那条原始密码（用于种 cookie）；
 *  - 已有 cookie 命中 → rawQueryToken=null（不要重复种）。 */
function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  const qTok = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
  if (qTok) {
    // URL `?token=<原始 PIN>` 用于分享/扫码直达：用户拿到 URL 就能直输明文 PIN，
    // 不需要把 sha256 哈希也告诉他们。匹配上后由调用方通过 maybeSeedAuthCookie
    // 种 HttpOnly 哈希 cookie，让浏览器后续子资源（assets/*.js 等）也走 cookie
    // 路径——避免「主页 200 但子资源 401」白屏（issue #35）。
    for (const token of list) {
      if (safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
    }
  }
  return { ok: false, rawQueryToken: null };
}

/** 当请求通过 `?token=<原始 PIN>` 进入且尚无 cookie 时，在响应里种 HttpOnly cookie。
 *  monkey-patch res.writeHead 把 set-cookie 头注入到第一个响应里——同 POST /pocket-login
 *  路径（lib/proxy.mjs 显式 res.writeHead 加 set-cookie）效果一致。 */
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return; // 已有 cookie 就不重复种
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, headers) {
    const h = { ...(headers ?? {}) };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    // 已有 set-cookie 头（数组/字符串都支持）则追加
    const prev = h['set-cookie'];
    if (Array.isArray(prev)) h['set-cookie'] = [...prev, cookie];
    else if (typeof prev === 'string') h['set-cookie'] = [prev, cookie];
    else h['set-cookie'] = cookie;
    return origWriteHead(statusCode, h);
  };
}

/**
 * 把浏览器可见的权威改写成 loopback 权威。
 * 除 Host/Origin 外，还必须规范化 Referer 与 Sec-Fetch-Site：DSH 宿主的特权方法
 * 栅栏（settings.describe/credentials.* 等 PRIVILEGED_METHODS）会拒绝
 * sec-fetch-site === 'cross-site'，并校验 Origin 与 Host 匹配；远程访问的这两个头
 * 若不改写，设置/凭据平面会在宿主侧被 403（issue #58 的另一半）。
 * 统一小写化键名，避免 Node 原样转发时大小写键并存导致重复头。
 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'sec-fetch-site') continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = 'http:';
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ---------- dsh web 浏览器会话 token（issue #77） ----------
// 新版 dsh web（>= 0.1.2-alpha.1）给浏览器会话加了启动 token：根路径 `GET /` 必须带一次
// `?token=<启动 token>` 换一个绑定 authority 的 cookie，之后 /api 与 WebSocket 才放行；
// 否则一律 401（"dsh web authentication required"）。手机扫码进来的 URL 天然没有这个
// token，所以代理要在转发时补一次。
//
// 只在 `GET /` 且请求还没带 dsh-auth-* cookie 时注入：上游拿到 token 会 303 回干净的根
// 路径，若每次都注入就会 303 循环（浏览器很快报"重定向次数过多"）。
const DSH_AUTH_COOKIE = 'dsh-auth-';
/**
 * 去掉 URL 上所有 `dsh-desktop-*` query 参数（issue #75）。
 *
 * dsh-pocket 在 ≤ 2.1.1 会用 `history.replaceState` 往页面 URL 上写
 * `dsh-desktop-mode=compatibility` 和 `dsh-desktop-platform=<系统>`
 * （desktopEnvPatchScript，已在 2.1.2 删除）。副作用是：用户当时收藏/保存过
 * 的那个地址**一直带着这两个参数**。升级之后我们不再注入了，但用户打开旧
 * 收藏时 URL 里仍然有 —— 上游 `decideDesktopBrowserAccess` 只要见到
 * `dsh-desktop-` 前缀就认定是渲染器请求，普通浏览器没有渲染器 token，直接
 * 403 forbidden。表现就是「我已经升到最新版了，还是 forbidden」。
 *
 * 脏参数是我们写进去的，就得由我们清掉。所有方法、所有路径都清理（不只是
 * `GET /`）——API 与 WebSocket 握手带上这些参数同样会被拦。
 *
 * @param {string} reqUrl - 原始请求路径（含 query）。
 * @returns {string} 清理后的路径；无该前缀参数或解析失败时原样返回。
 */
export function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? '/', 'http://dsh.invalid');
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith('dsh-desktop-'));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}

export function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  // 登录成功后跳回的 `/?dsh-pocket-auth=1`：强制重做一次握手（旧 cookie 可能已过期/被撤销）
  const force = u.searchParams.has('dsh-pocket-auth');
  if (!force && String(cookieHeader ?? '').includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set('token', launchToken);
  return `${u.pathname}${u.search}`;
}

// ---------- 会话握手重试计数（issue #91） ----------
// Safari（iOS/macOS）不持久化「http:// + 纯 IP 源」上由 3xx 响应下发的 cookie，
// 于是 dsh web 的 launch-token→cookie 握手永远收敛不了：代理每次 `GET /`
// 都补 `?token=`，上游每次 303 回 `/`，浏览器每次都不带 cookie → 无限重定向
// （Safari 报「发生了太多重定位」）。
//
// 两道防线：
//   1) 代理把这次 303 改写成 200 过渡页（Set-Cookie 照发 + meta refresh 跳回 `/`），
//      200 响应上的 cookie 不会被 Safari 的重定向 cookie 策略丢掉；
//   2) 万一 1) 也不管用，用下面的计数器在若干次尝试后停止注入 token 并给出
//      可操作提示页——宁可给用户一句人话，也不要无限转圈。
//
// 只按客户端 IP 计数（无需 cookie 支持，正适合「cookie 用不了」的这个场景）。
export const DEFAULT_HANDSHAKE_LIMIT = 3;
export const HANDSHAKE_WINDOW_MS = 60_000;
/** 提示页「重试」按钮用的查询参数：命中即清空该 IP 的失败计数，且不往上游透传。 */
export const HANDSHAKE_RETRY_PARAM = 'dsh-pocket-retry';

/** 摘掉某个查询参数后重新拼路径；解析失败或本来就没有则原样返回。 */
export function stripQueryParam(reqUrl, name) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (!u.searchParams.has(name)) return reqUrl;
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

// ---------- 登录后回跳保住原 query（本次 B 项）----------
// 现象（真机取证）：手机首访 `/?token=<PIN>&dsh-layout=auto`，登录成功后代理
// 固定 302 到 `/?dsh-pocket-auth=1`——用户加的 `dsh-layout` 被吞了，于是那次
// "强制手机抽屉"的试验等于没做（客户端 boot 记录的 href 只剩根路径）。
// 现在回跳只丢掉 token（密码不该继续挂在地址栏）和我们自己的握手/标记参数，
// 其它参数原样带回去；cookie、限速、常量时间比对、握手 force 语义一概不动。
//
// 防注入：Location 的 path 永远是 `/`，只搬 query；key 走白名单正则，
// 值截 120 字并由 URLSearchParams 百分号编码（换行/空格进不了头），
// 参数个数封顶 8 个，敏感名（token/password/secret/…）一律不带。
const LOGIN_DROP_PARAMS = ['token', 'dsh-pocket-auth', 'dsh-pocket-retry'];
const LOGIN_CARRY_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const LOGIN_CARRY_SENSITIVE_RE = /(token|password|passwd|secret|cookie|authorization|apikey|api_key)/i;
const LOGIN_CARRY_MAX_PARAMS = 8;
const LOGIN_CARRY_VALUE_MAX = 120;

/** 参数名守卫：只接受白名单形状，`dsh-desktop-*`（issue #75）也一概不带。 */
function carryKeyAllowed(key) {
  const name = String(key ?? '');
  if (!LOGIN_CARRY_KEY_RE.test(name)) return false;
  const lower = name.toLowerCase();
  if (LOGIN_DROP_PARAMS.includes(lower)) return false;
  if (lower.startsWith('dsh-desktop-')) return false;
  if (LOGIN_CARRY_SENSITIVE_RE.test(lower)) return false;
  return true;
}

/** 从一条 URL/路径上摘出可回带的参数（丢掉 token 与自家握手参数）。 */
function carryParams(rawUrl, into) {
  if (!rawUrl) return;
  let u;
  try { u = new URL(String(rawUrl), 'http://dsh.invalid'); } catch { return; }
  for (const [key, value] of u.searchParams) {
    if (!carryKeyAllowed(key)) continue;
    if (into.has(key)) continue;                        // 先到先得：表单 action 优先于 Referer
    if (into.size >= LOGIN_CARRY_MAX_PARAMS) break;
    into.append(key, String(value).slice(0, LOGIN_CARRY_VALUE_MAX));
  }
}

/**
 * 登录页表单/过渡页要带上的查询串（不含 `?`），没有可带参数时返回 ''。
 * @param {string} reqUrl - 当前请求的原始路径（含 query）。
 */
export function loginCarryQuery(reqUrl) {
  const sp = new URLSearchParams();
  carryParams(reqUrl, sp);
  return sp.toString();
}

/**
 * POST /pocket-login 成功后的 302 目标。
 * 兜底顺序：表单 action 上的参数 → 来源页（Referer）上的参数 → 只留 dsh-pocket-auth=1。
 * @param {string} postUrl - POST 请求自身的 url（`/pocket-login?dsh-layout=auto`）。
 * @param {string} [referer] - 请求头 Referer（同源表单默认带完整 query）。
 * @returns {string} 形如 `/?dsh-layout=auto&dsh-pocket-auth=1`，无参数时 `/?dsh-pocket-auth=1`。
 */
export function postLoginRedirectLocation(postUrl, referer = '') {
  const sp = new URLSearchParams();
  carryParams(postUrl, sp);
  carryParams(referer, sp);
  // 语义不变：登录成功后一律强制重做一次 dsh web 会话握手（issue #77）
  sp.set('dsh-pocket-auth', '1');
  const qs = sp.toString();
  return qs ? `/?${qs}` : '/?dsh-pocket-auth=1';
}

export function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  /** ip -> { count, start } */
  const hits = new Map();
  return {
    /** 记一次握手注入，返回窗口内的累计次数。 */
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    /** 握手成功（拿到会话 cookie 的请求）→ 清零。 */
    clear(ip) {
      hits.delete(ip);
    },
    /** 该 IP 是否已达重试上限。 */
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    /** 清理过期条目，防长期运行内存膨胀。 */
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    },
  };
}

/** 握手过渡页：200 + Set-Cookie（由调用方带上）+ meta refresh 跳回干净根路径。
 * carry：跳回时保住的 query（已白名单过滤；token / dsh-desktop-* / dsh-pocket-* 一概不带），
 * 否则手机上 `?dsh-layout=auto` 这类参数会在这一跳被吞掉。 */
export function handshakePageHtml(carry = '') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/${carryAttr(carry)}">
<title>DSH Pocket · 正在进入 | opening…</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>正在进入… | opening…</p></body></html>`;
}

/** 握手反复失败时的提示页（issue #91）：说清原因并给出可操作的规避办法。 */
export function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 无法完成登录握手</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>🔁 无法完成登录握手</h1>
<p>浏览器没有保存 DSH 下发的会话 cookie，代理反复重试后仍未成功，因此停在这里而不是无限跳转。</p>
<p><strong>Safari（iOS/macOS）</strong> 在 <code>http://</code> 纯 IP 地址上不会保存这类 cookie，局域网入口因此进不去。</p>
<p>可以试试：<br>
① 换 Chromium 系浏览器（Chrome / Edge）打开局域网地址；<br>
② 改用<strong>公网入口</strong>（设置页开启公网访问，拿到 <code>https://…trycloudflare.com</code> 地址）——HTTPS 域名上 Safari 正常。</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">重试一次 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete (issue #91). Safari over plain <code>http://</code> + IP is the known case — try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}

// ---------- WebSocket 心跳注入（PR #41，issue #29） ----------
// DSH 客户端与宿主的 WebSocket downlink 都不发 ping/pong（客户端只读流、
// 宿主只推帧），空闲连接会被路由器 NAT 空闲超时或手机系统省电机制**静默**
// 丢弃：没有 FIN/RST，浏览器收不到 close 事件，dsh-client-connection 也就
// 永远不会重连——手机页面看起来还开着，实则实时通道已死（消息不同步、
// 点击会话卡在加载）。
//
// 代理在每个透传的 WS 连接上定期向浏览器侧发送协议层 Ping（0x89 0x00，
// server→client 不掩码）：
//   - 浏览器网络栈按 RFC 6455 自动回 Pong（不经过任何 JS），一来一回让
//     双向都有流量，NAT/防火墙空闲超时不再触发；
//   - host 心跳截止期是「两个 Ping 周期无活动」（默认 2s × 2 = 4s），手机端
//     会话数据 ~2.5MB 会阻塞 Ping/Pong——proxy 必须比 host 更频繁地 Ping，
//     让浏览器持续回 Pong，host 才能看到活动、不断链；
//   - 连续 missLimit 个周期没有任何入站字节（浏览器已死或链路被静默丢弃）
//     → 主动 destroy 连接：浏览器拿到 close 后 dsh-client-connection 会
//     按指数退避自动重连，实时通道随即恢复。
// 只 Ping 浏览器侧：上游是本机 loopback，不会过期；浏览器回的 Pong 原样
// 透传给上游 ws 服务（未请求的 Pong 对 ws 库无害，只触发无害的 pong 事件）。
const WS_PING_FRAME = Buffer.from([0x89, 0x00]); // FIN + opcode 9、长度 0、不掩码

/**
 * 在透传的浏览器侧 socket 上挂载心跳：定期 Ping 保活 + 静默断链检测。
 * 任一路由方向只要有字节流动（Pong 响应）就把静默计数归零；连续 missLimit
 * 个周期零入站流量则判定链路已死，销毁 socket 触发浏览器端重连。
 *
 * intervalMs 不宜过短：Ping 帧是直接写入 TCP 流的 2 字节，若恰好在 host
 * 大帧（如 2.5MB 会话同步）的中间插入，会损坏 WS 帧流导致浏览器断连。
 * 30s 是安全值——SSH 隧道自带 ServerAliveInterval=15s 保活，proxy 的心跳
 * 只用于检测静默断链。
 * @param {import('node:net').Socket} socket 浏览器侧的透传 socket
 * @param {{intervalMs?:number, missLimit?:number}} [opts] 心跳周期与容忍的静默周期数
 */
function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2 } = {}, onDead = null) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      // 连续多个周期没有任何入站流量（连 Pong 都没有）→ 静默断链，断开让客户端重连
      try { onDead?.('heartbeat-miss'); } catch { /* 忽略 */ }
      socket.destroy();
      return;
    }
    // write 到已销毁的 socket 会抛错（destroy 竞态），写前检查并兜底
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/** 诊断端点：手机 beacon 走 POST，电脑读取走 GET（仅 loopback）。 */
const DIAG_PATH = '/.dsh-pocket/diag';
const DIAG_BODY_MAX = 16 * 1024;
const DIAG_HITS = new Map();

/** 简易速率限制：每个 IP 每分钟最多 120 条，防止诊断端点被刷爆。 */
function diagRateLimited(ip) {
  const now = Date.now();
  const entry = DIAG_HITS.get(ip) ?? { start: now, count: 0 };
  if (now - entry.start > 60_000) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count += 1;
  DIAG_HITS.set(ip, entry);
  if (DIAG_HITS.size > 500) {
    for (const [key, value] of DIAG_HITS) {
      if (now - value.start > 120_000) DIAG_HITS.delete(key);
    }
  }
  return entry.count > 120;
}

/** 请求是否来自本机回环（读诊断文件只允许本机）。 */
function isLoopbackRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 读取诊断 POST 请求体（上限 16 KB，防止大包）。 */
function readDiagBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > DIAG_BODY_MAX) {
        tooLarge = true;
        body = '';
      }
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', () => resolve(null));
  });
}

/**
 * 启动 dsh-pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port]      监听端口（默认 3081；dsh web 保持 3080）
 * @param {string} [opts.host]      监听地址（默认 0.0.0.0：LAN 与隧道都能到）
 * @param {{host:string,port:number}} [opts.upstream] 上游 dsh web（默认 127.0.0.1:3080）
 * @param {string} [opts.injectHtml] 注入 HTML 的内容（默认 polyfill + 移动端适配；传 '' 关闭）
 * @param {object} [opts.auth]       可选访问令牌认证（issue #13）：{ getToken, getAltTokens?, isProtected, sessionKey }
 *   - getToken(host) → 主 PIN（公网/局域网各一个，按 host 分类）
 *   - getAltTokens?(host) → 替代令牌列表（可选），校验时与主 PIN 任一命中即放行
 * @param {object|false} [opts.rateLimit] 登录速率限制参数覆盖（issue #40；测试用短窗口）
 * @param {object|false} [opts.heartbeat] WebSocket 心跳注入（PR #41）：{ intervalMs, missLimit }；false 关闭（默认开：30s/容忍 2 个静默周期）
 * @param {() => boolean} [opts.lanAccessEnabled] 局域网访问是否开启（默认开启）。关闭时拦截经局域网 Host 的请求（公网/loopback 不受影响）。
 * @returns {Promise<{server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function createPocketProxy({ port = 3081, host = '0.0.0.0', upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, auth = null, rateLimit = null, heartbeat = {}, lanAccessEnabled = () => true, launchToken = () => '', handshakeLimit } = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  // WebSocket permessage-deflate（2026-10-25）：见 lib/ws-deflate.mjs 顶部注释。
  // 默认开启（省 3~4 倍字节），DSH_POCKET_WS_DEFLATE=0 一键回退明文。
  const wsDeflateEnabled = process.env.DSH_POCKET_WS_DEFLATE !== '0';
  const decideWsDeflate = (headerValue) => (wsDeflateEnabled && wsDeflateAllowed()
    ? negotiatePermessageDeflate(headerValue)
    : null);
  const wsDeflate = attachWsDeflate;
  // 会话握手重试计数（issue #91）：Safari 在 http://IP 源上丢 3xx 的 cookie → 死循环
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === 'number' ? { max: handshakeLimit } : {},
  );
  const mobileBatches = createMobileBatchStore({ upstream, rewriteHeaders: loopbackAuthority, log });
  const server = createServer((req, res) => {
    let urlPath = '';
    try { urlPath = new URL(req.url ?? '/', 'http://diag.invalid').pathname; } catch { urlPath = ''; }

    // 诊断端点（先于鉴权）：
    //   POST — 手机 client/orb/diag.ts 的 sendBeacon，写入 profile 下的 JSONL；
    //   GET  — 仅本机回环可读，返回最近 30 分钟的 page/ws/client 汇总。
    if (urlPath === DIAG_PATH) {
      if (req.method === 'POST') {
        const ip = clientIp(req);
        if (diagRateLimited(ip)) {
          res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end('{"error":"too-many-events"}');
          return;
        }
        void readDiagBody(req).then((body) => {
          if (body === null) {
            res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"too-large"}');
            return;
          }
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          if (parsed === null || typeof parsed !== 'object') {
            res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"invalid-json"}');
            return;
          }
          const { ev, ...rest } = parsed;
          appendDiagnostic({
            ev: 'client',
            name: String(ev ?? 'event').slice(0, 48),
            ip,
            ua: String(req.headers['user-agent'] ?? '').slice(0, 220),
            ...rest,
          });
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
        });
        return;
      }
      if (req.method === 'GET') {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end('{"error":"loopback-only"}');
          return;
        }
        const summary = diagnosticSummary({ minutes: 30, limit: 120 });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(summary));
        return;
      }
      res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"method-not-allowed"}');
      return;
    }

    // 整页 reload 的直接证据：只记 HTML 文档请求（不记 JS/CSS/图片）。
    // 隧道探活（UA=dsh-pocket-tunnel-probe，每 20s 一次）不记，避免日志被探针刷满。
    if (req.method === 'GET' && (urlPath === '/' || /\.html?$/i.test(urlPath))) {
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 220);
      if (!ua.includes('dsh-pocket-tunnel-probe')) {
        appendDiagnostic({
          ev: 'page',
          host: policyHost(req, String(req.headers.host ?? '')),
          ip: clientIp(req),
          path: String(req.url ?? '').slice(0, 240),
          ref: String(req.headers.referer ?? '').slice(0, 200),
          ua,
        });
      }
    }

    // 策略判定一律用 policyHost（issue #90）：Host 头可伪造，用不可伪造的 TCP 源地址
    // 给它设下限。转发给上游的 Host 由 loopbackAuthority 单独改写，不受这里影响。
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    // 局域网访问关闭（issue #54）：拦截经局域网 IP/主机名访问的请求；
    // 公网（含任意非内网 Host——issue #66 fail closed）与 loopback（本机/cloudflared 回连）放行，
    // 公网流量随后照常走访问密码认证。
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    // 访问令牌认证（issue #13 + #18 + #33 + #40 + #69）：局域网与公网按开关/来源要求密码
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      // 临时 PIN（issue #69）：按 host 同源分发（公网临时 PIN 只在公网入口放行，局域网同理）
      const altTokens = protectedHost && token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const sessionKey = auth.sessionKey ?? null;
      const acceptedTokens = token ? [token, ...altTokens] : [];
      if (protectedHost && token) {
        const ip = clientIp(req);
        // 登录提交：速率限制（issue #40）→ 校验密码 → 种持久 HttpOnly cookie（30 天，绑定进程会话密钥）→ 回首页
        if (req.method === 'POST' && req.url?.startsWith('/pocket-login')) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(rl.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, rl.retryAfter, loginCarryQuery(req.url)));
            return;
          }
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
          req.on('end', () => {
            const submitted = String(new URLSearchParams(body).get('token') ?? '');
            // 与 cookie / ?token= 两条通道保持一致：常量时间比较 + 主 PIN 与替代令牌
            // （临时 PIN，issue #69 钩子）任一命中即放行。原先这里是 `submitted === token`
            // ——既会提前返回（计时侧信道可逐字节还原 PIN），又把替代令牌挡在门外。
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== undefined) {
              limiter?.clear(ip);
              res.writeHead(302, {
                // 带上 dsh-pocket-auth=1：登录成功后强制重做一次浏览器会话握手，
                // 换掉可能已过期/被撤销的 dsh web 会话 cookie（issue #77）。
                // 同时保住用户原 URL 上除 token 之外的 query（本次 B 项）：
                // 原先写死 '/?dsh-pocket-auth=1' 会把 ?dsh-layout=auto 之类吞掉。
                location: postLoginRedirectLocation(req.url, req.headers.referer ?? ''),
                'set-cookie': `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                'cache-control': 'no-store',
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`dsh-pocket: login failed from ${ip} | 登录失败 IP: ${ip}`);
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml(true, isPublic, 0, loginCarryQuery(req.url)));
            }
          });
          return;
        }
        // `?token=<PIN>` 是与 POST 登录等价的一次密码尝试（issue #90）：此前只有 POST
        // 分支调用 limiter.record()，这条通道既不计数也不受锁定约束，等于给攻击者留了
        // 一个可全速穷举 8 位 PIN 的旁路。下面把它并入同一套限速。
        const isGuess = hasQueryToken(req);
        if (isGuess) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          // 锁定期内直接拒绝、不做比对——否则锁定窗口本身就是免费的穷举窗口。
          // 正确密码也一并拒绝，与 POST 登录的锁定语义保持一致。
          if (rl.locked) {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml('locked', isPublic, rl.retryAfter));
            } else {
              res.writeHead(429, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'retry-after': String(rl.retryAfter),
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`dsh-pocket: bad ?token= from ${ip} | URL 密码错误 IP: ${ip}`);
          }
          if (isHtmlRequest(req)) {
            // 锁定期间打开登录页也给提示（HTTP 200 + 锁定文案；429 语义留给 POST 拒绝）
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPageHtml(rl.locked ? 'locked' : false, isPublic, rl.retryAfter, loginCarryQuery(req.url)));
          } else {
            res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        // ?token=<原始 PIN> 直达时种 HttpOnly cookie，让浏览器后续子资源也走 cookie 路径（issue #35）
        if (authResult.rawQueryToken) {
          limiter?.clear(ip); // 与 POST 登录成功一致：正确的分享链接不该逐步累积到锁定
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    // HTML 必须取未压缩版本：注入与移动首屏精简都只能安全改写纯文本。
    // 上游 HTML 仅几十 KB，identity 的额外字节远小于误下放数 MB 旧插件 batch。
    if (isHtmlRequest(req)) headers['accept-encoding'] = 'identity';
    // dsh web 浏览器会话 token（issue #77）：首屏根路径补一次，换回绑定 authority 的 cookie
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    // 先清掉历史遗留的 dsh-desktop-* 参数（issue #75），再补 launch token
    // 握手重试上限（issue #91）：Safari 不保存 http://IP 源上 3xx 下发的 cookie →
    // 补 token → 上游 303 → 浏览器仍无 cookie → 无限循环。达到上限就别再补了，
    // 让请求落到提示页，而不是继续转圈。
    const handshakeIp = clientIp(req);
    // `/?dsh-pocket-retry=1`：提示页上的「重试」入口——清掉这一轮的失败计数，让握手
    // 重新走一遍（否则用户得干等窗口过期）。这参数是我们自己加的，不往上游透传。
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== '' && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver
      ? cleanPath
      : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    // 请求带上了会话 cookie → 这一轮的握手计数可以清掉了（说明 cookie 通路是好的）
    if (!didInjectToken && String(req.headers.cookie ?? '').includes(DSH_AUTH_COOKIE)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      // 已判定握不上手 → 停在这里给人话，别再转圈。API/WS 不走这里（上游会 401）。
      res.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-dsh-pocket-handshake': 'blocked',
      });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    if (mobileBatches.handle(req, res)) return;
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        // issue #91：我们刚注入了 launch token，上游回 303（换 cookie 后回干净根路径）。
        // Safari 不保存 http://IP 源上 3xx 响应下发的 cookie，于是浏览器下次仍无 cookie
        // → 代理再注入 → 再 303 → 死循环。这里把这次 303 改成 200 过渡页：Set-Cookie
        // 照发（200 上的 cookie 不会被那条重定向策略丢掉），页面用 meta refresh 跳回 `/`。
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          delete out.location; // 自己跳，不留给浏览器去重做一次 303
          const page = Buffer.from(handshakePageHtml(loginCarryQuery(req.url)), 'utf8');
          out['content-type'] = 'text/html; charset=utf-8';
          out['content-length'] = String(page.length);
          out['cache-control'] = 'no-store';
          out['x-dsh-pocket-handshake'] = 'transition';
          proxyRes.resume(); // 消费掉上游响应体，释放连接
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        // issue #81：上游 desktop-browser-access 门禁（DSH Desktop 未开启「浏览器访问」时）
        // 对普通浏览器（含经本代理转发的手机）返回 403 text/plain "forbidden"，且本代理无法
        // 携带 Electron renderer secret 绕过。对符合该特征的**浏览器导航**请求改写为可操作
        // 提示页；API/WS 与其余 403 原样透传（不猜 secret、不把任意 403 都判为桌面门禁）。
        if (proxyRes.statusCode === 403 && contentType.includes('text/plain')) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateOverflow = false;
          const passRaw403 = () => {
            if (res.headersSent) return;
            res.writeHead(403, { ...proxyRes.headers });
            if (gateChunks.length) res.write(Buffer.concat(gateChunks));
            proxyRes.pipe(res);
          };
          proxyRes.on('data', (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            if (Buffer.concat(gateChunks).length > 65536) { gateOverflow = true; gateChunks.length = 0; passRaw403(); }
          });
          proxyRes.on('end', () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString('utf8').trim();
            if (navReq && body === 'forbidden') {
              res.writeHead(403, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'x-dsh-pocket-gate': 'desktop-browser-access',
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 只给**未压缩**的 HTML 文档注入（SSE/WS/JS/CSS 原样透传；压缩流注入会损坏页面）；
        // 注入后修正 Content-Length
        if (injectHtml && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            let mobileBootLean = false;
            const ua = String(req.headers['user-agent'] ?? '');
            const fullPlugins = new URL(req.url ?? '/', 'http://pocket.invalid').searchParams.get('dsh-full-plugins') === '1';
            if (/(?:Android|iPhone|iPad|HarmonyOS|Mobile)/i.test(ua) && !fullPlugins) {
              const optimized = optimizeMobileBoot(html, { createBatch: mobileBatches.register });
              html = optimized.html;
              mobileBootLean = optimized.changed;
            }
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            // 注入后的 HTML 携带本代理的动态补丁（含注入标记判重），
            // 必须禁用缓存——否则手机/中间层（nginx 等）拿到没有补丁的旧
            // 文档后，isLoopback 修复不生效且难以排查（表现为"改了没效果"）。
            outHeaders['cache-control'] = 'no-store';
            if (mobileBootLean) outHeaders['x-dsh-pocket-mobile-boot'] = 'lean';
            delete outHeaders['etag'];
            delete outHeaders['last-modified'];
            delete outHeaders['expires'];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 大 JSON/text 响应**流式压缩**（issue #12）：长会话历史一次返回 17MB+，
        // 局域网直连与隧道段都吃满带宽；压缩到 ~1MB。跳过已压缩、SSE 流
        // （/api/events.* 原样透传）、HTML（走上面的注入分支）。
        // brotli 质量选 6（issue #25）：zlib 默认 q11 压 17MB 要 40s+，手机直接超时；
        // q6 实测 128ms（比 gzip 的 88ms 略慢但同档）且输出更小（1.00MB vs 1.20MB）。
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, staticCacheHeaders(req.url, outHeaders));
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          // 任一端断开都要清理（含压缩流）。注意：不能用 proxyRes 的 'close'
          // 来掐 res——正常结束后 close 也会触发，此时压缩流可能还没写完，
          // 会误杀连接；异常中止用 'aborted'。
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, staticCacheHeaders(req.url, proxyRes.headers));
        proxyRes.pipe(res);
        // 任一端断开都要清理另一端：客户端断连销毁上游流（不留僵尸），
        // 上游流中途断开也要掐断客户端（否则响应头已发、体没发完 → 悬挂）
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: 无法连接上游 dsh web（${upstream.host}:${upstream.port}）——先启动 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // WebSocket upgrade（DSH 的 /api/events.mux + events.host 流式通道）原样透传
  server.on('upgrade', (req, socket, head) => {
    // 与 HTTP 侧同一套判定（issue #90）：否则伪造 Host 的 WS 握手仍可绕过局域网开关
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    // 局域网访问关闭：拦截经局域网 Host 的 WS 握手（公网/loopback 放行——issue #66 fail closed）
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // WebSocket 同样校验（防止绕过 HTTP 认证从 WS 进入；含临时 PIN，issue #69）
    if (auth) {
      const token = isProtectedHost(host, auth.isProtected) ? (auth.getToken?.(host) ?? null) : null;
      const altTokens = token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      // WS 握手上的 ?token= 与 HTTP 侧同权（issue #90）：不并入限速的话，攻击者
      // 只要把穷举换到 upgrade 请求上就照样不受限。
      const wsIp = clientIp(req);
      const wsGuess = hasQueryToken(req);
      if (token && wsGuess) {
        const rl = limiter?.status(wsIp) ?? { locked: false, retryAfter: 0 };
        if (rl.locked) {
          socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfter}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
      }
      const wsAuth = authCheck(req, acceptedTokens, auth.sessionKey ?? null);
      if (token && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp);
          log?.(`dsh-pocket: bad ws ?token= from ${wsIp} | WS 密码错误 IP: ${wsIp}`);
        }
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp);
    }
    // 诊断：WS 连接的生命周期（手机是否在周期性重连 = 页面跳动的直接证据）。
    const wsId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wsStarted = Date.now();
    const wsPath = String(req.url ?? '').slice(0, 240);
    const wsUa = String(req.headers['user-agent'] ?? '').slice(0, 220);
    const wsIp = clientIp(req);
    let wsOpened = false;
    let wsLogged = false;
    let wsBytesIn = 0;
    let wsBytesOut = 0;
    let wsCloseReason = '';
    const logWsClose = () => {
      if (!wsOpened || wsLogged) return;
      wsLogged = true;
      appendDiagnostic({
        ev: 'ws-close',
        id: wsId,
        host,
        ip: wsIp,
        ua: wsUa,
        path: wsPath,
        durMs: Date.now() - wsStarted,
        bytesIn: wsBytesIn,
        bytesOut: wsBytesOut,
        reason: wsCloseReason || 'unknown',
      });
    };

    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      host: upstream.host, port: upstream.port, method: req.method, path: stripDesktopMarkers(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      // permessage-deflate（2026-10-25）：手机打开长会话详情时，dsh web 会把整段会话
      // 历史的开屏快照经这条 mux 推给手机（实测 13.5MB 事件 JSON / 2801 条事件），
      // 上游 dsh web 自己不协商压缩（101 里没有 sec-websocket-extensions），于是
      // 13.5MB 明文要过「服务器 → 手机」那一段 2.7Mbps 的窄口 = 38s+。
      // 这里由代理在浏览器侧接下 permessage-deflate，逐条 deflate 上游文本帧。
      const wsDeflateValue = wsDeflate && decideWsDeflate(req.headers['sec-websocket-extensions']);
      if (wsDeflateValue) raw.push(`Sec-WebSocket-Extensions: ${wsDeflateValue}`);
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      wsOpened = true;
      appendDiagnostic({
        ev: 'ws-open',
        id: wsId,
        host,
        ip: wsIp,
        ua: wsUa,
        path: wsPath,
      });
      socket.on('data', (chunk) => { wsBytesIn += chunk.length; });
      proxySocket.on('data', (chunk) => { wsBytesOut += chunk.length; });
      // pipe 必须 end:false：默认 end:true 会在对端 FIN 时抢先 end() 对端 socket
      // （优雅 FIN），此时 teardown 的 destroy() 已无法强制关闭对方——上游只收
      // 到 FIN 进入 half-open 永不关闭（PR #56）。半关闭统一交给下面的 'end'
      // 监听 → teardown destroy（RST 强制关闭双方）。
      if (wsDeflateValue && wsDeflate) {
        // 压缩通道：由 ws-deflate 接管两条 socket 的 'data'（同样 end:false 语义）
        const wsDef = wsDeflate({
          client: socket,
          upstream: proxySocket,
          onFailure: noteWsDeflateFailure,
          onError: (err) => log?.(`dsh-pocket: ws-deflate failed: ${err?.message ?? err}`),
        });
        socket.on('close', () => { try { wsDef.close(); } catch {} });
        proxySocket.on('close', () => { try { wsDef.close(); } catch {} });
      } else {
        socket.pipe(proxySocket, { end: false });
        proxySocket.pipe(socket, { end: false });
      }
      // 心跳注入（PR #41）：保活 + 静默断链检测（见 attachWebSocketHeartbeat）
      if (heartbeat !== false) {
        attachWebSocketHeartbeat(socket, heartbeat ?? {}, (reason) => { wsCloseReason ||= reason; });
      }
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）。
      // 上游侧必须 resetAndDestroy（发 RST）：destroy() 只发干净 FIN，而上游
      // http server 默认 allowHalfOpen=true，收到 FIN 不自动关闭 → 上游仍悬挂
      // （PR #56 实测）。RST 强制对端立即关闭。
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch {} }
        try { socket.destroy(); } catch {}
      };
      // 上游侧透传 socket 的读错误（如 dsh web 重启/断开时的 ECONNRESET）必须
      // 吞掉并清理对端，否则未处理的 'error' 事件会让整个 dsh web 进程崩溃退出。
      proxySocket.on('error', () => { wsCloseReason ||= 'upstream-error'; try { socket.destroy(); } catch {} logWsClose(); });
      proxySocket.on('close', () => { wsCloseReason ||= 'upstream'; logWsClose(); teardown(); });
      socket.on('close', () => { wsCloseReason ||= 'browser'; logWsClose(); teardown(); });
      // 半关闭（收到对端 FIN 的 'end'）对双向转发同样意味着这一端要走了：http server
      // 默认 allowHalfOpen=true，收到 FIN 只触发 'end' 不自动关——若不在 'end' 时销毁，
      // 浏览器/App 直接关页（不发 WS close 帧就 FIN）留下的连接会永久挂在 half-open
      // 状态，上游连接槽被占（且 server.close() 永远等不完）。双向流里半关闭无意义。
      socket.on('end', () => { wsCloseReason ||= 'browser-end'; tapEnd(); });
      proxySocket.on('end', () => { wsCloseReason ||= 'upstream-end'; tapEnd(); });
      function tapEnd() {
        logWsClose();
        teardown();
      }
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return; // 理论上 101 走 upgrade 事件
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        // end 会 flush 响应头再 FIN——不要紧跟 destroy()，否则排队的头会被丢弃
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume(); // 消费掉上游响应体，释放连接
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // 关键：浏览器在握手请求后可能立即发出首帧（如 mux 流的初始 RPC），
    // node 把它放在 upgrade 事件的 head 里。必须先于 end() 写入 proxyReq，
    // 让上游在 upgrade 事件里就拿到它（与直连行为一致）；等 101 之后再写
    // 会变成迟到的 socket 数据，DSH 的 mux 协议可能错过这个窗口。
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  // 跟踪所有 TCP 连接（含 WebSocket upgrade 后的 socket——Node 的
  // closeAllConnections 不包含它们，不手动销毁 close() 会永远等）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // 防未处理 error 崩进程
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
