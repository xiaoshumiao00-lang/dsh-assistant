// 固定公网地址：SSH 反向隧道守护（Windows 本机 → 云服务器 7080 → 本机代理端口）
//
// 为什么放在插件里（2026-10-18）：
//   - 以前靠「计划任务 + tunnel.cmd 循环」维持：任务本身看不见窗口，但 ssh 半死
//     （TCP 断了、进程还在）时循环不重启，公网地址就永久 502；手动重开又会多开一个
//     黑窗口，用户明确不要。
//   - 放到插件里：DSH 启动 → 代理就绪 → 这里自动拉起 ssh（windowsHide，零窗口）；
//     DSH 退出 → 一起停掉。断线/半死由探活发现后自动重连，不需要任何人工操作。
//
// 安全边界：公网入口仍然要 8 位 PIN（由 proxy.mjs 校验），这里只负责把端口接出去。
//
// 设计要点：
//   - 先探活再 spawn：如果已有隧道（手动开的、上次没退干净的）健康，就直接「收养」，
//     避免重复 -R 绑定 7080 导致 ExitOnForwardFailure 死循环；
//   - 两连败才重启：偶发网络抖动不打断正在用的连接；
//   - 退避 3s→6s→…→60s，成功探活后归零，避免网络断了以后疯狂重连。
//
// 2026-10-20 事故复盘（手机整天连不上，状态一直是「连接中… / ssh exited (code=255)」）：
//   真凶不在本机，而在**远端**：服务器上挂着一个 13 小时前的旧 sshd-session，仍占着
//   0.0.0.0:7080。新隧道因此报
//     Error: remote port forwarding failed for listen port 7080
//   并且因为 -o ExitOnForwardFailure=yes 直接 255 退出。本机既有的 killStaleTunnels()
//   只杀本机残留 ssh，够不着远端 → 每一轮重连都撞同一面墙；加上若干条「失败后不再排
//   重连」的路径，重试链最终断掉，本机连一个 ssh 尝试进程都看不到。本次修复：
//   1) 识别 255 + forward failure → 一次性 ssh 命令诊断远端占用者 → 安全校验后清理 → 立即重试；
//   2) enabled=true 时任何失败都必须 scheduleRetry（异常兜底、缺私钥也重试）；
//   3) state 里带 reason / attempts / cleanups / lastStderr，设置页能显示人话；
//   4) 收养外部健康隧道时把它的本机 pid 也记进状态，避免「插件说没连上、机器上却有进程」。

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';

const POWERSHELL = process.platform === 'win32'
  ? (existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    : 'powershell.exe')
  : '';

/** 一次 ssh 会话最多保留多少 stderr 文本用于诊断（再多也只留尾部）。 */
const STDERR_LIMIT = 4_000;
/** 远端端口被旧隧道占用时，连续自动清理的上限（超过就只报错、不再动手，避免误杀循环）。 */
export const MAX_AUTO_CLEANUPS = 3;
/** 单次清理最多允许 kill 的进程数：超过说明识别结果可疑，宁可报错不动手。 */
const MAX_KILL_TARGETS = 6;

/**
 * 本机残留 ssh 隧道进程查找（不杀）。
 * 匹配条件同时包含 `-R 0.0.0.0:<remotePort>:127.0.0.1:` 与 `@<host>`，只可能命中
 * 同一条隧道，不会误伤用户其它 ssh 会话。
 */
export function findTunnelProcesses(cfg, { execFn = execFile } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Write-Output $_.ProcessId }`;
        execFn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
          { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
            resolve(String(stdout ?? '').split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
          });
      } else {
        execFn('pgrep', ['-f', `${needle}`], { timeout: 10_000 }, (err, stdout) => {
          resolve(err ? [] : String(stdout ?? '').split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
        });
      }
    } catch {
      resolve([]);
    }
  });
}

/**
 * 清理「本机」残留的 ssh 隧道进程（探活失败、准备自己拉起时调用）。
 *
 * 为什么需要：DSH 重启后本机代理端口若发生变化，旧隧道（或过渡期维护进程拉起的
 * ssh）仍然占着 VPS 的 7080，新 ssh 会因 ExitOnForwardFailure 立即退出 → 永远起不来。
 * 注意：这里只治本机；远端残留（上个会话留下的 sshd-session）由 reclaimRemotePort() 处理。
 */
export function killStaleTunnels(cfg, { onKill, execFn = execFile } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`;
        execFn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
          { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
            const killed = String(stdout ?? '').split(/\s+/).filter(Boolean);
            if (killed.length) onKill?.(killed);
            resolve(killed);
          });
      } else {
        execFile('pkill', ['-f', `${needle}.*${target}`], { windowsHide: true, timeout: 10_000 },
          (err) => { if (!err) onKill?.(['pkill']); resolve(err ? [] : ['pkill']); });
      }
    } catch {
      resolve([]);
    }
  });
}

/** 默认值：与本机既有部署一致（腾讯云 49.234.20.84:7080 → 127.0.0.1:3081）。 */
export const SSH_TUNNEL_DEFAULTS = Object.freeze({
  enabled: false,
  host: '',
  port: 22,
  user: 'root',
  remotePort: 7080,
  keyPath: '',
  /** 0 = 跟随插件代理实际端口（推荐）；>0 用于手工指到别的本地端口 */
  localPort: 0,
});

