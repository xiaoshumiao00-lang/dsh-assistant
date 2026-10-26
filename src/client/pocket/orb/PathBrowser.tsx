// 电脑路径浏览器（底部抽屉）：浏览的一定是**本地电脑**的目录/文件（fs.list 主机端执行）。
// mode='dir' → 只列目录，底部「选择此目录」；mode='file' → 列目录+文件，点文件即选中。
import { useEffect, useState } from 'react'
import type { OrbKey } from './locales.ts'

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

  useEffect(() => {
    let live = true
    setError(null)
    setListing(null)
    api.listFs(path, { includeFiles: mode === 'file' }).then(
      (result) => {
        if (live) setListing(result as FsListing)
      },
      (err) => {
        if (live) setError(err?.message ?? String(err))
      },
    )
    return () => {
      live = false
    }
  }, [path, mode])

  const upOne = (): void => {
    if (!listing) return
    const parent = listing.crumbs.length >= 2 ? listing.crumbs[listing.crumbs.length - 2].path : listing.path
    if (parent !== listing.path) setPath(parent)
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
