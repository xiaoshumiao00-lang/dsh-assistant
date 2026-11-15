/**
 * SenseVoice 常驻服务的保活器（宿主启动即保证 + 心跳自愈）。
 *
 * 为什么要有这一层（2026-11-15 实测根因）：
 *   - SenseVoice 是本机 `127.0.0.1:3098` 的常驻 ONNX 服务（模型加载一次约 2.2s，工作集约 1.05GB）；
 *     它以前只靠 `start-sensevoice.cmd`（计划任务那条路已被本仓库弃用）和被谁顺手拉一下，
 *     结果 08:26 语音派单时它已经不在，`asr failed` 直接落在 lane.log。
 *   - `sensevoice-watchdog.ps1` 是靠计划任务挂的，实测它的日志文件从未存在过 = 从未跑过。
 *     本仓库的规矩是「不靠计划任务」：所以保活挪进插件层（鹈鹕 lane 启动路径）。
 *   - 实测本机宿主（`DSH` 主进程）在一个 Windows job object 里，凡是它派生的整棵子树
 *     （node → cmd.exe → python）都在同一个 job 里（`IsProcessInJob` 逐 pid 验过）；
 *     `detached: true` 只保证「直接父进程被杀/正常退出」不会带走服务（实测 5 种杀法都活着），
 *   但 job 整体被拆时仍在 job 内的进程会被拖走。因此真正的兜底是这里：
 *     **每次 lane 起来就先探测、探测到没人再起；跑着死了由心跳 + ASR 腿失败补探重新拉起**。
 *
 * 三条硬约束（钉在单测里）：
 *   1. 探测到 `/health` 通就不许再拉一份（同一端口只能有一份 SenseVoice，重复拉会再多 1.05GB）；
 *   2. 拉起必须**无窗口**：直接 spawn `venv-sherpa` 的 `pythonw.exe` 跑 `sensevoice_server.py`
 *      （GUI 子系统解释器 + `windowsHide` + stdin 断开、stdout/stderr 都追加进同一个 `sensevoice.log`，
 *      `> 20MB` 滚动到 `sensevoice.log.1` 这条规矩在插件里等价重做一份）。
 *      为什么不再走 `start-sensevoice.cmd`（2026-11-15 用户反馈 + 实测）：
 *      那条 .cmd 里的 `start "" /b python.exe` 需要一台控制台，宿主是 GUI 进程没有，于是 Windows
 *      给这次调用新分一台 conhost = 桌面上一扇黑色 CMD 窗；python 挂在那台控制台上，cmd 退出窗也不消失。
 *      同机实测两组 flags：`python.exe` + `windowsHide` + `detached` 仍然拿到控制台
 *      （`GetConsoleWindow()` 非 0、默认终端是 Windows Terminal 时桌面多一扇窗）；
 *      `pythonw.exe` 则是 `GetConsoleWindow() == 0`、无 conhost 子进程、桌面窗口数不变。
 *      `start-sensevoice.cmd` 保留给人手动用，插件层只走无窗口这条。
 *   3. 连续拉不起来要退避 + 上限（到点停止、落一条日志、冷却后再试），且整个过程不许打断
 *      正在跑的转写请求。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** SenseVoice 服务目录与它的启动脚本（仓库内固定名字，不写死任何用户目录）。 */
export const TIHU_ASR_DIR_NAME = 'asr-sensevoice'
export const TIHU_ASR_CONFIG_FILE = 'sensevoice.config.json'
/** 给人手动用的那条 .cmd（插件层**不再**用它拉起，见文件头第 2 条）。 */
export const TIHU_ASR_START_SCRIPT = 'start-sensevoice.cmd'
/** 插件层真正起的那个服务脚本（在服务目录里，cwd 也是它）。 */
export const TIHU_ASR_SERVER_SCRIPT = 'sensevoice_server.py'
/** 服务日志（stdout + stderr 都追加进这一个文件，与那条 .cmd 的规矩一致）。 */
export const TIHU_ASR_LOG_FILE = 'sensevoice.log'
/** 日志滚动门槛：大于 20MB 就挪成 `.1`（与 .cmd 里 `if %%~zA GTR 20971520 move /y` 等价）。 */
export const TIHU_ASR_LOG_MAX_BYTES = 20 * 1024 * 1024