function toPort(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

/** 宽松归一化：坏值一律回退默认，不抛错（设置页/手写 settings.json 都可能写歪）。 */
export function normalizeSshTunnelConfig(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: v.enabled === true,
    host: String(v.host ?? '').trim(),
    port: toPort(v.port, SSH_TUNNEL_DEFAULTS.port),
    user: String(v.user ?? SSH_TUNNEL_DEFAULTS.user).trim() || SSH_TUNNEL_DEFAULTS.user,
    remotePort: toPort(v.remotePort, SSH_TUNNEL_DEFAULTS.remotePort),
    keyPath: String(v.keyPath ?? '').trim(),
    localPort: Number.isInteger(Number(v.localPort)) && Number(v.localPort) > 0 ? Number(v.localPort) : 0,
  };
}

/** 是否具备启动条件（主机 + 私钥）。 */
export function sshTunnelConfigured(cfg) {
  return Boolean(cfg && cfg.host && cfg.keyPath);
}

/** Windows 上 ssh.exe 不在 PATH 时用系统自带绝对路径。 */
function sshBinary() {
  if (process.platform === 'win32') {
    const p = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
    if (existsSync(p)) return p;
  }
  return 'ssh';
}

function knownHostsNull() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/** 子进程环境：禁掉任何交互式口令提示（BatchMode 之外的双保险）。 */
function childEnv() {
  return { ...process.env, SSH_ASKPASS: '', DISPLAY: '' };
}

/** 拼 ssh 参数（导出便于测试断言）。 */
export function buildSshArgs(cfg, localPort) {
  const args = [
    '-N',
    '-R', `0.0.0.0:${cfg.remotePort}:127.0.0.1:${localPort}`,
    '-i', cfg.keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHostsNull()}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    // ERROR 级别仍会打印 `Error: remote port forwarding failed for listen port N`
    // （2026-10-20 实测），足够分类，又不至于把 stderr 灌满。
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
  ];
  if (cfg.port && cfg.port !== 22) args.push('-p', String(cfg.port));
  args.push(`${cfg.user}@${cfg.host}`);
  return args;
}

/** 一次性远端命令（诊断/清理）用的 ssh 参数：不带转发、不开 tty。 */
export function buildRemoteCmdArgs(cfg) {
  const args = [
    '-T',
    '-i', cfg.keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHostsNull()}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
  ];
  if (cfg.port && cfg.port !== 22) args.push('-p', String(cfg.port));
  args.push(`${cfg.user}@${cfg.host}`);
  return args;
}

/** 把多行错误压成一行短文本（去掉控制字符，只留最后几行）。 */
function oneLine(s, limit = 320) {
  const lines = String(s ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((x) => x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .filter(Boolean);
  return lines.slice(-3).join(' / ').slice(0, limit);
}

/**
 * ssh 失败原因分类（顺序即优先级）。
 * reason: port_occupied | auth | hostkey | dns | network | unknown
 */
const FAILURE_PATTERNS = Object.freeze([
  ['port_occupied', /remote port forwarding failed|remote forward failure|port forwarding failed|could not request remote|address already in use/i],
  ['auth', /permission denied|too many authentication|no supported authentication|no matching (?:key|host key|public key)|invalid format|unprotected private key|bad permissions|load private key|no such identity|not allowed because/i],
  ['hostkey', /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|man-in-the-middle/i],
  ['dns', /could not resolve hostname|name or service not known|temporary failure in name resolution/i],
  ['network', /ssh: connect to host|connection timed out|connection refused|no route to host|network is unreachable|connection reset by peer|connection closed by remote host|kex_exchange_identification|server unexpectedly closed|timeout, server not responding|broken pipe|packet write/i],
]);

export function classifySshFailure(stderr, code = null) {
  const s = String(stderr ?? '');
  for (const [reason, re] of FAILURE_PATTERNS) {
    const m = s.match(re);
    if (m) return { reason, detail: oneLine(m[0], 120), code };
  }
  return { reason: s ? 'unknown' : 'unknown', detail: '', code };
}

/**
 * 探活 HTTP 失败的分类：
 *   no_listener       → 远端 7080 上没人监听（不必去远端清理，直接 spawn）
 *   stale_or_halfopen → 有人监听但转不到可用后端（典型：远端旧 sshd-session 占坑）
 *   network           → 到 VPS 的路由都不通（清理也没意义）
 */
export function classifyProbeFailure(message) {
  const s = String(message ?? '');
  if (/ECONNREFUSED/i.test(s)) return 'no_listener';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|probe timeout|timed out/i.test(s)) {
    return /probe timeout|socket hang up|ECONNRESET|EPIPE/i.test(s) ? 'stale_or_halfopen' : 'network';
  }
  return 'unknown';
}

// ---------- 远端端口占用：诊断与自动清理 ----------

const DIAG_MARKS = Object.freeze({
  tools: '@@DSHPOCKET_TOOLS@@',
  holders: '@@DSHPOCKET_HOLDERS@@',
  sshd: '@@DSHPOCKET_SSHD@@',
  tree: '@@DSHPOCKET_TREE@@',
  end: '@@DSHPOCKET_END@@',
});
const DIAG_ORDER = [DIAG_MARKS.tools, DIAG_MARKS.holders, DIAG_MARKS.sshd, DIAG_MARKS.tree, DIAG_MARKS.end];

/** awk 只比对「Local Address:Port」列，精确到端口尾（:70800 不会误命中 :7080）。 */
function awkPortFilter(port) {
  return `awk '$4 ~ /:${port}$/'`;
}

/** 一次 ssh 往返拿齐：工具是否存在、谁占着 remotePort、SSH 端口监听者、sshd 进程树。 */
export function remoteDiagnoseCommand(cfg) {
  const p = Number(cfg.remotePort);
  const s = Number(cfg.port) || 22;
  return [
    `echo ${DIAG_MARKS.tools}`,
    'command -v ss; command -v awk; command -v ps',
    `echo ${DIAG_MARKS.holders}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(p)}`,
    `echo ${DIAG_MARKS.sshd}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(s)}`,
    `echo ${DIAG_MARKS.tree}`,
    'ps -o pid=,ppid=,comm= -C sshd,sshd-session 2>/dev/null',
    `echo ${DIAG_MARKS.end}`,
  ].join('; ');
}

/** 校验远端输出：分隔标记必须齐全且按序，否则视为输出异常（不据此 kill）。 */
export function parseRemoteDiagnosis(stdout) {
  const text = String(stdout ?? '').replace(/\r/g, '');
  const pos = [];
  for (const mark of DIAG_ORDER) {
    const i = text.indexOf(mark);
    if (i < 0) return { ok: false, error: '远端诊断输出不完整（ssh 未建立或输出被改写），已放弃自动清理 | remote diagnosis incomplete' };
    pos.push(i);
  }
  for (let i = 1; i < pos.length; i += 1) {
    if (pos[i] <= pos[i - 1]) return { ok: false, error: '远端诊断输出顺序异常，已放弃自动清理 | remote diagnosis out of order' };
  }
  const section = (mark) => {
    const idx = DIAG_ORDER.indexOf(mark);
    const start = pos[idx] + mark.length;
    const end = idx + 1 < DIAG_ORDER.length ? pos[idx + 1] : text.length;
    return text.slice(start, end).split('\n').map((l) => l.trim()).filter(Boolean);
  };
  const tools = section(DIAG_MARKS.tools);
  const has = (name) => tools.some((t) => new RegExp(`(^|/)${name}$`).test(t));
  if (!has('ss') || !has('awk') || !has('ps')) {
    return { ok: false, error: `远端缺少 ss/awk/ps，无法确认端口占用者身份，已放弃自动清理 | remote lacks ss/awk/ps: ${tools.join(',') || '(empty)'}` };
  }
  return { ok: true, tools, holders: section(DIAG_MARKS.holders), sshdListeners: section(DIAG_MARKS.sshd), tree: section(DIAG_MARKS.tree) };
}

/** `users:(("sshd-session",pid=861352,fd=12))` → [{name, pid}]；同时给出本地地址列。 */
function parseSsLine(line) {
  const cols = line.split(/\s+/);
  const owners = [];
  const usersMatch = line.match(/users:\((.+)\)\s*$/);
  const body = usersMatch ? usersMatch[1] : '';
  const quoted = /"([^"]*)",\s*pid=(\d+)/g;
  let m;
  while ((m = quoted.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  if (!owners.length) {
    const plain = /([A-Za-z0-9_@:.[\]+%/ -]+),\s*pid=(\d+)/g;
    while ((m = plain.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  }
  return { state: cols[0] ?? '', addr: cols[3] ?? '', owners, raw: line.slice(0, 200) };
}

function parsePsLine(line) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] };
}

