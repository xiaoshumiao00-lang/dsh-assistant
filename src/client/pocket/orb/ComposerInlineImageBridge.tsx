// composer 图片光标标记的 React 桥：挂在宿主 conversation.input.left 槽位（不可见，
// 与 PcFileInputBridge 同一槽位同一拿法），从标准 props 拿 useInput / inputActions，
// 把每帧最新 InputState 喂给 composerInlineImage.ts 里的纯 driver。
// 逻辑与判据全部在 composerInlineImage.ts（零依赖，离线可测），这里只做接线。
import { useEffect, useMemo, useRef } from 'react'
import {
  createComposerInlineImageDriver,
  type ComposerInlineImageDriver,
  type DraftAttachmentLike,
} from './composerInlineImage.ts'

interface InputActionsLike {
  captureInsertion?: () => { start: number; end: number; draftRev: number }
  insertText?: (text: string, span: { start: number; end: number; draftRev: number }) => boolean
}

interface ConversationApiLike {
  resolveDraftAttachments?: (ids: readonly string[]) => readonly DraftAttachmentLike[]
}

interface InputSnapshotLike {
  draft: string
  attachmentIds: readonly string[]
  draftRev: number
  phase: string
}

export function ComposerInlineImageBridge({
  sessionId,
  inputActions,
  useInput,
  conversationApi,
}: {
  sessionId?: string
  inputActions?: InputActionsLike
  useInput?: <T>(selector: (state: InputSnapshotLike) => T) => T
  conversationApi?: ConversationApiLike | null
}): null {
  // 严格 session 作用域槽位：useInput 一定在（SessionStandardProps）。没有就整个不动作。
  const input = typeof useInput === 'function' ? useInput((state) => state) : undefined

  const driverRef = useRef<ComposerInlineImageDriver | null>(null)
  const depsRef = useRef({ inputActions, conversationApi })
  depsRef.current = { inputActions, conversationApi }

  const driver = useMemo(() => createComposerInlineImageDriver({
    insertText: (text, span) => {
      const actions = depsRef.current.inputActions
      if (typeof actions?.insertText !== 'function') return false
      try {
        return actions.insertText(text, span) === true
      } catch {
        return false
      }
    },
    captureInsertion: () => {
      const actions = depsRef.current.inputActions
      if (typeof actions?.captureInsertion !== 'function') throw new Error('captureInsertion unavailable')
      return actions.captureInsertion()
    },
    resolveAttachments: (ids) => {
      const api = depsRef.current.conversationApi
      if (typeof api?.resolveDraftAttachments !== 'function') return []
      try {
        return api.resolveDraftAttachments(ids) ?? []
      } catch {
        return []
      }
    },
    readStorage: (key) => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
  }), [])

  useEffect(() => {
    driverRef.current = driver
    if (input === undefined) return
    driver.onInput(
      {
        draft: typeof input.draft === 'string' ? input.draft : '',
        attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : [],
        draftRev: typeof input.draftRev === 'number' ? input.draftRev : 0,
        phase: typeof input.phase === 'string' ? input.phase : 'plain',
      },
      sessionId,
    )
  })

  // 卸载时忘掉这个会话，避免下次挂载把旧图片当成「新增」再插一遍标记。
  useEffect(() => () => {
    if (sessionId !== undefined) driverRef.current?.forgetSession(sessionId)
  }, [driver, sessionId])

  return null
}
