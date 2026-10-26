// 悬浮球输入区：大输入框 + / 命令弹层 + 附件菜单（手机图片/手机文件/电脑文件）+ 语音 + 发送。
// 附件芯片语义与桌面悬浮球一致：
//   图片 → prompt 的 image 内容块（模型可见）；文件 → 落盘/引用后正文内联 [file: 路径]。
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { OrbModel } from './orb-api.ts'
import type { OrbKey } from './locales.ts'
import { MicCapture, VoiceError, audioFileToBase64 } from './voice.ts'
import type { VoiceSegment } from './voice.ts'
import { fixTerms, cleanFillers } from './asr-terms.ts'

/** 录音按钮图标：与 DSH 原生输入框那个「小录音机」同款——细描边圆角胶囊 + 弧形 + 立杆，
 * 不填色，跟随文字颜色。 */
function RecorderIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.8a2.8 2.8 0 0 0-2.8 2.8v6.6a2.8 2.8 0 0 0 5.6 0V5.6A2.8 2.8 0 0 0 12 2.8Z" />
      <path d="M18.4 11.2v1a6.4 6.4 0 0 1-12.8 0v-1" />
      <path d="M12 18.6v2.6" />
    </svg>
  )
}

/** 语音转写桥：由 OrbOverlay 注入（Host 侧是否具备 speech Remote 在这里体现）。
 * 录音在手机、转写在电脑，见 voice.ts 与 orb-api.ts 的 transcribe。 */
export interface OrbVoiceBridge {
  /** Host 是否挂载了 speech Remote（官方 voice-input bundle 已启用）。 */
  available: boolean
  /** 浏览器侧阻断原因：局域网 http（insecure）或 API 缺失（unsupported）。 */
  blocked: 'insecure' | 'unsupported' | null
  /** Host 允许的最长录音秒数。 */
  maxSeconds: number
  transcribe: (audioBase64: string) => Promise<string>
}

/** / 弹层条目：命令（走 commands/execute）与技能（发给 agent 执行）合并展示。 */
export interface SlashItem {
  name: string
  description: string
  kind: 'command' | 'skill'
}

/** 附件芯片（发送时才转成内容块/内联引用）。 */
export type OrbChip =
  | { kind: 'image'; name: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }
  | { kind: 'phone-file'; name: string; data: string }
  | { kind: 'pc-file'; name: string; path: string }

const IMAGE_TYPES: Record<string, OrbChip extends { kind: 'image' } ? OrbChip['mediaType'] : never> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024

/** FileReader → dataURL 的 base64 段。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

/** 录音中的停止键：实心圆角方块（再点一下结束并转写）。 */
function StopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" rx="4" fill="currentColor" />
    </svg>
  )
}

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  chips: OrbChip[]
  onAddChips: (chips: OrbChip[]) => void
  onRemoveChip: (index: number) => void
  onSend: () => void
  /** 语音松手后直接发这条（绕过草稿：草稿里已有的内容会拼在前面一起发）。 */
  onSendText: (text: string) => void
  sending: boolean
  slashItems: SlashItem[]
  onPickSlash: (item: SlashItem) => void
  models: OrbModel[]
  modelLabel: string
  onPickModel: (model: OrbModel) => void
  /** 后台任务模型（code_agent 会话用）：标签 + 选择回调，与前台同一目录。 */
  backgroundModelLabel: string
  onPickBackgroundModel: (model: OrbModel) => void
  onOpenPcFiles: () => void
  /** 语音桥；undefined = 本次不提供语音（不渲染麦克风）。 */
  voice?: OrbVoiceBridge
  toast: (message: string) => void
  t: (key: OrbKey) => string
  disabled?: boolean
}

