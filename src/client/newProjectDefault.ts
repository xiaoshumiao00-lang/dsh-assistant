/** 新建项目对话框的默认项目文件夹：用户不手动选择文件夹时，
 *  自动在「本机默认项目父目录」（本地配置文件里的 `newProjectParent`）下新建一个
 *  以当前时间命名（YYYYMMDDHHmm）的子文件夹。
 *  仓库里不再写死个人目录：值来自 `~/.dsh/assistant/config.json`（不入库），
 *  由宿主 `/api/assistant/config` 下发、页面缓存；没有本机配置时按「平台 Desktop
 *  或助手目录下的 projects/」回落（宿主侧回落，见 src/assistant-config.ts）。
 *  纯函数 + 宿主目录列检查，无 react 依赖，可 node 单元测试。 */
import { joinPath, basenameOf } from './pathutil.ts'
import { loadAssistantConfig, newProjectParentSync } from './assistant-config.ts'

/** 已解析到的默认父目录（没有本机配置时是空串）。 */
export function configuredNewProjectParent(): string {
  return newProjectParentSync()
}

/** 异步解析默认父目录：先缓存，再向宿主要（宿主会按本机配置 / Desktop / 助手目录决定）。 */
export async function resolveNewProjectParent(fetchImpl: typeof fetch = fetch): Promise<string> {
  const local = configuredNewProjectParent()
  if (local) return local
  const config = await loadAssistantConfig(fetchImpl)
  return config?.newProjectParent ?? ''
}

/** 把当前（或给定）时间格式化为 YYYYMMDDHHmm，如 202609271401 = 2026年9月27日14:01 */
export function stampFolderName(d: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`
}

/** 默认父目录下是否已存在名为 name 的子文件夹（用宿主 /api/worktable/fs 目录列；请求失败视为不存在） */
export async function defaultChildExists(name: string, parent: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!parent) return false
  try {
    const r = await fetchImpl('/api/worktable/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: parent }),
    })
    if (!r.ok) return false
    const d = (await r.json()) as { entries?: { name?: string }[] }
    const entries = Array.isArray(d?.entries) ? d.entries : []
    return entries.some((e) => e != null && e.name === name)
  } catch {
    return false
  }
}

/** 计算默认项目文件夹：当前时间戳命名的子文件夹；名字已被占用（同分钟建两次）时依次追加 -2/-3… 直到不重名。
 *  默认父目录解析不到时返回空串（调用方不预填，用户仍可「选择位置…」手动挑）。 */
export async function defaultProjectFolder(fetchImpl?: typeof fetch): Promise<string> {
  const parent = await resolveNewProjectParent(fetchImpl)
  if (!parent) return ''
  const base = stampFolderName()
  let name = base
  let n = 2
  while (await defaultChildExists(name, parent, fetchImpl ?? fetch)) {
    name = `${base}-${n}`
    n += 1
  }
  return joinPath(parent, name)
}

/** 新建项目弹窗未填名称时的默认项目名 = 项目文件夹名（默认文件夹下 = 当前时间戳，与文件夹名一致；
 *  手动选的文件夹则取该文件夹名；尾分隔符等取不到名的边缘情形回退当前时间戳） */
export function defaultProjectName(folderPath: string): string {
  const b = basenameOf(folderPath.trim().replace(/[\\/]+$/, ''))
  return b || stampFolderName()
}

/** 归一比对键：Windows 下大小写不敏感、`/` 与 `\` 混用，统一成小写反斜杠。 */
function pathKey(p: string): string {
  return String(p ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 是否是本插件自动生成的默认项目文件夹（默认父目录下的 YYYYMMDDHHmm / YYYYMMDDHHmm-n）。
 *  用途：弹窗关了没保存时这个时间戳已经过时，重开必须重新生成，否则两个项目会落到同一个文件夹。
 *  @param parent 默认父目录；不传时取本机已解析的值（解析不到就不判自动，避免误认别人的目录）。 */
export function isAutoProjectFolder(folderPath: string, parent: string = configuredNewProjectParent()): boolean {
  const key = pathKey(folderPath)
  const parentKey = pathKey(parent)
  if (!key || !parentKey || !key.startsWith(parentKey + '\\')) return false
  return /^\d{12}(-\d+)?$/.test(key.slice(parentKey.length + 1))
}

/**
 * 手机端「选择位置」抽屉的起始目录：
 *   - 空值 → 默认父目录（本机配置里的 newProjectParent，未配置时空串 = 由调用方决定退让）；
 *   - 本插件自动生成的**待创建**时间戳目录 → 默认父目录：这个目录要等保存时才 mkdir，
 *     直接把它当起点会让宿主 fs.list 抛 ENOENT，选择器一打开就是「无法读取目录」；
 *   - 其它（用户手动选过 / 已存在的真实目录）→ 原样，从那里继续往下浏览。
 */
export function projectFolderBrowseStart(
  folderPath: string | null | undefined,
  fallback: string = configuredNewProjectParent(),
): string {
  const wanted = String(folderPath ?? '').trim()
  if (!wanted) return fallback
  // 自动目录（时间戳子目录）的父目录按定义就是默认父目录：直接给规范化的默认父目录，
  // 免得尾分隔符 / 正反斜杠混写时算出一个带混合分隔符的路径。
  if (isAutoProjectFolder(wanted, fallback)) return fallback
  return wanted
}
