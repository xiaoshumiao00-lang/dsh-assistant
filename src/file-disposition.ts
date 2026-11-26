/**
 * 本地文件路由的「怎么打开」口径（2026-11-26 需求：秘书回复卡里的图片/附件能在手机点开）。
 *
 * 为什么要有这一层：`/api/worktable/file` 以前只给 content-type，浏览器（尤其手机）拿不到
 * 「这是个文件、还是就在标签页里显示」的信号——
 *   - 图片 / pdf / svg / 文本：`inline`，弹出来的标签页自己就能看；
 *   - docx / xlsx / pptx / zip 等其余一切：`attachment` + 文件名，手机浏览器才会下载文件、
 *     下载完点一下就能弹系统的「用哪个应用打开」。
 * 文件名一律再补一份 RFC 5987 的 `filename*=UTF-8''<百分号编码>`：中文名必须原样传到手机，
 * 只写 ASCII 的 filename 会被写成下划线（安卓 WebView 与部分浏览器只认 filename*）。
 * ASCII 那份保留作老浏览器兜底（控制字符 / 非 ASCII 一律换成下划线，顺带挡掉 CR/LF 注入）。
 */

import { basename, extname } from 'node:path'

/** 能在标签页里直接显示的扩展名（inline）；不在这里的一律 attachment。 */
export const INLINE_FILE_EXTENSIONS = [
  'txt', 'log', 'md', 'markdown', 'json', 'csv', 'xml', 'html', 'htm', 'css', 'js', 'mjs',
  'pdf', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'mp3', 'mp4', 'webm', 'woff', 'woff2', 'ttf', 'otf', 'wasm',
]

const INLINE_FILE_EXTENSION_SET = new Set(INLINE_FILE_EXTENSIONS)

/** 路径/文件名 → 小写扩展名（不含点）；没有扩展名回空串。 */
export function fileExtensionOf(nameOrPath: string): string {
  const value = String(nameOrPath ?? '').trim()
  if (value === '') return ''
  const ext = extname(value)
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase()
}

/** 该扩展名用 inline 还是 attachment（纯函数，单测直接验）。 */
export function fileDispositionType(ext: string): 'inline' | 'attachment' {
  return INLINE_FILE_EXTENSION_SET.has(String(ext ?? '').trim().toLowerCase()) ? 'inline' : 'attachment'
}

/** RFC 5987：encodeURIComponent 之后还要把 `'()*!` 也百分号编码，否则部分浏览器解析失败。 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * 组装 content-disposition 的值（纯函数，单测直接验）：
 *   `attachment; filename="report_2026.docx"; filename*=UTF-8''report_2026.docx`
 * type 缺省时按扩展名判；filename 取 basename（不带目录，避免任何注入面）。
 */
export function contentDispositionValue(nameOrPath: string, ext?: string): string {
  const full = String(nameOrPath ?? '').trim()
  const name = basename(full) === '' ? 'file' : basename(full)
  const type = fileDispositionType(ext ?? fileExtensionOf(name))
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

/** 路由里直接用的响应头值（按绝对路径判类型）。 */
export function contentDispositionHeaderFor(absPath: string): string {
  return contentDispositionValue(absPath, fileExtensionOf(absPath))
}

/** 供 scripts/test-*.mjs 离线验的纯函数出口（不碰文件系统、不碰 http）。 */
export const fileDispositionTestSurface = {
  INLINE_FILE_EXTENSIONS,
  fileExtensionOf,
  fileDispositionType,
  contentDispositionValue,
  contentDispositionHeaderFor,
}
