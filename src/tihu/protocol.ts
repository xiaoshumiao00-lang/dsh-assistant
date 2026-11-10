/**
 * 鹈鹕（tihu）设备协议 v0 —— 手机/浏览器模拟设备 ⇄ 宿主 lane 的唯一线格式。
 *
 * 设计约束（P0）：
 *   - 所有消息统一信封 `{ v, type, id, seq, ts, payload }`；`v` 恒为 "0"。
 *   - **字段只增不删**：解析器只校验必需字段，多出来的字段原样保留（新固件可以
 *     带旧宿主不认识的字段，旧宿主不认识就忽略，不能因此判整条消息非法）。
 *   - **未知 type 必须忽略**：`parseUpstream()` 对不认识的 type、坏 JSON、超长的
 *     文本一律返回 `null`，绝不抛错——设备端以后加消息类型时，老宿主不能崩。
 *   - 上行：hello / audio.frame / text.input / session.end / screen.gesture /
 *     voice.* / tts.sample / task.reply / ping。
 *   - 下行：transcript / tts.audio / screen.frame / event.progress / event.alert /
 *     session.bound / voice.* / task.* / pong。设备屏上不存在任何「授权请求」消息。
 *
 * 2026-11-09 统一指挥：页面开机发裸 hello，宿主绑到唯一的指挥会话；设备只认任务七屏，
 * 没有会话选择器、没有授权屏。协议仍遵守「字段只增不删、未知 type 忽略」。
 *
 * 为什么单独一层：P1 要换成真板子（ESP32-S3-BOX-3）固件，协议必须能脱离
 * WebSocket 实现被单测覆盖——`scripts/test-tihu-protocol.mjs` 直接 import 本文件。
 */

/** 协议版本。设备与宿主不一致时由 hello 的 `protocol` 字段拒绝（见 lane）。 */
export const TIHU_PROTOCOL_VERSION = '0' as const

/** 触摸坐标上限（与 screen-spec 的 320×240 同一事实来源）。 */
const SCREEN_BOUNDS = { widthPx: 320, heightPx: 240 } as const

/** 越界坐标钳到 [0, max]：页面缩放/横屏错位时可能发出负值或超屏的点，忽略会永远点不中。 */
function clampCoord(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)))
}

/** 上行消息类型（设备 → 宿主）。 */
export const TIHU_UPSTREAM_TYPES = [
  'hello',
  'audio.frame',
  'text.input',
  'session.end',
  'screen.gesture',
  'voice.list',
  'voice.create',
  'voice.select',
  'tts.sample',
  'task.reply',
  'ping',
] as const
/** 下行消息类型（宿主 → 设备）。 */
export const TIHU_DOWNSTREAM_TYPES = [
  'transcript',
  'tts.audio',
  'screen.frame',
  'event.progress',
  'event.alert',
  'session.bound',
  'voice.list',
  'voice.created',
  'task.list',
  'task.update',
  'task.notify',
  'pong',
] as const

export type TihuUpstreamType = (typeof TIHU_UPSTREAM_TYPES)[number]
export type TihuDownstreamType = (typeof TIHU_DOWNSTREAM_TYPES)[number]

/** 统一信封。`id` 由发送方生成（设备端可用随机十六进制），`seq` 单调递增。 */
export interface TihuEnvelope<T extends string, P> {
  /** 协议版本，恒为 "0"。 */
  v: typeof TIHU_PROTOCOL_VERSION
  /** 消息类型。 */
  type: T
  /** 消息 id（回声用：设备回执带回原消息 id）。 */
  id: string
  /** 发送方自增序号，便于发现丢帧；宿主不依赖它排序。 */
  seq: number
  /** 毫秒时间戳（设备本地时钟即可，宿主只用于日志）。 */
  ts: number
  /** 载荷。 */
  payload: P
}

/* ---------- 上行载荷（设备 → 宿主） ---------- */

