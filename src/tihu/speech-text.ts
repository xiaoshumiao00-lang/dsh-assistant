/**
 * 送 TTS 前的文本清洗（屏幕显示仍用原文）。
 *
 * 目标：去掉 markdown 标记、链接语法、emoji/符号，只留可朗读的人类语言；
 * 清洗后为空时调用方不得合成空串（按「无语音（仅文字）」处理）。
 */
/** 只去掉 harness/工具噪音（XML 元数据、英文执行日志、坐标、图片哈希行），保留 markdown。 */
export function stripToolNoise(input: string): string {
  let text = String(input ?? '')
  // harness/Computer Use 元数据：XML 标签（含成对内容）整条去掉。
  text = text.replace(/<([a-zA-Z][a-zA-Z0-9_-]*)>[\s\S]*?<\/\1>/g, ' ')
  text = text.replace(/<[^>\s]+\/?>/g, ' ')
  // 英文工具执行日志 / 坐标 / 图片与哈希元数据行：整行丢弃。
  const noisyLine = /^\s*(?:[✓✗]\s*)?(?:Waited\s+\d|Clicked screen|Pressed hotkey|Opened https?|Opened app|Coordinates remain|position\s*\[|\[image omitted|\(sha256:|Normalized copy|image\/png|read-only copy|(?:screenshot|wait|long_wait|click|hotkey|scroll|drag|input_text|open_in_browser|open_in_finder|open_app|list_apps|code_agent|ask_user_question|skill|present|working_directory|web_search|web_fetch|截图|等待|长等待|点击|按键|滚动|拖拽|输入文字|打开网页|打开文件\/目录|打开应用|列出应用|派发后台任务|等待确认|加载技能|记忆操作|展示结果|切换目录|搜索|抓取网页)\s*$)/i
  text = text.split(/\r?\n/).filter((line) => !noisyLine.test(line)).join('\n')
  // 行内残留坐标描述。
  text = text.replace(/Coordinates remain\s+[\d-]+\s*[-–]\s*\d+/gi, ' ')
  text = text.replace(/position\s*\[[^\]]*\]/gi, ' ')
  return text
}

export function toSpeechText(markdown: string): string {
  let text = stripToolNoise(markdown)
  // 代码块围栏（保留内容，去掉 ```lang 与 ```）
  text = text.replace(/```[^\n]*\n?/g, ' ')
  // 图片 ![alt](url) → 去掉（图片不可朗读）
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
  // 链接 [文字](url) → 文字
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 裸 URL → 「链接」
  text = text.replace(/https?:\/\/[^\s)）]+/gi, '链接')
  // 行内代码 / 加粗 / 斜体 / 删除线
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)([^*_]+)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  // 标题、引用、列表、表格线、分隔线
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
  text = text.replace(/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, ' '))
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
  text = text.replace(/\|/g, ' ')
  // emoji / 符号类（含 ZWJ、变体选择符、键帽、杂项符号）
  text = text.replace(/[\p{Extended_Pictographic}\p{So}\uFE0F\u200D\u20E3]/gu, '')
  text = text.replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
  // 归一化空白，避免连续停顿
  text = text.replace(/\s+/g, ' ').trim()
  return text
}
