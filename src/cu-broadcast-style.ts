/**
 * Computer Use 会话的「语音播报友好」系统提示词（鹈鹕 ESP 语音助手）。
 *
 * 背景：CU 会话的回复会同时出现在两种很窄的出口上——
 *   - 鹈鹕（tihu）2.4″ 320×240 小屏：一屏放不下长文，正文按像素折行；
 *   - 本地 TTS 朗读：markdown 符号、表格、代码块、列表、emoji 读出来是噪音。
 * 所以给 CU 会话追加一段风格约束：短、口语、先结论、少过程汇报。
 *
 * 挂载方式与宿主内嵌 computer-use 一致（vendor/computer-use/index.js:1196）：
 *   ctx.systemPrompt.section({ name, order, text: (context) => string })
 * 回调里 `context.agent?.session` 是当前会话，返回空字符串即「本段不生效」。
 * CU 策略段 order=1750，这里取 1800（紧随其后，先有策略再谈表达）。
 */

/** CU 会话判定用的 preset id（与 src/tihu/lane.ts 的 TIHU_COMPUTER_USE_PRESET 同值）。 */
export const CU_COMPUTER_USE_PRESET = 'computer-use'

/**
 * 约束文案。
 *
 * 四条要点分别对应真实故障：①小屏与 TTS 都吃不下长文；②符号会被念出来；
 * ③路径/命令念歪了没法照做；④逐步汇报会把屏幕刷成流水账、朗读拖长。
 */
export const CU_BROADCAST_STYLE_TEXT = [
  '本次会话的回复会显示在 320×240 的小屏上，并由语音朗读出来，请按下面的风格作答。',
  '一、正文控制在 150 字以内，先给结论，只留关键信息；确实需要更多内容时，先给一两句结论再问用户要不要细节。',
  '二、用口语化短句，使用正常的中文标点（逗号、句号、问号等），保证屏幕上易读；不要用 markdown、表格、列表、代码块和表情符号（任务本身要求写代码、写文档或展示表格时除外）。',
  '三、文件路径、命令、网址、错误信息保留原文照写，不要翻译或改写，方便用户直接复制或照着读。',
  '四、操作过程少汇报，不要逐步列举点了哪里、读了哪个文件；做完用一两句话总结结果。',
].join('\n')

/** 宽松取一个 preset 字符串：直接字段 / header / 投影（字符串、{val}、{value}）。 */
function presetOfSession(source: any): string {
  if (source === null || source === undefined) return ''
  const direct = source.agentPreset
  if (typeof direct === 'string' && direct !== '') return direct
  const viaHeader = source.header?.agentPreset
  if (typeof viaHeader === 'string' && viaHeader !== '') return viaHeader
  // 投影形态：{ agentPreset: { val } } / { values: { agentPreset } } / { values: { agentPreset: { val } } }
  for (const candidate of [source.projection?.values?.agentPreset, source.projection?.agentPreset, source.values?.agentPreset]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (candidate !== null && typeof candidate === 'object') {
      const inner = candidate.val ?? candidate.value
      if (typeof inner === 'string' && inner !== '') return inner
    }
  }
  return ''
}

/**
 * 这条会话是不是 Computer Use 模式。
 *
 * 故意做**宽松**判定：宿主不同版本把 preset 放在 header、投影缓存或投影
 * provider 的 values 里，任一命中就当作 CU——宁可多给一段风格约束，
 * 也不要因为形状变化让鹈鹕的回复又变回长文。
 */
export function isComputerUseSessionForPrompt(session: any): boolean {
  return presetOfSession(session) === CU_COMPUTER_USE_PRESET
}

/**
 * 注册系统提示词段落。宿主没有 systemPrompt 服务或没有 section 方法时
 * 只记一条警告并静默返回——绝不能因为提示词注册失败让整个插件起不来。
 *
 * @returns 注销函数（宿主给了就返回，没给返回 undefined）。
 */
export function registerCuBroadcastStyle(ctx: any, log?: (line: string) => void): (() => void) | undefined {
  const warn = typeof log === 'function' ? log : () => {}
  let systemPrompt: any
  try {
    systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
  } catch {
    systemPrompt = ctx?.systemPrompt
  }
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') {
    warn('[dsh-assistant] 没有 systemPrompt 服务：跳过 CU 语音播报风格提示（不影响插件其它功能）')
    return undefined
  }
  try {
    const off = systemPrompt.section({
      name: 'tihu:broadcast-style',
      order: 1800,
      text: (context: any) => (isComputerUseSessionForPrompt(context?.agent?.session) ? CU_BROADCAST_STYLE_TEXT : ''),
    })
    return typeof off === 'function' ? off : undefined
  } catch (error) {
    warn(`[dsh-assistant] CU 语音播报风格提示注册失败：${(error as Error)?.message ?? String(error)}`)
    return undefined
  }
}
