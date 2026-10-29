/**
 * 私人助手在控制室里的那张卡片（纯逻辑，无 React / 无宿主依赖，便于单测）。
 *
 * 为什么把助手做成一张**普通项目卡**而不是新的卡片类型：
 *   - 项目卡=文件夹+布局+绑定会话，助手正好是一个固定目录里的常驻会话；
 *   - 状态灯、实时进度、运行时长、子代理数、会话列表、＋新建、重命名、隐藏、删除、
 *     拖拽排序——全部白拿，不用为助手再写一遍；
 *   - 归入项目文件夹后，助手会话不会再被「正在运行」临时卡片收走，两者不打架。
 *
 * 三条硬规矩：
 *   1. 按**文件夹**判重（不按 id）：用户手工把同一目录加成项目时不能出现两张卡；
 *   2. 删除墓碑（projects.removed）优先级最高：用户删过就不再自动重建；
 *   3. 建卡只动 layouts / folders / iconOverrides / order，不碰绑定与视图。
 */
import { normalizeFolderPath } from './sessionFolder.ts'

/** 固定 id：删除墓碑与跨端同步都靠它。 */
export const ASSISTANT_PROJECT_ID = 'wt-assistant'
export const ASSISTANT_CARD_NAME = '私人助手'
export const ASSISTANT_CARD_ICON = '🤖'

/** 只读投影：判重/判墓碑要用到的字段（真实项目状态字段更多，原样透传）。 */
export interface AssistantCardState {
  layouts: { id: string }[]
  folders: Record<string, string>
  iconOverrides: Record<string, string>
  order: string[]
  removed: string[]
}

/** 已有项目卡覆盖了助手目录？（Windows 大小写不敏感、分隔符与尾斜杠归一） */
export function hasAssistantFolder(projects: AssistantCardState, home: string): boolean {
  const target = normalizeFolderPath(home).toLowerCase()
  if (target === '') return false
  return projects.layouts.some((layout) => normalizeFolderPath(projects.folders[layout.id] ?? '').toLowerCase() === target)
}

/** 该不该建卡（不看 layout，纯判定）。 */
export function shouldAddAssistantCard(projects: AssistantCardState, home: string): boolean {
  if (normalizeFolderPath(home) === '') return false
  if (projects.removed.includes(ASSISTANT_PROJECT_ID)) return false
  return !hasAssistantFolder(projects, home)
}

/**
 * 返回加上助手卡之后的新状态；不需要加时原样返回同一个对象（调用方可据此跳过写盘）。
 * @param layout 调用方用现有 buildLayout 建好的布局（id / icon 已按助手卡设定）。
 */
export function withAssistantCard<T extends AssistantCardState>(projects: T, home: string, layout: { id: string }): T {
  if (!shouldAddAssistantCard(projects, home)) return projects
  return {
    ...projects,
    layouts: [...projects.layouts, layout],
    folders: { ...projects.folders, [ASSISTANT_PROJECT_ID]: home },
    iconOverrides: { ...projects.iconOverrides, [ASSISTANT_PROJECT_ID]: ASSISTANT_CARD_ICON },
    order: [ASSISTANT_PROJECT_ID, ...projects.order.filter((id) => id !== ASSISTANT_PROJECT_ID)],
  } as T
}
