/**
 * 观察帧内容块改写（真正喂到模型眼前的那一层）。
 *
 * 2026-11-27 §12 实测教训：`tools/execute` 的 around 位只能改工具 value（`paths`），
 * 而模型看到的是 **content 块**里的 `{ type: 'image', attachment }` —— 换路径改了落盘与剪贴板，
 * 没改模型像素。宿主 `dsh-tools` 的 `tools/post-execute` 瀑布才是能改 content 的那层：
 *   `decision = { kind: 'accept', content?: ContentBlock[] }`（见 dsh-tools postExecute 注释：
 *   "`accept` keeps the call successful (replacing `content` when given)"）。
 *
 * 因此这里在 post-execute 上：读 attachment 字节 → 画编号 → `attachments.saveImage()` 存新附件 →
 * 把 image 块的 `attachment` 换成新 ref，并把候选清单作为 text 块追加。
 *
 * 三条铁律（与 cu-uia-observe.ts 一致）：
 *   ① 通道关 / 探针不启动 / 没有可画编号 / 读不到附件 / 存不进附件 → **原 decision 原样返回**（同一引用）；
 *   ② 只换 image 块的 attachment 引用，**不碰任何坐标字段**，也不改 value（模型坐标永远原样执行）；
 *   ③ vendor/computer-use 一行不改：这里只消费它的 content 块形状（`{type:'image',attachment}`）。
 */
import type { ChannelDecision, ChannelSwitch, UiaControl, UiaRect } from './cu-uia-core.ts'
import { planMarks } from './cu-uia-core.ts'
import { OverlayUnsupportedError, overlayPng } from './cu-uia-overlay.ts'
import { buildSlimControlHint, onscreenMarks } from './cu-uia-core.ts'
import { recordMetrics } from './cu-uia-metrics.ts'

/** 本机逐步工具名（关通道时不进任何分支，零开销；只有开通道才按这套名字匹配）。 */
export const CU_OBSERVATION_TOOLS = [
  'computer_use',
  'screenshot',
  'click',
  'type',
  'open_app',
  'open',
  'move',
  'drag',
  'key',
  'hotkey',
  'scroll',
  'long_press',
  'long_wait',
  'wait',
] as const

export type ContentBlock = Record<string, any>
export type ImageRef = Record<string, any>

export type ContentIo = {
  /** 读附件字节（宿主 attachments.readImage 的包装；失败返回 null） */
  readImage: (ref: ImageRef) => Promise<Buffer | null>
  /** 存新附件，返回新 ref（宿主 attachments.saveImage 的包装；失败返回 null） */
  saveImage: (png: Buffer, name: string) => Promise<ImageRef | null>
}

export type ContentRewrite = {
  content: ContentBlock[]
  /** 换掉的 image 块数 / 画上的编号数 / 追加的清单字符数 */
  replaced: number
  drawn: number
  hintChars: number
  hintLines: number
}

/**
 * 纯逻辑：把 content 里的 image 块换成编号图（是否换由 plan 决定，IO 全部注入，离线可测）。
 * 任一环节不成立 → 返回 `null`，调用方必须原样返回原 decision。
 */
export async function rewriteContentBlocks(
  content: readonly ContentBlock[],
  input: {
    switch?: ChannelSwitch
    decision?: ChannelDecision
    controls?: readonly UiaControl[]
    windowRect?: UiaRect | null
    io: ContentIo
    namePrefix?: string
    maxChars?: number
  },
): Promise<ContentRewrite | null> {
  const sw = input.switch
  if (sw !== undefined && sw !== null && sw.enabled !== true) return null
  const decision = input.decision
  if (decision !== undefined && decision !== null && decision.enabled !== true) return null
  if (!Array.isArray(content) || content.length === 0) return null
  // ① 清单瘦身：只列本屏可视区里、名字非空的前 8 条（框仍然按全部编号画在图上）
  const marks = planMarks(input.controls ?? [], input.windowRect ?? null)
  if (marks.length === 0) return null
  const slim = buildSlimControlHint(onscreenMarks(marks, input.windowRect ?? null), { maxItems: 8, maxChars: 300 })
  const hint = slim.text
  let replaced = 0
  let drawn = 0
  const next: ContentBlock[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') { next.push(block); continue }
    if (block.type !== 'image' || block.attachment === null || typeof block.attachment !== 'object') { next.push(block); continue }
    try {
      const bytes = await input.io.readImage(block.attachment)
      if (bytes === null) { next.push(block); continue }
      const imageWidth = Number(block.attachment.width ?? 0)
      const windowWidth = Number(input.windowRect?.w ?? 0)
      const scale = imageWidth > 0 && windowWidth > 0 ? imageWidth / windowWidth : 1
      const out = overlayPng(bytes, marks, {
        windowOrigin: { x: Number(input.windowRect?.x ?? 0), y: Number(input.windowRect?.y ?? 0) },
        scale,
      })
      if (out.drawn === 0) { next.push(block); continue }
      const saved = await input.io.saveImage(out.png, `${input.namePrefix ?? 'frame'}-marks`)
      if (saved === null) { next.push(block); continue }
      next.push({ ...block, attachment: saved })
      replaced += 1
      drawn += out.drawn
    } catch (error) {
      // 画不上（不是 PNG / 解码失败 / 尺寸怪）：这一块保持原样，绝不中断 CU 调用
      if (error instanceof OverlayUnsupportedError || error instanceof Error) { next.push(block); continue }
      throw error
    }
  }
  if (replaced === 0) return null
  if (hint !== '') next.push({ type: 'text', text: hint })
  return { content: next, replaced, drawn, hintChars: hint.length, hintLines: slim.lines }
}