/** 能力声明：设备自报支持哪些下行能力（宿主据此决定要不要发 TTS）。 */
export interface TihuCapabilities {
  /** 能本地朗读（浏览器 speechSynthesis / P1 的本地 VITS）。 */
  tts?: boolean
  /** 有屏幕，能渲染 screen.frame。 */
  screen?: boolean
  /** 有麦克风（浏览器 getUserMedia 可用）。 */
  microphone?: boolean
  /** 能播放音频文件（P1 的 Opus 下行）。 */
  speaker?: boolean
}

export interface HelloPayload {
  /** 设备唯一标识：P0 用浏览器 localStorage 生成的随机串，P1 用 MAC。 */
  clientId: string
  /** 设备端实现版本（模拟页 / 固件版本号，仅日志用）。 */
  clientVersion?: string
  /** 设备实现的协议版本，必须等于 TIHU_PROTOCOL_VERSION。 */
  protocol?: string
  /** 能力集合。 */
  capabilities?: TihuCapabilities
  /** 设备名（屏上显示用）。 */
  deviceName?: string
  /**
   * 目标会话 id。模拟页按 URL ?session= → 本 origin 的 `dsh.tihu.session` →
   * 宽松读一次 `dsh.sessions.current` 的顺序取；宿主会校验它是否存在
   * （不存在回 session.invalid，页面退回屏下选择器）。
   */
  sessionId?: string
  /**
   * 自动跟随模式（2026-11-07）：不带 sessionId 时由宿主自动绑定「最近活跃的
   * Computer Use 会话」，并在每次注入前重新判定、变化即跟随。
   */
  auto?: boolean
}

/** 一段 WAV 音频：16 kHz / 单声道 / 16 bit，base64（不含 data: 前缀）。 */
export interface AudioFramePayload {
  /** 编码格式；P0 只接受 wav（P1 加 opus）。 */
  format: 'wav'
  /** 采样率，必须 16000（官方 speech 服务按 16k 校验）。 */
  sampleRate: number
  /** 声道数，必须 1。 */
  channels: number
  /** 位深，必须 16。 */
  bits: number
  /** 裸 base64（标准字母表，无换行）。 */
  audioBase64: string
  /** 时长（毫秒），仅日志与上限判断。 */
  durationMs?: number
}

export interface TextInputPayload {
  /** 文本（文字兜底输入，或设备侧已转写的文本）。 */
  text: string
  /** 来源：语音转写 / 键盘输入 / 撤回重说。 */
  source?: 'voice' | 'keyboard' | 'retry'
}

export interface PingPayload {
  /** 设备生成的随机数，宿主原样回在 pong 里。 */
  nonce?: string
}

/* ---------- 下行载荷（宿主 → 设备） ---------- */

export interface TranscriptPayload {
  /** 转写文本。 */
  text: string
  /** 是否最终结果（P0 只有最终结果；P1 接流式时先落中间态）。 */
  final: boolean
  /** 来源。 */
  source: 'voice' | 'keyboard'
  /** 是否允许设备「撤回重说」（转写错误时）。 */
  retryable?: boolean
}

/**
 * 本地 TTS 的 PCM 音频块（宿主 → 页面）。
 *
 * 流式：`seq` 从 0 单调递增，每块约 120 ms；整句合成完之前就发首块。
 * `total`/`final` 在流结束时补上（流式时 total 未知，先给 0）。
 */
export interface TtsAudioPayload {
  /** 本段语音内的块序号（0 起）。 */
  seq: number
  /** 总块数（流式过程中未知时为 0）。 */
  total: number
  /** 采样率（固定 24000）。 */
  sampleRate: 24000
  /** 声道（固定单声道）。 */
  channels: 1
  /** 采样格式（固定 pcm16 = signed little-endian 16bit）。 */
  format: 'pcm16'
  /** PCM 数据（base64）。 */
  data: string
  /** 对应的 tts.text 段序号，页面据此取消该段的 speechSynthesis 兜底。 */
  index?: number
  /** 本块文本（可选，便于页面显示/重读）。 */
  text?: string
  /** 本块文本在整段回复里的字符区间（用于正文滚动/高亮）。 */
  charStart?: number
  charEnd?: number
  /**
   * 这段音频念的是什么：`done` = 完成页正文朗读（页面据此把「青底行」对齐到真实播放）。
   * 缺省 = 普通播报（一句话播报 / 试听），不推进完成页高亮。
   */
  read?: 'done'
  /** 是否为最后一块。 */
  final?: boolean
  /**
   * 试听音频（`tts.sample` 的应答）：页面据此播放但**不写进本轮朗读缓存**，
   * 也不推进正文高亮——试听不算一轮回复。
   */
  sample?: true
}

