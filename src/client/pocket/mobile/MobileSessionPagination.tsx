import { createElement as h, useEffect, useMemo, useState } from 'react'
import { SESSION_PAGE_SIZE, sessionPageModel } from './session-pagination.mjs'

export interface MobileSessionPaginationLabels {
  loadMore: string
  loaded: string
}

/**
 * 包装宿主 single slot 的原 WorkspaceBrowser，而不是复制一套会话 CRUD。
 * 原组件、inject、children slot、view store 全部复用；这里只在平铺视图投影分页后的
 * sessions hook，workspaces 快照保持完整，因此打开、重命名、归档、拖动排序仍走宿主原动作。
 */
function wrapWorkspaceBrowser(Original: any, labels: MobileSessionPaginationLabels): any {
  const MobileSessionPagination = (props: any) => {
    const fullList = props.useSessions((state: any) => state)
    const fullWorkspaces = props.useWorkspaces((state: any) => state)
    const view = props.useStore((state: any) => state)
    const [limit, setLimit] = useState(SESSION_PAGE_SIZE)
    const [searching, setSearching] = useState(false)

    // 搜索仍交给原组件与原 remote search；有查询时恢复完整元数据，保证 20 条之外的
    // 标题、目录、正文结果都不少。清空 / Escape / 打开结果后回到截页视图。
    useEffect(() => {
      const isSearchInput = (target: any): boolean => target instanceof Element
        && target.matches('[class$="_searchInput"]')
      const syncSearchValue = (target: any) => {
        if (!isSearchInput(target)) return
        queueMicrotask(() => {
          const input = document.querySelector('[class$="_searchInput"]') as HTMLInputElement | null
          setSearching(input?.value.trim() ? true : false)
        })
      }
      const onInput = (event: Event) => syncSearchValue(event.target)
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && isSearchInput(event.target)) setSearching(false)
      }
      const onClick = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return
        if (event.target.closest('[class$="_clearButton"], [class*="searchResultRow"]') !== null) setSearching(false)
      }
      document.addEventListener('input', onInput, true)
      document.addEventListener('change', onInput, true)
      document.addEventListener('keyup', onInput, true)
      document.addEventListener('focusout', onInput, true)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('click', onClick, true)
      return () => {
        document.removeEventListener('input', onInput, true)
        document.removeEventListener('change', onInput, true)
        document.removeEventListener('keyup', onInput, true)
        document.removeEventListener('focusout', onInput, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('click', onClick, true)
      }
    }, [])

    useEffect(() => {
      setLimit(SESSION_PAGE_SIZE)
    }, [view?.groupBy, view?.orderBy, view?.archivedFilter])

    const model = useMemo(
      () => sessionPageModel(fullList, fullWorkspaces, view, limit),
      [fullList, fullWorkspaces, view, limit],
    )
    // 搜索时不能截 list.ids / workspace.sessionIds，否则宿主本地即时匹配会漏掉未加载行。
    const paging = !searching && view?.groupBy === 'flat'
    // FlatList 只读 list.ids；目录快照保持完整，避免触发宿主目录保留/排序副作用。
    const sessionSnapshot = paging ? model.list : fullList
    const workspaceSnapshot = fullWorkspaces
    const useSessions = useMemo(() => (selector: any) =>
      props.useSessions((_: any) => selector(sessionSnapshot)), [props.useSessions, sessionSnapshot])
    const useWorkspaces = useMemo(() => (selector: any) =>
      props.useWorkspaces((_: any) => selector(workspaceSnapshot)), [props.useWorkspaces, workspaceSnapshot])

    const original = Original({ ...props, useSessions, useWorkspaces })
    return h('div', {
      'data-dshp-session-pagination': searching ? 'search' : paging ? 'page' : 'native',
      style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' },
    },
    h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } }, original),
    paging && model.total > 0 ? h('div', {
      'data-dshp-session-page-footer': '',
      style: {
        flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: '6px 8px', borderTop: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)', fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
    },
    model.hasMore ? h('button', {
      type: 'button',
      'data-dshp-load-more': '',
      'aria-label': `${labels.loadMore} · ${labels.loaded} ${model.loaded} / ${model.total}`,
      onClick: () => setLimit((current) => current + SESSION_PAGE_SIZE),
      style: {
        font: 'inherit', cursor: 'pointer', minHeight: 30, padding: '0 12px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        color: 'var(--dsw-alias-label-secondary, #4b5563)',
        fontWeight: 500, boxShadow: 'none',
      },
    }, labels.loadMore) : null,
    h('span', { 'data-dshp-session-page-count': '' }, `${labels.loaded} ${model.loaded} / ${model.total}`)) : null)
  }
  Object.defineProperty(MobileSessionPagination, '__dshMobileSessionPagination', { value: true })
  return MobileSessionPagination
}

/**
 * 原位装饰官方 entry.component，保留原 entry 的 children / store / inject 所有权。
 * 单独 shadow 一份 entry 会丢掉 renderSlot 组合上下文；重复 children 又会被 SlotCore 拒绝。
 * 注册并立刻撤销一个不占位的优先级脉冲，只是让 SlotCore 通知 React 重读 component。
 */
export function installMobileSessionPagination(ctx: any, labels: MobileSessionPaginationLabels): () => void {
  let stopped = false
  let syncing = false
  let wrappedEntry: any = null
  let wrappedComponent: any = null
  let originalComponent: any = null
  const pulse = (entry: any): void => {
    const base = Number(entry?.options?.priority ?? 0)
    for (let offset = 1; offset <= 20; offset += 1) {
      try {
        const dispose = ctx.slots.register({
          name: 'sidebar.workspaces', priority: (Number.isFinite(base) ? base : 0) + offset,
        }, () => null)
        dispose()
        return
      } catch { /* 优先级撞车时试下一位，不碰其它 entry */ }
    }
  }
  const restore = (): void => {
    if (wrappedEntry !== null && wrappedEntry.component === wrappedComponent) {
      wrappedEntry.component = originalComponent
      pulse(wrappedEntry)
    }
    wrappedEntry = null
    wrappedComponent = null
    originalComponent = null
  }
  const sync = (): void => {
    if (stopped || syncing) return
    syncing = true
    try {
      const entries = ctx.slots.entriesOfSlot('sidebar.workspaces') ?? []
      const original = [...entries].reverse().find((entry: any) =>
        entry?.component && entry.component.__dshMobileSessionPagination !== true)
      if (original === undefined) return
      if (wrappedEntry !== null && wrappedEntry !== original) restore()
      if (original.component === wrappedComponent && wrappedEntry === original) return
      originalComponent = original.component
      const Component = wrapWorkspaceBrowser(originalComponent, labels)
      original.component = Component
      wrappedEntry = original
      wrappedComponent = Component
      pulse(original)
    } finally {
      syncing = false
    }
  }
  const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', sync)
  sync()
  return () => {
    stopped = true
    try { unsubscribe?.() } catch { /* 不影响宿主原组件恢复 */ }
    restore()
  }
}