/**
 * 依据诊断结果算出「允许清理」的 pid 集合。安全边界：
 *   - remotePort 等于 SSH 服务端口 → 直接拒绝；
 *   - 每一行占用记录都必须解析得出进程名，且名字必须以 sshd 开头（sshd / sshd-session）；
 *     名字对不上（frps、nginx、别的服务）→ 拒绝清理，只报错；
 *   - 看不到 users:(...) 归属（权限不足、内核 socket）→ 拒绝；
 *   - pid<=1、或该 pid 同时是 SSH 端口的监听进程（就是 sshd 本体）→ 拒绝；
 *   - 只额外带上 [priv] 监视父进程：它必须也是 sshd*、不是 SSH 监听进程、
 *     且它的直接子进程全在本次清理集合里（否则可能牵连别人的会话）；
 *   - 目标数量超过 MAX_KILL_TARGETS → 拒绝。
 */
export function planRemoteKills(parsed, cfg) {
  const port = Number(cfg?.remotePort);
  const sshPort = Number(cfg?.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '远端端口配置非法，已放弃自动清理 | invalid remote port' };
  if (port === sshPort) return { ok: false, error: `远端端口就是 SSH 服务端口 :${sshPort}，拒绝清理 | refusing to touch the sshd service port` };
  if (!parsed || parsed.ok === false) return { ok: false, error: parsed?.error ?? '缺少诊断结果 | no diagnosis' };

  const holders = [];
  const seen = new Set();
  for (const raw of parsed.holders) {
    const line = parseSsLine(raw);
    if (!/^(LISTEN|UNQ)/i.test(line.state)) {
      return { ok: false, error: `端口 ${port} 的监听行无法解析，已放弃自动清理 | unparsable listener line: ${line.raw}`, };
    }
    if (!line.owners.length) {
      return { ok: false, error: `端口 ${port} 的占用者身份不可见（权限或内核 socket），已放弃自动清理 | cannot identify holder: ${line.raw}` };
    }
    for (const o of line.owners) {
      if (!/^sshd/i.test(o.name) || !Number.isInteger(o.pid)) {
        return { ok: false, error: `端口 ${port} 被非 sshd 进程占用（${o.name || '?'} pid=${o.pid}），拒绝清理 | port held by non-sshd process` };
      }
      if (!seen.has(o.pid)) { seen.add(o.pid); holders.push({ pid: o.pid, name: o.name, addr: line.addr }); }
    }
  }
  if (!holders.length) return { ok: true, holders: [], kill: [], note: `远端端口 ${port} 空闲，无需清理 | remote port free` };

  // SSH 服务端口的监听进程（含 sshd 本体）永远不碰。
  const protectedPids = new Set([1]);
  for (const raw of parsed.sshdListeners) for (const o of parseSsLine(raw).owners) if (Number.isInteger(o.pid)) protectedPids.add(o.pid);

  const tree = parsed.tree.map(parsePsLine).filter(Boolean);
  const byPid = new Map(tree.map((p) => [p.pid, p]));
  const childrenOf = new Map();
  for (const p of tree) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p.pid);
  }

  const kill = [];
  const killSet = new Set();
  const add = (entry) => { if (!killSet.has(entry.pid)) { killSet.add(entry.pid); kill.push(entry); } };

  for (const h of holders) {
    if (h.pid <= 1) return { ok: false, error: `占用进程 pid=${h.pid} 非法，已放弃自动清理 | refusing to touch pid ${h.pid}` };
    if (protectedPids.has(h.pid)) return { ok: false, error: `占用进程同时是 SSH(:${sshPort}) 监听进程，拒绝清理 | holder is also the sshd service listener` };
    add({ pid: h.pid, name: h.name, role: 'holder' });
    let cur = h.pid;
    for (let depth = 0; depth < 3; depth += 1) {
      const node = byPid.get(cur);
      if (!node) break;
      const parent = byPid.get(node.ppid);
      if (!parent || parent.pid <= 1) break;
      if (protectedPids.has(parent.pid)) break;
      if (!/^sshd/i.test(parent.comm)) break;
      const kids = childrenOf.get(parent.pid) ?? [];
      if (!kids.length || !kids.every((k) => killSet.has(k))) break; // 会牵连别人的会话 → 不带它
      add({ pid: parent.pid, name: parent.comm, role: 'priv-parent' });
      cur = parent.pid;
    }
  }
  if (kill.length > MAX_KILL_TARGETS) {
    return { ok: false, error: `清理目标过多（${kill.length} 个 pid），判定为异常，已放弃自动清理 | too many kill targets` };
  }
  return { ok: true, holders, kill };
}

