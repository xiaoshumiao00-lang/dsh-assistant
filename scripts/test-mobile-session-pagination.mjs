/** 手机会话列表截页与首次详情历史窗口回归：node scripts/test-mobile-session-pagination.mjs */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sessionPageModel, SESSION_PAGE_SIZE } from '../src/client/pocket/mobile/session-pagination.mjs'

const makeList = (count, { current = '', pinned = [], archived = [] } = {}) => {
  const ids = Array.from({ length: count }, (_, i) => `s${String(i).padStart(3, '0')}`)
  const byId = Object.fromEntries(ids.map((id, i) => [id, {
    id,
    title: `标题 ${id}`,
    updatedAt: 10_000 - i,
    retainedBy: id === current ? { mainView: 1 } : {},
    pinned: pinned.includes(id),
    archived: archived.includes(id),
  }]))
  return { ids, byId, phase: 'ready', projectionsBySession: {} }
}
const workspacesFor = (list) => ({
  phase: 'ready', state: 'idle', archivedSessionIds: Object.values(list.byId).filter((s) => s.archived).map((s) => s.id),
  pinnedSessionIds: Object.values(list.byId).filter((s) => s.pinned).map((s) => s.id),
  items: [
    { workspaceId: 'w0', path: 'D:/zero', title: 'Zero', createdAt: '2026-01-01', sessionIds: list.ids.filter((_, i) => i % 2 === 0) },
    { workspaceId: 'w1', path: 'D:/one', title: 'One', createdAt: '2026-01-02', sessionIds: list.ids.filter((_, i) => i % 2 === 1) },
  ],
})
const view = { groupBy: 'flat', orderBy: 'updated', archivedFilter: 'default', sessionOrderByAccount: {}, groupExpansion: {} }
const idsOf = (model) => model.visibleIds

// 1. 默认只取当前排序前 20，完整 byId / 原数组均不删不改。
{
  const list = makeList(45)
  const before = JSON.stringify(list)
  const model = sessionPageModel(list, workspacesFor(list), view, SESSION_PAGE_SIZE)
  assert.equal(SESSION_PAGE_SIZE, 20)
  assert.equal(model.total, 45)
  assert.equal(model.loaded, 20)
  assert.equal(model.hasMore, true)
  assert.deepEqual(idsOf(model), list.ids.slice(0, 20))
  assert.equal(Object.keys(model.list.byId).length, 45, '选择/搜索仍需完整元数据')
  assert.equal(JSON.stringify(list), before, '不得原地改宿主快照')
}

// 2. 加载更多按原顺序追加，无重复、无漏项；末页精确到总数。
{
  const list = makeList(45)
  const ws = workspacesFor(list)
  const first = sessionPageModel(list, ws, view, 20)
  const second = sessionPageModel(list, ws, view, 40)
  const third = sessionPageModel(list, ws, view, 60)
  assert.deepEqual(idsOf(second).slice(0, 20), idsOf(first))
  assert.equal(new Set(idsOf(second)).size, 40)
  assert.deepEqual(idsOf(third), list.ids)
  assert.equal(third.loaded, 45)
  assert.equal(third.hasMore, false)
}

// 3. 当前选择在 20 条之外仍作为有序额外行保留；翻到覆盖它后不重复。
{
  const list = makeList(45, { current: 's037' })
  const ws = workspacesFor(list)
  const first = sessionPageModel(list, ws, view, 20)
  assert.equal(first.loaded, 21)
  assert.equal(first.visibleIds.at(-1), 's037')
  assert.equal(first.list.byId.s037.retainedBy.mainView, 1, '主面板选择不能丢')
  const second = sessionPageModel(list, ws, view, 40)
  assert.equal(second.visibleIds.filter((id) => id === 's037').length, 1)
  assert.equal(second.loaded, 40)
}

