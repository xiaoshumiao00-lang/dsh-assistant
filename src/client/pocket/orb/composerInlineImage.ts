// composer 图片光标标记（2026-11-25 需求：多张图片堆在输入框上方 chip 条，与正文脱节，
// 用户想在光标处提到「第 N 张图」时模型能对上号）。
//
// 宿主取证结论（app.asar 0.2.2，RE 报告见 composer-inline-image-20261125.md）：
//   - 输入框是 Lexical contenteditable（[data-composer-input]），编辑器节点类型在建
//     编辑器时固定（DraftEditorRuntime: nodes:[ReferenceChipNode, CommandChipNode,
//     TextRefNode, QuoteNode]）——插件无法注册新的 decorator 节点类型，「真内联缩略图」
//     必须改宿主，不做。本模块走兜底路线：光标标记。
//   - 图片一律走上传附件管线（apply.ts addFiles：isImageMediaType → uploads），发送时
//     ConversationController.sendSession 把附件块按 attachmentIds 顺序排在文本块前面
//     （service.ts: content = [...uploaded, text]）——模型看到的图片序 = 图片在
//     attachmentIds 里的相对顺序（只数 kind==='image' 的成员）。
//   - 公开写入通道：inputActions.captureInsertion() 给带 draftRev 的 detect 坐标光标
//     span；inputActions.insertText(text, span) 带 draftRev CAS 的定点插入（宿主
//     facade.ts:150-155 / runtime.ts:282 insertAsyncText，PASTE_TAG 独立撤销步）。
//   - 坐标系：InputState.draft 是 clipboard 投影（chip 展开成它的 clipboardText），
//     insertText 的 span 是 detect 投影（chip = 1 个 U+FFFC）。两者只差 chip：
//     detect = clipboard − Σ(chip.length − 1)。chip 的 clipboard 跨度从会话草稿的
//     localStorage 镜像读（dsh.conversation.<sid> = {draft:{text,references,quotes}}，
//     宿主每次 publish 同步写）——镜像的 text 与 input.draft 一致才允许动手。
//
// 映射规则（确定性）：
//   文本里的 `[图k:名字]` 标记 ↔ wire 用户消息里第 k 个图片块（attachmentIds 中
//   kind==='image' 的第 k 个）。带名字的标记靠「名字」认图（同名多张按出现次序一一
//   对应），删除/重排后由 reconcile 自愈：名字对不上的标记删掉，序号不等于图片 wire
//   序号的标记改写。不带名字的 `[图N]` 按「第 N 张图」序号语义：N 在图片数内就保留
//   （图N 天然等于第 N 张，不用改），超出图片数才删；图片数为 0 时不动无名标记，
//   免得误删用户手打的内容。每轮渲染最多应用一处修改，天然收敛。
//
// 本文件是纯核心 + driver，零依赖（测试直接 import，Node 环境没有 react）。
// React 桥接在 ComposerInlineImageBridge.tsx。

/** localStorage 里会话草稿镜像的键前缀（宿主 stores.ts 同款）。 */
export const CONVERSATION_STORAGE_PREFIX = 'dsh.conversation.'
/** 关闭开关：localStorage 'dsh-assistant.composerInlineImage' = '0' 时整套不动作。 */
export const DISABLE_KEY = 'dsh-assistant.composerInlineImage'
/** 单次 onInput 最多应用的 reconcile 修改数（防御性上限，正常一处就收敛）。 */
export const MAX_EDITS_PER_CALL = 4

/**
 * 扫描文本里的图片标记。
 * @param text - clipboard 投影的草稿文本。
 * @returns 按文本顺序排列的标记（坐标都是 clipboard 的 UTF-16 偏移）。
 */
export interface ImageMarker {
  /** 标记整体 [start, end)。 */
  readonly start: number
  readonly end: number
  /** 序号数字部分 [digitsStart, digitsEnd)（重编号只动这一段）。 */
  readonly digitsStart: number
  readonly digitsEnd: number
  /** 当前写着的序号。 */
  readonly ordinal: number
  /** 名字部分（[图3] 形式为 ''）。 */
  readonly name: string
}

const MARKER_SCAN_RE = /\[图(\d+)(?::([^\]\n]{0,80}))?\]/g