/** 跑一条远端命令（一次性 ssh，无转发）。永不 reject，失败以对象返回。 */
export function runRemoteSsh(cfg, command, timeoutMs = 20_000, { execFn = execFile } = {}) {
  if (!sshTunnelConfigured(cfg)) return Promise.resolve({ ok: false, error: 'SSH 隧道未配置 | not configured', stdout: '', stderr: '' });
  return new Promise((resolve) => {
    let args;
    try { args = [...buildRemoteCmdArgs(cfg), command]; } catch (err) {
      resolve({ ok: false, error: oneLine(err?.message ?? err), stdout: '', stderr: '' });
      return;
    }
    try {
      execFn(sshBinary(), args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20, env: childEnv() },
        (err, stdout, stderr) => {
          const killed = Boolean(err && err.killed);
          resolve({
            ok: !err,
            killed,
            exitCode: err && Number.isInteger(err.code) ? err.code : (err ? 1 : 0),
            error: err ? (killed ? `timeout after ${timeoutMs}ms` : oneLine(err.message ?? err)) : '',
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            reason: err ? classifySshFailure(stderr).reason : '',
          });
        });
    } catch (err) {
      resolve({ ok: false, error: `ssh 执行失败: ${oneLine(err?.message ?? err)}`, stdout: '', stderr: '', killed: false, exitCode: 1, reason: 'unknown' });
    }
  });
}

/**
 * 远端端口被旧隧道占用 → 诊断 + 安全清理（TERM，必要时 KILL），并确认端口已释放。
 * 返回一条清理记录（不抛异常），调用方据此决定要不要继续 spawn。
 */