/** 可选音色（默认音色 + 克隆音色）。 */
export interface VoiceInfo {
  /** 页面用的名字（默认音色固定 `default`）。 */
  name: string
  /** default | cloned */
  kind: 'default' | 'cloned'
  /** 参考音频时长（毫秒，仅克隆音色）。 */
  durationMs?: number
  /** 参考音频采样率。 */
  sampleRate?: number
  /** 创建时间（毫秒）。 */
  createdAt?: number
  /** 备注。 */
  note?: string
}

/** 下行：音色列表。 */
export interface VoiceListPayload {
  voices: VoiceInfo[]
  /** 当前选中的音色（页面本地选择，宿主不强制）。 */
  selected?: string
  /** 本地 TTS 引擎状态；不可用时页面直接走系统语音。 */
  engine: { available: boolean; model?: string; error?: string }
}

/** 上行：新建克隆音色。 */
export interface VoiceCreatePayload {
  /** 音色名（页面名，英文/数字/下划线，1–32 字）。 */
  name: string
  /** 参考音频 WAV base64（16k 或 24k 单声道 16bit，3–10 秒）。 */
  wavBase64: string
  /** 备注。 */
  note?: string
}

/** 上行：选择音色（页面下拉框）。 */
export interface VoiceSelectPayload {
  name: string
  /** edge-tts 兜底音色（zh-CN-...Neural），不填用默认云健。 */
  edgeVoice?: string
  /** 仅离线：禁用 edge-tts，只走本地 Qwen。 */
  offlineOnly?: boolean
}

/** 上行：试听（请宿主合成一句示例语音，走与正式朗读同一条 TTS 链路）。 */
export interface TtsSamplePayload {
  /** 自定义示例语句；不填就用宿主默认的「试听：我是云健，声音正常吗？」。 */
  text?: string
}

/** 下行：克隆音色已创建。 */
export interface VoiceCreatedPayload {
  voice: VoiceInfo
  /** 是否直接命中缓存（第二次同音色）。 */
  cached?: boolean
}

/** 320×240 屏幕帧：阶段标签 / 标题 / 要点行 / 进度数字。 */
export interface ScreenFramePayload {
  /** 阶段标签，如「聆听」「思考」「动手」「完成」。主页屏这一行现在空着（不给文本）：
   *  首页最上方那一行是页面自己画的「本地时钟 HH:MM + 三格信号柱」（用户 2026-11-08 确认），
   *  宿主不推时间、也不推连接状态，更没有「项目 总数 个 · 第 x/y 页」那一行。
   *  朗读屏这行是文案（页面在末尾自己接上窗口位置「· 起始行/总行」）。 */
  stage: string
  /** 标题（一行，最多约 18 个汉字）。 */
  title: string
  /** 要点行（每条最多约 20 个汉字，P0 最多 4 条）。 */
  bullets: string[]
  /** 进度：已完成 / 总数；没有总量的阶段给 done。 */
  progress?: { done: number; total?: number }
  /** 视觉基调：idle | busy | ok | alert（warn＝待决策/追问的琥珀色）。 */
  tone?: 'idle' | 'busy' | 'ok' | 'alert' | 'warn'
  /** 屏幕模式：home=任务棋盘（含空态）；status=状态屏。 */
  mode?: 'home' | 'status'
  /** 底部按钮（停止 / 重读 / 回棋盘…；由屏帧自己给）。 */
  actions?: { id: string; label: string }[]
  /** 屏末尾有几行是「统计行」：页面按 statsFontPx 小 2 号字号渲染。 */
  statsTail?: number