export function scanImageMarkers(text: string): ImageMarker[] {
  const markers: ImageMarker[] = []
  MARKER_SCAN_RE.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = MARKER_SCAN_RE.exec(text)) !== null) {
    const digits = hit[1] as string
    const name = hit[2] ?? ''
    markers.push({
      start: hit.index,
      end: hit.index + hit[0].length,
      digitsStart: hit.index + 2, // '[' '图' 两个 UTF-16 单位
      digitsEnd: hit.index + 2 + digits.length,
      ordinal: Number.parseInt(digits, 10),
      name,
    })
    if (hit[0] === '') MARKER_SCAN_RE.lastIndex += 1 // 永不匹配空串，防御
  }
  return markers
}

/** 把文件名整理成能安全放进标记的形态：去括号/控制字符、限长。 */
export function sanitizeImageName(name: unknown): string {
  const clean = String(name ?? '')
    .replace(/[\[\]\n\r\u0000-\u001f]/g, '')
    .trim()
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean
}

/** 生成一个标记文本：有名字 `[图3:a.png]`，没名字 `[图3]`。 */
export function formatImageMarker(ordinal: number, name: string): string {
  const n = Math.max(1, Math.floor(ordinal))
  return name === '' ? `[图${String(n)}]` : `[图${String(n)}:${name}]`
}

/** 附件列表（conversation.resolveDraftAttachments 的产物形状）里图片 id 的有序子序列。 */
export interface DraftAttachmentLike {
  readonly id: string
  readonly kind?: string
  readonly file?: { readonly name?: string } | null
}

export function imageAttachmentsOf(attachments: readonly DraftAttachmentLike[]): DraftAttachmentLike[] {
  return attachments.filter((attachment) => attachment.kind === 'image')
}

export interface ImageIdDiff {
  /** 新增的图片 id（按 attachmentIds 顺序，宿主只追加）。 */
  readonly added: readonly string[]
  /** 被移除的图片 id。 */
  readonly removed: readonly string[]
}

/** 对比两轮图片 id 序列，得出增删（文件类附件不进图片编号，直接忽略）。 */
export function diffImageIds(previous: readonly string[], next: readonly string[]): ImageIdDiff {
  const prevSet = new Set(previous)
  const nextSet = new Set(next)
  return {
    added: next.filter((id) => !prevSet.has(id)),
    removed: previous.filter((id) => !nextSet.has(id)),
  }
}

/** 一处文本修改（clipboard 坐标）。 */
export interface TextEdit {
  /** [start, end) clipboard 坐标。 */
  readonly start: number
  readonly end: number
  readonly replacement: string
  /** 动手前对当前草稿的期望切片（校验用，不匹配就放弃本轮）。 */
  readonly expect: string
}

export interface ReconcilePlan {
  /** 需要动的修改，按 start 降序（先动后头的，前头偏移不受影响）。 */
  readonly edits: readonly TextEdit[]
  /** 已经没有要动的了。 */
  readonly converged: boolean
}

/**
 * 名字 → 该名字对应图片的 wire 序号队列（按图片顺序）。同一名字多次出现时，
 * 文本里第 k 个同名标记对应该名字的第 k 张图。
 */
function ordinalQueuesByName(images: readonly { readonly name: string }[]): Map<string, number[]> {
  const queues = new Map<string, number[]>()
  images.forEach((image, index) => {
    const queue = queues.get(image.name)
    if (queue === undefined) queues.set(image.name, [index + 1])
    else queue.push(index + 1)
  })
  return queues
}

/**
 * 对当前草稿算「自愈计划」：
 *   - 名字对不上任何现存图片的标记 → 删掉（连带吃掉紧随的一个空格）；
 *   - 序号 ≠ 对应图片 wire 序号的标记 → 只改数字段。
 * 不做任何插入——插入是光标语义，走 additions 通道。
 * @param draft - clipboard 投影的当前草稿文本。
 * @param images - 当前图片列表（wire 顺序，已 sanitize 的名字）。
 */
