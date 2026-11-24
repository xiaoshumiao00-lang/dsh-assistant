/**
 * 后台 Code agent → Computer Use 会话的 GUI 回传桥（纯逻辑，不 import 宿主模块）。
 *
 * 背景：CU 会话用 `code_agent` 把文件/搜索类工作交给标准模式的后台会话后，
 * 后台会话没有屏幕、也没有 GUI 工具；一旦任务必须点一下桌面（打开微信、
 * 在原生对话框里选文件、读一个只有窗口里才看得到的值），它只能拿标准工具
 * 硬猜。这里给它一个 `computer_use` 工具：把「一具体 GUI 步骤 + 要带回什么」
 * 交回启动它的 CU 会话，前台做完后把结果作为工具结果返回，后台继续。
 *
 * 设计约束：
 *   - 同步等待：工具调用期间后台 agent 保持 running，code_agent 的完成通知
 *     不会在 GUI 步骤做完之前误触发。
 *   - 同一 CU 会话串行：多个后台任务同时请求时排队，避免两条 notice 交错、
 *     各自读到对方的结果。
 *   - 只处理文字结果：截图留在 CU 会话里，后台模型不需要视觉能力。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 模型可见的工具名。 */
export const COMPUTER_USE_TOOL = 'computer_use'

/**
 * 一次回传结果最多带回多少字符。
 *
 * 2026-11-24 口径（与秘书通知、code_agent 完成通知同一条）：整段能带全就整段带；超上限时
 * **保留头 + 保留尾**（头 15000 + 尾 5000），中间换成「省略多少字、省略在第几字到第几字」的
 * 标注；同时把裁切前的完整原文落盘（该 CU 会话项目目录下 .dsh-cu-notices/），
 * 工具结果里直接给出绝对路径，后台用 read 整段读回。
 * 改前是「只保留结尾、开头全丢」：结论在前、末尾路径在后，两头都需要。
 */
export const MAX_RESULT_CHARS = 20000

/** 裁切时原样保留的头部字数。 */
export const RESULT_HEAD_KEEP_CHARS = 15000

/** 裁切时原样保留的尾部字数（结论、末尾路径、提交号都在这一段）。 */
export const RESULT_TAIL_KEEP_CHARS = 5000

/** 完整原文落盘的目录名。 */
export const BRIDGE_DUMP_DIR_NAME = '.dsh-cu-notices'

/** 默认等待上限：20 分钟。GUI 步骤通常几秒，留足用户在场决策的时间。 */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 20 * 60 * 1000

/** 注入 notice 后等它被 driver 领取的上限。 */
const START_WAIT_MS = 60 * 1000

const POLL_MS = 25

/** CU 会话 id → 串行队列尾。key 用会话 id，多个后台任务共享同一前台。 */
const QUEUES = new Map()

/** 单测用：清空串行队列。 */
export function resetBridgeQueues() {
  QUEUES.clear()
}

function abortError() {
  const error = new Error('computer_use handoff aborted')
  error.name = 'AbortError'
  return error
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let timer
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 一段回传文本的裁切结果（头 + 尾 + 省略标注；fullText 是裁切前的整段，落盘用）。 */
export function digestText(text, max = MAX_RESULT_CHARS) {
  const value = String(text ?? '').trim()
  const originalChars = value.length
  if (originalChars <= max) {
    return {
      text: value,
      fullText: value,
      truncated: false,
      originalChars,
      keptHeadChars: originalChars,
      keptTailChars: 0,
      omittedChars: 0,
      omittedFromChar: 0,
      omittedToChar: 0
    }
  }
  const headChars = Math.min(RESULT_HEAD_KEEP_CHARS, Math.max(1, Math.round((max * 3) / 4)))
  const tailChars = Math.min(RESULT_TAIL_KEEP_CHARS, Math.max(1, max - headChars))
  const head = value.slice(0, headChars)
  const tail = value.slice(value.length - tailChars)
  const omittedFromChar = headChars + 1
  const omittedToChar = value.length - tailChars
  const omittedChars = omittedToChar - omittedFromChar + 1
  const marker = `\n\n…〔中间省略 ${omittedChars} 字：第 ${omittedFromChar}–${omittedToChar} 字；结论与末尾路径都在下面这段原文里，完整原文见落盘文件〕…\n\n`
  return {
    text: `${head}${marker}${tail}`,
    fullText: value,
    truncated: true,
    originalChars,
    keptHeadChars: headChars,
    keptTailChars: tailChars,
    omittedChars,
    omittedFromChar,
    omittedToChar
  }
}

/** 按字符上限裁切：整段能带全就原样带；超上限保留头 + 尾，中间省略（不再只留结尾）。 */
export function capText(text, max = MAX_RESULT_CHARS) {
  return digestText(text, max).text
}

/** 落盘文件名：cu-notice-full-YYYYMMDD-HHMMSS.md（本地时区）。 */
export function bridgeDumpFileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `cu-notice-full-${stamp}.md`
}