  /**
   * 任务棋盘投影（屏 1，含空态）。有它就代表这一帧是棋盘：
   * `empty: true` 是同一个版式的空态（不另开一屏）。
   */
  board?: TaskBoardPayload
  /**
   * 三拍小圆点（派单回执用）：已入队 → 排队 2 个 → 开始跑。
   * 页面按 state 画实心/空心，不自己推断进度。
   */
  steps?: { label: string; state: 'done' | 'active' | 'pending' }[]
  /**
   * 倒计时条（派单回执 5 秒回棋盘、待决策 60 秒按默认项）。
   * `totalSeconds` 不给就按 `seconds` 画满。
   */
  countdown?: { seconds: number; totalSeconds?: number; text?: string }
  /** 完成屏右端「另有 N 条 ▸」（其它完成收进状态行，不再单独占一条气泡带）。 */
  more?: { count: number; text: string }
  /** 屏 7 歧义候选卡（项目名＋来源，序号 1/2）。 */
  ask?: { candidates?: { index: number; projectName: string; source: string }[] }
  /**
   * 完成屏正文（7 行窗口）：按像素折好的回答摘要行 ＋ 当前朗读行。
   * 状态行写「完成 · N/M」，大标题是任务/会话标题（不是回答第一句）。
   * `ranges` 是每一行在朗读文本里的字符区间（码点下标，与 `tts.audio.charStart/charEnd`
   * 同一坐标系）：页面据此把「正在播的那段 PCM」换算成行，高亮跟着真实播放走。
   */
  done?: { lines: string[]; current?: number; ranges?: number[][] }
  /** 这一帧属于哪条任务（屏上点按/答问句时用它回 task.reply）。 */
  taskId?: string
}

export interface ProgressPayload {
  /** 阶段。 */
  stage: string
  /** 一行事件文本。 */
  text: string
  /** 可选进度数字。 */
  done?: number
  /** 可选总量。 */
  total?: number
}

export interface AlertPayload {
  /** 级别。 */
  level: 'info' | 'warn' | 'error'
  /** 一行告警文本。 */
  text: string
}

export interface SessionEndPayload {
  /** 要结束的会话；不填则用设备 hello 里绑定的那个。 */
  sessionId?: string
  /** 结束原因（页面按钮 / 超时 / 设备主动）。仅日志用。 */
  reason?: string
}

/** 上行：绑定一个会话，或切回「自动跟随」。 */
/** 屏幕手势：上/下滑（滚动历史）与点击（预留）。 */
export type ScreenGesturePayload =
  | { action: 'swipe'; dy: number; phase: 'start' | 'move' | 'end' }
  | { action: 'tap'; x: number; y: number; hit?: 'screen' | 'action' | 'task'; actionId?: string; taskId?: string }

/** 下行：绑定成功（宿主是权威，标题/是否 live/模式以这里为准）。 */
export interface SessionBoundPayload {
  sessionId: string
  /** 会话名；拿不到时为空串（页面显示短 id）。 */
  title: string
  /** 项目名（cwd 目录名）；主页屏底部「已绑定：<项目名>」用，禁止裸会话 id。 */
  project?: string
  /** 会话当前是否在宿主内存里（没打开的话语音注入前要先在桌面打开）。 */
  live?: boolean
  /** agent preset（`agentPreset` 投影）。 */
  preset?: string
  /** 是否 Computer Use 模式；false 时页面必须显示醒目提示。 */
  computerUse?: boolean
  /** 是否自动跟随模式绑定的。 */
  auto?: boolean
  /** 这次绑定是否因为「最活跃的 CU 会话变了」而自动跟随（页面提示「已自动跟随到」）。 */
  followed?: boolean
}

/* ---------- 任务登记簿（Task Ledger）投影 ----------
 *
 * 2026-11-09 统一指挥会话：屏与播报的事实源从「会话 id」换成「任务 id」。
 * 这三个下行类型是登记簿的线格式；`screen.frame.board` 是它的屏投影（页面按它画任务棋盘），
 * `task.list` / `task.update` / `task.notify` 给固件与后续页面用同一份数据，不另造形状。
 */