export function planReconcile(draft: string, images: readonly { readonly name: string }[]): ReconcilePlan {
  const edits: TextEdit[] = []
  const queues = ordinalQueuesByName(images)
  const imageCount = images.length
  const pushDelete = (marker: ImageMarker): void => {
    // 整个标记作废，连带吃掉紧随的一个空格（插入时我们带上的）。
    const withSpace = draft.charAt(marker.end) === ' ' ? 1 : 0
    edits.push({
      start: marker.start,
      end: marker.end + withSpace,
      replacement: '',
      expect: draft.slice(marker.start, marker.end + withSpace),
    })
  }
  for (const marker of scanImageMarkers(draft)) {
    if (marker.name === '') {
      // 无名标记 = 「第 N 张图」序号语义：图片数内天然正确；超出才删；
      // 一张图都没有时不动它（多半是用户手打的，别误删）。
      if (imageCount > 0 && marker.ordinal > imageCount) pushDelete(marker)
      continue
    }
    const queue = queues.get(marker.name)
    const ordinal = queue === undefined ? undefined : queue.shift()
    if (ordinal === undefined) {
      pushDelete(marker)
      continue
    }
    if (ordinal !== marker.ordinal) {
      const replacement = String(ordinal)
      if (replacement !== draft.slice(marker.digitsStart, marker.digitsEnd)) {
        edits.push({
          start: marker.digitsStart,
          end: marker.digitsEnd,
          replacement,
          expect: draft.slice(marker.digitsStart, marker.digitsEnd),
        })
      }
    }
  }
  edits.sort((a, b) => b.start - a.start)
  return { edits, converged: edits.length === 0 }
}

/** chip 的 clipboard 跨度（references/quotes 共用形状，宿主 schema 校验过的有序不重叠区间）。 */
export interface ChipSpan {
  readonly offset: number
  readonly length: number
}

/**
 * clipboard 坐标折叠成 detect 坐标：每个完整位于偏移之前的 chip 少算 (length−1) 个单位。
 * 标记是纯文本段，永远不会落在 chip 的展开区间里，所以只对「chip 末尾 ≤ 偏移」求和。
 * @param clipboardOffset - clipboard 投影里的偏移。
 * @param chips - 按 offset 升序的 chip 跨度表。
 * @returns detect 投影里的对应偏移。
 */
export function detectOffsetOfClipboardOffset(clipboardOffset: number, chips: readonly ChipSpan[]): number {
  let detect = clipboardOffset
  for (const chip of chips) {
    const end = chip.offset + chip.length
    if (end <= clipboardOffset) detect -= chip.length - 1
    else break
  }
  return detect
}

/** 解析 localStorage 草稿镜像，拿 chip 跨度表。镜像 text 与 live draft 不一致就返回 null（不动手）。 */
export function readChipSpansFromStorage(raw: string | null, liveDraft: string): ChipSpan[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const draft = (parsed as { draft?: unknown })?.draft as { text?: unknown; references?: unknown; quotes?: unknown } | undefined
    if (draft === undefined || typeof draft.text !== 'string' || draft.text !== liveDraft) return null
    const spans: ChipSpan[] = []
    const collect = (list: unknown): boolean => {
      if (list === undefined || list === null) return true
      if (!Array.isArray(list)) return false
      for (const item of list) {
        const span = item as { offset?: unknown; length?: unknown }
        if (typeof span?.offset !== 'number' || typeof span?.length !== 'number'
          || !Number.isInteger(span.offset) || !Number.isInteger(span.length)
          || span.offset < 0 || span.length <= 0 || span.offset + span.length > liveDraft.length) return false
        spans.push({ offset: span.offset, length: span.length })
      }
      return true
    }
    if (!collect(draft.references)) return null
    if (!collect(draft.quotes)) return null
    spans.sort((a, b) => a.offset - b.offset)
    // 宿主 schema 保证有序不重叠；防御重复读入导致重复扣减。
    const deduped: ChipSpan[] = []
    for (const span of spans) {
      const last = deduped[deduped.length - 1]
      if (last !== undefined && last.offset === span.offset && last.length === span.length) continue
      deduped.push(span)
    }
    return deduped
  } catch {
    return null
  }
}

/** driver 看到的宿主输入面（InputState 的子集 + 动作）。 */
export interface ComposerInlineInput {
  readonly draft: string
  readonly attachmentIds: readonly string[]
  readonly draftRev: number
  readonly phase: string
}

