// 电脑路径浏览器（底部抽屉）：浏览的一定是**本地电脑**的目录/文件（fs.list 主机端执行）。
// mode='dir' → 只列目录，底部「选择此目录」；mode='file' → 列目录+文件，点文件即选中。
//
// 复用方：悬浮球项目目录 / 会话输入框「电脑文件」附件 / 工作台新建项目「选择位置」
// （三者共用同一套跨盘、面包屑、桌面快捷方式逻辑，不再各写一份浏览弹窗）。
import { useEffect, useRef, useState } from 'react'
import type { OrbKey } from './locales.ts'
import { parentPathOf } from '../../pathutil.ts'
import { copyTextToClipboard } from '../../clipboard.ts'

export interface FsEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size: number
  mtimeMs: number
  hidden: boolean
}

interface FsListing {
  path: string
  home: string
  desktop: string
  drives: string[]
  crumbs: Array<{ name: string; path: string }>
  entries: FsEntry[]
  truncated: boolean
}

export interface FsBrowserApi {
  listFs(path: string, opts?: { includeFiles?: boolean; cwd?: string }): Promise<unknown>
}

export interface PathBrowserProps {
  mode: 'dir' | 'file'
  api: FsBrowserApi
  startPath: string
  t: (key: OrbKey) => string
  onPick: (entry: FsEntry) => void
  onPickDir: (path: string) => void
  onClose: () => void
  /** 选中文件后的读取/暂存中状态（不阻塞列表浏览，只提示正在处理）。 */
  busy?: boolean
  busyLabel?: string
  /** 选中文件失败时显示在列表上方的错误（例如读取失败/会话输入框不可用）。 */
  actionError?: string | null
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function PathBrowser({ mode, api, startPath, t, onPick, onPickDir, onClose, busy = false, busyLabel, actionError = null }: PathBrowserProps) {
  const [path, setPath] = useState(startPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 起始路径不存在/读不了、已自动退到上级目录的提示（只在首次定位时出现） */
  const [fellBack, setFellBack] = useState(false)
  /** 起始路径（mount 时定）：只在还停在起点时允许自动上退；用户自己导航后一律按结果报错 */
  const initialPathRef = useRef(startPath)
  /** 地址栏复制反馈：idle 显示「复制地址」，done/fail 短暂显示结果后复位 */
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'fail'>('idle')
  const copyTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
  }, [])

  useEffect(() => {
    let live = true
    setError(null)
    setListing(null)
    setFellBack(false)
    // 起点允许逐级上退：新建项目的默认文件夹是「待创建」的时间戳目录，
    // 会话 cwd 也可能已被删除——直接报「无法读取目录」会让选择器成为死路。
    const allowFallback = path === initialPathRef.current
    void (async () => {
      let target = path
      let stepped = false
      for (;;) {
        try {
          const result = (await api.listFs(target, { includeFiles: mode === 'file' })) as FsListing
          if (!live) return
          setListing(result)
          setFellBack(stepped)
          return
        } catch (err) {
          if (!live) return
          const parent = parentPathOf(target)
          if (allowFallback && parent && parent !== target) {
            target = parent
            stepped = true
            continue
          }
          setError(err?.message ?? String(err))
          return
        }
      }
    })()
    return () => {
      live = false
    }
  }, [path, mode])

  const upOne = (): void => {
    // 列表没读出来（含首次定位失败）时按字符串取上级，保证「上一级」始终能当退路。
    if (!listing) {
      const parent = parentPathOf(path)
      if (parent !== path) setPath(parent)
      return
    }
    const parent = listing.crumbs.length >= 2 ? listing.crumbs[listing.crumbs.length - 2].path : listing.path
    if (parent !== listing.path) setPath(parent)
  }

  /** 地址栏当前展示/复制的绝对路径：优先用主机返回的规范化路径，读不到时退回导航中的路径 */
  const currentPath = listing?.path || path

  /** 一键复制当前地址（http 页面没有 Clipboard API 时由 copyTextToClipboard 兜底） */
  const copyCurrentPath = async (): Promise<void> => {
    if (currentPath === '') return
    const copied = await copyTextToClipboard(currentPath)
    setCopyState(copied ? 'done' : 'fail')
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }

  return (
    <>
      <div data-pocket-orb="sheet-mask" onClick={onClose} />
      <div data-pocket-orb="sheet">
        <div data-pocket-orb="sheet-head">
          <button type="button" data-pocket-orb="header-btn" onClick={upOne}>{t('upOne')}</button>
          {/* 「桌面」= 系统真实桌面目录（支持重定向，如 D:\陈潘HBEU\Desktop） */}
          <button type="button" data-pocket-orb="header-btn" onClick={() => setPath(listing?.desktop ?? listing?.home ?? '')}>{t('home')}</button>
          <div data-pocket-orb="target-path">{mode === 'file' ? t('pcFileHint') : t('pickDir')}</div>
          <button type="button" data-pocket-orb="header-btn" onClick={onClose}>{t('cancel')}</button>
        </div>
        {/* 地址栏：显示当前绝对路径，点一下即复制（手机上 http 页面由 execCommand 兜底） */}
        {currentPath !== '' && (
          <button
            type="button"
            data-pocket-orb="path-bar"
            data-copied={copyState}
            title={currentPath}
            onClick={() => { void copyCurrentPath() }}
          >
            <span data-pocket-orb="path-text">{currentPath}</span>
            <span data-pocket-orb="path-copy">
              {copyState === 'done' ? t('copied') : copyState === 'fail' ? t('copyFailed') : t('copyPath')}
            </span>
          </button>
        )}
        {/* 盘符切换条：跨盘浏览（C:\ D:\ E:\ …），当前盘高亮 */}
        {listing && listing.drives.length > 0 && (
          <div data-pocket-orb="crumbs">
            {listing.drives.map((drive) => (
              <button
                key={drive}
                type="button"
                data-pocket-orb="crumb"
                data-current={listing.path.toLowerCase().startsWith(drive.toLowerCase()) ? '1' : '0'}
                onClick={() => setPath(drive)}
              >
                {drive.slice(0, 2)}
              </button>
            ))}
          </div>
        )}
        {listing && (
          <div data-pocket-orb="crumbs">
            {listing.crumbs.map((crumb) => (
              <span key={crumb.path}>
                <button type="button" data-pocket-orb="crumb" onClick={() => setPath(crumb.path)}>{crumb.name}</button>
                <span>/</span>
              </span>
            ))}
          </div>
        )}
        <div data-pocket-orb="sheet-list">
          {fellBack && <div data-pocket-orb="sheet-status" role="status">{t('fallbackUp')}</div>}
          {error !== null && <div data-pocket-orb="sheet-status">{error}</div>}
          {actionError != null && actionError !== '' && (
            <div data-pocket-orb="sheet-status" role="alert" style={{ color: 'var(--dsw-alias-state-error-primary,#d54941)' }}>{actionError}</div>
          )}
          {busy && <div data-pocket-orb="sheet-status" role="status">{busyLabel ?? t('loading')}</div>}
          {listing === null && error === null && <div data-pocket-orb="sheet-status">{t('loading')}</div>}
          {listing !== null && listing.entries.length === 0 && <div data-pocket-orb="sheet-status">{t('emptyDir')}</div>}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              data-pocket-orb="entry"
              disabled={busy && entry.kind === 'file'}
              onClick={() => (entry.kind === 'dir' ? setPath(entry.path) : onPick(entry))}
            >
              <span data-pocket-orb="entry-icon">{entry.kind === 'dir' ? '📁' : '📄'}</span>
              <span data-pocket-orb="entry-name">{entry.name}</span>
              {entry.kind === 'file' && <span data-pocket-orb="entry-meta">{fmtSize(entry.size)}</span>}
            </button>
          ))}
          {listing?.truncated === true && <div data-pocket-orb="sheet-status">{t('truncated')}</div>}
        </div>
        {mode === 'dir' && listing !== null && (
          <div data-pocket-orb="sheet-foot">
            <button type="button" data-pocket-orb="sheet-btn" onClick={onClose}>{t('cancel')}</button>
            <button type="button" data-pocket-orb="sheet-btn" data-primary="1" onClick={() => onPickDir(listing.path)}>
              {t('pickThisDir')}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