/** 任务状态（屏上胶囊文案就是它的中文映射，见 task-ledger.ts 的 capsuleOf）。 */
/**
 * 任务七态（设计 §5）：排队 → 派单 → 执行中 → 待决策 → 完成 → 已播报 → 归档。
 * `announced` 是「完成且已播过」；归档在登记簿里用 `archived`（不移入下行屏）。
 */
export type TaskState = 'queued' | 'dispatched' | 'running' | 'awaiting' | 'done' | 'announced'

/** 棋盘一行（任务棋盘：屏 1）。 */
export interface TaskBoardRow {
  /** 稳定短号（屏与播报都用它）。 */
  taskId: string
  /** 一句话意图（规范化后的短语）。 */
  title: string
  /** 状态（文字胶囊的依据，不只靠颜色）。 */
  state: TaskState
  /** 胶囊文字：排队 / 执行中 / 待决策 / 完成。 */
  capsule: string
  /** 副行：「项目 · 第 N 步」。 */
  sub: string
  /**
   * 右端时长环：percent 0–1（满圈＝30 分钟），tone 决定颜色语义。
   * empty＝排队（空环）、done＝满环、warn＝跑久了（转琥珀）、normal＝进行中。
   */
  ring: { percent: number; tone: 'normal' | 'warn' | 'done' | 'empty' }
  /** 待决策行的琥珀问号徽标。 */
  badge?: 'ask'
  /** 子代理还在跑的数量（>0 时状态图形外侧加一圈缓慢旋转的短弧；不写文字）。 */
  subagents?: number
  /** 最近 8 步耗时（毫秒）：棋盘微条，只做节奏感，不参与状态。 */
  micro?: number[]
}

/** 任务棋盘整屏。 */
export interface TaskBoardPayload {
  rows: TaskBoardRow[]
  /** 顶行三段计数（在跑 / 等你 / 排队）。 */
  counts: { running: number; awaiting: number; queued: number }
  page: { index: number; total: number }
  total: number
  /** 一个任务都没有：同一版式的空态（不另开一屏）。 */
  empty: boolean
}

/** 下行：整张棋盘（主页数据源）。 */
export interface TaskListPayload {
  board: TaskBoardPayload
}

/** 下行：单行变更（替代按会话帧刷屏）。 */
export interface TaskUpdatePayload {
  taskId: string
  state: TaskState
  capsule: string
  sub: string
  ring: { percent: number; tone: 'normal' | 'warn' | 'done' | 'empty' }
  /** 结果摘要（完成时的一行话，不是正文）。 */
  summary?: string
}

/** 播报优先级：P0 需要人（打断）／P1 完成／P2 里程碑／P3 进度（不播）。 */
export type TaskNotifyLevel = 0 | 1 | 2 | 3

/** 下行：通知总线 → 屏与播报。 */
export interface TaskNotifyPayload {
  level: TaskNotifyLevel
  taskId: string
  /** 一句播报/气泡文案。 */
  text: string
  /** 气泡 id（点气泡＝看这条任务，不切会话）。 */
  bubbleId?: string
  /** 这句是否已经交给语音播报（8 秒窗口合并后的结果）。 */
  spoken: boolean
}

/** 上行：设备上点选项 / 答问句 / 轻命令 → 回指挥会话（不是回任务会话）。 */
export interface TaskReplyPayload {
  /** 目标任务；缺省由登记簿按「当前屏上这条」解析。 */
  taskId?: string
  /** 点了第几个选项（0 起，与 confirm.ask 的 options 同序）。 */
  optionIndex?: number
  /** 自由文本回答（等价于手输）。 */
  text?: string
  /** 轻命令：看任务／回棋盘／撤单／停止。 */
  command?: 'open' | 'board' | 'cancel' | 'stop'
}

/* ---------- 消息联合类型 ---------- */


export type TihuUpstreamMessage =
  | TihuEnvelope<'hello', HelloPayload>
  | TihuEnvelope<'audio.frame', AudioFramePayload>
  | TihuEnvelope<'text.input', TextInputPayload>
  | TihuEnvelope<'session.end', SessionEndPayload>
  | TihuEnvelope<'screen.gesture', ScreenGesturePayload>
  | TihuEnvelope<'voice.list', Record<string, never>>
  | TihuEnvelope<'voice.create', VoiceCreatePayload>
  | TihuEnvelope<'voice.select', VoiceSelectPayload>
  | TihuEnvelope<'tts.sample', TtsSamplePayload>
  | TihuEnvelope<'task.reply', TaskReplyPayload>
  | TihuEnvelope<'ping', PingPayload>