export interface ComposerInlineImageDriverDeps {
  /** 宿主 inputActions.insertText（draftRev CAS）。 */
  readonly insertText: (text: string, span: { start: number; end: number; draftRev: number }) => boolean
  /** 宿主 inputActions.captureInsertion（当前选区的 detect span + 当前 rev）。 */
  readonly captureInsertion: () => { start: number; end: number; draftRev: number }
  /** conversation.resolveDraftAttachments：按 id 取回附件（kind/file.name）。 */
  readonly resolveAttachments: (ids: readonly string[]) => readonly DraftAttachmentLike[]
  /** localStorage.getItem 的注入形态（测试可替身）。 */
  readonly readStorage: (key: string) => string | null
  /** 开关：返回 false 时整套不动作。 */
  readonly enabled?: () => boolean
}

const FROZEN_PHASES = new Set(['adjudicating', 'submitting', 'sending'])

/**
 * 光标标记 driver：桥接组件每次渲染喂它一次最新 InputState，它内部
 *   1) 对新加的图片在光标处插入 `[图N:名字]` 标记（一批一条 insertText）；
 *   2) 对现存文本跑自愈（最多 MAX_EDITS_PER_CALL 处，改不完下一渲染接着改）。
 * 全部走宿主公开 action 通道 + draftRev CAS，失败即放弃本轮，绝不写坏草稿。
 */
export function createComposerInlineImageDriver(deps: ComposerInlineImageDriverDeps) {
  const prevBySession = new Map<string, readonly string[]>()
  let editsThisCall = 0

  const enabled = (): boolean => {
    if (deps.enabled !== undefined) return deps.enabled()
    try {
      return deps.readStorage(DISABLE_KEY) !== '0'
    } catch {
      return true
    }
  }

  return {
    /** 每渲染一次调一次（input 为该会话当前 InputState 快照）。 */
    onInput(input: ComposerInlineInput, sessionId: string | undefined | null): void {
      editsThisCall = 0
      const sid = typeof sessionId === 'string' ? sessionId : ''
      if (sid === '' || !enabled()) return
      const frozen = FROZEN_PHASES.has(input.phase)

      let attachments: readonly DraftAttachmentLike[] = []
      try {
        attachments = deps.resolveAttachments(input.attachmentIds) ?? []
      } catch {
        attachments = []
      }
      const images = imageAttachmentsOf(attachments)
      const imageIds = images.map((image) => image.id)
      const names = new Map(images.map((image) => [image.id, sanitizeImageName(image.file?.name)]))

      // 1) 新增图片 → 光标处插标记（先于自愈，保住「用户光标」语义）。
      const prevIds = prevBySession.get(sid)
      if (prevIds !== undefined && !frozen) {
        const { added } = diffImageIds(prevIds, imageIds)
        if (added.length > 0) {
          const markers = added.map((id) => formatImageMarker(imageIds.indexOf(id) + 1, names.get(id) ?? ''))
          const text = `${markers.join(' ')} `
          let span: { start: number; end: number; draftRev: number }
          try {
            span = deps.captureInsertion()
          } catch {
            span = { start: 0, end: 0, draftRev: input.draftRev }
          }
          if (span.draftRev === input.draftRev) deps.insertText(text, span)
        }
      }
      prevBySession.set(sid, imageIds)

      // 2) 自愈：标记 ↔ 图片 按名字对齐，最多 MAX_EDITS_PER_CALL 处/轮。
      if (frozen || input.draft === '') return
      let raw: string | null = null
      try {
        raw = deps.readStorage(`${CONVERSATION_STORAGE_PREFIX}${sid}`)
      } catch {
        return
      }
      const chips = readChipSpansFromStorage(raw, input.draft)
      if (chips === null) return
      const plan = planReconcile(input.draft, images.map((image) => ({ name: names.get(image.id) ?? '' })))
      for (const edit of plan.edits) {
        if (editsThisCall >= MAX_EDITS_PER_CALL) break
        if (input.draft.slice(edit.start, edit.end) !== edit.expect) continue
        const start = detectOffsetOfClipboardOffset(edit.start, chips)
        const end = detectOffsetOfClipboardOffset(edit.end, chips)
        const ok = deps.insertText(edit.replacement, { start, end, draftRev: input.draftRev })
        if (ok) editsThisCall += 1
      }
    },
    /** 测试/卸载用：忘掉某会话（如会话关闭），下次见到当全新 adopting。 */
    forgetSession(sessionId: string): void {
      prevBySession.delete(sessionId)
    },
  }
}

export type ComposerInlineImageDriver = ReturnType<typeof createComposerInlineImageDriver>
