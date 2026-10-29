// 悬浮球 ↔ DSH 服务的调用封装。全部走已在运行的连接：
//   - 会话：注入的 `sessions` 服务（与桌面/web 官方客户端同一个会话系统）；
//   - / 命令：注入的 `remote.commands`（与桌面输入框同一命令注册表，行为完全一致）；
//   - 电脑文件：pocket 自有 RPC `fs.list` / `fs.saveUpload`（主机端执行，浏览的是电脑磁盘）。

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../api.js'
import { cwdKey, findReusableBlank, presetKey, visibleHistory } from './session-plan.ts'
import { focusSessionInHost } from '../../sessionFocus.ts'

/** 创建中的会话（按目录去重）。模块级：悬浮球页面即使被重复挂载出多个实例，
 * 同一目录的并发创建也共用同一个在途请求，不会叠出成串的空白会话。 */
type CreateResult = { sessionId: string; appliedPreset: string | null; reused: boolean }
const creatingByCwd = new Map<string, Promise<CreateResult>>()

/** 会话当前/下一条消息使用的模型（主机 modelSelection 投影）。 */
export interface OrbModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 会话目录行（从 sessions.list 快照整理，字段做防御性读取）。 */
export interface OrbSessionRow {
  sessionId: string
  title: string
  cwd: string
  running: boolean
  updatedAt: number
  /** 会话实际运行的 agent 预设（如 'computer-use'）——用于与桌面悬浮球对账。 */
  agentPreset: string
  /** 主机 modelSelection 投影：next = 下一条消息要用的模型，lastUsed = 最近一次实际用的。 */
  modelSelection: { lastUsed: OrbModelSelection | null; next: OrbModelSelection | null } | null
  /** 是否已置顶（工作区 pinnedSessionIds 包含此会话）。 */
  pinned: boolean
  /** 是否已归档（工作区 archivedSessionIds 包含此会话）。 */
  archived: boolean
  /** 该会话还没有任何一轮对话（主机投影 blank）——悬浮球默认不显示它，见 session-plan.ts。 */
  blank: boolean
}

interface SnapshotRow {
  sessionId: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  origin?: string
  parentSessionId?: string
  cwd?: string
  title?: string | null
  projections?: { values?: { title?: string | null; cwd?: string | null; agentPreset?: string | null; modelSelection?: OrbSessionRow['modelSelection'] } }
  /** projectList 拍平后的投影值（agentPreset / modelSelection 的实际所在）。 */
  projectionValues?: { title?: string | null; cwd?: string | null; agentPreset?: string | null; modelSelection?: OrbSessionRow['modelSelection'] }
}

/** prompt/命令附件内容块（与 session/prompt 线格式一致）。 */
export type OrbContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }

export interface OrbCommand {
  name: string
  description: string
  input?: { hint?: string }
}

/** 技能目录项（skills/list 线格式）。 */
export interface OrbSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

/** 模型目录项（拍平 groups 后的展示行）。 */
export interface OrbModel {
  provider: string
  model: string
  name: string
  groupName: string
  description?: string
}

/** 浏览器无 secure context（局域网 http）时 crypto.randomUUID 不可用，自备 RFC4122 v4。 */
function newRequestId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

function clientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** 取某个目录对应的宿主工作区 id（必要时注册）。
 *
 *  为什么必须带工作区建会话：宿主 SessionCommandController.create 只在拿到 workspaceId 时
 *  才会 `workspace.attachSession(sessionId)`；退化成 `{cwd}` 建会话时，会话只有 cwd、没有工作区归属
 *  ——控制室从项目卡新建会话后右侧工作区不是该项目的文件夹（用户还得手动重选工作文件夹），
 *  手机端新建的会话也不落在对应工作区分组里。
 *
 *  形状兼容：宿主 0.2 的 ctx.workspaces.create 返回的是 **Remote 信封**
 *  `{ ok, value: { workspace, created } }`（见 @deepseek-ai/dsh-api-workspace-controller），
 *  旧实现按顶层 workspaceId 读会恒为 undefined；这里信封 / 嵌套视图 / 裸视图都认。
 *  宿主拒绝（目录不存在）或该宿主没有 workspaces 能力 → null，由调用方回退 {cwd}。 */