export type TihuDownstreamMessage =
  | TihuEnvelope<'transcript', TranscriptPayload>
  | TihuEnvelope<'tts.audio', TtsAudioPayload>
  | TihuEnvelope<'screen.frame', ScreenFramePayload>
  | TihuEnvelope<'event.progress', ProgressPayload>
  | TihuEnvelope<'event.alert', AlertPayload>
  | TihuEnvelope<'session.bound', SessionBoundPayload>
  | TihuEnvelope<'voice.list', VoiceListPayload>
  | TihuEnvelope<'voice.created', VoiceCreatedPayload>
  | TihuEnvelope<'task.list', TaskListPayload>
  | TihuEnvelope<'task.update', TaskUpdatePayload>
  | TihuEnvelope<'task.notify', TaskNotifyPayload>
  | TihuEnvelope<'pong', PingPayload>

/* ---------- 解析与构造 ---------- */

/** 单条消息上限：音频 base64 最大 4 MB（≈ 官方 speech 的 maxAudioBytes），文本 64 KB。 */
export const TIHU_MAX_MESSAGE_BYTES = 6 * 1024 * 1024
/** 文本输入上限（字符）。 */
export const TIHU_MAX_TEXT_CHARS = 4000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 信封骨架是否成立（不校验 payload）。坏数据一律 false，不抛错。 */
export function isTihuEnvelope(value: unknown): value is TihuEnvelope<string, unknown> {
  if (!isObject(value)) return false
  if (value.v !== TIHU_PROTOCOL_VERSION) return false
  if (typeof value.type !== 'string' || value.type === '') return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return false
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return false
  return isObject(value.payload)
}

/** 从 base64 中取出 WAV 头四个字节，判断是不是 RIFF/WAVE。 */
export function looksLikeWavBase64(audioBase64: string): boolean {
  if (typeof audioBase64 !== 'string' || audioBase64.length < 12) return false
  // "UklGR" 是 "RIFF" 的 base64 前缀；"V0FWR" 是 "WAVE"（第 9 字节起）的 base64 片段。
  return audioBase64.startsWith('UklGR')
}

/**
 * 解析一条上行消息。
 *
 * 返回值：
 *   - 合法且认识的类型 → 信封对象（多出来的字段保留）；
 *   - 未知 type / 坏 JSON / 字段缺失 / 超限 → `null`（调用方必须当「忽略」处理）。
 *
 * 任何情况下都不抛错——设备端不能把宿主打崩。
 */
