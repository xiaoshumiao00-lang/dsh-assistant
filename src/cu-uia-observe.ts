/**
 * 观察帧包装（插件侧 around-dispatch）：把「带编号的 PNG 副本」换进工具结果里，
 * 让模型真正看到编号框——**不改 vendor 的三处出口**。
 *
 * 依据（宿主源码，只读核对）：
 *   - `@deepseek-ai/dsh-tools` 的执行链是 `tools/pre-execute` → `tools/execute`（around-dispatch）→
 *     `tools/post-execute` → `tools/result`；`vendor/computer-use` 的 screenshot/click 结果只回
 *     `paths` / `screens` 这些**文件路径**，图像在渲染时才从磁盘读。
 *   - 所以插件侧只要在 `tools/execute` 的 around 位把 `paths` / `screens[].path` 换成
 *     「编号版 PNG」的路径，模型看到的就是带编号的帧；vendor 一行都不用改。
 *
 * 三条硬边界（写死在这里，不许放宽）：
 *   ① 开关关 / 探针判不启动 / 画不出编号 / PNG 形状不支持 → **返回原 value 对象本体**，
 *      不复制帧、不写文件、不加任何字段（`output.schema` 是 additionalProperties:false）；
 *   ② 只改 `paths` 与 `screens[].path` 指向的文件，坐标字段一个都不碰（模型坐标永远原样执行）；
 *   ③ 编号图落盘在系统临时目录（`dsh-cu-marks/`），不污染用户桌面；原帧文件一个字节都不动。
 *
 * 本轮**没有**在插件入口调用 `installCuObservationWrapper()`：接线要在 `src/assistant.ts` 里加一行
 * 再重建 bundle + 重启宿主，按用户口径（重启由用户点）先停在这。见 docs/computer-use-提速前后对比-2026-11-27.md §10。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ChannelDecision, ChannelSwitch, UiaControl, UiaMark, UiaRect } from './cu-uia-core.ts'
import { createPageCache, decideControlChannel, pageCacheKey, planChannelFrame, planMarks, resolveChannelSwitch } from './cu-uia-core.ts'
import { createUiaSidecar } from './cu-uia-sidecar.ts'
import { installContentWrapper } from './cu-uia-content.ts'
import { OverlayUnsupportedError, overlayPng } from './cu-uia-overlay.ts'

/** 编号图落盘目录（系统临时目录下，可随时清）。 */
export const OVERLAY_DIR_NAME = 'dsh-cu-marks'
/** 一帧最多给几个文件画编号（多屏时只画前 N 屏，避免重复烧 CPU）。 */
export const OVERLAY_MAX_FILES = 4