export function Composer({
  value,
  onChange,
  chips,
  onAddChips,
  onRemoveChip,
  onSend,
  onSendText,
  sending,
  slashItems,
  onPickSlash,
  models,
  modelLabel,
  onPickModel,
  backgroundModelLabel,
  onPickBackgroundModel,
  onOpenPcFiles,
  voice,
  toast,
  t,
  disabled = false,
}: ComposerProps) {
  const [attachMenu, setAttachMenu] = useState(false)
  const [modelMenu, setModelMenu] = useState(false)
  const [bgModelMenu, setBgModelMenu] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** 录音态：elapsed 秒 + 实时电平（0~1）。null = 没在录音。 */
  const [rec, setRec] = useState<{ elapsed: number; level: number } | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const captureRef = useRef<MicCapture | null>(null)
  const tickRef = useRef<number | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)

  /** 把转写结果接到草稿后面（已有内容结尾是标点/空白就不再补空格）。 */
  const appendText = (text: string): void => {
    if (text === '') {
      toast(t('voiceEmpty'))
      return
    }
    onChange(value === '' ? text : `${value}${/[。，、；：！？,.;:!?\s]$/.test(value) ? '' : ' '}${text}`)
  }

  /** 分段转写再拼起来：**按停顿长短决定标点**。
   * 你说话时的自然换气很长（想词的时候经常 0.8 秒以上），所以句号要卡得更严：
   * ≥1200ms 才算说完一句（句号），400–1200ms 是句内换气（逗号），更短直接连。 */
  const transcribeSegments = async (segments: VoiceSegment[]): Promise<string> => {
    let out = ''
    for (const segment of segments) {
      const part = cleanFillers(fixTerms((await voice!.transcribe(segment.audio)).trim()))
      if (part === '') continue
      if (out === '') {
        out = part
        continue
      }
      const sep = /[。！？!?…；;，,、]$/.test(out)
        ? ''
        : segment.gapMs >= 1200
          ? '。'
          : segment.gapMs >= 400
            ? '，'
            : ''
      out += sep + part
    }
    return out
  }

  /** http 局域网兜底：系统录音机录一段 → 选文件 → 转写（文件选择不受安全上下文限制）。 */
  const handleAudioFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || voice === undefined) return
    setTranscribing(true)
    try {
      const segments = await audioFileToBase64(file, voice.maxSeconds)
      appendText(await transcribeSegments(segments))
    } catch (error) {
      const kind = error instanceof VoiceError ? error.kind : null
      if (kind === 'empty') toast(t('voiceEmpty'))
      else toast(`${t('voiceFailed')}：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setTranscribing(false)
    }
  }

  const stopTick = (): void => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
  }

  /** 再点一次录音按钮：结束录音 → 转写 → 写进草稿。
   * 行为与电脑端输入框那个录音按钮一致（转成文字放进输入框，不替你发送）。 */
  const finishRecording = async (): Promise<void> => {
    const capture = captureRef.current
    if (capture === null) return
    captureRef.current = null
    stopTick()
    setRec(null)
    setTranscribing(true)
    try {
      const segments = await capture.stop(voice?.maxSeconds ?? 60)
      appendText(await transcribeSegments(segments))
    } catch (error) {
      const kind = error instanceof VoiceError ? error.kind : null
      if (kind === 'empty' || kind === 'interrupted') toast(t('voiceEmpty'))
      else if (kind === 'permission') toast(t('voiceDenied'))
      else toast(`${t('voiceFailed')}：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setTranscribing(false)
    }
  }

  /** 放弃这次录音（右侧 ✕）。 */
  const cancelRecording = (): void => {
    const capture = captureRef.current
    if (capture === null) return
    captureRef.current = null
    stopTick()
    capture.cancel()
    setRec(null)
  }

  /** 点一下开始录音。麦克风在点击手势里申请，iOS 才给。 */
  const startRecording = async (): Promise<void> => {
    if (voice === undefined || rec !== null || transcribing || sending) return
    if (voice.blocked === 'insecure') {
      // http 局域网拿不到实时麦克风（浏览器硬限制）→ 退到「系统录音机录一段、选文件」，
      // 转写链路完全相同；文件选择不受安全上下文限制，所以这条路在 http 上可用。
      toast(t('voiceInsecure'))
      audioInputRef.current?.click()
      return
    }
    if (voice.blocked === 'unsupported' || !voice.available) {
      toast(t('voiceUnavailable'))
      return
    }
    // 录音期间把输入法收起来：键盘顶着录音条很碍事；转写完也不主动 focus，
    // 免得刚说完就弹键盘把结果挡住。
    try { (document.activeElement as HTMLElement | null)?.blur?.() } catch { /* 忽略 */ }
    const capture = new MicCapture()
    captureRef.current = capture
    try {
      await capture.start()
    } catch (error) {
      captureRef.current = null
      capture.cancel()
      const kind = error instanceof VoiceError ? error.kind : null
      if (kind === 'permission') toast(t('voiceDenied'))
      else if (kind !== 'interrupted') toast(`${t('voiceFailed')}：${(error as Error)?.message ?? String(error)}`)
      return
    }
    // 授权期间又点了取消 / 组件已卸载。
    if (captureRef.current !== capture) {
      capture.cancel()
      return
    }
    setRec({ elapsed: 0, level: 0 })
    const startedAt = Date.now()
    const limit = voice.maxSeconds || 60
    tickRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      setRec((cur) => (cur === null ? cur : { ...cur, elapsed, level: capture.level() }))
      // 到上限自动收：Host 会拒收超长音频，不能等用户自己发现。
      if (elapsed >= limit) void finishRecording()
    }, 120)
  }

  const onMicClick = (): void => {
    if (rec !== null) void finishRecording()
    else void startRecording()
  }

  // 卸载时必须释放麦克风，否则轨道会一直亮着录音指示灯。
  useEffect(() => () => {
    stopTick()
    captureRef.current?.cancel()
    captureRef.current = null
  }, [])

  // 自适应增高（40vh 封顶）。
  const autosize = (): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }
  useEffect(autosize, [value])

  // / 弹层：首行以 / 开头时弹出，按输入过滤（命令 + 技能，与桌面一致）。
  const slashMatch = value.match(/^\/([a-z0-9_-]*)/i)
  const slashOpen = slashMatch !== null && !value.includes('\n')
  const slashQuery = slashMatch?.[1]?.toLowerCase() ?? ''
  const filtered = slashItems.filter((c) => c.name.toLowerCase().startsWith(slashQuery)).slice(0, 10)

  const addFiles = async (files: FileList | null, asImages: boolean): Promise<void> => {
    if (files === null || files.length === 0) return
    const added: OrbChip[] = []
    for (const file of Array.from(files)) {
      const dataUrl = await readAsDataUrl(file)
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const mediaType = IMAGE_TYPES[file.type]
      if (asImages && mediaType !== undefined && file.size <= MAX_IMAGE_BYTES) {
        added.push({ kind: 'image', name: file.name, mediaType, data })
      } else if (asImages && mediaType === undefined) {
        // 图片入口拿到非标准图片（如 HEIC）→ 降级为文件落盘引用，不阻断。
        if (file.size > MAX_FILE_BYTES) toast(t('fileTooBig'))
        else added.push({ kind: 'phone-file', name: file.name, data })
      } else if (asImages) {
        toast(t('imageTooBig'))
      } else {
        if (file.size > MAX_FILE_BYTES) toast(t('fileTooBig'))
        else added.push({ kind: 'phone-file', name: file.name, data })
      }
    }
    if (added.length > 0) onAddChips(added)
  }

  return (
    <div data-pocket-orb="composer">
      {chips.length > 0 && (
        <div data-pocket-orb="chips">
          {chips.map((chip, index) => (
            <span key={`${chip.name}-${index}`} data-pocket-orb="chip">
              {chip.kind === 'image' && <img data-pocket-orb="chip-img" src={`data:${chip.mediaType};base64,${chip.data}`} alt="" />}
              {chip.kind === 'pc-file' ? '💻' : chip.kind === 'phone-file' ? '📄' : null}
              <span data-pocket-orb="chip-name">{chip.name}</span>
              <button type="button" data-pocket-orb="chip-x" aria-label="remove" onClick={() => onRemoveChip(index)}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div data-pocket-orb="input-row">
        {/* 菜单弹层定位锚在 OrbPage 外层（menu-anchor）；这里只包按钮，不定位 */}
        <span style={{ position: 'static' }}>
          <button
            type="button"
            data-pocket-orb="icon-btn"
            aria-label={t('attach')}
            onClick={() => setAttachMenu((v) => !v)}
          >📎</button>
          {attachMenu && (
            <div data-pocket-orb="menu">
              <button
                type="button"
                data-pocket-orb="menu-item"
                onClick={() => { setAttachMenu(false); imageInputRef.current?.click() }}
              >{t('phoneImages')}</button>
              <button
                type="button"
                data-pocket-orb="menu-item"
                onClick={() => { setAttachMenu(false); fileInputRef.current?.click() }}
              >{t('phoneFiles')}</button>
              <button
                type="button"
                data-pocket-orb="menu-item"
                onClick={() => { setAttachMenu(false); onOpenPcFiles() }}
              >
                {t('pcFiles')}
                <span data-pocket-orb="menu-item-desc">{t('pcFileHint')}</span>
              </button>
            </div>
          )}
        </span>
        <div data-pocket-orb="input-shell">
          {rec !== null ? (
            <div data-pocket-orb="rec-row">
              <span data-pocket-orb="rec-dot" aria-hidden="true" />
              <span data-pocket-orb="rec-time">{rec.elapsed}s</span>
              <span data-pocket-orb="rec-bars" aria-hidden="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <i
                    key={i}
                    data-pocket-orb="rec-bar"
                    style={{
                      height: `${Math.round(4 + 20 * rec.level * (0.55 + 0.45 * Math.sin(i * 1.7 + rec.elapsed)))}px`,
                    }}
                  />
                ))}
              </span>
            </div>
          ) : transcribing ? (
            <div data-pocket-orb="rec-row">
              <span data-pocket-orb="rec-time">{t('voiceTranscribing')}</span>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              data-pocket-orb="textarea"
              rows={1}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          {/* 常驻按钮：录音中它变成红色方块，再点一下停止并转写。 */}
          {voice !== undefined && (
            <button
              type="button"
              data-pocket-orb="inline-mic"
              data-recording={rec !== null ? '1' : undefined}
              aria-label={rec !== null ? t('voiceStop') : t('voice')}
              title={rec !== null ? t('voiceStop') : t('voice')}
              disabled={transcribing}
              onClick={onMicClick}
            >
              {rec !== null ? <StopIcon /> : <RecorderIcon />}
            </button>
          )}
        </div>
        {rec !== null ? (
          <button
            type="button"
            data-pocket-orb="icon-btn"
            aria-label={t('cancel')}
            onClick={cancelRecording}
          >✕</button>
        ) : (
          <button
            type="button"
            data-pocket-orb="send-btn"
            disabled={sending || disabled || transcribing || (value.trim() === '' && chips.length === 0)}
            onClick={onSend}
          >
            {sending ? t('sending') : t('send')}
          </button>
        )}
      </div>
      {/* 输入框下方：前台模型 + 后台任务模型（同一目录；同行靠右、窄屏省略号不换行） */}
      <div data-pocket-orb="model-row">
        <button
          type="button"
          data-pocket-orb="model-btn"
          aria-label={t('model')}
          title={`${t('model')}：${modelLabel}`}
          onClick={() => { setBgModelMenu(false); setModelMenu((v) => !v) }}
        >
          🤖 <span data-pocket-orb="model-btn-label">{modelLabel}</span> ▾
        </button>
        <button
          type="button"
          data-pocket-orb="model-btn"
          aria-label={t('backgroundModel')}
          title={`${t('backgroundModel')}：${backgroundModelLabel}`}
          onClick={() => { setModelMenu(false); setBgModelMenu((v) => !v) }}
        >
          🧵 <span data-pocket-orb="model-btn-label">{backgroundModelLabel}</span> ▾
        </button>
      </div>
      {slashOpen && slashItems.length > 0 && (
        <div data-pocket-orb="menu">
          <div data-pocket-orb="menu-head">
            {t('skill')} {slashItems.filter((i) => i.kind === 'skill').length}
            {' · '}
            {t('commands')} {slashItems.filter((i) => i.kind === 'command').length}
          </div>
          {filtered.length === 0 && <div data-pocket-orb="menu-item">{t('slashEmpty')}</div>}
          {filtered.map((item) => (
            <button
              key={`${item.kind}-${item.name}`}
              type="button"
              data-pocket-orb="menu-item"
              onClick={() => onPickSlash(item)}
            >
              /{item.name}
              <span data-pocket-orb="menu-item-desc">
                {item.kind === 'skill' ? `[${t('skill')}] ` : ''}{item.description}
              </span>
            </button>
          ))}
        </div>
      )}
      {modelMenu && (
        <div data-pocket-orb="menu">
          {models.length === 0 && <div data-pocket-orb="menu-item">{t('loading')}</div>}
          {models.map((model) => (
            <button
              key={`${model.provider}/${model.model}`}
              type="button"
              data-pocket-orb="menu-item"
              onClick={() => { setModelMenu(false); onPickModel(model) }}
            >
              {model.name}
              <span data-pocket-orb="menu-item-desc">{model.groupName}</span>
            </button>
          ))}
        </div>
      )}
      {bgModelMenu && (
        <div data-pocket-orb="menu">
          <div data-pocket-orb="menu-head">
            {t('backgroundModel')} · {t('backgroundModelHint')}
          </div>
          {models.length === 0 && <div data-pocket-orb="menu-item">{t('loading')}</div>}
          {models.map((model) => (
            <button
              key={`${model.provider}/${model.model}`}
              type="button"
              data-pocket-orb="menu-item"
              onClick={() => { setBgModelMenu(false); onPickBackgroundModel(model) }}
            >
              {model.name}
              <span data-pocket-orb="menu-item-desc">{model.groupName}</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { void addFiles(e.target.files, true); e.target.value = '' }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { void addFiles(e.target.files, false); e.target.value = '' }}
      />
      {/* http 兜底录音入口：capture 让 Android/iOS 直接进系统录音机，录完把文件回传转写。 */}
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        capture
        style={{ display: 'none' }}
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = ''
          void handleAudioFile(picked)
        }}
      />
    </div>
  )
}
