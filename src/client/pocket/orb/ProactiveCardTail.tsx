/**
 * 主动服务卡片（标准会话页里的一枚卡片，不是另一套页面外壳）。
 *
 * 为什么挂在「本轮尾部」槽位（conversation.chat.turnTail）：
 *   - 用户在截图里认可的就是 pocket 原生会话页；插件不能再画自己的消息列表。
 *   - 这个槽位是宿主给插件预留的、位于**当前这一轮消息之后**的扩展位（deliverables
 *     的卡片就用它），所以卡片长在消息流里、外观完全是原生会话页的一部分。
 *   - 只对「个人秘书固定会话」渲染，其它会话返回 null —— 普通会话外观一个像素都不变。
 *
 * 通用性：卡片内容来自宿主 /api/assistant/proactive 的卡组，字段固定
 *   { id, title, summary?, items?, details?, time?, badge? }
 * 秘书以后每条主动消息只要按这个形状落卡，渲染出来就是同一张卡（本组件没有
 * 「明日武汉出差」之类的硬编码）。
 *
 * 稳定态守卫（防闪烁）：
 *   1. 首屏用模块缓存同步给到已渲染内容（有缓存就不会出现空态）；
 *   2. 拉到数据后**只在内容真的变了才 setState**（按内容签名比较）；
 *   3. 没有骨架屏、没有 loading 态、失败就保持原样，也不会重试到渲染震荡。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import type { OrbApi } from './orb-api.ts'

export interface ProactiveCard {
  id: string
  title: string
  summary?: string
  items?: string[]
  details?: string
  time?: string
  badge?: string
  /** 引用的会话（可选）：渲染成可点引用块。 */
  refSessionId?: string
  refTitle?: string
}

interface CachedCards {
  cards: ProactiveCard[]
  /** 已经取过一次（失败也算，避免失败后无限重试造成渲染震荡）。 */
  fetched: boolean
}

const cache = new Map<string, CachedCards>()
const inflight = new Map<string, Promise<void>>()

/**
 * 「同一批卡只在会话最末一轮显示一次」。
 *
 * turnTail 槽位是**每一轮**都会渲染一次的（实测 2 轮就出现 2 张一模一样的卡）。
 * 主动服务卡是会话级的常驻信息，不是某一轮的产出，所以只挂在最末一轮尾部：
 * 这里登记当前已挂载的各轮次序号，取最大值，只有「我这一轮 == 最大轮次」的实例渲染卡片。
 * 新的一轮挂上来时老实例自动让位（退订时重算），不需要任何轮询。
 */
const activeTurns = new Map<number, number>()
let latestTurn = -1
const turnListeners = new Set<() => void>()

function recomputeLatestTurn(): void {
  let max = -1
  for (const turn of activeTurns.keys()) if (turn > max) max = turn
  if (max === latestTurn) return
  latestTurn = max
  for (const listener of [...turnListeners]) {
    try { listener() } catch { /* 订阅者异常不影响其它实例 */ }
  }
}

function subscribeLatestTurn(listener: () => void): () => void {
  turnListeners.add(listener)
  return () => { turnListeners.delete(listener) }
}

function latestTurnSnapshot(): number {
  return latestTurn
}

/** 测试用：清空轮次登记。 */
export function resetTurnRegistryForTests(): void {
  activeTurns.clear()
  latestTurn = -1
}

/** 测试用：清空缓存。 */
export function resetProactiveCardCacheForTests(): void {
  cache.clear()
  inflight.clear()
}

/** 卡片内容签名：内容没变就不换状态引用（避免无意义重渲染 = 不闪）。 */
export function proactiveSignature(cards: ProactiveCard[]): string {
  return cards
    .map((card) => [
      card.id,
      card.title,
      card.summary ?? '',
      (card.items ?? []).join('~'),
      card.details ?? '',
      card.time ?? '',
      card.badge ?? '',
      card.refSessionId ?? '',
      card.refTitle ?? '',
    ].join('|'))
    .join('\n')
}

/** 宽松归一：宿主返回什么形状都不让组件抛错。 */
export function normalizeCards(raw: unknown): ProactiveCard[] {
  const list = Array.isArray(raw) ? raw : []
  const out: ProactiveCard[] = []
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const title = String(item.title ?? '').trim()
    if (title === '') continue
    out.push({
      id: String(item.id ?? title),
      title,
      summary: typeof item.summary === 'string' ? item.summary : '',
      items: Array.isArray(item.items) ? item.items.map((entry) => String(entry)).filter((entry) => entry !== '') : [],
      details: typeof item.details === 'string' ? item.details : '',
      time: typeof item.time === 'string' ? item.time : '',
      badge: typeof item.badge === 'string' ? item.badge : '主动服务',
      refSessionId: typeof item.refSessionId === 'string' && item.refSessionId !== '' ? item.refSessionId : undefined,
      refTitle: typeof item.refTitle === 'string' && item.refTitle !== '' ? item.refTitle : undefined,
    })
  }
  return out
}