async function workspaceIdForCwd(ctx: any, cwd: string): Promise<string | null> {
  let ws: any = null
  try { ws = ctx.get?.('workspaces') ?? ctx.workspaces } catch { ws = null }
  if (!ws || typeof ws.create !== 'function') return null
  try {
    const res = await ws.create({ path: cwd })
    if (res && typeof res === 'object' && res.ok === false) return null
    const value = res && typeof res === 'object' && 'value' in res ? res.value : res
    const view = value && typeof value === 'object' && 'workspace' in value ? value.workspace : value
    const id = view?.workspaceId ?? view?.id ?? null
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

export function makeOrbApi(ctx: any) {
  const rpcCall = (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<any> =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal)

  /** 解包 {ok,value} 信封；失败抛 Error（携带主机端双语消息）。 */
  const unwrap = (res: any) => {
    if (res && res.ok === true) return res.value
    throw new Error(res?.error?.message ?? String(res))
  }

  /** 快照 → 目录行（含空白会话在内，已剔除子代理行与已归档行），置顶在前、按更新时间倒序。
   * 置顶/归档状态在工作区服务里（workspaces.list 快照），不在 sessions 里。 */
  const allRows = (): OrbSessionRow[] => {
    const snap = ctx.sessions.list.getSnapshot()
    let pinnedSet: Set<string> | null = null
    let archivedSet: Set<string> | null = null
    try {
      const ws = ctx.get?.('workspaces') ?? ctx.workspaces
      const wsSnap = ws?.list?.getSnapshot?.()
      if (wsSnap) {
        pinnedSet = new Set(wsSnap.pinnedSessionIds ?? [])
        archivedSet = new Set(wsSnap.archivedSessionIds ?? [])
      }
    } catch { /* workspaces 不可用 → 全部视为未置顶/未归档 */ }
    const rows: OrbSessionRow[] = []
    for (const id of snap.ids ?? []) {
      const row = (snap.byId?.[id] ?? {}) as SnapshotRow
      if (row.origin === 'subagent') continue
      const sid = row.sessionId ?? id
      // 已归档的会话不在悬浮球列表显示（归档 = 从列表隐藏，电脑端可恢复）
      if (archivedSet?.has(sid)) continue
      // 投影值在行的 projectionValues 上（projectList 拍平后的形状）；
      // title/cwd 也可能已拍平到行顶层，两处都兜底读。
      const values = row.projectionValues ?? row.projections?.values
      rows.push({
        sessionId: sid,
        title: row.title ?? values?.title ?? '',
        cwd: row.cwd ?? values?.cwd ?? '',
        running: row.running === true,
        updatedAt: row.updatedAt ?? 0,
        agentPreset: values?.agentPreset ?? '',
        modelSelection: values?.modelSelection ?? null,
        pinned: pinnedSet?.has(sid) === true,
        archived: false,
        blank: row.blank === true,
      })
    }
    // 置顶在前，其余按更新时间倒序
    rows.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
    return rows
  }

  /** 语音转写服务（官方 voice-input 插件挂载的 cordis 服务，服务名是 'remote.speech'）。
   * 不能用 ctx.remote.speech 直接取：那个命名空间是以**独立 Service** 注册的
   * （api-gateway 的 createNamespace 用 remoteServiceKey(name) 建了一个插件 fiber），
   * 没在 inject 列表里声明过的插件在 ctx.remote 上取不到它——必须按服务名查。 */
  const speechService = (): any => {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('remote.speech') : undefined
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch { /* 服务未注册 */ }
    try { return ctx.remote?.speech } catch { return undefined }
  }

  /** 官方模型选择器已经加载的共享目录（全局 catalog / 当前会话目录）。
   *  直接 Remote 还没就绪或失败时用它兜底，保证「所有模型」都能列出来，
   *  而不是只剩当前会话那一个。宿主没有 ui-model-selection / 目录尚未加载时返回 null。 */
  const officialCatalogOf = (sessionId?: string | null): { default: { provider: string; model: string } | null; models: OrbModel[] } | null => {
    try {
      const resolver: any = ctx.get?.('modelDirectories') ?? (ctx as any).modelDirectories
      if (!resolver) return null
      let value: any = null
      try {
        const state = resolver.catalog?.store?.getSnapshot?.()
        value = state?.value ?? null
        if (!value) {
          try { void resolver.catalog?.load?.() } catch { /* 目录自己会在就绪后通知 */ }
        }
      } catch { /* 私有目录形状变化时退回 per-session 目录 */ }
      if ((!value || !Array.isArray(value.groups) || value.groups.length === 0) && sessionId) {
        try {
          const dir = resolver.directoryFor?.(sessionId)
          const state = dir?.store?.getSnapshot?.()
          if (state && Array.isArray(state.groups) && state.groups.length > 0) {
            value = { groups: state.groups, default: null }
          } else {
            try { void dir?.load?.() } catch { /* 下次重试再读 */ }
          }
        } catch { /* 会话尚未绑定/已销毁 */ }
      }
      const groups = value?.groups
      if (!Array.isArray(groups) || groups.length === 0) return null
      const models: OrbModel[] = []
      for (const group of groups) {
        if (!group?.id) continue
        for (const model of group.models ?? []) {
          if (!model?.id) continue
          models.push({
            provider: String(group.id),
            model: String(model.id),
            name: String(model.name || model.id),
            groupName: String(group.name || group.id),
            description: typeof model.description === 'string' ? model.description : undefined,
          })
        }
      }
      if (models.length === 0) return null
      const d = value?.default
      return {
        default: d && typeof d.provider === 'string' && typeof d.model === 'string'
          ? { provider: d.provider, model: d.model }
          : null,
        models,
      }
    } catch { return null }
  }

  return {
    /** 浏览电脑目录/文件（includeFiles=true 含文件，附件选择器用）。 */
    async listFs(path: string, opts: { includeFiles?: boolean; cwd?: string } = {}) {
      return unwrap(await rpcCall(POCKET_ENDPOINTS.fsList, {
        path,
        includeFiles: opts.includeFiles === true,
        cwd: opts.cwd,
      }))
    },

    /** 手机附件落盘到电脑 → 返回绝对路径。 */
    async saveUpload(name: string, data: string): Promise<{ path: string; size: number }> {
      return unwrap(await rpcCall(POCKET_ENDPOINTS.fsSaveUpload, { name, data }))
    },

    /** 会话历史列表：空白（无内容、未命名）会话不在悬浮球显示——与桌面侧栏同一套规矩；
     * 唯一例外是悬浮球当前正指着的那条（否则目标条会指到看不见的会话）。
     * 只是不显示：这些会话本身没有被删除或归档，发送时会被复用。 */
    listSessions(currentSessionId?: string | null): OrbSessionRow[] {
      return visibleHistory(allRows(), currentSessionId)
    },

    /** 单条会话行（不走历史列表的空白过滤）：首屏列表还没刷出来时目标条也要有内容。 */
    sessionRow(sessionId: string): OrbSessionRow | null {
      return allRows().find((row) => row.sessionId === sessionId) ?? null
    },

    /** 该目录下可复用的空白会话 id（没有则 null）。
     * 传了 agentPreset 就只认同模式的空白会话——模式不一致的空白会话宁可不用，
     * 否则「新建会话」会继承另一条会话的模式。
     * 复用既有空白会话 = 不会又多出一条「未命名会话」。 */
    reusableBlank(cwd: string, excludeId?: string | null, agentPreset?: string | null): string | null {
      return findReusableBlank(allRows(), cwd, { excludeId, agentPreset })
    },

    /** 订阅会话列表变化；返回退订函数。 */
    subscribeSessions(listener: () => void): () => void {
      return ctx.sessions.list.subscribe(listener)
    },

    /** 订阅工作区列表变化（置顶/归档状态变化时刷新列表）。 */
    subscribeWorkspaces(listener: () => void): () => void {
      try {
        const ws = ctx.get?.('workspaces') ?? ctx.workspaces
        return ws?.list?.subscribe?.(listener) ?? (() => {})
      } catch { return () => {} }
    },

    /** 取得一个可用的目标会话：
     *  1. 该目录已经有**同模式**的空白会话（无内容、未命名）→ **复用**它，不新建；
     *     模式不同的空白会话不复用——复用会让新会话模式与用户选中的会话不一致；
     *  2. 否则创建，并且同一目录 + 同一模式的并发创建共用同一个在途请求。
     * 返回 reused = 走的是复用，调用方据此决定要不要提示预设回退。
     * 空目录**不传** cwd 字段——主机只对 undefined 回退默认目录，
     * 传空字符串会被 mkdir('') 打回 ENOENT。
     * 带预设时走底层 remote.session.create——sessions.create 的客户端封装
     * 只透传 workspaceId/cwd/sessionId，会把 agentPreset 丢掉。 */
    async createSession(
      cwd: string,
      agentPreset?: string,
      opts: { reuseBlank?: boolean } = {},
    ): Promise<{ sessionId: string; appliedPreset: string | null; reused: boolean }> {
      const trimmed = String(cwd ?? '').trim()
      if (opts.reuseBlank !== false) {
        // 这里必须显式传模式（空串 = 标准模式），不能省成「不限模式」，
        // 否则会复用另一模式的空白会话，新会话的模式就跟选中会话不一致了。
        const blank = findReusableBlank(allRows(), trimmed, { agentPreset: presetKey(agentPreset) })
        if (blank !== null) {
          const row = allRows().find((r) => r.sessionId === blank)
          return { sessionId: blank, appliedPreset: row?.agentPreset ?? agentPreset ?? null, reused: true }
        }
      }
      // 目录先注册成宿主工作区，再带 workspaceId 建会话（否则会话只有 cwd、没有工作区归属，
      // 见 workspaceIdForCwd 注释）。注册失败/宿主无此能力 → 回退 {cwd}，行为与旧版一致。
      const workspaceId = trimmed ? await workspaceIdForCwd(ctx, trimmed) : null
      const base = workspaceId ? { workspaceId } : trimmed ? { cwd: trimmed } : {}
      const key = `${cwdKey(trimmed) || '__host-default__'}::${String(agentPreset ?? '').trim()}`
      const inflight = creatingByCwd.get(key)
      if (inflight !== undefined) return inflight
      const promise = (async (): Promise<CreateResult> => {
        if (agentPreset) {
          const result = await ctx.remote.session.create({ ...base, agentPreset })
          if (result?.ok) {
            void ctx.sessions.refresh?.()
            return { sessionId: result.value.sessionId, appliedPreset: agentPreset, reused: false }
          }
          // 预设不存在（computer-use 由 dsh-orb 之类的插件注册，卸载后就没有了）：
          // **不要静默回退成标准会话** —— 用户会以为建好了 CU 会话，进去却是标准模式。
          throw new Error(`agent preset unavailable: ${String(agentPreset)}`)
        }
        const sessionId = await ctx.sessions.create(base)
        void ctx.sessions.refresh?.()
        return { sessionId, appliedPreset: null, reused: false }
      })()
      creatingByCwd.set(key, promise)
      const clear = (): void => {
        if (creatingByCwd.get(key) === promise) creatingByCwd.delete(key)
      }
      void promise.then(clear, clear)
      return promise
    },

    /** 向会话发 prompt。
     * mode: 'steer' = 插话（打断/并入正在执行的一轮），'queue' = 排队等这一轮结束。
     * 优先走 sessions 服务（带本地记账）；其包装不可用/失败时回退原始
     * session/prompt 线调用（行为一致，都是主机同一入口）。 */
    async prompt(sessionId: string, content: OrbContentBlock[], mode: 'queue' | 'steer' = 'queue'): Promise<void> {
      try {
        const result = await ctx.sessions.using(
          sessionId,
          { source: 'dsh-pocket-orb' },
          (reference: any) => reference.binding.session.prompt(content, mode),
        )
        if (result?.ok) return
        throw new Error(result?.error?.message ?? 'prompt rejected')
      } catch (err) {
        const result = await ctx.remote.session.prompt({
          requestId: newRequestId(),
          sessionId,
          mode,
          content,
          clientTimeZone: clientTimeZone(),
        })
        if (!result?.ok) throw new Error(result?.error?.message ?? (err as Error)?.message ?? 'prompt rejected')
      }
    },

    /** / 命令列表（与桌面输入框同一注册表；不可用返回空数组）。 */
    async commandList(sessionId: string): Promise<OrbCommand[]> {
      const remote = ctx.remote?.commands
      if (!remote?.list) return []
      const result = await remote.list(sessionId)
      if (!result?.ok) return []
      return result.value ?? []
    },

    /** 执行 / 命令（line 含斜杠前缀，如 "/goal xxx"）。 */
    async commandExecute(sessionId: string, line: string, attachments: OrbContentBlock[] = []): Promise<{ kind: 'success' | 'error'; text?: string }> {
      const remote = ctx.remote?.commands
      if (!remote?.execute) return { kind: 'error', text: 'commands unavailable' }
      const result = await remote.execute(sessionId, line, attachments)
      if (!result?.ok) throw new Error(result?.error?.message ?? 'command rejected')
      const value = result.value
      if (value === undefined) return { kind: 'error', text: `unknown command: ${line}` }
      return { kind: value.result?.kind ?? 'success', text: value.result?.text }
    },

    /** 技能列表（与桌面 / 菜单同源；不可用返回空数组）。 */
    async skillList(sessionId: string): Promise<OrbSkill[]> {
      const remote = ctx.remote?.skills
      if (!remote?.list) return []
      try {
        const result = await remote.list({ sessionId })
        if (!result?.ok) return []
        return result.value?.skills ?? []
      } catch {
        return []
      }
    },

    /** Host 是否提供语音转写（官方 voice-input bundle 挂载的 speech 服务）。
     * 未启用该插件时这里为 false —— 悬浮球据此隐藏麦克风，而不是留一个点了报错的按钮。 */
    speechAvailable(): boolean {
      return typeof speechService()?.transcribe === 'function'
    },

    /** Host 允许的最长录音秒数（取其 catalog；拿不到就给保守值）。
     * 写死会有风险：不同 Host 配置的上限不一样，超长会被拒收。 */
    async speechMaxSeconds(): Promise<number> {
      try {
        const result = await speechService().catalog()
        const value = result?.ok === true ? result.value : result
        const seconds = Number(value?.maxDurationSeconds)
        if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 120)
      } catch { /* catalog 不可用 → 下面的保守值 */ }
      return 60
    },

    /** 录音 base64 → 文字。转写在 Host 本地跑（SenseVoice），音频不出内网。 */
    async transcribe(audioBase64: string, signal?: AbortSignal): Promise<string> {
      const speech = speechService()
      if (typeof speech?.transcribe !== 'function') throw new Error('speech remote unavailable')
      const result = await speech.transcribe({ audioBase64 }, signal)
      if (result?.ok === false) throw new Error(result?.error?.message ?? 'transcribe rejected')
      const value = result?.ok === true ? result.value : result
      return String(value?.text ?? '')
    },

    /**
     * 读某个会话的尾部（宿主 follow 接口的**开场快照**）。任意会话都能读——包括没在当前
     * 视图打开、只在后台跑的会话；控制室卡片靠它显示「最新一条进度」。
     *
     * 为什么用 follow 而不是 page：
     *   1. page 必须给一个**已存在的** throughSeq，-1 在宿主里表示「空游标」，
     *      返回 0 条记录（旧实现就是这么永远取不到进度的）；
     *   2. 正在流式输出的这一轮只存在于 `assistantStream.activeAttempt.stream`
     *      （紧凑 chunk 记录），page 根本不返回它——只有 follow 带 assistantStream。
     * 拿到开场快照后立刻断开（return 会让异步迭代器释放 follow 句柄），不会长期占连接。
     * 返回 null 表示这个宿主版本没有 follow 接口 / 该会话不可读。
     */
    async sessionTail(sessionId: string, maxMessages = 8): Promise<{ events: any[]; stream: any; cursor?: number } | null> {
      const follow = (ctx.remote.session as any)?.follow
      if (typeof follow !== 'function') return null
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => { try { controller.abort() } catch {} }, 4000) : null
      try {
        const stream = follow.call(ctx.remote.session, {
          address: { kind: 'session', sessionId },
          assistantStream: true,
          maxMessages,
        }, controller?.signal)
        for await (const frame of stream) {
          if (frame?.type !== 'snapshot') continue
          const records: any[] = Array.isArray(frame.records) ? frame.records : []
          return {
            events: records.map((record) => record?.event ?? record).filter(Boolean),
            stream: frame.assistantStream ?? null,
            cursor: frame.cursor,
          }
        }
        return null
      } catch {
        return null
      } finally {
        if (timer != null) clearTimeout(timer)
      }
    },

    /** 模型目录（拍平为展示行；与桌面模型选择同一目录）。
     *  Remote 失败/为空时自动退回官方模型选择器已缓存的目录，保证列表完整。 */
    async modelCatalog(): Promise<{ default: { provider: string; model: string }; models: OrbModel[] }> {
      try {
        // Remote 偶发不返回（移动端代理/连接刚建立）：1.5s 内拿不到就换官方目录 / HTTP
        const result = await Promise.race([
          ctx.remote.session.modelCatalog(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ])
        const value = result?.ok === true ? result.value : result
        const groups = value?.groups ?? []
        const models: OrbModel[] = []
        for (const group of groups) {
          for (const model of group.models ?? []) {
            models.push({
              provider: group.id,
              model: model.id,
              name: model.name || model.id,
              groupName: group.name || group.id,
              description: model.description,
            })
          }
        }
        if (models.length > 0) return { default: value?.default ?? { provider: '', model: '' }, models }
      } catch { /* 退回官方目录 */ }
      const official = officialCatalogOf()
      if (official?.models.length) {
        return { default: official.default ?? { provider: '', model: '' }, models: official.models }
      }
      // 最后兜底：同源 HTTP（移动端经公网代理时 Remote 可能不可用；Host 侧读同一份目录）
      try {
        if (typeof fetch === 'function') {
          const ctl = typeof AbortController === 'function' ? new AbortController() : null
          const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch {} }, 2500) : null
          try {
            const res = await fetch('/api/assistant/models', {
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: ctl?.signal,
            })
            if (res.ok) {
              const body = await res.json().catch(() => null)
              const catalog = body?.catalog ?? body
              const groups = catalog?.groups ?? []
              const models: OrbModel[] = []
              for (const group of groups) {
                for (const model of group?.models ?? []) {
                  if (!group?.id || !model?.id) continue
                  models.push({
                    provider: String(group.id),
                    model: String(model.id),
                    name: String(model.name || model.id),
                    groupName: String(group.name || group.id),
                    description: typeof model.description === 'string' ? model.description : undefined,
                  })
                }
              }
              if (models.length > 0) {
                return { default: catalog?.default ?? { provider: '', model: '' }, models }
              }
            }
          } finally {
            if (timer != null) clearTimeout(timer)
          }
        }
      } catch { /* HTTP 兜底也失败：返回空，由调用方提示 */ }
      return { default: { provider: '', model: '' }, models: [] }
    },

    /** 官方模型选择器已经加载的共享目录（全局 catalog / 当前会话目录）。 */
    officialModelCatalog(sessionId?: string | null) {
      return officialCatalogOf(sessionId)
    },

    /** 选择模型（作用于该会话的后续消息）。 */
    async selectModel(sessionId: string, selection: { provider: string; model: string }): Promise<void> {
      const result = await ctx.remote.session.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
      })
      if (!result?.ok) throw new Error(result?.error?.message ?? 'selectModel rejected')
    },

    /** 读主机当前的后台任务模型（dsh-orb 设置：新建 code_agent 会话时注入，见
     * dsh-orb 的 orbCodeAgentModel → code-agent.js selectModelKeepDefault）。
     * 与桌面「悬浮球设置 → 后台 Agent」是同一份配置（主机 models.json），
     * 走同源相对 fetch（登录 cookie 即可，与桌面设置页同一通道）；
     * 旧版 dsh-orb 没有这组路由时抛错，由调用方兜底提示。 */
    async backgroundModel(): Promise<{ provider: string; model: string; reasoningEffort?: string } | null> {
      const res = await fetch('/.dsh-orb/settings', { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`background settings unavailable (${res.status})`)
      const body = await res.json().catch(() => null)
      const sel = body?.background
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return {
          provider: sel.provider,
          model: sel.model,
          ...(typeof sel.reasoningEffort === 'string' ? { reasoningEffort: sel.reasoningEffort } : {}),
        }
      }
      return null
    },

    /** 写入后台任务模型（POST /.dsh-orb/background-model，主机持久化到 orb-agent-models.json；
     * 之后新建的 code_agent 后台会话即用此模型，已在跑的后台会话不变）。
     * 主机返回完整快照，这里回读校验——写没写进去必须让调用方知道，不能只发个 200 就当成功。 */
    async selectBackgroundModel(selection: { provider: string; model: string }): Promise<void> {
      const res = await fetch('/.dsh-orb/background-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ provider: selection.provider, model: selection.model }),
      })
      if (!res.ok) throw new Error(`background-model rejected (${res.status})`)
      const body = await res.json().catch(() => null)
      const applied = body?.background
      if (applied && typeof applied === 'object' && typeof applied.provider === 'string' && typeof applied.model === 'string') {
        if (applied.provider !== selection.provider || applied.model !== selection.model) {
          throw new Error(`background-model not applied (${applied.provider}/${applied.model})`)
        }
      }
    },

    /** 把主界面切到该会话（与点侧栏会话行等效）。 */
    openSession(sessionId: string): void {
      ctx.uiWorkspace?.openSession?.(sessionId)
    },

    /** 稳健版「切过去」：刚建出来的会话在宿主列表里可能还差一拍，
     *  直接 openSession 会抛 unknown session。走 sessionFocus 的重试/重拉/resync 链路。 */
    async focusSession(sessionId: string): Promise<{ opened: boolean; inList: boolean }> {
      let uw: any = null
      try { uw = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace') ?? null } catch { uw = null }
      const result = await focusSessionInHost({ sessions: ctx.sessions, list: ctx.sessions?.list, uiWorkspace: uw }, sessionId)
      return { opened: result.opened === true, inList: result.inList === true }
    },

    /** 重命名会话（走 sessions.using → binding.session.rename）。 */
    async renameSession(sessionId: string, title: string): Promise<void> {
      const result = await ctx.sessions.using(
        sessionId,
        { source: 'dsh-pocket-orb' },
        (reference: any) => reference.binding.session.rename(title),
      )
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(result?.error?.message ?? 'rename rejected')
      }
    },

    /** 归档会话（从工作区列表隐藏，电脑端可恢复）。 */
    async archiveSession(sessionId: string): Promise<void> {
      const fn = ctx.uiWorkspace?.archiveSession
      if (typeof fn !== 'function') throw new Error('archive unavailable on this host')
      await fn.call(ctx.uiWorkspace, sessionId, {})
    },

    /** 取消归档（恢复到工作区列表）。 */
    async unarchiveSession(sessionId: string): Promise<void> {
      const fn = ctx.uiWorkspace?.unarchiveSession
      if (typeof fn !== 'function') throw new Error('unarchive unavailable on this host')
      await fn.call(ctx.uiWorkspace, sessionId)
    },

    /** 置顶会话（排到列表最前）。 */
    async pinSession(sessionId: string): Promise<void> {
      const fn = ctx.uiWorkspace?.pinSession
      if (typeof fn !== 'function') throw new Error('pin unavailable on this host')
      await fn.call(ctx.uiWorkspace, sessionId)
    },

    /** 取消置顶。 */
    async unpinSession(sessionId: string): Promise<void> {
      const fn = ctx.uiWorkspace?.unpinSession
      if (typeof fn !== 'function') throw new Error('unpin unavailable on this host')
      await fn.call(ctx.uiWorkspace, sessionId)
    },
  }
}

export type OrbApi = ReturnType<typeof makeOrbApi>
