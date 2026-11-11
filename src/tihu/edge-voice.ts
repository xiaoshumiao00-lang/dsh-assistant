/**
 * 鹈鹕端「edge 云音色」的唯一解析入口 —— 谁生效、从哪来，只有这一个答案。
 *
 * 2026-11-11 实机根因（`问题一`）：设备听到的不是晓晓。查下来是三层叠在一起：
 *   1. `scripts/tihu-edge-tts.py` 的 aiohttp 走了 aiodns/AsyncResolver，本机 pycares
 *      起不来 DNS，edge-tts 每次 exit 3 → 宿主判定 edge 失败 → 回落本地 Kokoro；
 *      （已在该脚本里改成 ThreadedResolver，见 `_force_threaded_resolver`）
 *   2. 仓库默认常量还是 `zh-CN-YunjianNeural`，没配置的机器听到的是云健；
 *   3. 设备页 `voice.select` 会把它 localStorage 里的旧音色推上来，把 config 压掉。
 *
 * 现在优先级**只有一条**（高 → 低）：
 *   `TIHU_EDGE_VOICE`（临时排障） > `config.json` 的 `tihu.voice.edge` > 默认晓晓。
 * 设备页/`tihu_device_settings` 的临时切换只在「config 与 env 都没指定」时才被接受，
 * 否则一律忽略并写明原因（日志 `tihu tts: 引擎=edge 音色=... 来源=config|default`）。
 *
 * 只认清单里的云端音色；本地 Kokoro（`zf_*` / `zm_*` / 数字 sid）即使被手写进配置也当没配。
 */
import { loadAssistantConfig } from '../assistant-config.ts'
import { TIHU_CLOUD_VOICE_DEFAULT, isTihuCloudVoice } from './cloud-voices.ts'

/** 音色来源（日志里的 `来源=`）。`device` 只可能来自设备页/设备设置工具。 */
export type TihuEdgeVoiceSource = 'env' | 'config' | 'default' | 'device'

/** 一次解析结果：最终音色 + 它从哪来。 */
export interface TihuEdgeVoiceResolution {
  voice: string
  source: TihuEdgeVoiceSource
}

/** 只做纯判断（不读盘）：环境变量 → 配置值 → 默认晓晓。 */
export function resolveTihuEdgeVoice(envVoice?: string, configuredVoice?: string): TihuEdgeVoiceResolution {
  const env = String(envVoice ?? '').trim()
  if (env !== '') return { voice: env, source: 'env' }
  const configured = String(configuredVoice ?? '').trim()
  if (isTihuCloudVoice(configured)) return { voice: configured, source: 'config' }
  return { voice: TIHU_CLOUD_VOICE_DEFAULT, source: 'default' }
}

/** 真实运行时的解析：读 `TIHU_EDGE_VOICE` 与 `~/.dsh/assistant/config.json` 的 `tihu.voice.edge`。 */
export function tihuEdgeVoiceResolution(): TihuEdgeVoiceResolution {
  const env = (globalThis as any).process?.env?.TIHU_EDGE_VOICE
  let configured = ''
  try {
    configured = String((loadAssistantConfig().tihu as any)?.voice?.edge ?? '')
  } catch {
    // 读盘失败按「没配置」处理：默认晓晓，绝不让一个坏配置整条链路没声。
    configured = ''
  }
  return resolveTihuEdgeVoice(env, configured)
}

/** 兼容旧调用：只要最终音色字符串。 */
export function tihuEdgeVoiceDefault(): string {
  return tihuEdgeVoiceResolution().voice
}

/** 那条明确日志（一行，字段固定，便于 grep）。 */
export function edgeVoiceLogLine(engine: string, voice: string, source: TihuEdgeVoiceSource): string {
  return `tihu tts: 引擎=${engine} 音色=${voice} 来源=${source}`
}
