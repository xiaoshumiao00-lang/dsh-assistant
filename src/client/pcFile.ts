/** 手机端会话输入框「电脑文件」附件的纯逻辑（默认目录、大小、MIME）。
 *  真正读盘由主机 RPC/本地文件路由完成，浏览器只消费字节并交给官方附件管线。 */

/** 与 /api/worktable/file 的读取上限一致；与悬浮球上传的 25 MB 不同，
 *  这里是先下载到手机再交给官方上传，过大文件会明显拖慢手机。 */
export const PC_FILE_MAX_BYTES = 20 * 1024 * 1024

/** 会话所在项目文件夹优先；没有 cwd 时返回空串，让主机回退到用户 HOME。 */
export function pcFileStartPath(cwd: string | null | undefined): string {
  return String(cwd ?? '').trim()
}

/** sessions.list 的 cwd 可能拍平在行上，也可能在 projectionValues / projections.values。 */
export function sessionCwdOf(row: any): string {
  return pcFileStartPath(
    row?.cwd
    ?? row?.projectionValues?.cwd
    ?? row?.projections?.values?.cwd
    ?? '',
  )
}

export function isPcFileTooLarge(size: number | null | undefined, max = PC_FILE_MAX_BYTES): boolean {
  const n = Number(size)
  return Number.isFinite(n) && n > max
}

/**
 * 宿主把「添加」分组的固定命令名写死，第三方命令只能排在「指令」末尾。
 * 在空查询菜单里把电脑文件提到首行，并沿用首行分组标题；输入检索词时保持原生排序。
 */
export function hoistPcFileMenuItem<T extends { name?: string; section?: string }>(rows: readonly T[], query: string): T[] {
  const out = [...rows]
  if (query !== '') return out
  const index = out.findIndex((row) => row?.name === 'file-pc')
  if (index <= 0) return out
  const [item] = out.splice(index, 1)
  const first = out[0]
  const moved = { ...item, section: first?.section } as T
  out.unshift(moved)
  return out
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/**
 * 读取本地路由的 Content-Type；缺失或泛型时按扩展名补一次。
 * 图片必须拿到 image/* 才会进入官方图片草稿，其余类型由官方当文件上传。
 */
export function pcFileMime(name: string, contentType?: string | null): string {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (declared !== '' && declared !== 'application/octet-stream') return declared
  const clean = String(name ?? '').replace(/[?#].*$/, '')
  const dot = clean.lastIndexOf('.')
  const ext = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}