/** 心跳间隔：60s 一次（够快不至于让语音哑火 10 分钟，也不至于天天扰民）。 */
export const TIHU_ASR_KEEPER_HEARTBEAT_MS = 60_000
/** 连续失败上限：到点就停止重起，避免模型加载失败时把宿主拖进循环。 */
export const TIHU_ASR_KEEPER_MAX_FAILURES = 3
/** 退避阶梯（第 1/2/3 次失败后各等多久）；超出列表长度沿用最后一档。 */
export const TIHU_ASR_KEEPER_BACKOFF_MS = [15_000, 60_000, 300_000]
/** 达到上限后的冷却：到点清零计数器再试一轮。 */
export const TIHU_ASR_KEEPER_COOLDOWN_MS = 30 * 60_000
/** `/health` 探测超时（与 TTS sidecar 那条规矩一致：短超时，别把心跳拖住）。 */
export const TIHU_ASR_HEALTH_TIMEOUT_MS = 2_000
/** 拉起后等服务就绪：模型实测约 2.2s，给 20 次 × 1s 的窗口。 */
export const TIHU_ASR_UP_POLL_ATTEMPTS = 20
export const TIHU_ASR_UP_POLL_INTERVAL_MS = 1_000
/** ASR 腿失败后补探测的合并窗口：一次派单会打好几条腿，别按腿数重复拉。 */
export const TIHU_ASR_KEEPER_KICK_DEBOUNCE_MS = 3_000

/** 保活器自己的诊断计数器（给单测和排查用）。 */
export interface TihuAsrKeeperStats {
  /** 一共拉起过几次。 */
  launches: number;
  /** 连续失败计数（成功探测到或冷却到点清零）。 */
  consecutiveFailures: number;
  /** 最近一次结果：healthy（探测到已活着）/ up（拉起后起来了）/ down（还是没起来）。 */
  lastResult: string;
  /** 最近一次 ensure 的原因标签。 */
  lastReason: string;
  /** 到 `nextAllowedAtMs` 之前不再尝试（退避中）。 */
  nextAllowedAtMs: number;
  /** 上限达到后的冷却到期时间（0 = 没有冷却）。 */
  cooldownUntilMs: number;
  /** 服务根目录（没解析到就是 undefined）。 */
  root: string | undefined;
  /** 探测地址（从 `sensevoice.config.json` 的 host/port 拼出来）。 */
  healthUrl: string;
  /** 心跳是否在跑。 */
  heartbeat: boolean;
  /** 保活器是否被关掉（`TIHU_ASR_KEEPER=0` 或 options.disabled）。 */
  disabled: boolean;
}

export interface TihuAsrServiceConfig {
  host: string;
  port: number;
  healthUrl: string;
}

export interface TihuAsrLaunchSpec {
  /** venv-sherpa 的 python.exe（不是 cmd.exe —— GUI 宿主起 cmd 会新开一台控制台）。 */
  command: string;
  args: string[];
  options: {
    cwd: string;
    /** detach 出去：父进程正常退出/被硬杀都不带走服务。 */
    detached: boolean;
    /** 关键：`CREATE_NO_WINDOW`，不起控制台窗口。 */
    windowsHide: boolean;
    /** 三条标准流：stdin 断开；stdout/stderr 都写进 `options.logPath`（不是管道，宿主死了也不断）。 */
    stdio: ['ignore', 'log', 'log'];
    /** 默认 false：直接甩 exe 时由 Node 负责给带空格的路径加引号。 */
    windowsVerbatimArguments: boolean;
    /** 追加写的那份日志（`sensevoice.log`）。 */
    logPath: string;
  };
}

/** 打开（必要时先滚动）服务日志：追加模式，stdout 与 stderr 共用这一个 fd。 */
export interface TihuAsrLogHandle {
  path: string;
  fd: number;
  /** 这一次打开之前是否已经把旧日志挪成了 `.1`。 */
  rotated: boolean;
}