export async function reclaimRemotePort(cfg, {
  log = console,
  run = runRemoteSsh,
  // 注意：不能 unref——这是被 await 的清理间隔，unref 会让短命进程（维护脚本）在
  // 清理进行到一半时因为没有其它句柄而直接退出（2026-10-20 故障注入实测踩到）。
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  diagnoseCommand = remoteDiagnoseCommand,
  timeoutMs = 20_000,
} = {}) {
  const rec = { at: Date.now(), ok: false, holders: [], kill: [], killed: [], error: '', note: '', stage: 'diagnose' };
  const info = (...a) => (log.info ?? log.log)?.call(log, ...a);
  const warn = (...a) => log.warn?.(...a);
  if (!sshTunnelConfigured(cfg)) { rec.error = 'SSH 隧道未配置 | not configured'; return rec; }
  if (Number(cfg.remotePort) === (Number(cfg.port) || 22)) { rec.error = '远端端口即 SSH 服务端口，拒绝清理 | refusing ssh port'; return rec; }

  const diag = await run(cfg, diagnoseCommand(cfg), timeoutMs);
  rec.stage = 'diagnose';
  if (diag.killed) { rec.error = '远端诊断超时，已放弃自动清理 | diagnosis timed out'; return rec; }
  if (diag.error && !diag.stdout.trim()) {
    // 诊断用的这条 ssh 自己都没连上（认证/网络/瞬时抖动）：不猜、不动手，交给重试链下一轮。
    // 把 stderr 尾部一起放进记录，设置页能看到到底是哪种失败。
    const tail = oneLine(diag.stderr || diag.error, 200);
    rec.error = `远端诊断连接失败（${diag.reason || 'unknown'}）：${tail}`;
    return rec;
  }
  const parsed = parseRemoteDiagnosis(diag.stdout);
  if (!parsed.ok) { rec.error = parsed.error; return rec; }
  const plan = planRemoteKills(parsed, cfg);
  rec.holders = (plan.holders ?? []).map((h) => ({ pid: h.pid, name: h.name }));
  rec.kill = (plan.kill ?? []).map((k) => ({ pid: k.pid, name: k.name, role: k.role }));
  if (!plan.ok) { rec.error = plan.error; return rec; }
  if (!plan.kill.length) { rec.ok = true; rec.note = plan.note ?? '无需清理'; rec.stage = 'free'; return rec; }

  const pids = plan.kill.map((k) => k.pid).filter((p) => Number.isInteger(p) && p > 1);
  const pidArg = pids.join(' ');
  if (!pids.length || !/^\d+( \d+)*$/.test(pidArg)) { rec.error = '清理目标 pid 不合法，已放弃自动清理 | invalid pid list'; return rec; }

  warn(`dsh-pocket: remote port ${cfg.remotePort} held by ${rec.kill.map((k) => `${k.name}(pid=${k.pid})`).join(', ')} — cleaning up | 远端端口被旧隧道占用，自动清理`);
  rec.stage = 'term';
  await run(cfg, `kill ${pidArg}`, 15_000);
  rec.killed = pids;
  await sleep(1_500);
  let still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15_000);
  if (String(still.stdout ?? '').trim()) {
    rec.stage = 'kill';
    await run(cfg, `kill -KILL ${pidArg}`, 15_000);
    await sleep(1_200);
    still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15_000);
  }
  const free = !String(still.stdout ?? '').trim();
  rec.ok = free;
  rec.error = free ? '' : `清理后远端端口 ${cfg.remotePort} 仍被占用 | port still held`;
  if (free) info(`dsh-pocket: remote port ${cfg.remotePort} released (pid ${pidArg}) | 远端端口已释放`);
  return rec;
}

/** 默认值：连续自动清理上限（可由调用方覆盖，测试用小值）。 */
const DEFAULT_CLEANUP_LIMIT = MAX_AUTO_CLEANUPS;

/**
 * 创建 SSH 反向隧道守护。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig 读取最新配置（每次启动/探活都重读，改设置即可生效）
 * @param {() => number} [opts.getLocalPort] 插件代理实际端口（localPort=0 时用它）
 * @param {object} [opts.log] 日志（ctx.logger，需有 info/warn）
 * @param {number} [opts.probeIntervalMs] 探活间隔（默认 20s）
 * @param {number} [opts.probeTimeoutMs] 单次探活超时（默认 8s）
 * @param {number} [opts.startingGraceMs] spawn 后允许「尚未上线」的宽限期（超期强制回收）
 * @param {number} [opts.cleanupLimit] 连续自动清理远端占用的次数上限
 * @param {Function} [opts.spawnFn] 注入：建隧道
 * @param {Function} [opts.execFn] 注入：一次性命令
 * @param {Function} [opts.reclaim] 注入：远端端口清理（reclaimRemotePort 签名）
 * @param {Function} [opts.findProcesses] 注入：本机隧道进程查找（findTunnelProcesses 签名）
 */