// 4. 目录只过滤成员，不重排目录、不改每个目录内部既有相对顺序。
{
  const list = makeList(45, { current: 's037' })
  const ws = workspacesFor(list)
  const model = sessionPageModel(list, ws, view, 20)
  assert.deepEqual(model.workspaces.items.map((w) => w.workspaceId), ['w0', 'w1'])
  for (const [index, original] of ws.items.entries()) {
    const actual = model.workspaces.items[index].sessionIds
    assert.deepEqual(actual, original.sessionIds.filter((id) => model.visibleIds.includes(id)))
  }
  assert.equal(new Set(model.workspaces.items.flatMap((w) => w.sessionIds)).size,
    model.workspaces.items.flatMap((w) => w.sessionIds).length)
}

// 5. 手动排序以宿主 flat account 为准，rename 不改 updatedAt 也不应改变顺序。
{
  const list = makeList(30)
  const manual = [...list.ids].reverse()
  const ws = workspacesFor(list)
  const custom = { ...view, orderBy: 'manual', sessionOrderByAccount: { __flat_session_order__: manual } }
  const first = sessionPageModel(list, ws, custom, 20)
  assert.deepEqual(first.visibleIds, manual.slice(0, 20))
  list.byId.s000.title = '重命名后的标题'
  const renamed = sessionPageModel(list, ws, custom, 20)
  assert.deepEqual(renamed.visibleIds, first.visibleIds)
}

// 6. 归档过滤先作用于全集再取 20，不能先截普通会话导致“仅归档”空白。
{
  const archived = Array.from({ length: 25 }, (_, i) => `s${String(i).padStart(3, '0')}`)
  const list = makeList(45, { archived })
  const ws = workspacesFor(list)
  const model = sessionPageModel(list, ws, { ...view, archivedFilter: 'only' }, 20)
  assert.equal(model.total, 25)
  assert.equal(model.loaded, 20)
  assert.ok(model.visibleIds.every((id) => archived.includes(id)))
}

// 7. 新建/删除按最新快照重算；空页会收敛，不会把已删选择伪造成仍存在。
{
  const list = makeList(25, { current: 's024' })
  const ws = workspacesFor(list)
  const created = makeList(26, { current: 's024' })
  created.byId.s025 = { ...created.byId.s000, id: 's025', updatedAt: 20_000 }
  created.ids = ['s025', ...created.ids.filter((id) => id !== 's025')]
  const added = sessionPageModel(created, workspacesFor(created), view, 20)
  assert.equal(added.visibleIds[0], 's025')
  assert.equal(added.visibleIds.at(-1), 's024')
  const deleted = makeList(24)
  const removed = sessionPageModel(deleted, workspacesFor(deleted), view, 20)
  assert.equal(removed.total, 24)
  assert.equal(removed.visibleIds.includes('s024'), false)
}

// 8. 接线回归：只包手机布局，搜索时恢复完整快照，footer 是实际数据页而不是 CSS 隐藏。
{
  const apply = readFileSync(new URL('../src/client/pocket/mobile/mobile-apply.tsx', import.meta.url), 'utf8')
  assert.match(apply, /installMobileSessionPagination/, 'mobileApply 未安装会话截页')
  const wrapper = readFileSync(new URL('../src/client/pocket/mobile/MobileSessionPagination.tsx', import.meta.url), 'utf8')
  assert.match(wrapper, /data-dshp-load-more/)
  assert.match(wrapper, /paging \? model\.list : fullList/)
  assert.match(wrapper, /const workspaceSnapshot = fullWorkspaces/, '平铺分页不得改目录快照')
  assert.match(wrapper, /SESSION_PAGE_SIZE/)
  assert.doesNotMatch(wrapper, /children:\s*original\.children/, 'shadow entry 不得重复声明宿主子 slot')
  assert.match(wrapper, /document\.addEventListener\('focusout', onInput, true\)/, '搜索清空/失陪必须退出完整快照模式')
  assert.match(wrapper, /const useSessions = useMemo/, '传给宿主的 hook 必须保持引用稳定')
  assert.match(wrapper, /original\.component = Component/, '必须原位包装以保留原 children / renderSlot')
  assert.doesNotMatch(wrapper, /disposeShadow = ctx\.slots\.register/, '不得再注册会丢子 slot 的 shadow entry')
  assert.doesNotMatch(wrapper, /display:\s*['"]none['"]/, '不得用 CSS 隐藏冒充数据分页')
}

console.log('mobile-session-pagination: 8/8 通过')
