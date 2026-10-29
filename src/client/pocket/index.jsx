// dsh-pocket 网页客户端：
//   1. 设置页签「手机访问」（局域网/公网二维码 + 更新/重启提示）
//   2. 移动端适配（移植自 MIT 项目 dsh-web-mobile，见 client/mobile/LICENSE.dsh-web-mobile）
//
// 手机扫码打开的就是电脑上的 dsh web，实时同步；窄屏自动变成抽屉布局。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了。专注扫码同屏这一件事。

import { createElement as h, useEffect, useRef, useState } from 'react';

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, redactStatus, compareVersions } from './api.js';
import { mobileApply } from './mobile/mobile-apply.tsx';
import { installDiag } from './orb/diag.ts';
import { orbApply } from './orb/orb-apply.tsx';
import { NS as POCKET_NS, zh as POCKET_ZH, en as POCKET_EN } from './pocket-locales.js';
import { PHONE_STUCK_VIEWPORT, readAppliedLayout, readStoredLayout, needsNarrowDesktopConfirm, stripLayoutParamFromHref, writeLayout } from './mobile/layout-mode.mjs';

const name = 'dsh-pocket';
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload'];

// 词典在 pocket-locales.js；这里只做「取 key → 替换 {占位符} → 字符串」。
// 不依赖 DSH t() 的插值能力，避免行为不一致。
function fmt(t, key, vars) {
  let s = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = String(s).split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// 界面布局三态（issue #74 + 本次 P0）：取值与 client/mobile/layout-mode.mjs 的
// LAYOUT_VALUES 完全一致，和抽屉底部快切、右下角常驻布局徽章共用同一个
// localStorage key（dsh-pocket.layout）。
const LAYOUT_OPTIONS = [
  { value: '', key: 'layoutAuto' },
  { value: 'mobile', key: 'layoutDrawer' },
  { value: 'desktop', key: 'layoutDesktop' },
];
// 生效值（body 上的 marker）→ 文案 key：'mobile' = 抽屉、'desktop' = 电脑。
const APPLIED_LAYOUT_KEYS = { '': 'layoutAuto', mobile: 'layoutDrawer', desktop: 'layoutDesktop' };

// 官方 DeepSeek Harness 设计系统（dsh-client-ui-theme design-platform.css）：
// 按钮 md=36px 胶囊形 / sm=28px；品牌色 --dsw-alias-brand-primary；
// hover 走 --dsw-alias-button-*-hover；间距 4px 栅格；正文 13px。
const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 480 },
  block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  code: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, wordBreak: 'break-all', margin: '6px 0 10px', color: 'var(--dsw-alias-label-primary,inherit)' },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))', color: 'var(--dsw-alias-label-primary-foreground, #fff)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 220, height: 220, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', margin: '8px 0' },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5 },
};