export interface TihuAsrKeeperOptions {
  /** 直接指定服务目录；不指定就按插件安装路径往上找（`TIHU_ASR_ROOT` 可覆盖）。 */
  root?: string;
  /** 探测地址覆盖（单测注入假服务用）。 */
  healthUrl?: string;
  /** 关掉保活（测试/临时排查用）。 */
  disabled?: boolean;
  intervalMs?: number;
  healthTimeoutMs?: number;
  maxFailures?: number;
  backoffMs?: number[];
  cooldownMs?: number;
  upPollAttempts?: number;
  upPollIntervalMs?: number;
  kickDebounceMs?: number;
  /** 解析服务目录时当作「自己所在的目录」的那一层（单测注入）。 */
  startDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 注入探测（单测用假服务或内存计数）。默认 `GET /health`。 */
  probeHealth?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** 注入拉起。默认无窗口起 venv-sherpa python 跑 `sensevoice_server.py`。 */
  launch?: (root: string, spec: TihuAsrLaunchSpec) => void | Promise<void>;
  /** 注入等待（单测把退避窗口压成 0）。默认 setTimeout。 */
  waitMs?: (ms: number) => Promise<void>;
  /** 注入时钟（单测钉退避/冷却）。默认 `Date.now`。 */
  now?: () => number;
  /** 留痕（插件层接到 lane.log 的 `note=tihu-asr-keeper`）。 */
  note?: (text: string) => void;
  /** 宿主 logger（可选，心跳异常时用）。 */
  log?: (line: string) => void;
}

/** 保活器对外：lane 启动调 `ensure`，心跳自己起，卸载调 `stop`。 */
export interface TihuAsrKeeper {
  ensure: (reason: string) => Promise<boolean>;
  kickAfterAsrFailure: (reason: string) => void;
  startHeartbeat: () => void;
  stop: () => void;
  stats: () => TihuAsrKeeperStats;
}

function asrDirProbe(dir: string): boolean {
  return existsSync(join(dir, TIHU_ASR_CONFIG_FILE)) && existsSync(join(dir, TIHU_ASR_START_SCRIPT))
}

function trimmedEnv(env: Record<string, string | undefined>, key: string): string {
  return String(env[key] ?? '').trim()
}

/** 往上找服务目录：源码在 `src/tihu/` → 仓库根；打包产物在 `lib/` → 也是仓库根。 */
export function tihuAsrRootCandidates(startDir: string, cwd?: string): string[] {
  const candidates: string[] = []
  let dir = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(join(dir, TIHU_ASR_DIR_NAME))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (cwd !== undefined && cwd !== '') candidates.push(join(cwd, TIHU_ASR_DIR_NAME))
  return candidates
}

/**
 * 解析 SenseVoice 服务目录。
 * 顺序：`TIHU_ASR_ROOT`（必须真有 config + cmd）→ 从插件自己所在往上找 → 宿主当前工作目录。
 * 一律不写死用户目录（仓库 lint 不许源码里出现个人路径）。
 */
export function resolveTihuAsrRoot(options: { startDir?: string; cwd?: string; env?: Record<string, string | undefined> } = {}): string | undefined {
  const env = options.env ?? process.env
  const override = trimmedEnv(env, 'TIHU_ASR_ROOT')
  if (override !== '' && asrDirProbe(override)) return override
  const startDir = options.startDir ?? dirname(fileURLToPath(import.meta.url))
  const cwd = options.cwd ?? (typeof process.cwd === 'function' ? process.cwd() : '')
  for (const candidate of tihuAsrRootCandidates(startDir, cwd)) {
    if (asrDirProbe(candidate)) return candidate
  }
  return undefined
}

/**
 * 服务地址从 `sensevoice.config.json` 读（port 3098 是那台机器上唯一的事实源）。
 * 读不到（文件坏了/缺字段）就返回 undefined，让保活器落一行「不启用」而不是瞎猜一个端口。
 */
export function readTihuAsrServiceConfig(root: string): TihuAsrServiceConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, TIHU_ASR_CONFIG_FILE), 'utf8')) as Record<string, unknown>
    const host = String(parsed?.host ?? '').trim() || '127.0.0.1'
    const port = Number(parsed?.port)
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) return undefined
    return { host, port, healthUrl: `http://${host}:${port}/health` }
  } catch {
    return undefined
  }
}

/**
 * venv-sherpa 的 python（`TIHU_ASR_PYTHON` 可覆盖；默认 `$DSH_HOME/tihu/venv-sherpa`，
 * 与 TTS 那边 `kokoroPythonPath()` 同一个运行时目录）。
 *
 * Windows 上**优先 `pythonw.exe`**：它是 GUI 子系统解释器，压根不申请控制台。
 * 2026-11-15 实测（同一台机器、同一套 flags）：
 *   - `python.exe` + `windowsHide` + `detached` → 仍然拿到一台控制台（`GetConsoleWindow()` 非 0），
 *     默认终端是 Windows Terminal 时桌面上就多一扇窗口；
 *   - `pythonw.exe` → `GetConsoleWindow() == 0`、无 conhost 子进程、桌面窗口数不变，
 *     而 stdout/stderr 照样进 `sensevoice.log`（isatty=False）。
 * 找不到就返回 undefined——宁可落一行日志不拉，也不回退到会开黑窗的 `cmd.exe` 老路子。
 */
