/**
 * 送 TTS 前的文本清洗（屏幕显示仍用原文）。
 *
 * 目标：去掉 markdown 标记、链接语法、emoji/符号，只留可朗读的人类语言；
 * 清洗后为空时调用方不得合成空串（按「无语音（仅文字）」处理）。
 */
export function toSpeechText(markdown: string): string {
  let text = String(markdown ?? '')
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