export function overlayDir(): string {
  const dir = join(tmpdir(), OVERLAY_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 编号图路径：原图同名 + `.marks.png`，落在临时目录（不写回桌面）。 */
export function overlayPathFor(sourcePath: string, index = 0): string {
  const name = basename(String(sourcePath ?? 'frame')).replace(/\.(png|jpg|jpeg)$/i, '')
  return join(overlayDir(), `${index}-${name}.marks.png`)
}

export type ObservationValue = {
  paths?: string[]
  screens?: Array<Record<string, any>>
  [key: string]: any
}

export type OverlayPlan = {
  useOverlay: boolean
  reason: 'ok' | 'switch-off' | 'channel-off' | 'no-marks' | 'no-path'
  marks: UiaMark[]
  hint: string
}

/** 纯决策：这一帧到底画不画（开关 → 探针判定 → 编号 → 有没有可画的图）。 */
export function planObservationOverlay(input: {
  switch?: ChannelSwitch
  decision?: ChannelDecision
  controls?: readonly UiaControl[]
  windowRect?: UiaRect | null
  paths?: readonly string[]
}): OverlayPlan {
  const paths = Array.from(input.paths ?? []).filter((path) => typeof path === 'string' && path !== '')
  if (input.switch !== undefined && input.switch !== null && input.switch.enabled !== true) return { useOverlay: false, reason: 'switch-off', marks: [], hint: '' }
  if (input.decision !== undefined && input.decision !== null && input.decision.enabled !== true) return { useOverlay: false, reason: 'channel-off', marks: [], hint: '' }
  const marks = planMarks(input.controls ?? [], input.windowRect ?? null)
  if (marks.length === 0) return { useOverlay: false, reason: 'no-marks', marks: [], hint: '' }
  const frame = planChannelFrame({ switch: input.switch, decision: input.decision, marks })
  if (!frame.useMarks) return { useOverlay: false, reason: 'channel-off', marks: [], hint: '' }
  if (paths.length === 0) return { useOverlay: false, reason: 'no-path', marks, hint: frame.hint }
  return { useOverlay: true, reason: 'ok', marks, hint: frame.hint }
}

export type OverlayValueResult = {
  value: ObservationValue
  plan: OverlayPlan
  /** 实际换掉的图片文件数；0 = 原 value 原样返回 */
  replaced: number
  drawn: number
}

/**
 * 把工具结果里的观察帧换成编号版（**只换路径**）。
 * 任一环节不支持（不是 PNG / 解不出来 / 画不出编号）→ 原 value 原样返回（保底 ①）。
 */
export function overlayObservationValue(
  value: ObservationValue,
  input: {
    switch?: ChannelSwitch
    decision?: ChannelDecision
    controls?: readonly UiaControl[]
    windowRect?: UiaRect | null
    scale?: number
    maxFiles?: number
  } = {},
): OverlayValueResult {
  const paths = Array.isArray(value?.paths) ? value.paths : []
  const plan = planObservationOverlay({ ...input, paths })
  if (!plan.useOverlay) return { value, plan, replaced: 0, drawn: 0 }
  const maxFiles = Math.max(1, Number(input.maxFiles ?? OVERLAY_MAX_FILES))
  const scale = Number(input.scale ?? 1)
  const windowRect = input.windowRect ?? null
  const origin = { x: Number(windowRect?.x ?? 0), y: Number(windowRect?.y ?? 0) }
  const replacedPaths: string[] = []
  let replaced = 0
  let drawn = 0
  for (const path of paths.slice(0, maxFiles)) {
    if (!/\.png$/i.test(path)) { replacedPaths.push(path); continue }
    try {
      const png = readFileSync(path)
      const out = overlayPng(png, plan.marks, { windowOrigin: origin, scale })
      if (out.drawn === 0) { replacedPaths.push(path); continue }
      const target = overlayPathFor(path, replaced)
      writeFileSync(target, out.png)
      replacedPaths.push(target)
      replaced += 1
      drawn += out.drawn
    } catch (error) {
      // 解不出来的帧：这一屏退回原图（其它屏照常处理），绝不因为画不上框就报错中断
      if (!(error instanceof OverlayUnsupportedError) && !(error instanceof Error)) throw error
      replacedPaths.push(path)
    }
  }
  if (replaced === 0) return { value, plan, replaced: 0, drawn: 0 }
  const next: ObservationValue = { ...value, paths: replacedPaths }
  if (Array.isArray(value.screens)) {
    next.screens = value.screens.map((screen, index) => {
      const original = typeof screen?.path === 'string' ? screen.path : ''
      if (original === '') return screen
      const mapped = replacedPaths[paths.indexOf(original)]
      return mapped === undefined || mapped === original ? screen : { ...screen, path: mapped }
    })
  }
  return { value: next, plan, replaced, drawn }
}

/**
 * 插件侧 around-dispatch 包装（宿主 `tools/execute` 瀑布）。
 * **本轮没有调用它**：接线要改插件入口（现有文件）+ 重建 + 重启，按口径等用户点头。
 * @returns 卸载函数（cordis 的 effect/dispose 口径）
 */
export function installCuObservationWrapper(ctx: any, opts: {
  readSwitch?: () => ChannelSwitch
  probe?: () => Promise<{ decision: ChannelDecision; controls: UiaControl[]; windowRect: UiaRect | null }>
  tools?: readonly string[]
} = {}): () => void {
  const tools = new Set(Array.from(opts.tools ?? ['computer_use', 'screenshot']))
  const readSwitch = typeof opts.readSwitch === 'function' ? opts.readSwitch : () => readCuUiaSwitch(ctx)
  const fallbackProbe = createObservationProbe()
  const probeFn = typeof opts.probe === 'function' ? opts.probe : () => fallbackProbe.sample()
  if (typeof ctx?.on !== 'function') return () => void 0
  const handler = async (exec: any, next: () => Promise<any>): Promise<any> => {
    const result = await next()
    const name = String(exec?.tool?.name ?? exec?.name ?? exec?.definition?.name ?? '')
    if (!tools.has(name)) return result
    try {
      const sw = readSwitch()
      if (sw.enabled !== true) return result
      const sample = await probeFn()
      const value = result?.value !== undefined ? result.value : result
      if (value === null || typeof value !== 'object') return result
      const swapped = overlayObservationValue(value, { switch: sw, decision: sample.decision, controls: sample.controls, windowRect: sample.windowRect })
      if (swapped.replaced === 0) return result
      return result?.value !== undefined ? { ...result, value: swapped.value } : swapped.value
    } catch {
      return result // 任何意外都保持原样（通道坏了不许影响 CU 本身）
    }
  }
  let disposeExecute: any = () => void 0
  try {
    disposeExecute = ctx.on('tools/execute', handler) ?? (() => void 0)
  } catch { disposeExecute = () => void 0 }
  // 2026-11-27 §12 实测：改 value.paths 到不了模型眼前，真正生效的是 post-execute 改 content 块。
  let disposeContent: any = () => void 0
  try {
    disposeContent = installContentWrapper(ctx, { readSwitch, probe: probeFn, tools: opts.tools })
  } catch { disposeContent = () => void 0 }
  return () => { try { disposeExecute() } catch {}; try { disposeContent() } catch {} }
}

/** 探针 + 缓存的一体化取数（接线方用；纯函数化便于单测替换）。 */
export function sampleObservation(input: {
  probe: () => Promise<{ ok: boolean; controls: UiaControl[]; window: { rect: UiaRect } | null; ms: number; error?: string }>
  decide: (outcome: any) => ChannelDecision
}): Promise<{ decision: ChannelDecision; controls: UiaControl[]; windowRect: UiaRect | null; cacheKey: string }> {
  return input.probe().then((outcome) => {
    const decision = input.decide(outcome)
    return {
      decision,
      controls: decision.enabled ? outcome.controls : [],
      windowRect: outcome.window === null ? null : outcome.window.rect,
      cacheKey: pageCacheKey(outcome.window as any),
    }
  })
}

/** profile 目录（与 src/coordinate-mode.ts 同款取法，拿不到就退 DSH_HOME / cwd）。 */
export function profileDirOf(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

/** 开关文件名（profile 目录下；`{"enabled": false}` 或缺省都算关）。 */
export const UIA_SWITCH_FILE = 'dsh-assistant-cu-uia.json'

/** 读 profile 文件里的 enabled；文件不存在 / 读不了 / 不是布尔 → undefined（交给缺省关）。 */
export function readCuUiaFileEnabled(ctx: any): boolean | undefined {
  try {
    // PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 UTF-8 BOM；不剥掉 JSON.parse 直接抛，
    // 开关就被判成「读不到 → 默认关」（2026-11-27 §12.5 实测踩过：14:56:07 那次 A/B 因此白跑）。
    const raw = readFileSync(join(profileDirOf(ctx), UIA_SWITCH_FILE), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : undefined
  } catch {
    return undefined
  }
}

/**
 * 一键回退的总开关读取口（接线方唯一入口）：
 * `DSH_CU_UIA=0` 优先 → profile 文件 enabled=false 优先于 =true → 什么都没有就关。
 */
export function readCuUiaSwitch(ctx: any): ChannelSwitch {
  return resolveChannelSwitch({ env: process.env.DSH_CU_UIA, fileEnabled: readCuUiaFileEnabled(ctx) })
}

export type ObservationSample = { decision: ChannelDecision; controls: UiaControl[]; windowRect: UiaRect | null; cacheKey: string }

/**
 * 默认探针：懒起 sidecar（42–49ms/页）+ 页面缓存（同页 TTL 内不重探）。
 * 任何异常都回「通道不启动」，绝不把异常抛给 CU 调用链。
 */
export function createObservationProbe(opts: { ttlMs?: number } = {}) {
  let sidecar: ReturnType<typeof createUiaSidecar> | null = null
  const cache = createPageCache({ ttlMs: Number(opts.ttlMs ?? 30_000), maxPages: 8 })
  return {
    async sample(): Promise<ObservationSample> {
      try {
        if (sidecar === null) sidecar = createUiaSidecar()
        const outcome = await sidecar.probe(200)
        const decision = decideControlChannel(outcome)
        const windowRect = outcome.window === null ? null : outcome.window.rect
        if (!decision.enabled) return { decision, controls: [], windowRect, cacheKey: '' }
        const key = pageCacheKey(outcome.window)
        const cached = cache.get(key)
        if (cached !== null) return { decision, controls: cached, windowRect, cacheKey: key }
        cache.set(key, outcome.controls)
        return { decision, controls: outcome.controls, windowRect, cacheKey: key }
      } catch {
        return { decision: { enabled: false, reason: 'error' }, controls: [], windowRect: null, cacheKey: '' }
      }
    },
    close(): void {
      try { sidecar?.close() } catch {}
      sidecar = null
    },
  }
}
