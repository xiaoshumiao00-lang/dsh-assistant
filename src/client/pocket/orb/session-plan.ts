// 悬浮球的会话选取策略（纯逻辑，无 DOM / 无宿主依赖，便于单测）：
//   1. 什么算「空白的未命名会话」；
//   2. 会话历史列表里如何隐藏它们（只影响悬浮球展示，不删除、不归档任何会话）；
//   3. 要开新会话时先在同目录的既有空白会话里复用哪一个。
//
// 背景：主机的会话投影带 `blank` 标记（该会话还没有任何一轮对话）。
// 桌面端侧栏本来就只显示「当前那一条」空白会话；悬浮球此前既不隐藏也不复用，
// 于是每次点开/发送都会留下一条裸目录的未命名会话，连点几次就是一串。

export interface SessionLike {
  sessionId: string
  title?: string | null
  cwd?: string | null
  running?: boolean
  pinned?: boolean
  archived?: boolean
  /** 主机投影：该会话尚无内容（真正的「空白会话」）。 */
  blank?: boolean
  updatedAt?: number
  agentPreset?: string
}

/** 目录比对键：分隔符统一（Windows 上 `/` 与 `\` 混用）、去尾部斜杠、大小写不敏感。
 * 只用于比对，不改写真实路径。 */
export function cwdKey(cwd?: string | null): string {
  return String(cwd ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 预设比对键：空串/缺省与 'standard' 都归为标准模式（主机默认），
 * 其余按预设 id 精确比对。悬浮球「新建」必须沿用选中会话的模式，这条键就是模式判据。 */
export function presetKey(preset?: string | null): string {
  const key = String(preset ?? '').trim()
  return key === '' ? 'standard' : key
}

/** 是否标准模式（主机默认预设，可能投影成空串或 'standard'）。 */
export function isStandardPreset(preset?: string | null): boolean {
  return presetKey(preset) === 'standard'
}

/** 「选中会话 → 新建会话模板」：新建必须落在同一目录、跑同一模式。
 * 目录为空时保持调用方原值（投影还没到达时不要用空目录覆盖用户选择）。 */
export function templateFromSession(row: SessionLike): { cwd: string; agentPreset: string } {
  return {
    cwd: String(row.cwd ?? '').trim(),
    agentPreset: presetKey(row.agentPreset),
  }
}

/** 会话当前（下一条消息）实际使用的模型：优先 `next`，其次 `lastUsed`。
 * 悬浮球选中会话后用它校正模型胶囊——胶囊显示什么，发出去就必须是什么。 */
export function sessionModel(
  row: { modelSelection?: { next?: { provider: string; model: string } | null; lastUsed?: { provider: string; model: string } | null } | null },
): { provider: string; model: string } | null {
  const selection = row.modelSelection?.next ?? row.modelSelection?.lastUsed ?? null
  return selection === null ? null : { provider: selection.provider, model: selection.model }
}

/**
 * 是否按「空白会话」对待。
 * 主机的 `blank` 投影是权威判据；老主机/缓存滞后的快照没有该字段时，
 * 退化为「无标题 + 不在跑 + 未置顶」——有标题或正在跑的会话绝不会被误判。
 */
export function looksBlank(row: SessionLike): boolean {
  if (typeof row.blank === 'boolean') return row.blank
  return !String(row.title ?? '').trim() && row.running !== true && row.pinned !== true
}

/**
 * 悬浮球历史列表：隐藏空白会话，当前选中的那条保留（否则目标条会指到看不见的会话）。
 * 入参已排序，返回保持原顺序。
 */
export function visibleHistory(rows: SessionLike[], currentSessionId?: string | null): SessionLike[] {
  return rows.filter((row) => !looksBlank(row) || row.sessionId === currentSessionId)
}

/**
 * 同目录、同模式下可复用的空白会话：取最近更新的那条。
 * 目录不确定（空 cwd = 主机默认目录）时不复用，避免把指令发进另一个项目。
 * 模式不确定（调用方没传 agentPreset）时不按模式过滤，保持旧行为。
 */
export function findReusableBlank(
  rows: SessionLike[],
  cwd: string,
  opts: { excludeId?: string | null; agentPreset?: string | null } = {},
): string | null {
  const key = cwdKey(cwd)
  if (key === '') return null
  const wantedPreset = opts.agentPreset === undefined ? null : presetKey(opts.agentPreset)
  let best: SessionLike | null = null
  for (const row of rows) {
    if (row.sessionId === opts.excludeId) continue
    if (row.running === true || row.pinned === true || row.archived === true) continue
    if (cwdKey(row.cwd) !== key) continue
    // 复用一条别的模式的空白会话会让新会话「项目地址对了、模式却不对」，
    // 因此模式必须一致；宁可新建一条同模式的空白会话（列表里依旧隐藏）。
    if (wantedPreset !== null && presetKey(row.agentPreset) !== wantedPreset) continue
    if (!looksBlank(row)) continue
    if (best === null || (row.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = row
  }
  return best?.sessionId ?? null
}
