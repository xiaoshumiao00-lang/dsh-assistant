/**
 * 本地 TTS sidecar（鹈鹕模块内置，不依赖任何外部插件 / 独立服务 / 别的仓库）。
 *
 * 主引擎（2026-11-08 用户拍板）：**Kokoro multi-lang v1.1-zh（sherpa-onnx，纯 CPU）**。
 *   - 驱动脚本在仓库内：`scripts/tihu-kokoro-tts-server.py`（与 `tihu-qwen-tts-server.py` 同级）；
 *   - 常驻 WebSocket 进程，由本模块 spawn / 健康检查 / 失败重启；端口沿用 DEFAULT_PORT 8731；
 *   - 权重 `~/.dsh/tihu/models/kokoro/kokoro-multi-lang-v1_1/model.onnx`（fp32；本机实测 int8
 *     反而慢 2.8–3.5 倍：RTF 1.34 对 0.477，所以这里显式排除 int8）；
 *   - Python 运行时 `~/.dsh/tihu/venv-sherpa`（sherpa-onnx 2.0.1 + websockets），不进仓库依赖。
 * 兜底：edge-tts 云健（`scripts/tihu-edge-tts.py`，音色 zh-CN-YunjianNeural 不变）。
 * 可选遗留：Qwen3-TTS sidecar 只有显式 `TIHU_TTS_ENGINE=qwen` 才启动（代码保留，默认不加载）。
 *
 * 设计：
 *   - **独立进程**：DSH 主进程只做 HTTP / WS 客户端；
 *   - 模型 / 二进制放 `~/.dsh/tihu/`，不进仓库；
 *   - Kokoro 走内部 WS 协议（JSON 请求 + 二进制 PCM 分块），这里再切成固定 120ms 块；
 *   - 本地合成**串行**（最多 1 路在合）：并池化会把 4 个线程抢成互相等，反而更慢。
 *
 * 失败策略：顺序固定 **Kokoro → edge**；任一路失败都以可读 Error 向上抛，由 lane 发
 * `event.alert` 并让页面降级；绝不静默。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Pcm16Chunker, TTS_CHUNK_MS, TTS_SAMPLE_RATE, validateReferenceWav } from './audio.ts'
import { toTtsSegments } from './protocol.ts'
import type { VoiceInfo } from './protocol.ts'

const DEFAULT_PORT = 8731
/** Kokoro 端口：默认沿用 8731；要和遗留 Qwen sidecar 并跑时用 TIHU_TTS_KOKORO_PORT 挪开。 */
const KOKORO_PORT_DEFAULT = DEFAULT_PORT
const HEALTH_TIMEOUT_MS = 180_000

/**
 * edge-tts 首块门限（默认 8000ms，`TIHU_EDGE_FIRST_MS` 可调）。
 *
 * 2026-11-07 断音根因（现场实测，见 `C:\Users\Administrator\.dsh\repro\tihu-tts-cut\`）：
 *   - 4 路并发首块 2263–3317ms，8 路并发开始有段被杀；
 *   - **12 路并发（=3 个 /tihu 标签页 × 4 段并发）8/12 段被 3500ms 门限杀掉，
 *     返回 0 字节**（probe-edge.mjs burst 12：`first=-1ms audio=0ms kills=firstTimer@3500ms`）；
 *   - 被杀之后落本地 Qwen，本机 CPU 首包实测 **54485ms**（probe-qwen.mjs），等于直接丢掉这一句。
 * 3500ms 只比正常首块（2.2–3.3s）高 200ms，任何抖动都会误杀；这里按实测 p99 的 2.4 倍取 8s，
 * 并且首块超时**先重试一次 edge**（见 synthesize），仍失败才落本地兜底。
 */
const EDGE_FIRST_MS_DEFAULT = 8_000
const EDGE_FIRST_MS_MIN = 3_000
const EDGE_FIRST_MS_MAX = 60_000

/** 环境变量整数化 + 夹到区间（非数字一律回落兜底值；0/负数按区间下限算）。 */
function clampMs(raw: unknown, min: number, max: number, fallback: number): number {
  const value = Number(raw)
  if (raw === undefined || raw === '' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** edge-tts 首块门限（毫秒）。 */
export function edgeFirstChunkMs(): number {
  return clampMs(process.env.TIHU_EDGE_FIRST_MS, EDGE_FIRST_MS_MIN, EDGE_FIRST_MS_MAX, EDGE_FIRST_MS_DEFAULT)
}

/**
 * 本地（Kokoro）首块门限：`TIHU_LOCAL_FIRST_MS`，默认 **2500ms**，夹在 1–60s。
 *
 * 依据（本轮实测，4 线程 fp32）：20 字首段 ≈ 4s 音频，合成 1.6–2.4s（RTF 0.33–0.48），
 * 2500ms 覆盖 p95；超时立刻切 edge，不让首句空等。
 */
const LOCAL_FIRST_MS_DEFAULT = 2_500
const LOCAL_FIRST_MS_MIN = 1_000
const LOCAL_FIRST_MS_MAX = 60_000

/** 本地首块门限（毫秒）。 */
export function localFirstChunkMs(): number {
  return clampMs(process.env.TIHU_LOCAL_FIRST_MS, LOCAL_FIRST_MS_MIN, LOCAL_FIRST_MS_MAX, LOCAL_FIRST_MS_DEFAULT)
}

/**
 * 主引擎：`TIHU_TTS_ENGINE` = `kokoro` | `edge` | `qwen`，**默认 kokoro**。
 *
 * 2026-11-08 用户拍板：Kokoro 本地为主，edge 兜底；qwen 只有**显式**设置才启动
 *（旧值 cpu/q4/qwen-cuda 仍识别成 qwen，但绝不作为默认）。
 */
export type TihuTtsEngine = 'kokoro' | 'edge' | 'qwen'

export function ttsEngine(): TihuTtsEngine {
  const raw = String(process.env.TIHU_TTS_ENGINE ?? '').trim().toLowerCase()
  if (raw === 'edge') return 'edge'
  if (raw === 'qwen' || raw === 'cpu' || raw === 'q4' || raw === 'qwen-cuda') return 'qwen'
  return 'kokoro'
}

/** Kokoro 中文音色（sid 与 voices.bin 顺序一致；sherpa-onnx 官方 sid→name 映射）。 */
export interface KokoroVoice {
  sid: number
  name: string
  gender: 'f' | 'm'
}

/** 中文女声 zf_*：sid 3–57（55 个）。 */
const KOKORO_ZH_FEMALE = [
  'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
  'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024', 'zf_026',
  'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039', 'zf_040', 'zf_042',
  'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048', 'zf_049', 'zf_051', 'zf_059',
  'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072', 'zf_073', 'zf_074', 'zf_075',
  'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086',
  'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
]
/** 中文男声 zm_*：sid 58–102（45 个）。 */
const KOKORO_ZH_MALE = [
  'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015', 'zm_016',
  'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033', 'zm_034', 'zm_035',
  'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053', 'zm_054', 'zm_055',
  'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', 'zm_064', 'zm_065',
  'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091',
  'zm_095', 'zm_096', 'zm_097', 'zm_098', 'zm_100',
]

/** 全部 103 个音色（0 af_maple / 1 af_sol / 2 bf_vale，其余中文）。 */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { sid: 0, name: 'af_maple', gender: 'f' },
  { sid: 1, name: 'af_sol', gender: 'f' },
  { sid: 2, name: 'bf_vale', gender: 'f' },
  ...KOKORO_ZH_FEMALE.map((name, index) => ({ sid: 3 + index, name, gender: 'f' as const })),
  ...KOKORO_ZH_MALE.map((name, index) => ({ sid: 58 + index, name, gender: 'm' as const })),
]

/** 中文音色（设备端音色列表只下发这些，外加当前选中的英文音色）。 */
export const KOKORO_ZH_VOICES: readonly KokoroVoice[] = KOKORO_VOICES.filter((voice) => voice.sid >= 3)

/** 默认音色：TIHU_KOKORO_SID（默认 35 = zf_060 女声）。 */
export const KOKORO_DEFAULT_SID = 35

/** sid → 音色名（未知 sid 返回 `sid<号>`）。 */
export function kokoroVoiceName(sid: number): string {
  return KOKORO_VOICES.find((voice) => voice.sid === sid)?.name ?? `sid${sid}`
}

/**
 * 音色名/编号 → sid：支持 `zf_060`、`35`、`sid35`；不认得的回落到 TIHU_KOKORO_SID（默认 35）。
 * 设备端沿用现有的 `voice.select` 通道（name 字段），不新增协议字段。
 */
export function kokoroSid(raw?: string | number): number {
  const envRaw = process.env.TIHU_KOKORO_SID
  const parsed = envRaw === undefined || String(envRaw).trim() === '' ? Number.NaN : Number(envRaw)
  const fallback = Number.isInteger(parsed) && parsed >= 0 && parsed <= 102 ? parsed : KOKORO_DEFAULT_SID
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw >= 0 && raw <= 102 ? raw : fallback
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'default') return fallback
  const byName = KOKORO_VOICES.find((voice) => voice.name.toLowerCase() === value)
  if (byName !== undefined) return byName.sid
  const numeric = value.startsWith('sid') ? value.slice(3) : value
  if (/^\d+$/.test(numeric)) {
    const sid = Number(numeric)
    if (sid >= 0 && sid <= 102) return sid
  }
  return fallback
}