export function PocketSettingsTab({ rpcCall, t }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tunnelState, setTunnelState] = useState(null); // 隧道进度 {phase, detail, startedAt}
  const [restartNotice, setRestartNotice] = useState(false); // 重启后提示
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updating, result, startedAt } | null
  const [isDesktop, setIsDesktop] = useState(false); // DSH Desktop（Electron）环境：更新/重启由桌面版管理
  const [now, setNow] = useState(Date.now()); // 每秒 tick，驱动倒计时

  // 只有正在显示的倒计时才需要 1Hz tick；空闲设置页不再每秒重渲染整张卡。
  const ticking = updateInfo?.updating === true
    || updateInfo?.restarting === true
    || ['downloading', 'starting', 'registering'].includes(tunnelState?.phase)
    || Number(status?.sshTunnel?.nextRetryAt) > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const elapsed = (startedAt) => (startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const load = async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      setStatus(s);
      setTunnelState(s.tunnelState ?? null);
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        // 新进程确认起来了：显示一次「已重启」，清掉旧的更新横幅（单状态，不并存），
        // 然后自动刷新页面加载新代码——不用用户手动刷新
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem('dshp-auto-reloaded')) {
          sessionStorage.setItem('dshp-auto-reloaded', '1');
          setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 2000);
        }
      }
    } catch { /* 忽略瞬时失败 */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  // 每次页面加载清掉自动刷新标记——这样下次重启（更新后）才能再次触发自动刷新
  useEffect(() => {
    try { sessionStorage.removeItem('dshp-auto-reloaded'); } catch { /* 忽略 */ }
  }, []);

  // 版本检测：host 当前版本 vs npm registry latest（registry 带 CORS *）
  // 两种情况显示横幅：① 有新版可更新；② 磁盘已更新但进程还是旧代码（重启生效）
  // cache: 'no-store' —— registry 响应带缓存头，浏览器会缓存旧版本号导致「小版本不提示」
  // 周期重查（每 5 分钟）：npm registry 的 /latest 走 CDN 边缘缓存，刚发布后打开页面
  // 可能拿到旧版本号——周期性重查让更新提示在缓存刷新后自动出现，不用重开页面。
  // 桌面端（isDesktop）：更新/重启由 DSH Desktop 管理，这里不做版本检测、不显示更新横幅
  useEffect(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { cache: 'no-store' })).json();
        if (!alive) return;
        const latest = typeof meta?.version === 'string' ? meta.version : null;
        if (latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          // 已更新未重启：显示「已更新，重启生效」+ 重启按钮
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: 'ok', updated: true });
        }
      } catch { /* 网络失败静默 */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [isDesktop]);

  // 重启宿主（更新生效必需：刷新页面不会重载服务端代码）
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...u, restarting: true, startedAt: Date.now() }));
    try {
      // 宿主 500ms 后自杀，RPC 响应可能来不及送达 → 3 秒超时兜底，别让按钮永远卡「重启中…」
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('restart requested (no reply within 3s)')), 3000)),
      ]);
      setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
    } catch (err) {
      // 网络断连/超时同样视为「已请求重启」——旧进程即将退出，等新进程起来后刷新即可
      const msg = String(err?.message ?? '');
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
        return;
      }
      setUpdateInfo((u) => ({ ...u, restarting: false, result: 'fail', output: err.message }));
    }
  };

  // 一键更新：调宿主 dsh plugin update（成功后宿主自动重启生效，用户只点一次）
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...u, updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...u,
        updating: false,
        result: r.ok ? 'ok' : 'fail',
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error,
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...u, updating: false, result: 'fail', output: err.message }));
    }
  };

  // 安全免责声明（issue #31）：每次开启公网都必须先弹框勾选「我已知情」。
  // 服务端同样强制（tunnel.start 需 disclaimer: true），防绕过前端直接调 RPC。

  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);

  const doStartTunnel = async () => {
    // 命名隧道模式：Token/域名没配齐就不发起（服务端同样会拒绝）
    const cfg = status?.tunnelConfig;
    if (cfg?.mode === 'named' && (!cfg.hostname || !cfg.tokenSet)) {
      setError(t('namedNeedCfg'));
      return;
    }
    setBusy(true);
    setError(null);
    setTunnelState({ phase: 'starting', detail: '正在开启…', startedAt: Date.now() });
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const startTunnel = () => {
    // 每次开启都弹免责确认（勾选后才能继续）
    setDisclaimerChecked(false);
    setDisclaimerOpen(true);
  };
  const confirmDisclaimer = () => {
    if (!disclaimerChecked) return; // 未勾选不允许
    setDisclaimerOpen(false);
    doStartTunnel();
  };

  const stopTunnel = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelStop, {})); } catch { /* 忽略 */ }
  };

  // 固定公网地址（SSH 反向隧道）：开关持久化到 settings.json，并立即生效。
  // 地址本身（host/remotePort/私钥）写在 settings.json 的 sshTunnel 里——设置页只做开关与状态。
  const toggleFixedTunnel = async () => {
    const next = !(status?.sshTunnel?.enabled === true);
    setBusy(true);
    try {
      setStatus(await call(POCKET_ENDPOINTS.sshTunnelSetEnabled, { on: next }));
      showToast(next ? t('fixedAddrOnToast') : t('fixedAddrOffToast'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // 公网模式（issue #66）：随机域名（默认零配置）/ 固定域名（Cloudflare 命名隧道 + Tunnel Token）
  // tunnelCfg：编辑态 { hostname, token, err } | null；token 输入留空 = 保持已存的 Token 不变
  const [tunnelCfg, setTunnelCfg] = useState(null);
  const switchToQuick = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, { mode: 'quick' })); } catch (err) { setError(err.message); }
  };
  const saveNamedTunnel = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, {
        mode: 'named',
        hostname: tunnelCfg?.hostname ?? '',
        token: tunnelCfg?.token || undefined, // 留空不覆盖已存 Token
      }));
      setTunnelCfg(null);
    } catch (err) {
      setTunnelCfg((c) => ({ ...c, err: err.message }));
    }
  };

  // 恢复出厂设置：清本机设置 + 重设随机密码（弹窗确认；RPC 端也强制校验 confirm）
  const [resetOpen, setResetOpen] = useState(false);
  const doFactoryReset = async () => {
    setResetOpen(false);
    setBusy(true);
    setError(null);
    try {
      setStatus(await call(POCKET_ENDPOINTS.pocketReset, { confirm: true }));
      setTunnelCfg(null);
      setCustomPin(null);
      setAdvOpen(false);
      showToast(t('resetDone'));
    } catch (err) {
      setError(err.message);
      showToast(t('resetFailed'));
    } finally {
      setBusy(false);
    }
  };

  // 刷新局域网访问密码（旧密码立即作废）
  const refreshLanPin = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanTokenRefresh, {});
      setStatus((s) => ({ ...s, lanToken: r.lanToken }));
    } catch { /* 忽略 */ }
  };

  // 局域网访问密码开关（issue #24）：默认开启；关闭后局域网扫码直连（公网不受影响）
  const setLanAuth = async (on) => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanAuthSetEnabled, { on });
      setStatus((s) => ({ ...s, lanAuthEnabled: r.lanAuthEnabled }));
    } catch { /* 忽略 */ }
  };

  // 局域网访问总开关：关闭后局域网扫码/链接直接失效（公网不受影响）。
  // 切换前弹窗确认（弹窗提醒）；服务端用 setLanEnabled 持久化，代理按 Host 实时拦截。
  const [lanToggleOpen, setLanToggleOpen] = useState(null); // null | true | false（目标 on 状态）
  const requestLanToggle = (on) => setLanToggleOpen(on);
  const confirmLanToggle = async () => {
    const on = lanToggleOpen;
    setLanToggleOpen(null);
    if (on === null) return;
    try {
      const r = await call(POCKET_ENDPOINTS.lanSetEnabled, { on });
      setStatus((s) => ({ ...s, lanEnabled: r.lanEnabled }));
    } catch (err) {
      setError(err.message);
    }
  };

  // 局域网地址手动覆盖（Tailscale/VPN 等远程访问场景）：空值恢复自动选择
  const setLanAddress = async (ip) => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.lanSetOverride, { ip }));
    } catch (err) {
      setError(err.message);
    }
  };

  // 自定义访问密码（issue #33）：公网/局域网各自设固定 8 位密码（英文字母大小写或数字）；自定义后公网不再自动轮换。
  // customPin: { which: 'public'|'lan', value, err } | null —— 正在输入自定义密码的区块
  const [customPin, setCustomPin] = useState(null);
  const saveCustomPin = async (which) => {
    try {
      const r = await call(POCKET_ENDPOINTS.pinSetCustom, { which, value: customPin?.value ?? '' });
      setStatus((s) => ({
        ...s,
        accessToken: which === 'public' ? r.pin : s.accessToken,
        lanToken: which === 'lan' ? r.pin : s.lanToken,
        publicPinCustom: which === 'public' ? true : s.publicPinCustom,
        lanPinCustom: which === 'lan' ? true : s.lanPinCustom,
      }));
      setCustomPin(null);
    } catch (err) {
      setCustomPin((c) => ({ ...c, err: err.message }));
    }
  };
  // 渲染自定义输入行（共用）：输入框 + 保存/取消
  const customPinRow = (which) => h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.5 } },
    t('customizing'),
    h('input', {
      style: { width: 130, margin: '0 6px', padding: '4px 8px', fontSize: 14, letterSpacing: 1, textAlign: 'center', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none' },
      type: 'password',
      maxLength: 8,
      value: customPin?.value ?? '',
      autoFocus: true,
      onChange: (e) => setCustomPin((c) => ({ ...c, value: e.target.value.replace(/[^a-zA-Z0-9]/g, ''), err: null })),
      onKeyDown: (e) => { if (e.key === 'Enter') saveCustomPin(which); if (e.key === 'Escape') setCustomPin(null); },
    }),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 2 }, onClick: () => saveCustomPin(which) }, t('save')),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setCustomPin(null) }, t('cancel')),
    customPin?.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(customPin.err)) : null,
  );
  // 「自定义」按钮（非输入态显示在密码行末尾）
  const customBtn = (which) => h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setCustomPin({ which, value: '', err: null }) }, t('customize'));

  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  const tunnelPhase = tunnelState?.phase ?? 'idle';
  const tunnelStarting = ['downloading', 'starting', 'registering'].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? '';
  const tunnelStateStarted = tunnelState?.startedAt ?? null;
  // 公网模式视图（issue #66）：{ mode, hostname, tokenSet }
  const tunnelModeView = status?.tunnelConfig ?? { mode: 'quick', hostname: '', tokenSet: false };
  const namedMode = tunnelModeView.mode === 'named';
  // 固定公网地址（SSH 反向隧道）状态：
  // { enabled, configured, url, phase, reason, adopted, adoptedPid, attempts, autoKills, cleanupLimit,
  //   cleanups[], lastError, lastStderr, nextRetryAt, keyExists, keyName }
  const fixed = status?.sshTunnel ?? null;
  const fixedOnline = fixed?.phase === 'online';
  // 状态文案按「诊断原因」给，不再一律「连接中…」——2026-10-20 整天连不上却只显示
  // 「连接中… / ssh exited (code=255)」，用户完全看不出是远端旧隧道占着端口。
  const fixedStatusLabel = (f) => {
    if (!f) return '';
    if (f.phase === 'online') return f.adopted ? t('fixedAddrOnlineAdopted') : t('fixedAddrOnline');
    if (!f.enabled) return t('fixedAddrOff');
    switch (f.reason) {
      case 'port_occupied': return t('fixedAddrOccupied');
      case 'cleanup_limit': return fmt(t, 'fixedAddrCleanupLimit', { n: f.cleanupLimit ?? f.autoKills ?? 3 });
      case 'auth': return t('fixedAddrAuth');
      case 'hostkey': return t('fixedAddrHostkey');
      case 'network': return t('fixedAddrNetwork');
      case 'dns': return t('fixedAddrDns');
      case 'key_missing': return t('fixedAddrKeyMissing');
      case 'not_configured': return t('fixedAddrNotConfigured');
      case 'spawn': return t('fixedAddrSpawnFail');
      case 'probe': return fmt(t, 'fixedAddrRetrying', { n: f.attempts ?? 0 });
      default: return f.phase === 'retrying' ? fmt(t, 'fixedAddrRetrying', { n: f.attempts ?? 0 }) : t('fixedAddrConnecting');
    }
  };
  // 次级明细行：下次重连倒计时 / 第几次重试 / 自动清理计数与远端占用进程 / 最后一次错误
  const fixedDetail = (f) => {
    if (!f) return '';
    if (f.phase === 'online') {
      return f.adoptedExternal && f.adoptedPid
        ? fmt(t, 'fixedAddrAdoptedHint', { pid: f.adoptedPid })
        : t('fixedAddrHint');
    }
    const bits = [];
    if (f.nextRetryAt) bits.push(fmt(t, 'fixedAddrNextRetry', { s: Math.max(0, Math.round((f.nextRetryAt - Date.now()) / 1000)) }));
    if (f.attempts) bits.push(fmt(t, 'fixedAddrAttempts', { n: f.attempts }));
    if (f.autoKills) bits.push(fmt(t, 'fixedAddrCleanups', { n: f.autoKills, limit: f.cleanupLimit ?? 3 }));
    const withHolders = (f.cleanups ?? []).find((c) => Array.isArray(c.holders) && c.holders.length);
    if (withHolders) bits.push(fmt(t, 'fixedAddrCleanupHolders', { list: withHolders.holders.join(', ') }));
    if (!f.keyExists && f.keySet) bits.push(fmt(t, 'fixedAddrKeyName', { name: f.keyName || '?' }));
    return bits.join(' · ');
  };
  const fixedDotColor = (f) => {
    if (f?.phase === 'online') return 'var(--dsw-alias-state-success-primary,#15803d)';
    if (f?.enabled) return 'var(--dsw-alias-state-warn-primary,#b45309)';
    return 'var(--dsw-alias-label-tertiary,#9ca3af)';
  };
  // 立即重连（人工兜底）：主机侧会 探活收养 → 清本机残留 → 清远端旧占用 → 新建，
  // 并重置退避与连续自动清理计数；RPC 不 await，进度靠设置页 3 秒轮询 status。
  const reconnectFixedTunnel = async () => {
    setBusy(true);
    try {
      setStatus(await call(POCKET_ENDPOINTS.sshTunnelReconnect, {}));
      showToast(t('fixedAddrReconnectToast'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  // 模式按钮选中态高亮：固定域名模式本身，或正在编辑固定域名配置，都视为「选中」
  const namedActive = namedMode || tunnelCfg !== null;
  // 后端错误消息统一为「中文 | English」混排；按当前界面语言只显示对应一半
  const errText = (msg) => {
    const s = String(msg ?? '');
    const i = s.indexOf(' | ');
    if (i < 0) return s;
    return (t('ok') === POCKET_ZH.ok ? s.slice(0, i) : s.slice(i + 3)).trim();
  };
  // 轻量 Toast：操作成功/失败后短暂提示（自动消失，不打断操作）
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const modeBtnStyle = (active) => ({
    ...styles.btn, height: 28, padding: '0 12px', fontSize: 12,
    fontWeight: active ? 600 : 400,
    background: active ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))' : 'var(--dsw-alias-bg-layer-1,#fff)',
    color: active ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-primary,inherit)',
  });
  // iOS 风格小开关（重排后统一用：局域网总开关 / 局域网密码开关）
  const Switch = (on, onClick) => h('button', {
    role: 'switch', 'aria-checked': !!on,
    style: { flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: 'none', padding: 0, position: 'relative', cursor: 'pointer', font: 'inherit', background: on ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))' : 'var(--dsw-alias-border-l2,#d1d5db)' },
    onClick,
  }, h('span', { style: { position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff' } }));
  // 卡片内主内容：二维码 + 地址 + 提示
  const qrArea = (src, url, hint) => h('div', { style: { background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 10, padding: '10px 12px', textAlign: 'center', margin: '10px 0' } },
    h('img', { src, alt: 'QR', style: styles.qr }),
    h('div', { style: styles.code }, url),
    h('div', { style: styles.muted }, hint));
  // 设置行：上分隔线，内部第一行 = 左标签 + 右操作；extra 作为第二段渲染
  const row = (label, control, extra) => h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 9, marginTop: 9 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('span', { style: { fontSize: 13 } }, label), control), extra ?? null);
  // 高级（手动选地址）展开态
  const [advOpen, setAdvOpen] = useState(false);
  // 界面布局三态（issue #74 + 本次 P0）。存储值即用户的选择：'' = 自动。
  // 注意 pickLayout **不**自动刷新：这里可能是桌面端设置页（宽屏），刷新代价大；
  // 手机上的即时逃生舱是常驻布局徽章（选完立刻 reload）。这里给「刷新页面」按钮。
  const [layoutChoice, setLayoutChoice] = useState(() => readStoredLayout());
  const [layoutDirty, setLayoutDirty] = useState(false);
  // 视口窄于官方 SIDEBAR_AUTO_COLLAPSE 那条线（PHONE_STUCK_VIEWPORT = 1024）时，
  // 选「电脑」要先过二次确认：用户的手机是普通直板机（不是折叠屏/Pad），
  // 横屏 innerWidth 也有 740-900，误点一次就把会话详情挤窄、抽屉也拿不到了。
  // 确认后 writeLayout 会写 dsh-pocket.layout.user，auto-heal 之后就不再挡他。
  const [layoutConfirm, setLayoutConfirm] = useState(false);
  const commitLayout = (value) => {
    // writeLayout：落 localStorage（'' = 删键）+ 把 body marker 同步成实际生效值，
    // 于是本次会话的 CSS 前缀就先对上了，剩下的（挂载哪些组件）要刷新才到位。
    writeLayout(value);
    // 地址上若挂着 ?dsh-layout=…（二维码 / 书签链接），一并清掉：URL 优先级高于
    // localStorage，不清的话下次进来又被压回原布局。
    const cleaned = stripLayoutParamFromHref(location.href);
    if (cleaned !== location.href) {
      try { history.replaceState(history.state, '', cleaned); } catch { /* 沙箱/跨源限制 → 只依赖 storage */ }
    }
    setLayoutChoice(value);
    setLayoutDirty(true);
    setLayoutConfirm(false);
    showToast(t('layoutSaved'));
  };
  const pickLayout = (value) => {
    if (value === layoutChoice) {
      setLayoutDirty(false);
      setLayoutConfirm(false);
      return;
    }
    if (value === 'desktop' && needsNarrowDesktopConfirm(window.innerWidth)) {
      setLayoutConfirm(true);
      return;
    }
    commitLayout(value);
  };

  return h('div', { style: styles.card },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('div', null,
        h('strong', null, t('title')),
        h('div', { style: styles.muted }, t('subtitle')),
      ),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', textAlign: 'right' } },
        h('div', { style: { whiteSpace: 'nowrap' } }, t('developer')),
        h('div', { style: { whiteSpace: 'nowrap' } }, t('starAsk')),
        h('a', { href: 'https://github.com/shaobeichen/dsh-pocket', target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary,#4f6ef7)', fontSize: 12, lineHeight: 1.6, textDecoration: 'underline' } },
          t('starCta')),
      ),
    ),

    // 桌面端不显示更新/重启横幅（更新由 DSH Desktop 管理），也不需要额外提示

    // 重启后提示（进程在后台运行，停止方法）——左侧蓝色色条（桌面端不会触发本插件的自重启）
    !isDesktop && restartNotice ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-brand-primary,#4f6ef7)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } }, t('restarted')),
        h('button', { style: styles.btn, onClick: () => setRestartNotice(false) }, t('ok')),
      ),
      h('div', { style: styles.muted, marginTop: 4, wordBreak: 'break-all' }, fmt(t, 'bgHint', { cmd: status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9` })),
    ) : null,

    // 更新提示——左侧黄色色条（提示有新版本）；单状态：有更新/更新中/已更新自动重启，不并存
    // 桌面端不渲染（更新由 DSH Desktop 管理）
    !isDesktop && updateInfo ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } },
          updateInfo.updated
            ? fmt(t, 'updatedRestart', { ver: updateInfo.current })
            : updateInfo.result === 'ok'
              ? (updateInfo.autoRestart ? fmt(t, 'updateAutoRestarting', { ver: updateInfo.latest }) : fmt(t, 'updatedOk', { ver: updateInfo.latest }))
              : fmt(t, 'updateAvailable', { ver: updateInfo.latest })),
        updateInfo.result !== 'ok'
          ? h('button', { style: styles.primary, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? t('updating') : fmt(t, 'updateTo', { ver: updateInfo.latest }))
          : updateInfo.autoRestart
            ? h('button', { style: styles.btn, disabled: true }, t('restartingNow'))
            : h('button', { style: styles.primary, onClick: restartPocket, disabled: updateInfo.restarting }, updateInfo.restarting ? t('restarting') : t('restartNow')),
      ),
      h('div', { style: styles.muted, marginTop: 4 },
        updateInfo.updating
          ? fmt(t, 'updatingDetail', { s: elapsed(updateInfo.startedAt) })
        : updateInfo.restarting
          ? fmt(t, 'restartingDetail', { s: elapsed(updateInfo.startedAt) })
        : updateInfo.result === 'ok'
          ? (updateInfo.autoRestart ? t('updatedAutoDetail')
            : t('updatedRestartDetail'))
        : updateInfo.result === 'fail' ? fmt(t, 'updateFailed', { err: errText(updateInfo.output) || t('unknownError') })
        : fmt(t, 'versionRange', { cur: updateInfo.current, latest: updateInfo.latest })),
    ) : null,

    // 局域网：标题行自带总开关 → 二维码+地址 → 设置行（访问密码 / 高级·手动选地址）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('lanAccess')),
        Switch(status?.lanEnabled !== false, () => requestLanToggle(status?.lanEnabled === false)),
      ),
      status?.lanEnabled === false
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } }, t('lanDisabledHint'))
        : (lanUrl
          ? h('div', null,
            qrArea(status.lanQr, lanUrl, t('lanHint')),
            // 访问密码行：开关 + 值（关闭时提示直连）
            row(t('lanPin'), Switch(status?.lanAuthEnabled !== false, () => setLanAuth(status?.lanAuthEnabled === false)),
              status?.lanAuthEnabled === false
                ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('lanPinOff'))
                : (customPin?.which === 'lan'
                  ? customPinRow('lan')
                  : h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.lanToken),
                    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: refreshLanPin }, t('refresh')),
                    customBtn('lan'),
                    status?.lanPinCustom ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)' } }, t('pinCustomHint')) : null,
                  ))),
            // 高级：手动选地址（默认收起）
            row(t('advAddress'),
              h('button', { style: { border: 'none', background: 'none', font: 'inherit', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', padding: 0 }, onClick: () => setAdvOpen((v) => !v) },
                (status?.lanIpOverride || t('lanAddressAuto')) + ' ›'),
              advOpen ? h('div', { style: { marginTop: 8 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
                  t('lanAddress'),
                  h('select', {
                    value: status?.lanIpOverride || '',
                    onChange: (e) => setLanAddress(e.target.value),
                    style: { font: 'inherit', height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
                  },
                  h('option', { value: '' }, t('lanAddressAuto')),
                  (status?.lanCandidates || []).map((ip) => h('option', { key: ip, value: ip }, ip)),
                  ),
                ),
              ) : null),
          )
          : h('div', { style: styles.muted }, t('lanStarting'))),
    ),

    // 公网：标题行自带 开启/关闭 → 开启后：二维码+地址、地址模式行、访问密码行
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('wanAccess')),
        tunnelUrl
          ? h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: stopTunnel }, t('stopTunnel'))
          : h('button', { style: { ...styles.primary, height: 28, padding: '0 14px', fontSize: 12 }, onClick: startTunnel, disabled: busy || tunnelStarting }, busy || tunnelStarting ? t('opening') : t('enable')),
      ),
      tunnelStarting
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
          tunnelPhase === 'downloading'
            ? fmt(t, 'downloading', { s: elapsed(tunnelStateStarted) })
            : fmt(t, 'connecting', { s: elapsed(tunnelStateStarted), suffix: elapsed(tunnelStateStarted) > 30 ? t('slowHint') : '' }))
        : tunnelPhase === 'error'
          ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } },
            fmt(t, 'error', { detail: errText(tunnelStateDetail) || t('unknownError') }))
          : (!tunnelUrl && !isDesktop ? h('div', { style: { ...styles.muted, marginTop: 8 } }, t('wanOffHint')) : null),
      tunnelUrl
        ? h('div', null,
          qrArea(status.tunnelQr, tunnelUrl, namedMode ? t('namedRunningHint') : t('wanHint')),
          // 防钓鱼 / 别收藏（issue #82）：公网链接仅本次有效、勿收藏提示
          h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 8, padding: '8px 10px' } }, t('wanEphemeralWarn')),
          // 地址模式行（随机/固定；固定域名选中或编辑时高亮）
          row(t('modeLabel'),
            h('span', { style: { display: 'inline-flex', gap: 6 } },
              h('button', { style: modeBtnStyle(!namedActive), onClick: namedMode ? switchToQuick : (tunnelCfg ? () => setTunnelCfg(null) : undefined) }, t('modeQuick')),
              h('button', { style: modeBtnStyle(namedActive), onClick: () => setTunnelCfg(tunnelCfg ? null : { hostname: tunnelModeView.hostname ?? '', token: '', err: null }) }, t('modeNamed')),
            ),
            h('div', { style: { marginTop: 6 } },
              // 刚保存固定域名但当前连接仍是随机域名：需关闭后重新开启才生效
              namedMode && /trycloudflare\.com/i.test(tunnelUrl ?? '') ? h('div', { style: { ...styles.warn } }, t('namedTakeEffect')) : null,
              // 固定域名：已保存摘要 + 修改入口（非编辑态）
              namedMode && !tunnelCfg ? h('div', { style: { ...styles.muted } },
                fmt(t, 'namedSummary', { host: tunnelModeView.hostname || '—', token: tunnelModeView.tokenSet ? t('namedTokenSet') : t('namedTokenMissing') }),
                h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setTunnelCfg({ hostname: tunnelModeView.hostname ?? '', token: '', err: null }) }, t('namedEdit')),
                h('div', { style: { ...styles.muted, marginTop: 4 } }, t('namedHow')),
                !tunnelModeView.tokenSet || !tunnelModeView.hostname ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('namedNeedCfg')) : null,
              ) : null,
              // 固定域名：编辑表单（域名 + Tunnel Token，Token 留空保持不变）
              tunnelCfg ? h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.6 } },
                h('div', null,
                  t('namedHostnameLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 200 },
                    placeholder: 'pocket.example.com',
                    value: tunnelCfg.hostname ?? '',
                    autoFocus: true,
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, hostname: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6 } },
                  t('namedTokenLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 240, fontFamily: 'ui-monospace,Menlo,monospace' },
                    type: 'password',
                    value: tunnelCfg.token ?? '',
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, token: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6, display: 'flex', gap: 8 } },
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: saveNamedTunnel }, t('save')),
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setTunnelCfg(null) }, t('cancel')),
                ),
                h('div', { style: { ...styles.muted, marginTop: 6 } }, t('namedHow')),
                h('div', { style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } }, t('namedSecurity')),
                tunnelCfg.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(tunnelCfg.err)) : null,
              ) : null,
            ),
          ),
          // 访问密码行：值 + 自定义（自定义输入态整体替换）
          status.accessToken
            ? row(t('pinLabel'),
              customPin?.which === 'public'
                ? null
                : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                  h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.accessToken),
                  customBtn('public')),
              h('div', { style: { marginTop: 6 } },
                customPin?.which === 'public' ? customPinRow('public') : null,
                status?.publicPinCustom ? h('div', { style: { ...styles.warn } }, t('pinCustomHint')) : null,
                namedMode ? h('div', { style: { ...styles.warn } }, t('namedSecurity')) : null))
            : null,
        )
        : null,
    ),

    // 固定公网地址（SSH 反向隧道）：地址固定、随 DSH 启动自动上线、不弹命令行窗口
    fixed ? h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('fixedAddrTitle')),
        fixed.configured ? Switch(fixed.enabled === true, toggleFixedTunnel) : null,
      ),
      !fixed.configured
        ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('fixedAddrNotConfigured'))
        : h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: fixedDotColor(fixed) } }),
              h('span', { style: { fontSize: 12, color: fixedOnline ? 'var(--dsw-alias-state-success-primary,#15803d)' : 'var(--dsw-alias-label-secondary,#6b7280)' } },
                fixedStatusLabel(fixed))),
            fixed.enabled ? h('button', { style: styles.btn, onClick: reconnectFixedTunnel, disabled: busy }, t('fixedAddrReconnect')) : null,
          ),
          fixed.url ? h('div', { style: { ...styles.code, marginTop: 6, wordBreak: 'break-all' } }, fixed.url) : null,
          h('div', { style: { ...styles.muted, marginTop: 4, wordBreak: 'break-all' } }, fixedDetail(fixed)),
          fixed.enabled && fixed.lastError && !fixedOnline
            ? h('div', { style: { ...styles.warn, marginTop: 4, wordBreak: 'break-all' } }, errText(fixed.lastError))
            : null,
          h('div', { style: { ...styles.muted, marginTop: 6 } }, t('fixedAddrHint')),
        ),
    ) : null,

    error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, marginTop: 8 } }, `❌ ${errText(error)}`) : null,

    // 界面布局三态（issue #74 + 本次 P0）：自动 / 抽屉 / 电脑。
    // 这个控件是"手机上被残留的 desktop 值卡死"的第二道逃生舱（第一道是
    // layout-mode.mjs 的 auto-heal，第三道是右下角常驻布局徽章）。
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('layoutSection')),
        h('div', { style: { display: 'inline-flex', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 999, overflow: 'hidden' } },
          LAYOUT_OPTIONS.map((option) => h('button', {
            key: option.value === '' ? 'auto' : option.value,
            type: 'button',
            'aria-pressed': layoutChoice === option.value,
            onClick: () => pickLayout(option.value),
            style: { ...modeBtnStyle(layoutChoice === option.value), border: 'none', borderRadius: 0 },
          }, t(option.key))),
        ),
      ),
      // 窄于 1024（官方 SIDEBAR_AUTO_COLLAPSE 那条线）时选「电脑」要先就地二次确认。
      // 不用 window.confirm：手机 WebView 里阻塞、样式不可控，还容易被内置浏览器吞掉。
      layoutConfirm ? h('div', { style: { ...styles.warn, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('span', null, fmt(t, 'layoutNarrowConfirm', { width: String(PHONE_STUCK_VIEWPORT) })),
        h('button', { style: { ...styles.primary, height: 28, padding: '0 12px', fontSize: 12 }, onClick: () => commitLayout('desktop') }, t('layoutNarrowConfirmOk')),
        h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12 }, onClick: () => setLayoutConfirm(false) }, t('layoutNarrowConfirmCancel')),
      ) : null,
      h('div', { style: { ...styles.muted, marginTop: 6 } }, t('layoutHint')),
      h('div', { style: { ...styles.muted, marginTop: 4 } }, fmt(t, 'layoutEffective', { mode: t(APPLIED_LAYOUT_KEYS[readAppliedLayout()] ?? 'layoutAuto') })),
      layoutChoice === 'desktop' ? h('div', { style: { ...styles.warn, marginTop: 4 } }, t('layoutDesktopWarn')) : null,
      // 布局是启动期决议（哪些组件挂不挂在加载时就定了），所以必须刷新才完全生效。
      layoutDirty ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h('span', { style: styles.warn }, t('layoutReloadHint')),
        h('button', { style: { ...styles.primary, height: 28, padding: '0 12px', fontSize: 12 }, onClick: () => { try { location.reload(); } catch { /* 忽略 */ } } }, t('layoutReload')),
      ) : null,
    ),

    // 恢复出厂设置：设置出问题时的临时兜底（最底部，避免误触）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('resetFactory')),
        h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: () => setResetOpen(true) }, t('resetGo')),
      ),
      h('div', { style: { ...styles.muted, marginTop: 6 } }, t('resetIntro')),
    ),

    // 恢复出厂设置确认弹框
    resetOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 440, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t('resetTitle')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)', whiteSpace: 'pre-line' } }, t('resetBody')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setResetOpen(false) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1, background: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: doFactoryReset }, t('resetConfirm')),
        ),
      ),
    ) : null,

    // Toast：重置等操作的即时反馈（固定屏幕正中央，2.6s 自动消失）
    toast ? h('div', {
      style: { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 10001, width: 'auto', maxWidth: 280, background: 'rgba(17,24,39,.92)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, lineHeight: 1.5, textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.22)' },
    }, toast) : null,

    // 局域网访问开关确认弹框（关闭/打开时弹窗提醒）
    lanToggleOpen !== null ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: lanToggleOpen ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t(lanToggleOpen ? 'lanToggleTitleOn' : 'lanToggleTitleOff')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t(lanToggleOpen ? 'lanToggleBodyOn' : 'lanToggleBodyOff')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setLanToggleOpen(null) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1 }, onClick: confirmLanToggle }, t('confirm')),
        ),
      ),
    ) : null,

    // 安全免责声明弹框（issue #31）：每次开启公网访问前确认
    disclaimerOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t('disclaimerTitle')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t('disclaimerBody')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: disclaimerChecked, onChange: (e) => setDisclaimerChecked(e.target.checked), style: { width: 16, height: 16 } }),
          t('disclaimerAgree'),
        ),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setDisclaimerOpen(false) }, t('cancel')),
          h('button', {
            style: { ...styles.primary, flex: 1, opacity: disclaimerChecked ? 1 : .5 },
            disabled: !disclaimerChecked,
            onClick: confirmDisclaimer,
          }, t('disclaimerAgree')),
        ),
        !disclaimerChecked ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('disclaimerHint')) : null,
      ),
    ) : null,

    // 页面最底部：反馈入口
    h('div', { style: { ...styles.block, textAlign: 'center' } },
      h('a', { href: 'https://github.com/shaobeichen/dsh-pocket/issues', target: '_blank', rel: 'noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', textDecoration: 'none' } },
        t('feedback')),
    ),
  );
}

export function apply(ctx) {
  // 诊断信标（client/orb/diag.ts）：记录启动次数/标题/悬浮球开关，批量发到
  // 宿主的 /.dsh-pocket/diag。必须在最前面装——启动账本要赶在宿主
  // restoreSelection 之前读、必要时擦掉 dsh.sessions.current。
  installDiag(ctx);

  // 兜底：确保 connection.isLoopback 为 true（issue #58）。
  // 注：代理注入的 loopback 补丁（proxy.mjs LOOPBACK_ENV_PATCH）已在 #105 移除——
  // 它与 DSH Desktop 2.0.4+ 客户端运行时不兼容，会令 BootHandoff 阶段白屏。
  // #58「远程浏览器开设置页」需上游提供官方信任来源机制才能正经解决；此处仅保留兜底。
  if (ctx?.connection) {
    try {
      Object.defineProperty(ctx.connection, 'isLoopback', { value: true, writable: true, configurable: true });
    } catch {
      try { ctx.connection.isLoopback = true; } catch { /* 忽略 */ }
    }
  }

  // 设置页签接入 DSH 本地化：注册 pocket 词典（zh/en），并绑定一个随当前 locale 切换的 t()。
  // 必须排在 mobileApply 之前：手机上的常驻布局徽章与 auto-heal 提示用的也是 pocket
  // 文案，而徽章在 mobileApply 里就注册进 shell.overlay 了 —— 词典晚注册会先闪一下 key。
  const translate = ctx.locale.bind(POCKET_NS);
  ctx.effect(() => ctx.locale.register(POCKET_NS, { zh: POCKET_ZH, en: POCKET_EN }), 'dsh-pocket: pocket locale dictionaries');

  // 移动端适配（dsh-web-mobile 移植）：抽屉布局/触控/安全区，仅窄屏生效
  mobileApply(ctx);

  // 悬浮球（手机端快捷任务页）：依赖 sessions / remote / uiWorkspace 等由其他
  // 插件提供的服务——用 ctx.inject 等它们到齐再装，不进静态 inject 名单，
  // 这样旧宿主缺服务时只缺悬浮球功能，设置页/移动端适配不受影响。
  ctx.inject(['sessions', 'remote', 'remote.commands', 'remote.session', 'remote.skills', 'uiWorkspace'], (orbCtx) => {
    orbApply(orbCtx);
  });

  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);

  // 设置入口统一收进 dsh-assistant 的「个人助手」页；这里不再单独注册「手机访问」页签。
}

export { name, inject, redactStatus };