export function resolveTihuAsrPython(env: Record<string, string | undefined> = process.env): string | undefined {
  const override = trimmedEnv(env, 'TIHU_ASR_PYTHON')
  if (override !== '') return override
  const dshHome = trimmedEnv(env, 'DSH_HOME') || join(homedir(), '.dsh')
  const binDir = join(dshHome, 'tihu', 'venv-sherpa', 'Scripts')
  const names = process.platform === 'win32' ? ['pythonw.exe', 'python.exe'] : ['python']
  for (const name of names) {
    const candidate = join(binDir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 拉起规格：直接起 venv-sherpa 的 pythonw 跑 `sensevoice_server.py`。
 * 无窗口靠三件事一起：`pythonw.exe`（GUI 子系统，不申请控制台）、`windowsHide`（不让任何环节
 * 新建控制台）、stdin 断开且 stdout/stderr 直接甩给日志文件 fd（不是管道、不是控制台）。
 * 服务目录（cwd）仍是 `asr-sensevoice`：模型/配置的**相对路径**都按它解析。
 */
export function buildTihuAsrLaunch(root: string, env?: Record<string, string | undefined>): TihuAsrLaunchSpec | undefined {
  const python = resolveTihuAsrPython(env ?? process.env)
  if (python === undefined) return undefined
  return {
    command: python,
    args: [join(root, TIHU_ASR_SERVER_SCRIPT)],
    options: {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'log', 'log'],
      windowsVerbatimArguments: false,
      logPath: join(root, TIHU_ASR_LOG_FILE),
    },
  }
}

/**
 * 打开服务日志（追加）。超过 20MB 先把旧文件挪成 `.1` 再开——
 * 与 `start-sensevoice.cmd` 里那条 `for %%A ... GTR 20971520 move /y ... .1` 等价。
 * 文件还不存在（第一次起）就不滚。
 */
export function openTihuAsrLog(root: string, maxBytes: number = TIHU_ASR_LOG_MAX_BYTES): TihuAsrLogHandle {
  const path = join(root, TIHU_ASR_LOG_FILE)
  let rotated = false
  try {
    if (statSync(path).size > maxBytes) {
      const rolled = `${path}.1`
      try { rmSync(rolled, { force: true }) } catch { /* 旧 .1 删不掉就继续，别为了滚动把服务拦下 */ }
      renameSync(path, rolled)
      rotated = true
    }
  } catch { /* 没有日志文件 = 第一次起，不用滚 */ }
  const fd = openSync(path, 'a')
  return { path, fd, rotated }
}

/**
 * Node 的 timer 上有 `unref`（DOM 那份声明把 setTimeout 说成返回 number，所以按结构取）。
 * 用途：保活器自己起的定时器一律不许让插件层变成「等它走」的理由。
 */
function unrefHandle(handle: unknown): void {
  const unref = (handle as { unref?: () => void } | null)?.unref
  if (typeof unref === 'function') unref.call(handle)
}

async function probeTihuAsrHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const info = (await response.json().catch(() => null)) as Record<string, unknown> | null
    return info === null ? true : info.ok !== false
  } catch {
    return false
  }
}

/**
 * 真正起服务：先开（必要时滚动的）日志，再把 stdin 断开、stdout/stderr 都指向这个 fd 起 python。
 * 全程不建控制台：`windowsHide` + `detached` + 无 tty 标准流。
 * 拉起后立刻关掉父进程这一份 fd（子进程在 spawn 时已复制），不留句柄泄漏。
 */
function launchTihuAsrService(root: string, spec: TihuAsrLaunchSpec, note: (text: string) => void): void {
  let handle: TihuAsrLogHandle
  try {
    handle = openTihuAsrLog(root)
  } catch (error) {
    note(`打开 ${TIHU_ASR_LOG_FILE} 失败：${(error as Error)?.message ?? String(error)}（不拉起了）`)
    return
  }
  if (handle.rotated) note(`${TIHU_ASR_LOG_FILE} 超过 ${Math.round(TIHU_ASR_LOG_MAX_BYTES / 1024 / 1024)}MB → 滚动到 ${TIHU_ASR_LOG_FILE}.1`)
  let child: ReturnType<typeof spawn>
  const stdio: Array<'ignore' | number> = ['ignore', handle.fd, handle.fd]
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.options.cwd,
      detached: spec.options.detached,
      windowsHide: spec.options.windowsHide,
      windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
      stdio,
    })
  } catch (error) {
    closeSync(handle.fd)
    note(`拉起失败：${(error as Error)?.message ?? String(error)}`)
    return
  }
  closeSync(handle.fd)
  // detached 出去的 python 由系统托管，这里不许把它当「服务掉了」；错误只落一行。
  child.on('error', (error: Error) => {
    note(`拉起报错：${error?.message ?? String(error)}`)
  })
  if (typeof child.unref === 'function') child.unref()
}

