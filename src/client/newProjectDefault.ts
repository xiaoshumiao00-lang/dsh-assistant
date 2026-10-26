/** 新建项目对话框的默认项目文件夹：用户不手动选择文件夹时，
 *  自动在 D:\陈潘HBEU\Desktop\删除 下新建一个以当前时间命名（YYYYMMDDHHmm）的子文件夹。
 *  纯函数 + 宿主目录列检查，无 react 依赖，可 node 单元测试。 */
import { joinPath, basenameOf } from './pathutil'

/** 新建项目默认父目录（用户指定 2026-09-27） */
export const DEFAULT_NEW_PROJECT_PARENT = 'D:\\陈潘HBEU\\Desktop\\删除'

/** 把当前（或给定）时间格式化为 YYYYMMDDHHmm，如 202609271401 = 2026年9月27日14:01 */
export function stampFolderName(d: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`
}

/** 默认父目录下是否已存在名为 name 的子文件夹（用宿主 /api/worktable/fs 目录列；请求失败视为不存在） */
export async function defaultChildExists(name: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl('/api/worktable/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: DEFAULT_NEW_PROJECT_PARENT }),
    })
    if (!r.ok) return false
    const d = (await r.json()) as { entries?: { name?: string }[] }
    const entries = Array.isArray(d?.entries) ? d.entries : []
    return entries.some((e) => e != null && e.name === name)
  } catch {
    return false
  }
}

/** 计算默认项目文件夹：当前时间戳命名的子文件夹；名字已被占用（同分钟建两次）时依次追加 -2/-3… 直到不重名 */
export async function defaultProjectFolder(fetchImpl?: typeof fetch): Promise<string> {
  const base = stampFolderName()
  let name = base
  let n = 2
  while (await defaultChildExists(name, fetchImpl)) {
    name = `${base}-${n}`
    n += 1
  }
  return joinPath(DEFAULT_NEW_PROJECT_PARENT, name)
}

/** 新建项目弹窗未填名称时的默认项目名 = 项目文件夹名（默认文件夹下 = 当前时间戳，与文件夹名一致；
 *  手动选的文件夹则取该文件夹名；尾分隔符等取不到名的边缘情形回退当前时间戳） */
export function defaultProjectName(folderPath: string): string {
  const b = basenameOf(folderPath.trim().replace(/[\\/]+$/, ''))
  return b || stampFolderName()
}
