/**
 * 播报预录缓存（`~/.dsh/tihu/preroll/`，设计 §8.7 / §11 P3 的「缓存·预录命中」）。
 *
 * 为什么需要：任务完成的播报是「一句短话」（`把磷石膏那组图重画——三张图已更新`），
 * 但每一句都要走一遍 edge/Kokoro 合成（首块 2 秒上下）。同一句话反复出现的场景很常见
 * （每天同一件事、同一条任务名称），第二次起再合成就是纯浪费——用户等的是「3 秒内听到」。
 *
 * 三条纪律：
 *   1. **只缓存单段播报**（一句话）：多段播报的拼接语义复杂，省下的那点时间不值当；
 *   2. **键＝音色 ＋ 文本**：换个音色必须重合成，否则念出来是别人的声音；
 *   3. **有上限**：文件数/总字节都封顶，超了先删最老的（缓存永远不该变成磁盘负担）。
 *
 * 存的是**裸 PCM**（16 bit 单声道 24 kHz）——正是 `tts.audio` 下发的格式，命中时零转换。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 缓存条数上限。 */
export const PREROLL_MAX_FILES = 120
/** 缓存总字节上限（8 MB ≈ 每条 3 秒音频存 60 条还有余量）。 */
export const PREROLL_MAX_BYTES = 8 * 1024 * 1024
/** 播报 PCM 的采样率（与 tts.audio 的 sampleRate 一致）。 */
export const PREROLL_SAMPLE_RATE = 24000
/** 单条缓存上限：超过 20 秒的「播报」不该走预录（那不是一句短话）。 */
export const PREROLL_MAX_AUDIO_MS = 20_000

/** 缓存目录：`$TIHU_PREROLL_DIR` → `$DSH_HOME/tihu/preroll` → `~/.dsh/tihu/preroll`。 */
export function defaultPrerollDir(): string {
  const override = String(process.env.TIHU_PREROLL_DIR ?? '').trim()
  if (override !== '') return override
  const dshHome = String(process.env.DSH_HOME ?? '').trim()
  return join(dshHome !== '' ? dshHome : join(homedir(), '.dsh'), 'tihu', 'preroll')
}

/** 缓存键：音色 ＋ 规范化后的文本（空白折叠，避免「同一句差一个空格」不命中）。 */
export function prerollKeyOf(voice: string, text: string): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  const name = String(voice ?? '').trim() || 'default'
  return createHash('sha1').update(`${name}\u0000${clean}`).digest('hex').slice(0, 16)
}

/** PCM 字节数 → 毫秒（16 bit 单声道）。 */
export function prerollAudioMs(bytes: number): number {
  return Math.round((Math.max(0, bytes) / 2 / PREROLL_SAMPLE_RATE) * 1000)
}

export interface PrerollStats {
  hits: number
  misses: number
  files: number
  bytes: number
  /** 命中率（0–1）；一次都没查过时给 0。 */
  hitRate: number
}

/**
 * 预录缓存本体。所有文件操作都吞异常：缓存坏了只该「不命中」，不该让播报失败。
 */
export class TihuPreroll {
  private readonly dir: string
  private hits = 0
  private misses = 0

  constructor(dir: string = defaultPrerollDir()) {
    this.dir = dir
  }

  /** 目录（诊断/测试用）。 */
  dirOf(): string {
    return this.dir
  }

  private fileOf(key: string): string {
    return join(this.dir, `${key}.pcm`)
  }

  /** 命中就返回裸 PCM；没命中返回 undefined（调用方去合成）。 */
  get(voice: string, text: string): Buffer | undefined {
    const key = prerollKeyOf(voice, text)
    const file = this.fileOf(key)
    try {
      const data = readFileSync(file)
      if (data.length === 0) return undefined
      // 只更新时间戳：常用句不该被当成「最老」清掉（不重写文件，避免每次命中都落一次盘）。
      try {
        const now = new Date()
        utimesSync(file, now, now)
      } catch { /* 只读盘也无所谓 */ }
      this.hits += 1
      return data
    } catch {
      this.misses += 1
      return undefined
    }
  }

  /** 存一条；超长/空/写不进去都返回 false（不算错误）。 */
  put(voice: string, text: string, pcm: Buffer): boolean {
    if (pcm.length === 0) return false
    if (prerollAudioMs(pcm.length) > PREROLL_MAX_AUDIO_MS) return false
    const key = prerollKeyOf(voice, text)
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.fileOf(key), pcm)
      this.prune()
      return true
    } catch {
      return false
    }
  }

  /** 按「文件数 + 总字节」两个上限修剪，先删最老的（mtime）。 */
  prune(): void {
    try {
      if (!existsSync(this.dir)) return
      const files = readdirSync(this.dir)
        .filter((name) => name.endsWith('.pcm'))
        .map((name) => {
          const path = join(this.dir, name)
          try {
            const info = statSync(path)
            return { path, bytes: info.size, mtimeMs: info.mtimeMs }
          } catch {
            return undefined
          }
        })
        .filter((item): item is { path: string; bytes: number; mtimeMs: number } => item !== undefined)
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
      let total = files.reduce((sum, item) => sum + item.bytes, 0)
      let count = files.length
      for (const item of files) {
        if (count <= PREROLL_MAX_FILES && total <= PREROLL_MAX_BYTES) break
        try {
          unlinkSync(item.path)
          count -= 1
          total -= item.bytes
        } catch { /* 删不掉就留着，下次再试 */ }
      }
    } catch { /* 缓存清理失败不影响播报 */ }
  }

  stats(): PrerollStats {
    let files = 0
    let bytes = 0
    try {
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          if (!name.endsWith('.pcm')) continue
          try {
            bytes += statSync(join(this.dir, name)).size
            files += 1
          } catch { /* 竞态删除 */ }
        }
      }
    } catch { /* 目录不可读 */ }
    const total = this.hits + this.misses
    return { hits: this.hits, misses: this.misses, files, bytes, hitRate: total === 0 ? 0 : this.hits / total }
  }

  /** 清空（测试/排障用：换了音色引擎后想强制重录）。 */
  clear(): void {
    try {
      if (!existsSync(this.dir)) return
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.pcm')) continue
        try { unlinkSync(join(this.dir, name)) } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    this.hits = 0
    this.misses = 0
  }
}