/**
 * 建一个 SenseVoice 保活器。
 *
 * 关键纪律：探测到活着就**直接返回**（绝不重复拉起）；同一时间只有一个 ensure 在跑（single-flight）；
 * 失败按退避阶梯等，达到上限就停手并冷却；所有等待都走注入的 `waitMs`，单测里能压成 0。
 */
export function createTihuAsrKeeper(options: TihuAsrKeeperOptions = {}): TihuAsrKeeper {
  const env = options.env ?? process.env
  const disabled = options.disabled === true || trimmedEnv(env, 'TIHU_ASR_KEEPER') === '0'
  const root = options.root ?? resolveTihuAsrRoot({ startDir: options.startDir, cwd: options.cwd, env })
  const service = root === undefined ? undefined : readTihuAsrServiceConfig(root)
  const envUrl = trimmedEnv(env, 'TIHU_ASR_HEALTH_URL')
  const injectedUrl = options.healthUrl ?? (envUrl === '' ? undefined : envUrl)
  const healthUrl = String(injectedUrl ?? service?.healthUrl ?? '').trim()
  const intervalMs = options.intervalMs ?? TIHU_ASR_KEEPER_HEARTBEAT_MS
  const healthTimeoutMs = options.healthTimeoutMs ?? TIHU_ASR_HEALTH_TIMEOUT_MS
  const maxFailures = options.maxFailures ?? TIHU_ASR_KEEPER_MAX_FAILURES
  const backoffMs = options.backoffMs ?? TIHU_ASR_KEEPER_BACKOFF_MS
  const cooldownMs = options.cooldownMs ?? TIHU_ASR_KEEPER_COOLDOWN_MS
  const upPollAttempts = options.upPollAttempts ?? TIHU_ASR_UP_POLL_ATTEMPTS
  const upPollIntervalMs = options.upPollIntervalMs ?? TIHU_ASR_UP_POLL_INTERVAL_MS
  const kickDebounceMs = options.kickDebounceMs ?? TIHU_ASR_KEEPER_KICK_DEBOUNCE_MS
  const note = options.note ?? (() => {})
  const logLine = options.log ?? (() => {})
  const probe = options.probeHealth ?? probeTihuAsrHealth
  const launchFn = options.launch ?? ((dir: string, spec: TihuAsrLaunchSpec) => launchTihuAsrService(dir, spec, note))
  const wait = options.waitMs ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const now = options.now ?? (() => Date.now())

  let consecutiveFailures = 0
  let launches = 0
  let lastResult = ''
  let lastReason = ''
  let nextAllowedAtMs = 0
  let cooldownUntilMs = 0
  let capLogged = false
  let backoffLogged = false
  /** 探测到活着时只在「第一次」落一行，别每 60s 刷一遍日志。 */
  let healthyLogged = false
  let pending: Promise<boolean> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let kickTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function resetGates(): void {
    consecutiveFailures = 0
    nextAllowedAtMs = 0
    cooldownUntilMs = 0
    capLogged = false
    backoffLogged = false
  }

  function stats(): TihuAsrKeeperStats {
    return {
      launches,
      consecutiveFailures,
      lastResult,
      lastReason,
      nextAllowedAtMs,
      cooldownUntilMs,
      root,
      healthUrl,
      heartbeat: timer !== undefined,
      disabled,
    }
  }

  async function ensure(reason: string): Promise<boolean> {
    if (stopped || disabled) return false
    if (pending !== null) return pending
    lastReason = reason
    if (healthUrl === '' || root === undefined) {
      if (!capLogged) {
        note('找不到 asr-sensevoice 服务目录（缺 sensevoice.config.json 或 start-sensevoice.cmd）→ 保活器不启用')
        capLogged = true
      }
      lastResult = 'no-root'
      return false
    }
    const run = (async (): Promise<boolean> => {
      const t = now()
      if (consecutiveFailures >= maxFailures) {
        if (cooldownUntilMs !== 0 && t >= cooldownUntilMs) {
          resetGates()
          note(`冷却到点，恢复尝试（${reason}）`)
        } else {
          if (!capLogged) {
            note(`连续 ${consecutiveFailures} 次拉不起来 → 停止重起（冷却 ${Math.max(0, Math.round((cooldownUntilMs - t) / 1000))}s 后重试，${reason}）`)
            capLogged = true
          }
          lastResult = 'capped'
          return false
        }
      } else if (nextAllowedAtMs !== 0 && t < nextAllowedAtMs) {
        if (!backoffLogged) {
          note(`退避中：再等 ${Math.max(0, Math.round((nextAllowedAtMs - t) / 1000))}s（连续失败 ${consecutiveFailures}/${maxFailures}，${reason}）`)
          backoffLogged = true
        }
        lastResult = 'backoff'
        return false
      }

      if (await probe(healthUrl, healthTimeoutMs)) {
        if (!healthyLogged) {
          note(`health ok（${reason}）→ 已活着，不再拉第二份 SenseVoice`)
          healthyLogged = true
        }
        resetGates()
        lastResult = 'healthy'
        return true
      }

      healthyLogged = false
      const spec = buildTihuAsrLaunch(root, env)
      if (spec === undefined) {
        note(`health down（${reason}）→ 找不到 venv-sherpa 的 python（TIHU_ASR_PYTHON 可覆盖）→ 不拉起（也不回退到会开黑窗的老路子）`)
      } else {
        note(`health down（${reason}）→ 无窗口拉起 SenseVoice（${spec.command} 跑 ${spec.args[0] ?? ''}）：${root}`)
      }
      try {
        if (spec !== undefined) {
          await launchFn(root, spec)
          launches += 1
        }
      } catch (error) {
        note(`拉起失败：${(error as Error)?.message ?? String(error)}`)
      }

      for (let attempt = 0; spec !== undefined && attempt < upPollAttempts; attempt += 1) {
        await wait(upPollIntervalMs)
        if (await probe(healthUrl, healthTimeoutMs)) {
          note(`SenseVoice 起来了（第 ${launches} 次拉起，等待 ${(attempt + 1) * upPollIntervalMs}ms）`)
          resetGates()
          lastResult = 'up'
          return true
        }
      }

      consecutiveFailures += 1
      const delay = backoffMs[Math.min(consecutiveFailures - 1, backoffMs.length - 1)] ?? 0
      const t2 = now()
      nextAllowedAtMs = t2 + delay
      backoffLogged = false
      if (consecutiveFailures >= maxFailures) {
        cooldownUntilMs = t2 + cooldownMs
        note(`还是没起来：连续失败 ${consecutiveFailures} 次 → 停手，冷却 ${Math.round(cooldownMs / 1000)}s（不再重复拉，内存不会二次膨胀）`)
      } else {
        note(`还是没起来：退避 ${Math.round(delay / 1000)}s 后重试（连续失败 ${consecutiveFailures}/${maxFailures}）`)
      }
      lastResult = 'down'
      logLine(`tihu asr keeper: SenseVoice 没起来 (${reason})`)
      return false
    })()
    pending = run
    try {
      return await run
    } finally {
      pending = null
    }
  }

  /** ASR 腿失败时补一次探测：合并窗口 + 单飞，绝不打断正在跑的转写。 */
  function kickAfterAsrFailure(reason: string): void {
    if (stopped || disabled) return
    if (kickTimer !== undefined) return
    const timer2 = setTimeout(() => {
      kickTimer = undefined
      void ensure(`asr 腿失败：${reason}`).catch((error: unknown) => {
        logLine(`tihu asr keeper 补探测异常：${(error as Error)?.message ?? String(error)}`)
      })
    }, kickDebounceMs)
    unrefHandle(timer2)
    kickTimer = timer2
  }

  function startHeartbeat(): void {
    if (stopped || disabled || timer !== undefined) return
    timer = setInterval(() => {
      void ensure('心跳').catch((error: unknown) => {
        logLine(`tihu asr keeper 心跳异常：${(error as Error)?.message ?? String(error)}`)
      })
    }, intervalMs)
    unrefHandle(timer)
  }

  function stop(): void {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (kickTimer !== undefined) {
      clearTimeout(kickTimer)
      kickTimer = undefined
    }
  }

  return { ensure, kickAfterAsrFailure, startHeartbeat, stop, stats }
}