/** 把裁切前的完整原文写成一份文件；落盘失败返回 null（绝不编造路径）。 */
export function writeBridgeDump(dir, text, options = {}) {
  const base = String(dir ?? '').trim()
  if (base === '') return null
  const body = String(text ?? '')
  const now = options.now ?? new Date()
  try {
    mkdirSync(base, { recursive: true })
    const file = join(base, bridgeDumpFileName(now))
    const header = [
      '# Computer Use 回传结果完整原文（插件落盘，通知/结果被裁前的全文）',
      '',
      `- 落盘时间：${now.toISOString()}`,
      `- 原文总字数：${body.length}`,
      `- 回传口径：单条上限 ${MAX_RESULT_CHARS} 字；超出时只带前 ${RESULT_HEAD_KEEP_CHARS} 字 + 后 ${RESULT_TAIL_KEEP_CHARS} 字`,
      '',
      '---',
      '',
    ].join('\n')
    writeFileSync(file, `${header}${body}`, 'utf8')
    return file
  } catch {
    return null
  }
}

/** 落盘目录：前台 CU 会话的项目目录下 .dsh-cu-notices/；拿不到 cwd 就不落盘。 */
function bridgeDumpDirOf(parent) {
  const cwd = String(parent?.session?.header?.cwd ?? '').trim()
  return cwd === '' ? '' : join(cwd, BRIDGE_DUMP_DIR_NAME)
}

/** 超上限时附在工具结果末尾的那段交代：原文多少字、省略多少、完整原文在哪个文件。 */
export function oversizedResultNotice(path, digest) {
  return `（完整原文共 ${digest.originalChars} 字，超过回传上限 ${MAX_RESULT_CHARS} 字，已被裁：只保留头 ${digest.keptHeadChars} 字 + 尾 ${digest.keptTailChars} 字，中间省略 ${digest.omittedChars} 字（约在第 ${digest.omittedFromChar}–${digest.omittedToChar} 字之间）。完整全文已落盘：${path}。需要用 read 整段读回，不许只依据头尾作答。）`
}

/**
 * 取「注入的 notice 之后的第一条 assistant 文字」。
 *
 * 比按消息下标倒数更准：后台请求排队时，用户可能插话，之后又跑了一轮；
 * 会话事件里 user/message 带我们那条消息的 id，assistant/message 带上它的
 * turn，从 notice 的 seq 往后找第一条 assistant 就是这次 GUI 请求的答复。
 */
export function findNoticeIndex(agent, messageId) {
  if (messageId === undefined) return -1
  let events
  try {
    events = agent?.session?.snapshotEvents?.() ?? []
  } catch {
    return -1
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data?.id === messageId) return index
  }
  return -1
}

/** 一条消息里所有 text 块拼成整段（块与块之间隔一个空行）。 */
function messageText(message) {
  const parts = (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? '').trim())
    .filter((text) => text !== '')
  return parts.join('\n\n')
}

/**
 * 前台这次答复的整段文字：从注入的 notice 之后、到下一条用户消息之前，
 * 所有 assistant 消息按顺序拼接（2026-11-23 修第四个 bug：原来只取第一条 assistant，
 * 答复被模型分几条消息交回时后面几整段直接丢掉；用户插话那条仍是硬边界）。
 */