export function parseUpstream(raw: unknown): TihuUpstreamMessage | null {
  try {
    let value: unknown = raw
    if (typeof raw === 'string') {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null
      value = JSON.parse(raw)
    } else if (Buffer.isBuffer(raw)) {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null
      value = JSON.parse(raw.toString('utf8'))
    }
    if (!isTihuEnvelope(value)) return null
    const type = value.type
    if (!(TIHU_UPSTREAM_TYPES as readonly string[]).includes(type)) return null
    const payload = value.payload as Record<string, unknown>

    switch (type) {
      case 'hello': {
        if (typeof payload.clientId !== 'string' || payload.clientId === '') return null
        if (payload.clientId.length > 200) return null
        if (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || payload.sessionId.length > 256)) return null
        if (payload.auto !== undefined && typeof payload.auto !== 'boolean') return null
        if (payload.capabilities !== undefined && !isObject(payload.capabilities)) return null
        return value as TihuUpstreamMessage
      }
      case 'audio.frame': {
        if (typeof payload.audioBase64 !== 'string' || payload.audioBase64 === '') return null
        if (payload.audioBase64.length > TIHU_MAX_MESSAGE_BYTES) return null
        if (payload.format !== 'wav') return null
        if (payload.sampleRate !== 16000 || payload.channels !== 1 || payload.bits !== 16) return null
        return value as TihuUpstreamMessage
      }
      case 'text.input': {
        if (typeof payload.text !== 'string') return null
        if (payload.text.length > TIHU_MAX_TEXT_CHARS) return null
        return value as TihuUpstreamMessage
      }
      case 'session.end': {
        // 结束本次语音会话：只带可选的 sessionId（不填就用设备绑定的那个）。
        if (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || payload.sessionId.length > 256)) return null
        if (payload.reason !== undefined && typeof payload.reason !== 'string') return null
        return value as TihuUpstreamMessage
      }
      case 'voice.list': return value as TihuUpstreamMessage
      case 'tts.sample': {
        // 试听：text 可选；给了就必须是短句（最长 200 字），超长/类型不对整条忽略。
        if (payload.text !== undefined) {
          if (typeof payload.text !== 'string' || payload.text.length > 200) return null
        }
        return value as TihuUpstreamMessage
      }
      case 'voice.select': {
        if (typeof payload.name !== 'string' || payload.name === '' || payload.name.length > 32) return null
        if (payload.edgeVoice !== undefined && (typeof payload.edgeVoice !== 'string' || payload.edgeVoice.length > 64)) return null
        if (payload.offlineOnly !== undefined && typeof payload.offlineOnly !== 'boolean') return null
        return value as TihuUpstreamMessage
      }
      case 'voice.create': {
        if (typeof payload.name !== 'string' || payload.name === '' || payload.name.length > 32) return null
        if (!/^[A-Za-z0-9_-]+$/.test(payload.name)) return null
        if (typeof payload.wavBase64 !== 'string' || payload.wavBase64 === '') return null
        if (payload.wavBase64.length > TIHU_MAX_MESSAGE_BYTES) return null
        if (payload.note !== undefined && typeof payload.note !== 'string') return null
        return value as TihuUpstreamMessage
      }
      case 'screen.gesture': {
        if (payload.action === 'swipe') {
          if (typeof payload.dy !== 'number' || !Number.isFinite(payload.dy)) return null
          if (payload.phase !== 'start' && payload.phase !== 'move' && payload.phase !== 'end') return null
          return value as TihuUpstreamMessage
        }
        if (payload.action === 'tap') {
          if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return null
          if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return null
          if (payload.hit !== undefined && payload.hit !== 'screen' && payload.hit !== 'action' && payload.hit !== 'task') return null
          if (payload.actionId !== undefined && (typeof payload.actionId !== 'string' || payload.actionId.length > 32)) return null
          if (payload.taskId !== undefined && (typeof payload.taskId !== 'string' || payload.taskId.length > 64)) return null
          // 钳制而不是丢弃：页面在真机缩放/横屏下会发出负值或超出 320×240 的点，
          // 直接忽略等于怎么点都没反应（2026-11-07 审计 P2-手势越界）。
          return {
            ...value,
            payload: {
              ...payload,
              x: clampCoord(payload.x, SCREEN_BOUNDS.widthPx),
              y: clampCoord(payload.y, SCREEN_BOUNDS.heightPx),
            },
          } as TihuUpstreamMessage
        }
        return null
      }
      case 'task.reply': {
        // 回指挥会话的答复：必须至少带一样实质内容（选项/文本/命令），全空就是坏帧。
        if (payload.taskId !== undefined && (typeof payload.taskId !== 'string' || payload.taskId.length > 64)) return null
        if (payload.optionIndex !== undefined) {
          if (typeof payload.optionIndex !== 'number' || !Number.isSafeInteger(payload.optionIndex)) return null
          if (payload.optionIndex < 0 || payload.optionIndex > 8) return null
        }
        if (payload.text !== undefined && (typeof payload.text !== 'string' || payload.text.length > TIHU_MAX_TEXT_CHARS)) return null
        if (payload.command !== undefined && payload.command !== 'open' && payload.command !== 'board' && payload.command !== 'cancel' && payload.command !== 'stop') return null
        if (payload.optionIndex === undefined && payload.text === undefined && payload.command === undefined) return null
        return value as TihuUpstreamMessage
      }
      case 'ping': return value as TihuUpstreamMessage
      default: return null
    }
  } catch {
    return null
  }
}

