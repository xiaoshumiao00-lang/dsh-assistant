/**
 * 鹈鹕端「云端音色」（edge-tts 的 zh-CN-*Neural）唯一清单。
 *
 * 为什么单列一个文件：同一批名字有四个消费方，谁都不想互相拖依赖——
 *   1. 设置页「个人助手 → 鹈鹕端」的默认云音色下拉（浏览器 bundle，不能带 node:fs）；
 *   2. 宿主侧本机配置校验（`assistant-config.ts`）；
 *   3. 合成链路（`tts.ts` 的 edge 兜底/主用音色）；
 *   4. 设备模拟页（`page.ts` 的音色下拉文案）。
 * 所以这里只放纯数据 + 纯函数：不 import 任何 node 内置模块，也不 import 别的 tihu 文件。
 *
 * 本地 Kokoro 音色（`zf_*` / `zm_*` / 0–102 的 sid）**不属于**云端音色：
 * `isTihuCloudVoice()` 对它们一律 false，设置页因此不可能把本地音色写进「默认云音色」。
 */

/** 一条云端音色。`id` 是 edge-tts 的 voice 名（原样传给 python 脚本）。 */
export interface TihuCloudVoice {
  readonly id: string
  readonly label: string
  /** 中文短名（「云健」「晓晓」）：屏上文案与试听句里用，别塞整个 label。 */
  readonly short: string
}

/**
 * 云端音色清单。改这里 = 设置页下拉、设备页下拉、校验白名单同时改。
 * 与 2026-11-10 之前设备页写死的那 4 项逐字一致（顺序也一样，别调）。
 */
export const TIHU_CLOUD_VOICES: readonly TihuCloudVoice[] = [
  { id: 'zh-CN-YunjianNeural', label: '云健 Yunjian（男声）', short: '云健' },
  { id: 'zh-CN-YunxiNeural', label: '云希 Yunxi（男声）', short: '云希' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 Xiaoxiao（女声）', short: '晓晓' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 Yunyang（男声）', short: '云扬' },
]

/**
 * 没配置任何值时的云端音色：**晓晓**（2026-11-11 用户拍板，替换原来的云健）。
 *
 * 与 `设备页下拉的默认项`、`tihuSampleTextOf('')`、`tts.status()` 的引擎名一致；
 * 配置了 `tihu.voice.edge` 的人仍然听自己选的那个（见 `edge-voice.ts` 的优先级）。
 */
export const TIHU_CLOUD_VOICE_DEFAULT = 'zh-CN-XiaoxiaoNeural'

/** 是不是清单里的云端音色（本地 Kokoro 的 zf_/zm_/sid 一律 false）。 */
export function isTihuCloudVoice(raw?: unknown): boolean {
  const value = String(raw ?? '').trim()
  if (value === '') return false
  return TIHU_CLOUD_VOICES.some((voice) => voice.id === value)
}

/** 云端音色的显示名（未知 id 原样返回，空值给默认音色的名字）。 */
export function tihuCloudVoiceLabel(raw?: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') return tihuCloudVoiceLabel(TIHU_CLOUD_VOICE_DEFAULT)
  return TIHU_CLOUD_VOICES.find((voice) => voice.id === value)?.label ?? value
}

/** 云端音色的中文短名（「云健」）：拼句子用；未知 id 也退回默认音色的短名。 */
export function tihuCloudVoiceShortName(raw?: unknown): string {
  const value = String(raw ?? '').trim()
  const hit = TIHU_CLOUD_VOICES.find((voice) => voice.id === value)
  if (hit !== undefined) return hit.short
  return TIHU_CLOUD_VOICES.find((voice) => voice.id === TIHU_CLOUD_VOICE_DEFAULT)?.short ?? '云健'
}