export function firstAssistantTextAfter(agent, messageId) {
  if (messageId === undefined) return ''
  let events
  try {
    events = agent?.session?.snapshotEvents?.() ?? []
  } catch {
    return ''
  }
  const start = findNoticeIndex(agent, messageId)
  if (start < 0) return ''
  const segments = []
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'user/message') break
    if (event?.type !== 'assistant/message') continue
    const text = messageText(event.data?.message).trim()
    if (text !== '') segments.push(text)
  }
  return segments.join('\n\n')
}

/** 会话里最新一条非空 assistant 文字；没有则返回空串。 */
export function lastAssistantText(agent, options = {}) {
  const after = Number.isInteger(options.after) ? Math.max(0, options.after) : 0
  let messages
  try {
    messages = agent?.session?.deriveMessages?.() ?? []
  } catch {
    return ''
  }
  for (let index = messages.length - 1; index >= after; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/** 消息是否还排在这个 agent 的 inbox 里（next-turn / next-step）。 */
export function isQueued(agent, messageId) {
  if (messageId === undefined || agent?.inbox === undefined) return false
  try {
    const lists = [agent.inbox.nextTurn ?? [], agent.inbox.nextStep ?? []]
    return lists.some((list) => list.some((message) => message?.id === messageId))
  } catch {
    return false
  }
}

/** 交给前台 CU 会话的完整请求文本。 */
export function buildHandoffText(task) {
  return [
    '后台 Code agent 需要一次桌面 GUI 操作（它看不到屏幕，也没有 GUI 工具）。',
    `任务：${String(task ?? '').trim()}`,
    '',
    '请在这个会话里直接完成这一步：',
    '- 先截图确认当前屏幕状态，需要时打开或切换到目标窗口。',
    '- 不要把这步再交给 code_agent，也不要写报告或长篇解释。',
    '- 完成后用一两句话回复具体结果：做了什么、看到了什么、拿到的文本/数值/文件路径。',
    '- 如果确实需要用户决定，用 ask_user_question 提问。'
  ].join('\n')
}

/** 工具结果（成功）。 */
export function resultText(result) {
  const body = result === '' ? '（前台会话没有给文字结果）' : result
  return `Computer Use 已完成这一步：\n${capText(body)}\n\n继续原任务；同一个步骤不要再请求一次。`
}

/** 工具结果（失败/超时）。失败原文按同一口径带全（改前这里另有一个 600 字的独立上限）。 */
export function failureText(reason) {
  return `Computer Use 没能完成这一步：${capText(reason)}\n\n不要重复调用 computer_use 追问同一步；继续用你现有的工具完成任务，或把需要用户在桌面上操作的事项写成清单交给用户。`
}

/** 同一前台会话内串行执行。 */
async function withParentLock(key, task) {
  const previous = QUEUES.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate, () => gate)
  QUEUES.set(key, tail)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (QUEUES.get(key) === tail) QUEUES.delete(key)
  }
}

/**
 * 等注入的 notice 被 driver 领取（或被判定为已开始）。
 * @returns {'running' | 'claimed' | 'pending' | 'aborted'}
 */
async function waitForStart(agent, messageId, options) {
  const signal = options.signal
  const deadline = Date.now() + (options.startWaitMs ?? START_WAIT_MS)
  for (;;) {
    if (signal?.aborted) return 'aborted'
    if (agent?.status === 'running') return 'running'
    if (!isQueued(agent, messageId)) return 'claimed'
    if (Date.now() >= deadline) return 'pending'
    await sleep(POLL_MS, signal)
  }
}

/**
 * 等前台会话回到 idle。
 * @returns {'idle' | 'disposed' | 'timeout' | 'aborted'}
 */
