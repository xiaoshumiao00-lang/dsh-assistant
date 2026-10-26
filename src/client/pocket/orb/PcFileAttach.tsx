// 手机端会话输入框的「电脑文件」附件入口。
//
// 宿主官方输入框的附件菜单由 commandUi 提供；这里追加一个仅在手机布局出现的
// 「电脑文件」命令。选择器复用悬浮球的 PathBrowser（fs.list 在电脑主机执行，
// 可跨盘浏览），默认从当前会话 cwd 开始。选中后经本地文件路由读取字节，
// 构造 File 交给官方会话附件管线（与手机本地选择文件相同的类型限制/上传/芯片）。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { PathBrowser, type FsBrowserApi, type FsEntry } from './PathBrowser.tsx'
import type { OrbKey } from './locales.ts'
import { PC_FILE_MAX_BYTES, isPcFileTooLarge, pcFileMime, pcFileStartPath, sessionCwdOf } from '../../pcFile.ts'

interface InputActions {
  addAttachments(ids: string[]): boolean
}

interface DraftDescriptor {
  id: string
}

interface ConversationApi {
  createDrafts(sessionId: string, files: File[]): DraftDescriptor[]
  releaseDraftAttachments(drafts: DraftDescriptor[]): void
}

interface SessionsApi {
  list: { getSnapshot(): any }
}

export interface PcFileRequest {
  sessionId: string
  startPath: string
}

type Listener = () => void
const listeners = new Set<Listener>()
let pendingRequest: PcFileRequest | null = null

export const pcFilePickerStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): PcFileRequest | null {
    return pendingRequest
  },
  open(sessionId: string, cwd: string | null | undefined): void {
    pendingRequest = { sessionId, startPath: pcFileStartPath(cwd) }
    listeners.forEach((listener) => { try { listener() } catch {} })
  },
  close(): void {
    if (pendingRequest === null) return
    pendingRequest = null
    listeners.forEach((listener) => { try { listener() } catch {} })
  },
}

/** 当前已挂载输入框的附件写入面（按会话）。命令菜单只有在有输入框时才显示入口。 */
const inputActionsBySession = new Map<string, InputActions>()

export function hasPcFileComposer(sessionId: string | undefined): boolean {
  return !!sessionId && inputActionsBySession.has(sessionId)
}

/** 只注册输入框能力，不渲染任何 DOM；随 composer 挂载/卸载。 */
export function PcFileInputBridge({ sessionId, inputActions }: { sessionId?: string; inputActions?: InputActions }) {
  useEffect(() => {
    if (!sessionId || !inputActions || typeof inputActions.addAttachments !== 'function') return
    inputActionsBySession.set(sessionId, inputActions)
    return () => {
      if (inputActionsBySession.get(sessionId) === inputActions) inputActionsBySession.delete(sessionId)
      if (pcFilePickerStore.getSnapshot()?.sessionId === sessionId) pcFilePickerStore.close()
    }
  }, [sessionId, inputActions])
  return null
}

/** 手机/窄屏布局：电脑端已有系统文件选择器，不重复显示。 */
export function isPhoneComposerLayout(): boolean {
  try {
    return window.matchMedia('(max-width: 640px), (pointer: coarse)').matches
  } catch {
    return window.innerWidth <= 640
  }
}

/** 附件菜单里的电脑图标：显示器 + 上传箭头。 */
export function PcFileCommandIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.8" y="3.6" width="18.4" height="12.2" rx="2" />
      <path d="M8.3 20.4h7.4M12 15.8v4.6" />
      <path d="M12 12.4V6.4M9.5 8.9 12 6.4l2.5 2.5" />
    </svg>
  )
}

async function errorTextOf(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    if (text === '') return `HTTP ${response.status}`
    try {
      const body = JSON.parse(text)
      return String(body?.error ?? body?.message ?? text)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return `HTTP ${response.status}`
  }
}

/** 从电脑本机路由读取选中的字节。该路由与资源管理器预览共用，支持任意扩展名/二进制。 */
async function readComputerFile(entry: FsEntry): Promise<File> {
  const response = await fetch('/api/worktable/file?path=' + encodeURIComponent(entry.path), { cache: 'no-store' })
  if (!response.ok) throw new Error(await errorTextOf(response))
  const blob = await response.blob()
  return new File([blob], entry.name, {
    type: pcFileMime(entry.name, blob.type || response.headers.get('content-type')),
    lastModified: Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : Date.now(),
  })
}

export interface PcFilePickerOverlayProps {
  api: FsBrowserApi
  conversationApi?: ConversationApi | null
  sessions?: SessionsApi | null
  t: (key: OrbKey) => string
}

export function PcFilePickerOverlay({ api, conversationApi, sessions, t }: PcFilePickerOverlayProps) {
  const request = useSyncExternalStore(pcFilePickerStore.subscribe, pcFilePickerStore.getSnapshot)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    setBusy(false)
    setActionError(null)
  }, [request])

  if (request === null) return null

  const attach = async (entry: FsEntry): Promise<void> => {
    if (busy) return
    if (isPcFileTooLarge(entry.size)) {
      setActionError(t('pcFileTooLarge'))
      return
    }
    const host = inputActionsBySession.get(request.sessionId)
    if (!host) {
      setActionError(t('pcFileComposerUnavailable'))
      return
    }
    if (!conversationApi) {
      setActionError(t('pcFileAttachUnavailable'))
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const file = await readComputerFile(entry)
      if (file.size > PC_FILE_MAX_BYTES) throw new Error(t('pcFileTooLarge'))
      // 读盘期间用户可能已关闭/切换会话或输入框卸载，不能把附件塞回已失效作用域。
      if (pcFilePickerStore.getSnapshot() !== request) return
      const latestHost = inputActionsBySession.get(request.sessionId)
      if (!latestHost) throw new Error(t('pcFileComposerUnavailable'))
      const drafts = conversationApi.createDrafts(request.sessionId, [file])
      if (!latestHost.addAttachments(drafts.map((draft) => draft.id))) {
        conversationApi.releaseDraftAttachments(drafts)
        throw new Error(t('pcFileComposerBusy'))
      }
      pcFilePickerStore.close()
    } catch (error) {
      if (pcFilePickerStore.getSnapshot() === request) {
        setActionError(`${t('pcFileReadFailed')}：${(error as Error)?.message ?? String(error)}`)
      }
    } finally {
      if (pcFilePickerStore.getSnapshot() === request) setBusy(false)
    }
  }

  const cwd = (() => {
    try { return sessionCwdOf(sessions?.list.getSnapshot()?.byId?.[request.sessionId]) } catch { return '' }
  })()

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3300, pointerEvents: 'auto' }}>
      <PathBrowser
        mode="file"
        api={api}
        startPath={request.startPath || cwd}
        t={t}
        busy={busy}
        busyLabel={t('pcFileReading')}
        actionError={actionError}
        onPick={(entry) => { void attach(entry) }}
        onPickDir={() => {}}
        onClose={() => { if (!busy) pcFilePickerStore.close() }}
      />
    </div>
  )
}