export function createSshTunnel({
  getConfig,
  getLocalPort = () => 3081,
  log = console,
  probeIntervalMs = 20_000,
  probeTimeoutMs = 8_000,
  maxBackoffMs = 60_000,
  startingGraceMs = 45_000,
  cleanupLimit = DEFAULT_CLEANUP_LIMIT,
  spawnFn = spawn,
  execFn = execFile,
  reclaim = reclaimRemotePort,
  findProcesses = findTunnelProcesses,
} = {}) {
  const info = (...a) => (log.info ?? log.log).call(log, ...a);
  const warn = (...a) => log.warn.call(log, ...a);

  const state = {
    phase: 'off', // off | starting | online | retrying | error
    reason: '', // port_occupied | auth | hostkey | dns | network | key_missing | cleanup_limit | probe | spawn | unknown
    adopted: false, // 已有一份健康隧道，不是本进程拉起的
    adoptedExternal: false, // 收养的是外部（手动/维护进程）起的隧道
    adoptedPid: null, // 收养时看到的本机 ssh pid
    pid: null,
    restarts: 0,
    attempts: 0, // 连续重连轮次（上线归零）
    autoKills: 0, // 连续自动清理次数（上线归零）
    cleanups: [], // 自动清理记录（最近 8 条）
    lastError: '',
    lastErrorAt: null,
    lastStderr: '',
    lastProbeAt: null,
    lastProbeStatus: 0,
    nextRetryAt: null,
    spawnedAt: null,
    url: '',
  };

  let child = null;
  let stopped = true;
  let probeTimer = null;
  let retryTimer = null;
  let backoff = 3_000;
  let failures = 0;
  /** 我们主动杀掉的子进程：它们的 exit 不应再触发一次重连。 */
  const expectedExits = new WeakSet();
  /** in-flight start，避免并发调用重复 spawn */
  let starting = null;

  const currentConfig = () => normalizeSshTunnelConfig(typeof getConfig === 'function' ? getConfig() : getConfig);

  function currentLocalPort(cfg) {
    const p = cfg.localPort > 0 ? cfg.localPort : Number(getLocalPort());
    return toPort(p, 3081);
  }

  /** 公网地址（host + remotePort）。 */
  function urlOf(cfg) {
    return cfg.host ? `http://${cfg.host}:${cfg.remotePort}` : '';
  }

  function setFailed(reason, message) {
    state.reason = reason || 'unknown';
    state.lastError = oneLine(message, 400);
    state.lastErrorAt = Date.now();
  }

  function pushCleanup(rec) {
    state.cleanups = [rec, ...state.cleanups].slice(0, 8);
  }

  /** HTTP 探活：能拿到任意 HTTP 响应（含 401/302/503）就说明「公网 → VPS → 本机代理」整条链路通。 */
  function probeOnce(cfg) {
    return new Promise((resolve) => {
      try {
        const req = http.request(
          {
            host: cfg.host,
            port: cfg.remotePort,
            path: '/',
            method: 'GET',
            timeout: probeTimeoutMs,
            headers: { 'user-agent': 'dsh-pocket-tunnel-probe' },
          },
          (res) => {
            res.resume();
            state.lastProbeAt = Date.now();
            state.lastProbeStatus = res.statusCode ?? 0;
            resolve({ ok: true, status: res.statusCode ?? 0 });
          },
        );
        req.on('timeout', () => { req.destroy(new Error('probe timeout')); });
        req.on('error', (err) => {
          state.lastProbeAt = Date.now();
          state.lastProbeStatus = 0;
          resolve({ ok: false, error: err?.message ?? String(err) });
        });
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }

  function clearTimers() {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function ensureProbeTimer() {
    if (probeTimer || stopped) return;
    probeTimer = setInterval(() => { void checkOnceSafely(false); }, probeIntervalMs);
    if (probeTimer.unref) probeTimer.unref();
  }

  /** 唯一排重连的入口：任何失败都必须经过这里，退避封顶 maxBackoffMs。 */
  function scheduleRetry(cfg, why, { reason = null, delayMs = null } = {}) {
    if (stopped) return;
    setFailed(reason ?? state.reason, why ?? state.lastError);
    state.attempts += 1;
    state.phase = 'retrying';
    const delay = Number.isInteger(delayMs) ? Math.max(500, delayMs) : backoff;
    state.nextRetryAt = Date.now() + delay;
    info(`dsh-pocket: ssh tunnel down (${reason ?? state.reason}, attempt ${state.attempts}) — retry in ${Math.round(delay / 1000)}s | 固定公网隧道断开（${state.attempts} 次重试，${Math.round(delay / 1000)} 秒后重连）`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      void startSafely();
    }, delay);
    if (retryTimer.unref) retryTimer.unref();
    backoff = Math.min(maxBackoffMs, Math.round(backoff * 2));
  }

  function markOnline(cfg) {
    failures = 0;
    backoff = 3_000;
    state.attempts = 0;
    state.autoKills = 0;
    state.phase = 'online';
    state.reason = '';
    state.lastError = '';
    state.nextRetryAt = null;
    state.url = urlOf(cfg);
  }

  function killChild() {
    if (!child) return;
    const c = child;
    child = null;
    state.pid = null;
    expectedExits.add(c);
    try { c.kill(); } catch { /* 已退出 */ }
  }

  function spawnTunnel(cfg, localPort) {
    const args = buildSshArgs(cfg, localPort);
    info(`dsh-pocket: starting ssh reverse tunnel ${cfg.host}:${cfg.remotePort} -> 127.0.0.1:${localPort} | 启动固定公网隧道`);
    let c;
    try {
      // windowsHide：Electron/Node 宿主是 GUI 进程，控制台子进程默认会弹一个黑窗口；这里必须隐藏。
      // stderr 必须管道捕获：不拿到「remote port forwarding failed」就永远分不清
      // 「远端端口被占」和「网络断了」（2026-10-20 事故的关键教训）。
      c = spawnFn(sshBinary(), args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: childEnv(),
      });
    } catch (err) {
      setFailed('spawn', `spawn failed: ${err?.message ?? err}`);
      warn(`dsh-pocket: ssh spawn threw | 拉起 ssh 失败: ${state.lastError}`);
      scheduleRetry(cfg, state.lastError, { reason: 'spawn' });
      return;
    }
    child = c;
    state.pid = c.pid ?? null;
    state.spawnedAt = Date.now();
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.phase = 'starting';
    // 注意：这里**不清空** state.reason —— 从「远端端口被占用」走到「正在重连建链」时，
    // 设置页应继续显示「被远端旧隧道占用（正在自动清理）」，直到真正 online（markOnline 才清空）。
    let stderrTail = '';
    if (c.stderr) {
      try { c.stderr.setEncoding('utf8'); } catch { /* 忽略 */ }
      c.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-STDERR_LIMIT); });
      c.stderr.on('error', () => { /* 忽略 */ });
    }
    c.once('error', (err) => {
      if (child === c) { child = null; state.pid = null; }
      scheduleRetry(cfg, `spawn failed: ${err?.message ?? err}`, { reason: 'spawn' });
    });
    c.once('exit', (code, signal) => {
      if (child === c) { child = null; state.pid = null; }
      if (expectedExits.has(c)) { expectedExits.delete(c); return; } // 主动回收，不重复排重连
      if (stopped) return;
      const cls = classifySshFailure(stderrTail, code);
      state.lastStderr = oneLine(stderrTail, 300);
      setFailed(cls.reason, `ssh exited (code=${code}${signal ? `, signal=${signal}` : ''})${state.lastStderr ? `: ${state.lastStderr}` : ''}`);
      state.restarts += 1;
      if (cls.reason === 'port_occupied') {
        // 下一轮 start() 会先探活再清理远端占用，这里只把重连排得更快（不等退避涨上去）。
        warn('dsh-pocket: ssh refused to bind remote port — stale remote tunnel | 远端端口被旧隧道占用，准备自动清理');
        scheduleRetry(cfg, state.lastError, { reason: 'port_occupied', delayMs: Math.min(backoff, 2_000) });
        return;
      }
      scheduleRetry(cfg, state.lastError, { reason: cls.reason });
    });
    // 给 ssh 一点时间建链，然后探活确认
    const t = setTimeout(() => { void checkOnceSafely(true); }, 3_500);
    if (t.unref) t.unref();
  }

  /** 远端端口占用自动清理：受 cleanupLimit 约束，超限只报错不动手。 */
  async function maybeReclaimRemotePort(cfg, probeClass) {
    if (probeClass === 'no_listener') return true; // 远端没人监听，无需清理
    if (state.autoKills >= cleanupLimit) {
      const msg = `远端 0.0.0.0:${cfg.remotePort} 仍被旧隧道占用，自动清理已连续尝试 ${state.autoKills} 次仍未恢复，需要人工处理（或在服务器上 kill 掉监听 ${cfg.remotePort} 的 sshd-session）| auto cleanup limit reached`;
      setFailed('cleanup_limit', msg);
      warn(`dsh-pocket: remote port cleanup limit reached (${state.autoKills}/${cleanupLimit}) — giving up on reclaim | 自动清理次数已达上限，需人工处理`);
      pushCleanup({ at: Date.now(), ok: false, stage: 'limit', error: msg, holders: [], kill: [], killed: [] });
      return false;
    }
    state.autoKills += 1;
    let rec;
    try {
      rec = await reclaim(cfg, { log, run: (c, command, ms) => runRemoteSsh(c, command, ms, { execFn }) });
    } catch (err) {
      rec = { at: Date.now(), ok: false, stage: 'error', error: oneLine(err?.message ?? err), holders: [], kill: [], killed: [] };
    }
    pushCleanup(rec);
    if (rec.ok) {
      info(`dsh-pocket: remote port reclaimed (attempt ${state.autoKills}/${cleanupLimit})${rec.killed?.length ? ` pid=${rec.killed.join(',')}` : ''} | 远端端口已清理`);
      return true;
    }
    setFailed('port_occupied', rec.error || '远端端口清理失败 | remote reclaim failed');
    warn(`dsh-pocket: remote port reclaim failed: ${state.lastError} | 远端端口自动清理失败`);
    return false; // 仍然继续 spawn：失败原因会在状态里显示，重试链不能断
  }

  async function checkOnce(afterSpawn = false) {
    if (stopped) return;
    const cfg = currentConfig();
    // 直接改 settings.json 把开关关掉 → 下一轮探活生效（设置页开关走 restart，即时生效）
    if (!cfg.enabled) { stop(); return; }
    if (!sshTunnelConfigured(cfg)) {
      setFailed('not_configured', 'sshTunnel 缺少 host 或 keyPath | missing host/keyPath');
      ensureProbeTimer(); // 设置补全后自动恢复
      return;
    }
    // 看门狗：ssh 进程活着但迟迟不上线（认证挂住、半开连接）→ 回收重连
    if (child && state.phase === 'starting' && state.spawnedAt && Date.now() - state.spawnedAt > startingGraceMs) {
      info('dsh-pocket: ssh not online within grace period — recycling | ssh 长时间未建立，回收重连');
      killChild();
      scheduleRetry(cfg, 'ssh not online within grace period', { reason: 'network', delayMs: 1_000 });
      return;
    }
    const probe = await probeOnce(cfg);
    if (stopped) return;
    if (probe.ok) {
      markOnline(cfg);
      if (afterSpawn) info(`dsh-pocket: ssh tunnel online — ${state.url} | 固定公网地址已可用`);
      return;
    }
    // 没有子进程、也不自认为是 online（例如已在退避中）→ 重连定时器已在负责，不重复排队
    if (!child && state.phase !== 'online') return;
    // 刚 spawn 的建链宽限期内，探活失败不算数：ssh 握手 + 远端 bind 偶发 3-6s，
    // 过早回收会把自己刚建好的隧道掐掉（2026-10-20 故障注入实测踩到）。
    if (!afterSpawn && child && state.spawnedAt && Date.now() - state.spawnedAt < 12_000) return;
    failures += 1;
    // 刚 spawn 后第一次探活给足时间（Cloudflare 之类不需要，SSH 建链通常 1-3s）
    const need = afterSpawn ? 4 : 2;
    if (failures < need) return;
    failures = 0;
    // 半死：进程还在但链路已断 → 主动杀掉，走重连（这是旧方案最大的坑）
    if (child) {
      info('dsh-pocket: ssh tunnel probe failed — recycling process | 隧道探活失败，回收 ssh 进程重连');
      killChild();
    } else {
      // 收养的外部隧道掉了
      state.adopted = false;
      state.adoptedPid = null;
      state.adoptedExternal = false;
    }
    setFailed('probe', `probe failed: ${probe.error ?? 'unknown'}`);
    scheduleRetry(currentConfig(), state.lastError, { reason: 'probe' });
  }

  function checkOnceSafely(afterSpawn = false) {
    return Promise.resolve()
      .then(() => checkOnce(afterSpawn))
      .catch((err) => {
        warn(`dsh-pocket: ssh tunnel probe threw | 隧道探活异常: ${oneLine(err?.message ?? err)}`);
        if (!stopped) scheduleRetry(currentConfig(), `probe threw: ${err?.message ?? err}`, { reason: 'unknown' });
      });
  }

  function startSafely() {
    return Promise.resolve()
      .then(() => start())
      .catch((err) => {
        // 任何一处意外异常都不能让重试链断掉（2026-10-20 观察到的「本机再无 ssh 尝试」根因之一）
        setFailed('unknown', `start failed: ${err?.message ?? err}`);
        warn(`dsh-pocket: ssh tunnel start threw | 固定公网隧道启动异常: ${state.lastError}`);
        if (!stopped) scheduleRetry(currentConfig(), state.lastError, { reason: 'unknown' });
      });
  }

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      await null; // 让 in-flight 语义从微任务开始，避免同步抛错把 starting 卡成 rejected
      const cfg = currentConfig();
      state.url = urlOf(cfg);
      if (!cfg.enabled || !sshTunnelConfigured(cfg)) {
        state.reason = cfg.enabled ? 'not_configured' : '';
        stop();
        return;
      }
      stopped = false;
      if (!existsSync(cfg.keyPath)) {
        // 私钥暂时不可用（网络盘/移动盘没挂载）也要继续重试，不能永久停在 error
        setFailed('key_missing', `private key not found: ${cfg.keyPath} | 找不到私钥`);
        warn(`dsh-pocket: ssh key not found: ${cfg.keyPath} | 找不到私钥，固定公网地址暂时无法启动（会持续重试）`);
        scheduleRetry(cfg, state.lastError, { reason: 'key_missing' });
        return;
      }
      if (child) { ensureProbeTimer(); return; }

      // 已有健康隧道（手动的/上次残留的）→ 收养，避免重复绑定远端端口
      const probe = await probeOnce(cfg);
      if (stopped) return;
      if (probe.ok) {
        markOnline(cfg);
        state.adopted = true;
        state.phase = 'online';
        let pids = [];
        try { pids = await findProcesses(cfg, { execFn }); } catch { /* 忽略 */ }
        state.adoptedPid = pids[0] ?? null;
        state.adoptedExternal = true;
        info(`dsh-pocket: existing ssh tunnel adopted — ${state.url}${state.adoptedPid ? ` (local ssh pid=${state.adoptedPid})` : ' (external process)'} | 已有固定公网隧道，直接沿用（不再新建）`);
        ensureProbeTimer();
        return;
      }

      // 探活失败：先清掉本机占着同一远端端口的残留 ssh（可能指向已失效的本地端口），
      // 再检查远端是否有旧会话留下的 sshd-session 占坑（2026-10-20 事故真凶）；
      // 两步都不做的话，新 ssh 会因 ExitOnForwardFailure 立刻 255 退出、永远起不来。
      const killedLocal = await killStaleTunnels(cfg, {
        execFn,
        onKill: (pids) => info(`dsh-pocket: killed stale local ssh tunnel pid=${pids.join(',')} | 清理本机残留隧道`),
      });
      if (killedLocal.length) pushCleanup({ at: Date.now(), ok: true, stage: 'local', holders: [], kill: [], killed: killedLocal, error: '' });
      if (stopped) return;

      const probeClass = classifyProbeFailure(probe.error);
      if (probeClass === 'stale_or_halfopen' || probeClass === 'unknown') {
        await maybeReclaimRemotePort(cfg, probeClass);
      } else {
        setFailed('network', `probe failed: ${probe.error ?? 'unknown'}`);
      }
      if (stopped) return;
      spawnTunnel(cfg, currentLocalPort(cfg));
      ensureProbeTimer();
    })().finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    stopped = true;
    clearTimers();
    killChild();
    state.phase = 'off';
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.nextRetryAt = null;
    state.attempts = 0;
  }

  /** 设置变化后重启（enabled/host/port/key 改了），或用户点「立即重连」。 */
  async function restart() {
    stop();
    state.restarts = 0;
    state.autoKills = 0;
    state.reason = '';
    state.lastError = '';
    backoff = 3_000;
    failures = 0;
    return start();
  }

  function status() {
    const cfg = currentConfig();
    return {
      enabled: cfg.enabled,
      configured: sshTunnelConfigured(cfg),
      host: cfg.host,
      remotePort: cfg.remotePort,
      sshPort: cfg.port,
      user: cfg.user,
      keySet: Boolean(cfg.keyPath),
      // 只暴露私钥文件名（不含目录）与是否存在——足够诊断 key_missing，不把本机路径全发给手机
      keyName: String(cfg.keyPath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '',
      keyExists: Boolean(cfg.keyPath) && existsSync(cfg.keyPath),
      localPort: currentLocalPort(cfg),
      url: state.url || urlOf(cfg),
      phase: state.phase,
      reason: state.reason,
      adopted: state.adopted,
      adoptedExternal: state.adoptedExternal,
      adoptedPid: state.adoptedPid,
      pid: state.pid,
      restarts: state.restarts,
      attempts: state.attempts,
      autoKills: state.autoKills,
      cleanupLimit,
      cleanups: state.cleanups.slice(0, 4).map((r) => ({
        at: r.at,
        ok: r.ok,
        stage: r.stage,
        killed: r.killed ?? [],
        holders: (r.holders ?? []).map((h) => `${h.name || '?'}:${h.pid}`),
        error: r.error ?? '',
      })),
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      lastStderr: state.lastStderr,
      lastProbeAt: state.lastProbeAt,
      lastProbeStatus: state.lastProbeStatus,
      nextRetryAt: state.nextRetryAt,
    };
  }

  return { start, startSafely, stop, restart, status, checkOnce, probeOnce, _state: state };
}