function waitForSettle(agent, options) {
  const signal = options.signal
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS
  return new Promise((resolve) => {
    let done = false
    let timer
    const offs = []
    const cleanup = () => {
      clearTimeout(timer)
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          /* 监听器已经随 agent 一起卸载 */
        }
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (status) => {
      if (done) return
      done = true
      cleanup()
      resolve(status)
    }
    const onAbort = () => finish('aborted')
    const check = () => {
      if (agent?.status !== 'running') finish('idle')
    }
    try {
      offs.push(agent.ctx.on('agent/status', check))
      offs.push(agent.ctx.on('agent/disposed', () => finish('disposed')))
    } catch {
      finish('idle')
      return
    }
    if (signal?.aborted) {
      finish('aborted')
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    check()
  })
}

/**
 * 把一个 GUI 步骤交给前台 CU 会话并等结果。
 * @param parent - 前台 CU agent（必须 live）
 * @param task - 模型写的一步 GUI 任务
 * @param options - createUserMessage / boundContextSummary / signal / timeoutMs / dumpDir
 * @returns {Promise<{ ok: boolean, result: string }>}
 */
export async function handoffToComputerUse(parent, task, options) {
  const { createUserMessage, boundContextSummary, signal, timeoutMs, dumpDir } = options
  const hasEvents = typeof parent.session?.snapshotEvents === 'function'
  const message = createUserMessage({
    content: [{ type: 'text', text: buildHandoffText(task) }],
    source: {
      kind: 'computer-use',
      form: 'notice',
      summary: boundContextSummary('Computer Use: background GUI request')
    }
  })
  try {
    parent.followup(message)
  } catch (error) {
    return { ok: false, result: `无法把请求交给前台会话：${String(error?.message ?? error)}` }
  }
  const dropQueued = () => {
    try {
      if (isQueued(parent, message.id)) parent.inbox.remove(message.id)
    } catch {
      /* 可能已被领取 */
    }
  }
  const start = await waitForStart(parent, message.id, {
    signal,
    startWaitMs: options.startWaitMs ?? START_WAIT_MS
  })
  if (start === 'aborted') {
    dropQueued()
    throw abortError()
  }
  if (start === 'pending') {
    dropQueued()
    return { ok: false, result: '前台 Computer Use 会话没有开始处理这个请求（可能正忙或已停用）。' }
  }
  const settled = await waitForSettle(parent, {
    signal,
    timeoutMs: timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS
  })
  if (settled === 'aborted') {
    dropQueued()
    throw abortError()
  }
  if (settled === 'disposed') return { ok: false, result: '前台 Computer Use 会话已关闭。' }
  if (settled === 'timeout') {
    dropQueued()
    const limit = timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS
    const label = limit >= 60000 ? `${Math.round(limit / 60000)} 分钟` : `${Math.round(limit / 1000)} 秒`
    return {
      ok: false,
      result: `等待前台 Computer Use 会话超时（${label}）；它可能仍在执行，也可能在等用户回答。`
    }
  }
  if (hasEvents && findNoticeIndex(parent, message.id) < 0) {
    return { ok: false, result: '前台会话没有收到这条请求（排队的消息被清空，可能被用户停止）。' }
  }
  // 真实会话用「notice 之后的第一条 assistant」精确取答复；老会话没有事件快照时
  // 才退回整段历史的最后一条文字（可能被用户后来那轮覆盖，只作兜底）。
  const outcome = hasEvents ? firstAssistantTextAfter(parent, message.id) : lastAssistantText(parent)
  // 2026-11-24：回传结果超上限时不再只留结尾，也不把整段硬塞回去——头尾都留，
  // 并把裁切前的完整原文落盘，工具结果里给出绝对路径。
  const digest = digestText(outcome)
  if (!digest.truncated) return { ok: true, result: outcome }
  const dumpDirResolved = String(dumpDir ?? '').trim() || bridgeDumpDirOf(parent)
  const path = writeBridgeDump(dumpDirResolved, digest.fullText)
  if (path === null) return { ok: true, result: outcome }
  return { ok: true, result: `${outcome}\n\n${oversizedResultNotice(path, digest)}` }
}

/** 解析这次调用该找哪个前台 CU 会话：优先用 code-agent registry 里最新的归属。 */
export function resolveCallerId(ctx, sessionId, fallbackParentId) {
  try {
    const registry = ctx?.get?.('codeAgentRegistry')
    const rows = registry?.list?.() ?? []
    const owner = rows.find((row) => row?.sessionId === sessionId)?.callerId
    if (typeof owner === 'string' && owner !== '') return owner
  } catch {
    /* registry 不可用时退回创建时记下的父会话 */
  }
  return fallbackParentId
}

/**
 * 构造 `computer_use` 工具定义。
 * 依赖注入 defineTool / createUserMessage / boundContextSummary，方便单测不动宿主。
 */
export function createComputerUseBridgeTool(options) {
  const {
    defineTool,
    createUserMessage,
    boundContextSummary,
    agent,
    ctx,
    parentId,
    maxHandoffs = 20
  } = options
  if (typeof defineTool !== 'function') throw new TypeError('createComputerUseBridgeTool: defineTool is required')
  const state = { handoffs: 0 }
  return defineTool({
    name: COMPUTER_USE_TOOL,
    description:
      'Ask the Computer Use session that started this background job to perform ONE visible desktop GUI step. ' +
      'You cannot see the screen. Call this when the task needs a desktop app: open or switch an application window, ' +
      'click a button, type into another app, pick a file in a native dialog, read a dialog or an on-screen value, ' +
      'or confirm what the screen currently shows. Give one concrete step and state exactly what to bring back ' +
      '(window title, visible text, chosen path, click result). The foreground Computer Use session sees the screen, ' +
      'performs the step, and returns a short report. Use this early instead of guessing, retrying shell commands, ' +
      'or scripting SendKeys/UI Automation. Do not use it for file, shell, web, or reasoning work your own tools can do; ' +
      'do not use it to ask the user a question; do not repeat a step that already returned a result. ' +
      'The call waits until that session finishes the step, so call it only when you truly need the screen.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description:
          'One concrete GUI step plus what to bring back, e.g. "在微信里打开文件传输助手，截图告诉我窗口标题和最后一条消息". Required.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? resultText(value.result) : failureText(value.result) }
      ]
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Computer Use',
      kind: 'execute',
      rawInput: { task: args.task }
    }),
    async execute(args, exec) {
      const task = String(args?.task ?? '').trim()
      if (task === '') throw new Error('computer_use task must include non-whitespace text')
      const caller = exec?.agent ?? agent
      if (caller === undefined) return { ok: false, result: 'computer_use requires a calling session' }
      state.handoffs += 1
      if (state.handoffs > maxHandoffs) {
        return {
          ok: false,
          result: `本会话已经连续请求 GUI ${maxHandoffs} 次，先停下：把剩余需要桌面的步骤整理给用户。`
        }
      }
      // 优先用调用者自己的 context 查服务：后台 agent 活着，它的 ctx 一定可用；
      // 预设作用域在插件重载后可能已经换了。
      const serviceCtx = typeof caller.ctx?.get === 'function' ? caller.ctx : ctx
      const targetId = resolveCallerId(serviceCtx, caller.id, parentId)
      if (typeof targetId !== 'string' || targetId === '') {
        return { ok: false, result: '找不到启动这个后台任务的 Computer Use 会话。' }
      }
      if (targetId === caller.id) {
        return { ok: false, result: '不能把 GUI 请求交给调用者自己。' }
      }
      const agents = serviceCtx?.get?.('agents')
      const parent = agents?.get?.(targetId)
      if (parent === undefined) {
        return { ok: false, result: `Computer Use 会话 ${targetId} 已不在运行（可能被关闭）。` }
      }
      try {
        return await withParentLock(targetId, () =>
          handoffToComputerUse(parent, task, {
            createUserMessage,
            boundContextSummary: boundContextSummary ?? ((summary) => summary),
            signal: exec?.signal,
            timeoutMs: options.timeoutMs,
            startWaitMs: options.startWaitMs,
            dumpDir: options.dumpDir
          })
        )
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        return { ok: false, result: String(error?.message ?? error) }
      }
    }
  })
}
