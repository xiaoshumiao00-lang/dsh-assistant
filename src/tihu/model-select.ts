/**
 * 鹈鹕端「默认前台/后台模型」落到会话上的那一跳。
 *
 * ## 为什么不能在建会话时指定模型
 *
 * 宿主 `session.create` 的请求体只有 `workspaceId / cwd / sessionId / agentPreset`
 * （`packages/api/session-controller/src/types.ts` 的 `SessionCreateRequest`），
 * `Commands.create()` 也只把这些字段透给 `agents.createSession()`；`agent-preset` 里同样没有
 * model 字段。所以「建会话时带模型」这条路在宿主侧**不存在**。
 *
 * 唯一被官方支持的宿主通路是建完之后、第一条 prompt 之前调
 * `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`
 * （同包 `index.ts` 的 `@Remote('selectModel')`）。dsh-orb 的 code_agent 就是这么做的
 * （见本仓库 `vendor/computer-use/code-agent.js` 的 `selectModelKeepDefault`）。
 *
 * ## 为什么要恢复默认
 *
 * 官方 `selectModel` 除了给这条会话装上选择，还会顺手 `agentDefaultModel.saveSelection()`
 * 把**全局默认模型**改成同一个（`commands.ts` 里 `void this.ctx.agentDefaultModel.saveSelection(selected)`）。
 * 不恢复的话，鹈鹕每派一次单就把用户 DSH 的默认模型换掉一次。这里照 dsh-orb 的写法：
 * 先快照默认 → selectModel → 把默认写回；并用一个进程级队列串行化，避免两次调用交错。
 * 注意 `saveSelection` 内部本身是串行串起来的（`this.saves` 链），所以后写的恢复一定排在
 * selectModel 触发的写入之后。
 *
 * 那个「极小窗口」仍然存在（官方接口没有 session-only 选项）：在官方写入与恢复之间，
 * 另一个窗口新建会话可能看到一次被选中的模型。dsh-orb 也接受这个代价，这里沿用。
 */

/** 一次模型选择（`reasoningEffort` 可选，宿主会归一化）。 */
export interface TihuModelRef {
  provider: string
  model: string
  reasoningEffort?: string
}

export type TihuModelKind = 'foreground' | 'background'

/** 进程级串行队列：多个鹈鹕设备 / 指挥台同时选模型时不许交错。 */
const QUEUE = Symbol.for('dsh-assistant.tihu-model-select.queue')

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const holder = globalThis as any
  const previous: Promise<unknown> = holder[QUEUE] ?? Promise.resolve()
  const run = previous.then(task, task)
  holder[QUEUE] = run.then(() => undefined, () => undefined)
  return run
}

/** 可选服务：cordis 对未 inject 的服务直读会 throw，一律 try/catch + ctx.get。 */
function optionalService(ctx: any, id: string): any {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

function sameSelection(left: TihuModelRef | undefined, right: TihuModelRef): boolean {
  if (left === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

function errorText(error: unknown): string {
  return (error as Error)?.message ?? String(error)
}

/**
 * 给一条**已建好**的会话指定模型，然后把全局默认模型放回去。
 *
 * 永远不抛：调用方是派单/建指挥台的主流程，模型没切上只能降级（用宿主默认模型继续跑），
 * 不能让一句话因为模型配置丢掉。
 *
 * @param ctx 宿主上下文（要能 `get('sessionController')` / `get('agentDefaultModel')`）。
 * @param request.sessionId 目标会话。
 * @param request.selection 要装的模型。
 * @param log 诊断日志（失败原因写进去，别静默）。
 */
export function selectModelKeepingDefault(
  ctx: any,
  request: { sessionId: string; selection: TihuModelRef },
  log: (line: string) => void = () => {},
): Promise<{ ok: boolean; error?: string }> {
  return enqueue(() => selectAndRestore(ctx, request, log))
}

async function selectAndRestore(
  ctx: any,
  request: { sessionId: string; selection: TihuModelRef },
  log: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const controller = optionalService(ctx, 'sessionController')
  const selectModel = controller?.selectModel
  if (typeof selectModel !== 'function') {
    return { ok: false, error: '宿主没有 sessionController.selectModel：这台宿主不能给会话单独指定模型' }
  }
  const chosen: TihuModelRef = {
    provider: request.selection.provider,
    model: request.selection.model,
    ...(request.selection.reasoningEffort === undefined || request.selection.reasoningEffort === ''
      ? {}
      : { reasoningEffort: request.selection.reasoningEffort }),
  }
  const defaults = optionalService(ctx, 'agentDefaultModel')
  const previous: TihuModelRef | undefined = typeof defaults?.currentSelection === 'function'
    ? defaults.currentSelection()
    : undefined
  try {
    await selectModel.call(controller, {
      sessionId: request.sessionId,
      provider: chosen.provider,
      model: chosen.model,
      ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
    })
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
  // selectModel 已经把这次选择写成全局默认；把它放回去（顺序由 agentDefaultModel 内部串行保证）。
  if (typeof defaults?.saveSelection === 'function' && previous !== undefined
    && typeof previous.provider === 'string' && previous.provider !== ''
    && typeof previous.model === 'string' && previous.model !== ''
    && !sameSelection(previous, chosen)) {
    try {
      await defaults.saveSelection({
        provider: previous.provider,
        model: previous.model,
        ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }),
      })
    } catch (error) {
      log(`tihu model: 已给会话选好模型，但全局默认模型没恢复（${errorText(error)}）`)
    }
  }
  return { ok: true }
}

/** 环境变量临时覆盖：`TIHU_MODEL_FOREGROUND=provider/model`。格式不对就当没配。 */
export function tihuModelEnvOverride(
  kind: TihuModelKind,
  env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {},
): TihuModelRef | null {
  const name = kind === 'foreground' ? 'TIHU_MODEL_FOREGROUND' : 'TIHU_MODEL_BACKGROUND'
  const raw = String(env?.[name] ?? '').trim()
  if (raw === '') return null
  const cut = raw.indexOf('/')
  if (cut <= 0 || cut === raw.length - 1) return null
  return { provider: raw.slice(0, cut).trim(), model: raw.slice(cut + 1).trim() }
}

/** 从 `~/.dsh/assistant/config.json` 的 `tihu.model.<kind>` 里取一条（形状不对就是 null）。 */
export function tihuModelOfConfig(tihu: unknown, kind: TihuModelKind): TihuModelRef | null {
  const raw = (tihu as any)?.model?.[kind]
  if (!raw || typeof raw !== 'object') return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 实际要用哪条模型：环境变量 > 本机配置 > null（跟随宿主默认）。
 *
 * @param kind 前台（派单任务会话）/ 后台（指挥台会话）。
 * @param tihu 配置里的 `tihu` 段（可能不存在）。
 * @param env 便于测试注入。
 */
export function resolveTihuModel(
  kind: TihuModelKind,
  tihu: unknown,
  env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {},
): TihuModelRef | null {
  return tihuModelEnvOverride(kind, env) ?? tihuModelOfConfig(tihu, kind)
}