export type PostExecuteDecision = { kind: 'accept'; content?: ContentBlock[]; [key: string]: any }

/**
 * 装 `tools/post-execute` 包装（这是让编号进入模型可见内容块的那一层）。
 * 通道关时：只做一次 `switch.enabled` 判断就返回原 decision（零 IO、零分配）。
 */
export function installContentWrapper(ctx: any, opts: {
  readSwitch: () => ChannelSwitch
  probe: () => Promise<{ decision: ChannelDecision; controls: UiaControl[]; windowRect: UiaRect | null }>
  io?: ContentIo
  tools?: readonly string[]
}): () => void {
  if (typeof ctx?.on !== 'function') return () => void 0
  const tools = new Set(Array.from(opts.tools ?? CU_OBSERVATION_TOOLS))
  const io = opts.io ?? attachmentIo(ctx)
  const handler = async (exec: any, result: any, next: () => Promise<PostExecuteDecision>): Promise<PostExecuteDecision> => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
    const name = String(exec?.name ?? exec?.tool?.name ?? '')
    if (!tools.has(name)) return decision
    let sw: ChannelSwitch
    try { sw = opts.readSwitch() } catch { return decision }
    if (sw.enabled !== true) return decision
    try {
      const sample = await opts.probe()
      if (sample.decision.enabled !== true) return decision
      const content = Array.isArray(decision.content) ? decision.content : Array.isArray(result?.content) ? result.content : []
      if (content.length === 0) return decision
      const overlayStarted = Date.now()
      const rewritten = await rewriteContentBlocks(content, {
        switch: sw,
        decision: sample.decision,
        controls: sample.controls,
        windowRect: sample.windowRect,
        io,
        namePrefix: name,
      })
      const overlayMs = Date.now() - overlayStarted
      // 通道开才埋点（关时上面已经 return，一次 IO 都不会发生）
      try {
        recordMetrics({
          at: new Date().toISOString(),
          tool: name,
          page: String((sample as any).cacheKey ?? ''),
          probed: (sample as any).probed === true,
          probeMs: Number((sample as any).probeMs ?? 0),
          hintChars: rewritten === null ? 0 : rewritten.hintChars,
          hintLines: rewritten === null ? 0 : rewritten.hintLines,
          replaced: rewritten === null ? 0 : rewritten.replaced,
          drawn: rewritten === null ? 0 : rewritten.drawn,
          overlayMs,
          decision: String(sample.decision?.reason ?? ''),
        })
      } catch {}
      if (rewritten === null) return decision
      return { ...decision, content: rewritten.content }
    } catch {
      return decision
    }
  }
  try {
    return ctx.on('tools/post-execute', handler) ?? (() => void 0)
  } catch {
    return () => void 0
  }
}

/** 默认 IO 适配层：吃宿主的 attachments 服务（readImage / saveImage），形状不符就回 null。 */
export function attachmentIo(ctx: any): ContentIo {
  const service = (() => {
    try { return ctx?.get?.('attachments') ?? ctx?.attachments ?? null } catch { return null }
  })()
  return {
    async readImage(ref: ImageRef): Promise<Buffer | null> {
      try {
        if (service === null || typeof service.readImage !== 'function') return null
        const out = await service.readImage(ref)
        const data = out?.data ?? out
        if (data === null || data === undefined) return null
        if (Buffer.isBuffer(data)) return data
        if (data instanceof Uint8Array) return Buffer.from(data)
        if (typeof data === 'string') return Buffer.from(data, 'base64')
        return null
      } catch { return null }
    },
    async saveImage(png: Buffer, name: string): Promise<ImageRef | null> {
      try {
        if (service === null || typeof service.saveImage !== 'function') return null
        const ref = await service.saveImage({ data: new Uint8Array(png), mediaType: 'image/png', name })
        return ref !== null && typeof ref === 'object' ? ref : null
      } catch { return null }
    },
  }
}