/**
 * 当前模块所在目录（不引 `node:url`：仓库没有 @types/node，用 lib.dom 的 URL 即可）。
 * Windows 下 pathname 形如 `/D:/repo/src/tihu/`，去掉开头斜杠再统一成反斜杠。
 */
function moduleDir(): string {
  const pathname = decodeURIComponent(new URL('.', import.meta.url).pathname)
  const withoutSlash = pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/+$/, '')
  return withoutSlash.replace(/\//g, '\\')
}

/**
 * 仓库内 Kokoro 模型目录候选（**开箱即用**：模型随仓库走，clone 后不再下载）。
 * 由模块位置向上两级定位仓库根：开发时 `src/tihu/tts.ts` → `../../`；
 * 打包后 `lib/index.js` → `../`。桌面插件是 junction 指回本仓库，解析结果仍落在仓库内。
 */
export function repoModelDirs(): string[] {
  const here = moduleDir()
  const roots = [join(here, '..', '..'), join(here, '..'), process.cwd()]
  const dirs: string[] = []
  for (const root of roots) {
    const dir = join(root, 'models', 'kokoro', 'kokoro-multi-lang-v1_1')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * Kokoro 权重目录：**先仓库内 models/kokoro/kokoro-multi-lang-v1_1**（随仓库分发），
 * 再回退 `~/.dsh/tihu/models/kokoro/`（旧安装），`TIHU_KOKORO_MODEL_DIR` 可覆盖。
 */
export function kokoroModelDir(): string {
  const explicit = process.env.TIHU_KOKORO_MODEL_DIR
  if (explicit !== undefined && explicit !== '') return explicit
  for (const dir of repoModelDirs()) {
    if (existsSync(join(dir, 'model.onnx'))) return dir
  }
  return join(tihuRoot(), 'models', 'kokoro', 'kokoro-multi-lang-v1_1')
}

/** Kokoro 权重文件（**固定 fp32**；int8 实测更慢，见文件头）。 */
export function kokoroModelPath(): string {
  const explicit = process.env.TIHU_KOKORO_MODEL
  if (explicit !== undefined && explicit !== '') return explicit
  return join(kokoroModelDir(), 'model.onnx')
}

/** 词表/音色/espeak/fst 资产目录：fp32 目录里没有就看同级的 int8 包（文本前端资产相同）。 */
export function kokoroAssetsDir(): string {
  const modelDir = kokoroModelDir()
  if (existsSync(join(modelDir, 'tokens.txt'))) return modelDir
  const sibling = join(dirname(modelDir), 'kokoro-int8-multi-lang-v1_1')
  return existsSync(join(sibling, 'tokens.txt')) ? sibling : modelDir
}

/** Python 运行时（独立 venv，不进仓库依赖）。 */
export function kokoroPythonPath(): string {
  const explicit = process.env.TIHU_KOKORO_PY
  if (explicit !== undefined && explicit !== '') return explicit
  return join(tihuRoot(), 'venv-sherpa', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python')
}

/** 驱动脚本：**仓库内** `scripts/tihu-kokoro-tts-server.py`（可用 TIHU_KOKORO_SERVER 覆盖）。 */
export function kokoroScriptPath(): string {
  const explicit = process.env.TIHU_KOKORO_SERVER
  if (explicit !== undefined && explicit !== '') return explicit
  const here = moduleDir()
  const candidates = [
    join(here, '..', '..', 'scripts', 'tihu-kokoro-tts-server.py'), // src/tihu → 仓库根
    join(here, '..', 'scripts', 'tihu-kokoro-tts-server.py'), // 打包后 lib → 仓库根
    join(process.cwd(), 'scripts', 'tihu-kokoro-tts-server.py'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** 缺依赖时要跑的一条命令（错误提示里原样给用户）。 */
export function kokoroInstallHint(): string {
  const python = kokoroPythonPath()
  const modelDir = kokoroModelDir()
  return [
    `① 装 Python 环境（模型随仓库自带，不用下载）：python -m venv "${dirname(dirname(python))}" && "${python}" -m pip install sherpa-onnx websockets`,
    `② 只有 models 目录被删空时才需要补模型：HF_ENDPOINT=https://hf-mirror.com "${python}" -c "from huggingface_hub import snapshot_download as d; d('csukuangfj/kokoro-multi-lang-v1_1', local_dir=r'${modelDir}')"`,
  ].join('；')
}

/** Kokoro 缺哪些文件（空数组 = 齐全）。 */
export function kokoroMissingFiles(): string[] {
  const assets = kokoroAssetsDir()
  const checks: Array<[string, string]> = [
    [kokoroPythonPath(), 'Python 运行时（venv-sherpa）'],
    [kokoroScriptPath(), '驱动脚本 scripts/tihu-kokoro-tts-server.py'],
    [kokoroModelPath(), 'fp32 权重 model.onnx'],
    [join(assets, 'tokens.txt'), 'tokens.txt'],
    [join(assets, 'voices.bin'), 'voices.bin'],
    [join(assets, 'lexicon-zh.txt'), 'lexicon-zh.txt'],
    [join(assets, 'espeak-ng-data'), 'espeak-ng-data 目录'],
    [join(assets, 'number-zh.fst'), 'number-zh.fst'],
    [join(assets, 'date-zh.fst'), 'date-zh.fst'],
  ]
  const missing: string[] = []
  for (const [path, label] of checks) {
    if (!existsSync(path)) missing.push(`${label}：${path}`)
  }
  return missing
}

/** 最小 WebSocket 句柄（Node 22+ 全局 WebSocket；刻意不引第三方类型/依赖）。 */
interface WsLike {
  binaryType: string
  onopen: (() => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send: (data: string) => void
  close: () => void
}

function openWebSocket(url: string): WsLike {
  const ctor = (globalThis as any)?.WebSocket
  if (typeof ctor !== 'function') {
    throw new Error('当前运行时没有全局 WebSocket（需要 Node 22+）；Kokoro 本地引擎无法连接')
  }
  return new ctor(url) as WsLike
}

/**
 * 默认音色在 CPU 上跑 Qwen 时**不再当兜底**。
 *
 * 实测（probe-qwen.mjs，单请求无并发）：CPU sidecar 首包 54485ms、整段 5.1s 音频；
 * 而 `synthesize()` 给默认音色只给 4500ms 就 abort —— 必然失败、白烧 4.5s，
 * 还让 lane 的按句 flush 卡住后面的段（用户听到的就是「念一句之后没了」）。
 * 所以默认音色 + CPU：快速失败并说明原因（要启用请显式设 `TIHU_TTS_CPU_FALLBACK=1`）。
 * 克隆音色（wantsClone）只有本地引擎，永远放行。
 */
export function cpuFallbackBlocked(wantsClone: boolean, backend: string): boolean {
  if (wantsClone) return false
  if (backend !== 'cpu') return false
  return process.env.TIHU_TTS_CPU_FALLBACK !== '1'
}

/**
 * 本地兜底**单独**的首包中止门限（毫秒，0 = 不单独中止，交给 `firstChunkBudget`）。
 * CPU 跑 Qwen 时首包实测 8.75s–54.5s（tts-server.log / probe-qwen），4500ms 只会把每一次
 * 兜底都变成一次空等；CPU 一律不设单独中止，GPU/Q4 保持原来的 4500ms 快速回落。
 */
export function localFallbackAbortMs(wantsClone: boolean, backend: string): number {
  if (wantsClone) return 0
  if (backend === 'cpu' || backend === 'q4') return 0
  return 4_500
}

export interface TihuTtsPaths {
  root: string
  bin: string
  model: string
  codec: string
  serverVoices: string
}

export interface TihuTtsOptions {
  log: (line: string) => void
  /** 工作区（会话 cwd），音色元数据放 `<workspace>/.tihu/voices`。 */
  workspaceOf?: (sessionId: string) => string | undefined
  /** 线程数（默认 4，避开 strata/CPU 专家池）。 */
  threads?: number
  /** sidecar 端口（默认 8731，只绑 127.0.0.1）。 */
  port?: number
  /** 覆盖二进制/模型路径（测试/自定义安装）。 */
  paths?: Partial<TihuTtsPaths>
  /** 关闭 sidecar（测试用）。 */
  disabled?: boolean
}

export interface SynthResult {
  sampleRate: number
  /** 首块到达耗时（毫秒）。 */
  firstChunkMs: number
  /** 总音频时长（毫秒）。 */
  audioMs: number
  /** 合成总耗时（毫秒）。 */
  totalMs: number
  chunks: number
}

export interface VoiceRecord {
  name: string
  serverVoiceId?: string
  sampleRate?: number
  durationMs?: number
  createdAt: number
  note?: string
}

function tihuRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tihu')
}

export function defaultTtsPaths(): TihuTtsPaths {
  const root = tihuRoot()
  return {
    root,
    bin: process.env.TIHU_TTS_SERVER ?? join(root, 'bin', 'tts-server.exe'),
    model: process.env.TIHU_TTS_MODEL ?? join(root, 'models', 'qwen3-tts-0.6b-q4_k_m.gguf'),
    codec: process.env.TIHU_TTS_CODEC ?? join(root, 'models', 'codec-q4_k_m.gguf'),
    serverVoices: process.env.TIHU_TTS_VOICES ?? join(root, 'voices-server'),
  }
}

/** 工作区音色目录。 */
export function voiceDirOf(workspace: string): string {
  return join(workspace, '.tihu', 'voices')
}

/** 音色名只允许安全字符（页面输入已校验，这里再兜一层）。 */
export function normalizeVoiceName(name: string): string | null {
  const value = String(name ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) return null
  if (value === 'default') return null
  return value
}

export function binaryKind(path: string): 'windows' | 'linux' | 'unknown' {
  try {
    const fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    readSync(fd, head, 0, 4, 0)
    closeSync(fd)
    if (head.toString('ascii', 0, 2) === 'MZ') return 'windows'
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'linux'
  } catch { /* 读不到按平台猜 */ }
  return process.platform === 'win32' ? 'windows' : 'linux'
}

/** Windows 路径 → WSL 路径（C:\a\b → /mnt/c/a/b）。 */
export function toWslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) return path.replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

function wslDistro(): string {
  return process.env.TIHU_TTS_WSL_DISTRO ?? 'Ubuntu'
}

/** 确保 WSL 发行版已启动（Stopped 时自动拉起）。 */
function ensureWslRunning(): void {
  const result = spawnSync('wsl.exe', ['-d', wslDistro(), '--', 'true'], { timeout: 30_000, windowsHide: true })
  if (result.status !== 0) {
    const detail = `${result.stderr?.toString('utf8') ?? ''}${result.stdout?.toString('utf8') ?? ''}`.trim()
    throw new Error(`WSL(${wslDistro()}) 启动失败：${detail || result.error?.message || '未知错误'}`)
  }
}

export class TihuTts {
  private options: TihuTtsOptions
  private paths: TihuTtsPaths
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private stderrTail = ''
  private port: number
  private modelLoaded = false
  private lastError = ''
  /** PyTorch sidecar 实际设备（cuda/cpu），启动后由 /health 回填。 */
  private activeDevice: 'cuda' | 'cpu' = (process.env.TIHU_TTS_DEVICE ?? 'cpu') === 'cuda' ? 'cuda' : 'cpu'
  /** 显存不足回落 CPU 的提示（页面事件区用）。 */
  private fallbackNote = ''
  /** GPU 启动/合成失败后本次进程内不再重试（不回退机械音）。 */
  private gpuFailed = false
  /** 实际出声引擎（用于事件标识）：kokoro / gpu(qwen) / edge / none。 */
  private engineInUse: 'kokoro' | 'gpu' | 'edge' | 'none' = 'none'
  private lastLabel = ''
  /** 本地合成串行锁：最多 1 路在合（Kokoro 只用 4 线程，并发只会互相等）。 */
  private localLock: Promise<unknown> = Promise.resolve()

  constructor(options: TihuTtsOptions) {
    this.options = options
    this.paths = { ...defaultTtsPaths(), ...(options.paths ?? {}) }
    this.port = options.port ?? KOKORO_PORT_DEFAULT
  }

  /** 当前实际会启动的后端：kokoro（默认）/ qwen-cuda / q4 / cpu / none。 */
  backend(): 'kokoro' | 'qwen-cuda' | 'q4' | 'cpu' | 'none' {
    if (this.options.disabled) return 'none'
    const engine = ttsEngine()
    if (engine === 'kokoro') return this.kokoroReady() ? 'kokoro' : 'none'
    if (engine === 'edge') return 'none'
    // engine === 'qwen'：只有显式 TIHU_TTS_ENGINE=qwen（或旧值）才走这条遗留路径。
    const legacy = String(process.env.TIHU_TTS_ENGINE ?? '').trim().toLowerCase()
    if (legacy === 'q4' && existsSync(this.paths.bin) && existsSync(this.paths.model) && existsSync(this.paths.codec)) return 'q4'
    if (legacy === 'cpu' && this.qwenReady()) return 'cpu'
    if (this.qwenReady() && !this.gpuFailed) return (process.env.TIHU_TTS_DEVICE ?? 'cpu') === 'cuda' ? 'qwen-cuda' : 'cpu'
    return 'none'
  }

  /** 实际出声引擎（状态屏/事件区用）：kokoro | gpu | edge | none。 */
  activeEngine(): 'kokoro' | 'gpu' | 'edge' | 'none' {
    return this.engineInUse
  }

  /** 本地 Kokoro 是否就绪（缺文件时与 backend() 一致）。 */
  private kokoroReady(): boolean {
    return kokoroMissingFiles().length === 0
  }

  /** 主引擎是不是本地 Kokoro（lane 据此把并发压到 1 路）。 */
  localPrimary(): boolean {
    return this.backend() === 'kokoro' || this.backend() === 'qwen-cuda' || this.backend() === 'cpu' || this.backend() === 'q4'
  }

  private qwenPython(): string {
    return process.env.TIHU_QWEN_PYTHON ?? join(this.paths.root, 'venv', 'Scripts', 'python.exe')
  }

  private qwenServerScript(): string {
    return process.env.TIHU_QWEN_SERVER ?? join(this.paths.root, 'qwen-tts-server.py')
  }

  private qwenModelDir(): string {
    return process.env.TIHU_QWEN_MODEL ?? join(this.paths.root, 'models', 'qwen3-tts-0.6b-pt')
  }

  private qwenReady(): boolean {
    return process.platform === 'win32' &&
      existsSync(this.qwenPython()) &&
      existsSync(this.qwenServerScript()) &&
      existsSync(join(this.qwenModelDir(), 'model.safetensors'))
  }

  /** 引擎是否可用（edge 或本地 Qwen 任一可用）。 */
  available(): boolean {
    return this.edgeReady() || this.backend() !== 'none'
  }

  status(): { available: boolean; model?: string; error?: string } {
    const backend = this.backend()
    const engine = ttsEngine()
    if (backend === 'kokoro') return { available: true, model: 'kokoro multi-lang-v1_1 (sherpa-onnx fp32)' }
    if (engine === 'kokoro') {
      // 缺依赖必须说清「缺哪个文件 + 该跑哪条命令」，不能只报一个空失败。
      const missing = kokoroMissingFiles()
      const reason = `Kokoro 未就绪（缺 ${missing.length} 项：${missing.slice(0, 3).join('；')}${missing.length > 3 ? ' …' : ''}）。${kokoroInstallHint()}`
      if (this.edgeReady()) return { available: true, model: 'edge-tts 云健(Yunjian)', error: reason }
      return { available: false, error: `${reason}；edge 兜底也不可用` }
    }
    if (backend === 'q4') return { available: true, model: 'qwen3-tts 0.6b-q4' }
    if (backend === 'cpu') return { available: true, model: 'qwen3-tts 0.6b-pt' }
    if (backend === 'qwen-cuda') return { available: true, model: 'qwen3-tts 0.6b-cuda' }
    if (this.edgeReady()) return { available: true, model: 'edge-tts 云健(Yunjian)' }
    return {
      available: false,
      error: this.lastError || `无语音：edge 不可用且本地引擎未就绪（${this.paths.root}）`,
    }
  }

  /** 显存不足回落 CPU 的原因（无回落返回空串）。 */
  deviceFallback(): string {
    return this.fallbackNote
  }

  /** 确保 sidecar 已启动并加载完模型。 */
  async ensureServer(): Promise<void> {
    const backend = this.backend()
    if (backend === 'none') return
    if (this.child !== null && this.modelLoaded) return
    if (this.starting !== null) return this.starting
    this.starting = this.startServer().catch((error) => {
      if (backend === 'qwen-cuda') {
        const message = (error as Error)?.message ?? String(error)
        this.gpuFailed = true
        this.fallbackNote = `GPU 不可用：${message}`
        this.log(`tts gpu unavailable: ${message}`)
        return
      }
      throw error
    }).finally(() => { this.starting = null })
    return this.starting
  }

  private async startServer(): Promise<void> {
    await mkdir(this.paths.serverVoices, { recursive: true })
    const port = await this.pickPort()
    this.port = port
    const backend = this.backend()
    if (backend === 'kokoro') {
      await this.startKokoro(port)
      return
    }
    let command = this.paths.bin
    let args = [
      '--model', this.paths.codec,
      '--backbone', this.paths.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--voice-dir', this.paths.serverVoices,
      '--allow-voice-create',
      '--n-threads', String(this.options.threads ?? 4),
      '--segment-bytes', '160',
      '--stream-chunk-ms', String(TTS_CHUNK_MS),
      '--max-frames', '400',
      '--temp', '0.9', '--top-k', '50', '--top-p', '1.0',
      '--repeat-penalty', '1.05', '--repeat-last-n', '4096',
      '--samplers', 'penalties;temperature;top_k;top_p',
    ]
    // Q4 的 Base 模型没有内置音色：用预生成的 speaker 文件作为默认音色（否则必须上传参考音频）。
    if (existsSync(join(this.paths.serverVoices, 'default.gguf'))) {
      args.push('--speaker-file', join(this.paths.serverVoices, 'default.gguf'))
    }
    if (backend === 'qwen-cuda' || backend === 'cpu') {
      command = this.qwenPython()
      args = [
        '-u', this.qwenServerScript(),
        '--model', this.qwenModelDir(),
        '--voices', this.paths.serverVoices,
        '--default-ref', join(this.paths.root, 'default-ref.wav'),
        '--host', '127.0.0.1',
        '--port', String(port),
        '--threads', String(this.options.threads ?? 8),
        '--device', backend === 'cpu' ? 'cpu' : 'cuda',
        '--dtype', process.env.TIHU_TTS_DTYPE ?? (backend === 'cpu' ? 'fp32' : 'bf16'),
      ]
    } else if (process.platform === 'win32' && binaryKind(this.paths.bin) === 'linux') {
      // WSL 里编出来的 Linux ELF：经 wsl.exe 启动，WSL2 的 localhost 转发让 Windows 侧访问 127.0.0.1。
      ensureWslRunning()
      command = 'wsl.exe'
      const libDir = toWslPath(dirname(this.paths.bin))
      args = ['-d', wslDistro(), '--', 'env', `LD_LIBRARY_PATH=${libDir}`, toWslPath(this.paths.bin), ...args.map((arg) => (/^[A-Za-z]:[\\/]/.test(arg) ? toWslPath(arg) : arg))]
    }
    this.log(`starting tts sidecar (${backend}): ${command} (port ${port})`)
    const logPath = join(this.paths.root, 'tts-server.log')
    try { mkdirSync(this.paths.root, { recursive: true }) } catch { /* 忽略 */ }
    const appendLog = (line: string): void => {
      try { appendFileSync(logPath, line) } catch { /* 忽略 */ }
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.stderrTail = ''
    appendLog(`\n[${new Date().toISOString()}] start ${backend} ${command} ${args.join(' ')}\n`)
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      appendLog(text)
    })
    child.stdout?.on('data', (chunk: Buffer) => { appendLog(chunk.toString('utf8')) })
    child.on('exit', (code, signal) => {
      const wasLoaded = this.modelLoaded
      this.child = null
      this.modelLoaded = false
      this.lastError = `本地 TTS 进程退出（code=${code ?? '?'} signal=${signal ?? '-'}）${this.stderrTail ? '：' + this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' ') : ''}`
      if (wasLoaded) this.log(`tts sidecar exited: ${this.lastError}`)
    })

    const started = Date.now()
    for (;;) {
      if (Date.now() - started > HEALTH_TIMEOUT_MS) {
        throw new Error(`本地 TTS 启动超时（${Math.round(HEALTH_TIMEOUT_MS / 1000)}s）：${this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ') || '无输出'}`)
      }
      if (this.child === null) throw new Error(this.lastError || '本地 TTS 进程启动失败')
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) {
          const info = await response.json().catch(() => null) as { device?: string; free_mb?: number } | null
          if (info?.device === 'cuda' || info?.device === 'cpu') {
            const requestedCuda = (process.env.TIHU_TTS_DEVICE ?? 'cuda') !== 'cpu'
            this.activeDevice = info.device
            if (requestedCuda && info.device === 'cpu') {
              this.fallbackNote = `显存不足（可用 ${Math.round(info.free_mb ?? 0)}MB），已回落 CPU 引擎`
            }
          }
          break
        }
      } catch { /* 继续等 */ }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.modelLoaded = true
    this.log(`tts sidecar ready in ${Date.now() - started} ms (port ${this.port})`)
  }

  /**
   * 启动 Kokoro sidecar：仓库内 `scripts/tihu-kokoro-tts-server.py` +
   * `~/.dsh/tihu/venv-sherpa` 的 Python + fp32 权重。常驻进程，模型只加载一次。
   */
  private async startKokoro(port: number): Promise<void> {
    const missing = kokoroMissingFiles()
    if (missing.length > 0) {
      throw new Error(`Kokoro 本地引擎不可用，缺 ${missing.length} 项：${missing.join('；')}。${kokoroInstallHint()}`)
    }
    const assets = kokoroAssetsDir()
    const threads = this.options.threads ?? clampMs(process.env.TIHU_KOKORO_THREADS, 1, 8, 4)
    const command = kokoroPythonPath()
    const args = [
      '-u', kokoroScriptPath(),
      '--model-dir', kokoroModelDir(),
      '--model', kokoroModelPath(),
      '--voices', join(assets, 'voices.bin'),
      '--tokens', join(assets, 'tokens.txt'),
      '--lexicon', [join(assets, 'lexicon-us-en.txt'), join(assets, 'lexicon-zh.txt')].join(','),
      '--data-dir', join(assets, 'espeak-ng-data'),
      '--dict-dir', join(assets, 'dict'),
      '--rule-fsts', [join(assets, 'date-zh.fst'), join(assets, 'phone-zh.fst'), join(assets, 'number-zh.fst')].join(','),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--num-threads', String(threads),
      '--sid', String(kokoroSid()),
    ]
    this.log(`starting tts sidecar (kokoro): ${command} (port ${port}, threads ${threads})`)
    const logPath = join(this.paths.root, 'tts-server.log')
    try { mkdirSync(this.paths.root, { recursive: true }) } catch { /* 忽略 */ }
    const appendLog = (line: string): void => {
      try { appendFileSync(logPath, line) } catch { /* 忽略 */ }
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.stderrTail = ''
    appendLog(`\n[${new Date().toISOString()}] start kokoro ${command} ${args.join(' ')}\n`)
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      appendLog(text)
    })
    child.stdout?.on('data', (chunk: Buffer) => { appendLog(chunk.toString('utf8')) })
    child.on('exit', (code, signal) => {
      const wasLoaded = this.modelLoaded
      this.child = null
      this.modelLoaded = false
      this.lastError = `Kokoro 进程退出（code=${code ?? '?'} signal=${signal ?? '-'}）${this.stderrTail ? '：' + this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' ') : ''}`
      if (wasLoaded) this.log(`tts sidecar exited: ${this.lastError}`)
    })

    const started = Date.now()
    for (;;) {
      if (Date.now() - started > HEALTH_TIMEOUT_MS) {
        throw new Error(`Kokoro 启动超时（${Math.round(HEALTH_TIMEOUT_MS / 1000)}s）：${this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ') || '无输出'}`)
      }
      if (this.child === null) throw new Error(this.lastError || 'Kokoro 进程启动失败')
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) {
          const info = await response.json().catch(() => null) as
            { engine?: string; sample_rate?: number; num_speakers?: number; load_ms?: number } | null
          if (info?.engine === 'kokoro') {
            this.activeDevice = 'cpu'
            this.log(`kokoro health: sr=${info.sample_rate} speakers=${info.num_speakers} load=${info.load_ms}ms`)
            break
          }
        }
      } catch { /* 继续等 */ }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    this.modelLoaded = true
    this.log(`tts sidecar ready in ${Date.now() - started} ms (port ${this.port})`)
  }

  private async pickPort(): Promise<number> {
    const base = this.options.port ?? this.defaultPort()
    for (let offset = 0; offset < 8; offset += 1) {
      const port = base + offset
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) })
        // 已有实例（例如热重载前遗留）：直接复用。
        if (response.ok) {
          this.modelLoaded = true
          return port
        }
      } catch { /* 端口空闲 */ }
      return port
    }
    return base
  }

  /** 默认端口：Kokoro 走 8731（TIHU_TTS_KOKORO_PORT 可挪）；Qwen 沿用 options/DEFAULT_PORT。 */
  private defaultPort(): number {
    if (ttsEngine() === 'kokoro') {
      const raw = Number(process.env.TIHU_TTS_KOKORO_PORT ?? '')
      if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw
      return KOKORO_PORT_DEFAULT
    }
    return DEFAULT_PORT
  }

  /** edge-tts 兜底是否可用（脚本 + Python；ffmpeg 由系统 PATH 提供）。 */
  edgeReady(): boolean {
    return existsSync(this.qwenPython()) && existsSync(join(this.paths.root, 'tihu-edge-tts.py'))
  }

  /** 当前引擎的中文标识（页面事件区）。 */
  engineLabel(voice: string): string {
    if (this.engineInUse === 'kokoro') {
      const sid = kokoroSid(voice)
      return `本地 Kokoro：${kokoroVoiceName(sid)}（sid ${sid}）`
    }
    if (this.engineInUse === 'edge') return '在线兜底：edge-tts 云健(Yunjian)'
    if (this.engineInUse === 'none') return '无语音（仅文字）'
    return `本地 TTS：qwen3-tts 0.6b-cuda / 音色 ${voice || 'default'}`
  }

  /** 引擎切换后取一次提示（空串表示没变化）。 */
  takeEngineNote(): string {
    const label = this.lastLabel
    this.lastLabel = ''
    return label
  }

  /**
   * edge-tts 在线兜底：Python 流式输出 MP3 → ffmpeg 解码 24k PCM。
   * 首块 1.5s 不到立即杀掉，由调用方决定落 Qwen 还是无语音。
   */
  private async synthesizeEdge(
    text: string,
    options: {
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
      edgeVoice?: string
    },
  ): Promise<SynthResult> {
    const started = Date.now()
    const voice = options.edgeVoice || process.env.TIHU_EDGE_VOICE || 'zh-CN-YunjianNeural'
    const py = spawn(this.qwenPython(), ['-u', join(this.paths.root, 'tihu-edge-tts.py'), '--text', text, '--voice', voice], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ff = spawn(process.env.TIHU_FFMPEG ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    py.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    ff.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    py.stdout?.pipe(ff.stdin)
    const chunker = new Pcm16Chunker()
    let chunks = 0
    let bytes = 0
    let firstAt = 0
    /** 外部取消（换绑/被更新的一轮取代）：只杀进程并记账，**不在事件回调里 throw**——
     *  AbortSignal 的监听器抛错会变成 process 级未捕获异常（实测直接崩测试进程）。 */
    let abortedBySignal = false
    const signal = options?.signal
    const onAbort = (): void => {
      abortedBySignal = true
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // 首块门限：见 edgeFirstChunkMs() 的实测依据（12 路并发 p99 3.3s，8s 留 2.4 倍余量）。
    const firstBudgetMs = edgeFirstChunkMs()
    let firstKilled = false
    const firstTimer = setTimeout(() => {
      firstKilled = true
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
    }, firstBudgetMs)
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => resolve()
        ff.stdout?.on('data', (chunk: Buffer) => {
          if (firstAt === 0) { firstAt = Date.now(); clearTimeout(firstTimer) }
          bytes += chunk.length
          for (const block of chunker.push(chunk)) {
            options.onChunk({ data: block, seq: chunks, total: 0, final: false })
            chunks += 1
          }
        })
        ff.on('error', (error) => reject(error))
        ff.on('close', done)
        py.on('close', (code) => {
          if (code !== 0 && firstAt === 0) reject(new Error(`edge-tts 失败（exit ${code}）：${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`))
        })
      })
      const tail = chunker.finish()
      if (abortedBySignal) throw new Error('edge-tts 已取消（本轮朗读被换绑/更新的一轮取代）')
      if (firstAt === 0 && tail.length === 0) {
        // 首块超时单独成一种错：synthesize 只对这种情况重试 edge（别把 403 也白等两轮）。
        if (firstKilled) throw new Error(`edge-tts 首块超时（${firstBudgetMs}ms 未返回音频）`)
        throw new Error(`edge-tts 没有返回音频：${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`)
      }
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final })
        chunks += 1
      }
      const totalMs = Date.now() - started
      const audioMs = Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000)
      if (audioMs < 50) throw new Error('edge-tts 返回音频过短')
      this.log(`edge-tts ok chars=${[...text].length} voice=${voice} first=${firstAt === 0 ? '?' : firstAt - started}ms total=${totalMs}ms audio=${audioMs}ms`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstAt === 0 ? totalMs : firstAt - started, audioMs, totalMs, chunks }
    } catch (error) {
      clearTimeout(firstTimer)
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
      throw error
    } finally {
      clearTimeout(firstTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 合成一段文本并流式输出 PCM 块。
   *
   * 引擎链（2026-11-08 用户拍板）：**Kokoro 本地 → edge 兜底 → （仅显式 qwen）Qwen**。
   * Kokoro 首块超过 `TIHU_LOCAL_FIRST_MS`（默认 2500ms）直接切 edge，不让首句空等。
   * 任一路失败都不静默：向上抛可读错误，lane 发红告警。
   */
  async synthesize(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      edgeVoice?: string
      offlineOnly?: boolean
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    const engine = ttsEngine()
    // Kokoro 没有克隆概念：voice 在这里是音色名/sid（zf_060、35 都算「选音色」，不是克隆）。
    const wantsClone = engine !== 'kokoro' && typeof options.voice === 'string' && options.voice !== '' && options.voice !== 'default'
    const offline = options.offlineOnly === true || process.env.TIHU_OFFLINE_ONLY === '1'
    let localError = ''
    let edgeError = ''

    // ① Kokoro（默认主引擎）。克隆音色不支持（只有 qwen 路径能克隆）。
    if (engine === 'kokoro' && !wantsClone) {
      if (this.backend() === 'kokoro') {
        try {
          const result = await this.synthesizeKokoro(text, options)
          this.setEngine('kokoro')
          return result
        } catch (error) {
          localError = (error as Error)?.message ?? String(error)
          this.lastError = localError
          this.log(`kokoro failed（切 edge 兜底）: ${localError}`)
        }
      } else {
        const missing = kokoroMissingFiles()
        localError = missing.length > 0
          ? `Kokoro 未就绪（缺 ${missing.slice(0, 3).join('；')}）。${kokoroInstallHint()}`
          : 'Kokoro 后端不可用（TIHU_TTS_ENGINE 不是 kokoro 或引擎被禁用）'
        this.log(`kokoro skipped: ${localError}`)
      }
    }

    // ② edge 兜底：音色保持 zh-CN-YunjianNeural（TIHU_EDGE_VOICE 可覆盖），rate 不动。
    if (!wantsClone && !offline && this.edgeReady()) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.synthesizeEdge(text, { ...options, edgeVoice: options.edgeVoice })
          this.setEngine('edge')
          return result
        } catch (error) {
          edgeError = (error as Error)?.message ?? String(error)
          const firstChunkTimeout = edgeError.includes('首块超时')
          const willRetry = firstChunkTimeout && attempt === 0
          this.log(`edge-tts failed${willRetry ? '（首块超时，重试一次 edge）' : ''}: ${edgeError}`)
          if (!willRetry) break
        }
      }
    }

    // ③ Qwen3-TTS 遗留路径：只有显式 TIHU_TTS_ENGINE=qwen（或克隆音色 / 仅离线且无 Kokoro）才走。
    const backend = this.backend()
    if (backend !== 'none' && (engine === 'qwen' || wantsClone || offline)) {
      if (cpuFallbackBlocked(wantsClone, backend)) {
        // 快速失败 + 说清原因：不让每一段都空等行业已成空等的本地兜底（CPU 首包 54s）。
        const reason = '本地 Qwen 跑在 CPU（实测首包 8–54s），已不再作为默认音色的兜底；要用请设 TIHU_TTS_CPU_FALLBACK=1'
        localError = reason
        this.lastError = reason
        this.log(`tts local fallback skipped: ${reason}`)
      } else {
        try {
          const controller = new AbortController()
          const abortMs = localFallbackAbortMs(wantsClone, backend)
          const timer = abortMs > 0 ? setTimeout(() => controller.abort(), abortMs) : null
          try {
            const result = await this.synthesizeCodec(text, { ...options, signal: options.signal ?? controller.signal })
            this.setEngine('gpu')
            return result
          } finally {
            if (timer !== null) clearTimeout(timer)
          }
        } catch (error) {
          localError = (error as Error)?.message ?? String(error)
          this.gpuFailed = true
          this.fallbackNote = `本地 Qwen 失败：${localError}`
          this.log(`tts qwen failed: ${localError}`)
        }
      }
    }

    this.engineInUse = 'none'
    this.lastLabel = '无语音（仅文字）'
    throw new Error(`本次无语音：Kokoro 与 edge 都失败（Kokoro：${localError || '未启用'}；edge：${edgeError || (offline ? '仅离线模式已禁用' : '不可用')}）`)
  }

  private setEngine(engine: 'kokoro' | 'gpu' | 'edge' | 'none'): void {
    this.engineInUse = engine
    this.lastLabel = this.engineLabel('')
  }

  /** 本地合成串行化：同时只允许 1 路在合（多设备/多段排队，绝不 12 路并上 CPU）。 */
  private serializeLocal<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.localLock.then(fn, fn)
    this.localLock = run.then(() => undefined, () => undefined)
    return run
  }

  /** 调用常驻 Kokoro sidecar（内部 WS：JSON 请求 + 二进制 PCM）。 */
  private async synthesizeKokoro(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    await this.ensureServer()
    return this.serializeLocal(() => this.kokoroRequest(text, options))
  }

  private async kokoroRequest(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    const started = Date.now()
    const sid = kokoroSid(options.voice)
    const budget = localFirstChunkMs()
    const chunker = new Pcm16Chunker()
    let chunks = 0
    let bytes = 0
    let firstChunkAt = 0
    const socket = openWebSocket(`ws://127.0.0.1:${this.port}/tts`)
    // 关键：默认 binaryType=blob，PCM 会变成 Blob（拿不到字节）→ 必须改成 arraybuffer。
    socket.binaryType = 'arraybuffer'
    try {
      const meta = await new Promise<{ audio_ms?: number; elapsed_ms?: number; cpu_s?: number }>((resolve, reject) => {
        let settled = false
        const timers: Array<ReturnType<typeof setTimeout>> = []
        const cleanup = (): void => { for (const timer of timers) clearTimeout(timer) }
        const fail = (message: string): void => {
          if (settled) return
          settled = true
          cleanup()
          try { socket.close() } catch { /* 忽略 */ }
          reject(new Error(message))
        }
        socket.onerror = () => fail('Kokoro sidecar 连接失败（WebSocket error）')
        socket.onclose = () => { if (!settled) fail('Kokoro sidecar 提前关闭连接') }
        socket.onopen = () => {
          try {
            socket.send(JSON.stringify({ type: 'synth', id: 1, text, sid, speed: 1.0 }))
          } catch (error) {
            fail(`Kokoro 请求发送失败：${(error as Error)?.message ?? String(error)}`)
          }
        }
        socket.onmessage = (event: { data: unknown }) => {
          const data = event.data
          if (typeof data === 'string') {
            let message: any
            try { message = JSON.parse(data) } catch { return }
            if (message?.type === 'error') {
              fail(`Kokoro 合成失败：${String(message?.message ?? '未知错误')}`)
              return
            }
            if (message?.type === 'done') {
              if (settled) return
              settled = true
              cleanup()
              try { socket.close() } catch { /* 忽略 */ }
              resolve({
                audio_ms: Number(message?.audio_ms) || 0,
                elapsed_ms: Number(message?.elapsed_ms) || 0,
                cpu_s: Number(message?.cpu_s) || 0,
              })
            }
            return
          }
          const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as any)?.buffer ?? [])
          if (view.byteLength === 0) return
          if (firstChunkAt === 0) firstChunkAt = Date.now()
          bytes += view.byteLength
          for (const block of chunker.push(view)) {
            options.onChunk({ data: block, seq: chunks, total: 0, final: false })
            chunks += 1
          }
        }
        timers.push(setTimeout(() => fail(`Kokoro 首块超时（${budget}ms 未返回音频）`), budget))
        timers.push(setTimeout(() => fail('Kokoro 合成超时（60s）'), 60_000))
        const signal = options.signal
        if (signal !== undefined) {
          const onAbort = (): void => fail('已取消（本轮朗读被换绑/更新的一轮取代）')
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      const tail = chunker.finish()
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final })
        chunks += 1
      }
      const totalMs = Date.now() - started
      const audioMs = Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000)
      if (audioMs < 50) throw new Error('Kokoro 没有返回有效音频（少于 50ms）')
      this.log(`kokoro ok chars=${[...text].length} sid=${sid} first=${firstChunkAt === 0 ? '?' : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms server=${meta.elapsed_ms ?? '?'}ms cpu=${meta.cpu_s ?? '?'}s chunks=${chunks}`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks }
    } finally {
      try { socket.close() } catch { /* 忽略 */ }
    }
  }

  private async synthesizeCodec(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    await this.ensureServer()
    const body = {
      model: 'qwen3-tts',
      input: text,
      response_format: 'pcm',
      text: undefined,
      ...(options.voice !== undefined && options.voice !== '' && options.voice !== 'default'
        ? { voice: { id: await this.resolveServerVoice(options.voice, options.sessionId) } }
        : {}),
    }
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const firstChunkBudget = this.backend() === 'q4' || this.backend() === 'cpu' ? 60_000 : 45_000
    const firstTimer = setTimeout(() => controller.abort(), firstChunkBudget)
    let firstChunkAt = 0
    let bytes = 0
    let chunks = 0
    const chunker = new Pcm16Chunker()
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => '')
        throw new Error(`TTS 合成失败 HTTP ${response.status}：${detail.slice(0, 300) || response.statusText}`)
      }
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        if (firstChunkAt === 0) {
          firstChunkAt = Date.now()
          clearTimeout(firstTimer)
        }
        bytes += value.length
        const blocks = chunker.push(value)
        for (const block of blocks) {
          options.onChunk({ data: block, seq: chunks, total: 0, final: false })
          chunks += 1
        }
      }
      const tail = chunker.finish()
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final })
        chunks += 1
      }
      const totalMs = Date.now() - started
      const audioMs = Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000)
      if (audioMs < 50) throw new Error('TTS 没有返回有效音频（少于 50ms）')
      this.log(`tts ok chars=${[...text].length} voice=${options.voice ?? 'default'} first=${firstChunkAt === 0 ? '?' : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms chunks=${chunks}`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks }
    } catch (error) {
      const message = (error as Error)?.name === 'AbortError'
        ? `TTS 合成超时（首块 ${Math.round(firstChunkBudget / 1000)}s 未返回）`
        : String((error as Error)?.message ?? error)
      this.lastError = message
      throw new Error(message)
    } finally {
      clearTimeout(firstTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 把文本切成 TTS 段（与 tts.text 同一套切分）。 */
  segments(text: string): string[] {
    return toTtsSegments(text)
  }

  /* ---------- 音色 ---------- */

  private workspaceDir(sessionId?: string): string {
    const workspace = (sessionId !== undefined ? this.options.workspaceOf?.(sessionId) : undefined) ?? process.cwd()
    return voiceDirOf(workspace)
  }

  /** 列出音色：Kokoro 模式下内置中文音色表 + 默认 + 工作区克隆音色。 */
  async listVoices(sessionId?: string): Promise<VoiceInfo[]> {
    const voices: VoiceInfo[] = [{ name: 'default', kind: 'default', note: this.backend() === 'kokoro' ? `默认 Kokoro ${kokoroVoiceName(kokoroSid())}` : undefined }]
    if (this.backend() === 'kokoro') {
      for (const voice of KOKORO_ZH_VOICES) {
        voices.push({ name: voice.name, kind: 'default', note: `${voice.gender === 'f' ? '中文女声' : '中文男声'} sid ${voice.sid}` })
      }
    }
    const dir = this.workspaceDir(sessionId)
    try {
      const files = await readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const record = JSON.parse(await readFile(join(dir, file), 'utf8')) as VoiceRecord
          const name = normalizeVoiceName(record.name)
          if (name === null) continue
          voices.push({
            name,
            kind: 'cloned',
            durationMs: record.durationMs,
            sampleRate: record.sampleRate,
            createdAt: record.createdAt,
            note: record.note,
          })
        } catch { /* 坏 metadata 跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    voices.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'default' ? -1 : 1))
    return voices
  }

  /** 读取工作区音色的 serverVoiceId（没有则视作未创建）。 */
  async readVoiceRecord(sessionId: string | undefined, name: string): Promise<VoiceRecord | null> {
    const normalized = normalizeVoiceName(name)
    if (normalized === null) return null
    const file = join(this.workspaceDir(sessionId), normalized + '.json')
    try {
      return JSON.parse(await readFile(file, 'utf8')) as VoiceRecord
    } catch {
      return null
    }
  }

  /**
   * 新建/复用克隆音色。
   * 同一 name 已有 serverVoiceId 且 embedding 文件还在 → 直接命中缓存，不再算 speaker。
   */
  async createVoice(
    payload: { name: string; wavBase64: string; note?: string },
    sessionId?: string,
  ): Promise<{ voice: VoiceInfo; cached: boolean }> {
    const name = normalizeVoiceName(payload.name)
    if (name === null) throw new Error('音色名只能包含英文/数字/下划线/短横线，1–32 字，且不能是 default')
    if (this.backend() === 'none') throw new Error('本地 Qwen 引擎未就绪，无法创建克隆音色')
    const dir = this.workspaceDir(sessionId)
    await mkdir(dir, { recursive: true })
    const wav = Buffer.from(payload.wavBase64, 'base64')
    const valid = validateReferenceWav(wav)
    if (!valid.ok) throw new Error('参考音频不合格：' + valid.reason)
    const existing = await this.readVoiceRecord(sessionId, name)
    const embedExt = this.backend() === 'q4' ? '.gguf' : '.embed.pt'
    if (existing?.serverVoiceId !== undefined && existsSync(join(this.paths.serverVoices, existing.serverVoiceId + embedExt))) {
      return {
        voice: { name, kind: 'cloned', durationMs: existing.durationMs, sampleRate: existing.sampleRate, createdAt: existing.createdAt, note: existing.note },
        cached: true,
      }
    }
    await this.ensureServer()
    // multipart 上传到 codec.cpp voice API（它会保存 <id>.gguf embedding）。
    const form = new FormData()
    form.append('name', name)
    form.append('audio_sample', new Blob([wav], { type: 'audio/wav' }), name + '.wav')
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/voices`, { method: 'POST', body: form })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`创建音色失败 HTTP ${response.status}：${detail.slice(0, 300) || response.statusText}`)
    }
    const created = await response.json() as { id?: string }
    const serverVoiceId = typeof created.id === 'string' && created.id !== '' ? created.id : ''
    if (serverVoiceId === '') throw new Error('创建音色失败：sidecar 没有返回 voice id')
    await writeFile(join(dir, name + '.wav'), wav)
    const record: VoiceRecord = {
      name,
      serverVoiceId,
      sampleRate: valid.info.sampleRate,
      durationMs: valid.info.durationMs,
      createdAt: Date.now(),
      ...(payload.note !== undefined && payload.note !== '' ? { note: payload.note.slice(0, 120) } : {}),
    }
    await writeFile(join(dir, name + '.json'), JSON.stringify(record, null, 2), 'utf8')
    this.log(`tts voice created name=${name} serverVoiceId=${serverVoiceId} duration=${valid.info.durationMs}ms`)
    return {
      voice: { name, kind: 'cloned', durationMs: record.durationMs, sampleRate: record.sampleRate, createdAt: record.createdAt, note: record.note },
      cached: false,
    }
  }

  private async resolveServerVoice(name: string, sessionId?: string): Promise<string> {
    const record = await this.readVoiceRecord(sessionId, name)
    if (record === null || record.serverVoiceId === undefined || record.serverVoiceId === '') {
      throw new Error(`音色 ${name} 没有可用的 embedding，请重新上传参考音频`)
    }
    if (!existsSync(join(this.paths.serverVoices, record.serverVoiceId + (this.backend() === 'q4' ? '.gguf' : '.embed.pt')))) {
      throw new Error(`音色 ${name} 的 embedding 已丢失，请重新上传参考音频`)
    }
    return record.serverVoiceId
  }

  /** 关掉 sidecar（插件卸载/热重载）。 */
  dispose(): void {
    const child = this.child
    this.child = null
    this.modelLoaded = false
    if (child !== null) {
      try { child.kill() } catch { /* 忽略 */ }
    }
  }

  private log(line: string): void {
    try { this.options.log(line) } catch { /* 忽略 */ }
  }
}