/** 递增序号生成器（每个连接一个）。 */
export function createSeq(): () => number {
  let seq = 0
  return () => { seq += 1; return seq }
}

/** 构造一条下行消息。`id` 不给就随机生成。 */
export function buildDownstream<T extends TihuDownstreamType, P>(
  type: T,
  payload: P,
  seq: number,
  id?: string,
): TihuEnvelope<T, P> {
  return {
    v: TIHU_PROTOCOL_VERSION,
    type,
    id: id ?? randomId('srv'),
    seq,
    ts: Date.now(),
    payload,
  }
}

/** 构造一条上行消息（模拟页与单测共用，保证两端线格式一致）。 */
export function buildUpstream<T extends TihuUpstreamType, P>(
  type: T,
  payload: P,
  seq: number,
  id?: string,
): TihuEnvelope<T, P> {
  return {
    v: TIHU_PROTOCOL_VERSION,
    type,
    id: id ?? randomId('dev'),
    seq,
    ts: Date.now(),
    payload,
  }
}

/** 短随机 id（不依赖 crypto.randomUUID：老 Safari/Android WebView 没有）。 */
export function randomId(prefix = 'tihu'): string {
  const rand = Math.random().toString(16).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/**
 * 日志用摘要：**绝不把 audioBase64 打进日志**（一条 4 MB base64 会把日志撑爆，
 * 且音频属于用户隐私）。其它字段照常。
 */
export function summarizeForLog(message: { type?: unknown; id?: unknown; payload?: unknown }): string {
  const type = typeof message?.type === 'string' ? message.type : '?'
  const id = typeof message?.id === 'string' ? message.id.slice(0, 40) : '?'
  const payload = isObject(message?.payload) ? { ...message.payload } : {}
  if (typeof payload.audioBase64 === 'string') payload.audioBase64 = `<${payload.audioBase64.length} 字符>`
  let body = ''
  try { body = JSON.stringify(payload).slice(0, 300) } catch { body = '<unserializable>' }
  return `${type}#${id} ${body}`
}

/* ---------- 屏幕帧辅助 ---------- */

/** 把一段回复切成适合 320×240 屏显示的要点行（按标点断句，最多 max 条）。 */
export function toBullets(text: string, max = 4, perLine = 20): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  const sentences = clean.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const sentence of sentences) {
    if (out.length >= max) break
    out.push(sentence.length > perLine ? `${sentence.slice(0, perLine)}…` : sentence)
  }
  if (out.length === 0) out.push(clean.slice(0, perLine))
  return out
}

/** 把长回复按句切成若干段给 TTS（每段不超过 perSegment 字符，P0 最多 maxSegments 段）。 */
/**
 * 把长回复按句切成 TTS 段（每段不超过 `perSegment` 字符）。
 *
 * 2026-11-07 修：**不再限制段数**。旧实现 `maxSegments = 4` 会把 320 字以后的
 * 内容直接丢弃（用户实测「只念几句就没了」）。现在默认切完全部文本，`index/total`
 * 由调用方按完整数组下发；超长无标点单句仍按 `perSegment` 硬切。
 */
export function toTtsSegments(text: string, perSegment = 80, maxSegments = Number.POSITIVE_INFINITY): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  const parts: string[] = []
  let rest = clean
  while (rest !== '' && parts.length < maxSegments) {
    if (rest.length <= perSegment) { parts.push(rest); break }
    // 在 perSegment 内找**最后一个**句末标点；找不到（或太靠前）就硬切。
    const window = rest.slice(0, perSegment)
    const match = window.match(/^[\s\S]*[。！？；!?;]/)
    const boundary = match === null ? 0 : match[0].length
    const cut = boundary >= Math.ceil(perSegment * 0.5) ? boundary : perSegment
    const safeCut = Math.max(1, Math.min(cut, rest.length))
    parts.push(rest.slice(0, safeCut).trim())
    rest = rest.slice(safeCut).trim()
  }
  return parts.filter(Boolean)
}
