/**
 * 折叠行（第四批需求 A 的「更早的消息压成一行」）。
 *
 * 一行只有：时间 + 该条首行前 24 字的短标题。可以点开看那条所在的原始文本预览，
 * 但点击**不会**把整张老卡拉回渲染（渲染窗口只在 pager 里，点击只开本地预览）。
 *
 * 三种卡共用这一行：assistant（秘书回复卡）、user（用户卡）、notice（通知卡）。
 * 元素带 `data-dsh-scard="collapsed-row"` + key/kind/turn，扫描层与分页 store 都靠它算顺序。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { CARD_KIND_ASSISTANT, truncateCardTitle } from '../../../secretary-card-shared'
import { secretaryPager } from './secretary-cards'

export interface CollapsedSecretaryCardProps {
  cardKey: string
  kind: string
  turnNo: string
  /** 卡片脚部同一套时间文本（HH:MM） */
  timeText: string
  /** 组件自己算出来的短标题兜底（pager 里没有宿主元数据时用它） */
  fallbackTitle?: string
  /** 卡自身的正文（预览兜底） */
  fallbackText?: string
}

/** 分页窗口的订阅 hook：所有卡都订阅同一个 store 版本，窗口一变就重新决定完整/折叠。 */
export function useSecretaryPagerVersion(): number {
  const pager = secretaryPager()
  return React.useSyncExternalStore(pager.subscribe, pager.getVersion, pager.getVersion)
}

/** 这张卡该完整渲染，还是压成一行折叠行。 */
export function useSecretaryCardWindow(cardKey: string): { collapsed: boolean; title: string; preview: string; capped: boolean; hintVisible: boolean } {
  const pager = secretaryPager()
  useSecretaryPagerVersion()
  const collapsed = cardKey === '' ? false : pager.isCollapsedCard(cardKey)
  const hostTitle = collapsed ? pager.collapsedTitle(cardKey) : ''
  const preview = collapsed ? pager.previewText(cardKey) : ''
  return {
    collapsed,
    title: hostTitle,
    preview,
    capped: pager.isCapped(),
    hintVisible: pager.hintVisible(),
  }
}

export function CollapsedSecretaryCard({ cardKey, kind, turnNo, timeText, fallbackTitle = '', fallbackText = '' }: CollapsedSecretaryCardProps): any {
  const pager = secretaryPager()
  const hostTitle = pager.collapsedTitle(cardKey)
  const title = hostTitle !== '' ? hostTitle : (fallbackTitle !== '' ? fallbackTitle : truncateCardTitle(fallbackText))
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)

  const toggle = (): void => { setOpen((current) => !current) }
  const preview = open ? (pager.previewText(cardKey) || fallbackText) : ''

  useEffect(() => {
    const el = rowRef.current
    if (el === null) return
    el.setAttribute('data-dsh-scard-open', open ? 'open' : 'false')
  }, [open])

  return React.createElement(
    'div',
    {
      ref: rowRef,
      'data-dsh-scard': 'collapsed-row',
      'data-dsh-scard-key': cardKey,
      'data-dsh-scard-kind': kind,
      'data-dsh-scard-turn': turnNo,
      'data-dsh-scard-open': open ? 'open' : 'false',
      className: `dsh-scard-collapsed dsh-scard-collapsed--${kind === CARD_KIND_ASSISTANT ? 'assistant' : kind}`,
    },
    React.createElement(
      'button',
      {
        type: 'button',
        'data-dsh-scard': 'collapse-row',
        'aria-expanded': open ? 'true' : 'false',
        title: '看这条原始文本预览（不会把老卡拉回渲染）',
        onClick: (event: any) => { event.stopPropagation(); toggle() },
      },
      React.createElement('span', { 'data-dsh-scard': 'collapse-time' }, timeText),
      React.createElement('span', { 'data-dsh-scard': 'collapse-title' }, title),
      React.createElement('span', { 'data-dsh-scard': 'collapse-caret' }, open ? '▸' : '▾'),
    ),
    open ? React.createElement('div', { 'data-dsh-scard': 'collapse-preview' }, preview) : null,
  )
}