/** 拉一次卡组；同会话并发只发一次。返回归一的卡组（失败返回已缓存内容）。 */
export async function fetchProactiveCards(sessionId: string): Promise<ProactiveCard[]> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return []
  const running = inflight.get(id)
  if (running !== undefined) {
    await running
    return cache.get(id)?.cards ?? []
  }
  const task = (async () => {
    try {
      const response = await fetch(`/api/assistant/proactive?sessionId=${encodeURIComponent(id)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return
      const body = await response.json().catch(() => null)
      const cards = normalizeCards(body?.cards)
      const current = cache.get(id)
      if (current !== undefined && proactiveSignature(current.cards) === proactiveSignature(cards)) {
        cache.set(id, { cards: current.cards, fetched: true })
        return
      }
      cache.set(id, { cards, fetched: true })
    } catch {
      // 取不到就保持原样（不显示空卡片，也不闪）
    } finally {
      inflight.delete(id)
    }
  })()
  inflight.set(id, task)
  await task
  return cache.get(id)?.cards ?? []
}

/** 组件 props：会话作用域槽位会带 sessionId（宿主 SessionStandardProps）；
 *  turnTail 槽位另外带 turn / seq（当前是第几轮），用来把卡片只挂在最末一轮。 */
export function ProactiveCardTail({ sessionId, turn, seq, api }: { sessionId?: string; turn?: number; seq?: number; api?: OrbApi }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  // 宿主 turnTail 的 props 是 sessionId / turn（Turn **对象**，不是序号）/ seq（该轮关闭节点的序号，数字）。
  // 实测（真页面 DOM 采样）：Number(turn) 恒为 NaN，所以「第几轮」的身份键只能用 seq；
  // 同一轮在不同渲染位置共享同一个 seq，可直接当去重键。seq 缺失时才退回数字型 turn。
  const turnNo = Number.isFinite(Number(seq))
    ? Number(seq)
    : (Number.isFinite(Number(turn)) ? Number(turn) : 0)
  const latest = useSyncExternalStore(subscribeLatestTurn, latestTurnSnapshot, () => 0)
  const [tick, setTick] = useState(0)
  const [cards, setCards] = useState<ProactiveCard[]>(() => cache.get(id)?.cards ?? [])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // 登记「我这一轮还挂着」：新的一轮进来后，老实例自动让位（卡片只出现在最末一轮）。
  useEffect(() => {
    activeTurns.set(turnNo, (activeTurns.get(turnNo) ?? 0) + 1)
    recomputeLatestTurn()
    return () => {
      const left = (activeTurns.get(turnNo) ?? 1) - 1
      if (left <= 0) activeTurns.delete(turnNo)
      else activeTurns.set(turnNo, left)
      recomputeLatestTurn()
    }
  }, [turnNo])

  // 会话变了（或在秘书会话挂载）：同步缓存内容，再按需拉一次；只在内容真变时 setState。
  useEffect(() => {
    if (!isSecretary) return
    const known = cache.get(id)
    if (known !== undefined) setCards(known.cards)
    if (known !== undefined && known.fetched) return
    void fetchProactiveCards(id).then((next) => {
      if (!aliveRef.current) return
      setCards((current) => (proactiveSignature(current) === proactiveSignature(next) ? current : next))
    })
  }, [id, isSecretary, tick])

  const toggle = useCallback((cardId: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }, [])

  /** 测试/调试用：强制重新拉一次（每点一次只多一次渲染）。 */
  const reload = useCallback((): void => {
    inflight.delete(id)
    cache.set(id, { cards: cache.get(id)?.cards ?? [], fetched: false })
    setTick((n) => n + 1)
  }, [id])
  void reload

  // 只在「会话最末一轮」显示（latest<=0 = 还没登记到任何轮次，按首屏先显示一次）
  const isLastTurn = latest <= 0 || turnNo === latest
  if (!isSecretary || !isLastTurn || cards.length === 0) return null

  return (
    <div data-dsh-proactive="wrap" data-dsh-proactive-turn={String(turnNo)}>
      {cards.map((card) => {
        const open = expanded.has(card.id)
        const items = card.items ?? []
        return (
          <article
            key={card.id}
            data-dsh-proactive="card"
            data-open={open ? '1' : '0'}
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => toggle(card.id)}
            onKeyDown={(event: any) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggle(card.id)
              }
            }}
          >
            <div data-dsh-proactive="head">
              <span data-dsh-proactive="badge">{card.badge || '主动服务'}</span>
              <span data-dsh-proactive="title" title={card.title}>{card.title}</span>
            </div>
            {card.summary !== undefined && card.summary !== '' && (
              <p data-dsh-proactive="summary">{card.summary}</p>
            )}
            {items.length > 0 && (
              <ul data-dsh-proactive="items">
                {(open ? items : items.slice(0, 2)).map((item) => (
                  <li key={item} data-dsh-proactive="item">{item}</li>
                ))}
              </ul>
            )}
            {open && card.details !== undefined && card.details !== '' && (
              <div data-dsh-proactive="details">{card.details}</div>
            )}
            <div data-dsh-proactive="foot">
              <span data-dsh-proactive="time">{card.time ?? ''}</span>
              <span data-dsh-proactive="foot-actions">
                {card.refSessionId !== undefined && (
                  <button
                    type="button"
                    data-dsh-proactive="ref"
                    title={`打开会话：${card.refTitle ?? card.refSessionId}`}
                    onClick={(event: any) => {
                      event.stopPropagation()
                      try { api?.openSession?.(card.refSessionId ?? '') } catch { /* 交给 focusSession 兜底 */ }
                      void api?.focusSession?.(card.refSessionId ?? '').catch(() => {})
                    }}
                  >
                    ↗ {card.refTitle ?? card.refSessionId}
                  </button>
                )}
                <button
                  type="button"
                  data-dsh-proactive="toggle"
                  onClick={(event: any) => { event.stopPropagation(); toggle(card.id) }}
                >
                  {open ? '收起' : '查看详情'}
                </button>
              </span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
