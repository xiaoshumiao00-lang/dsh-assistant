/**
 * 秘书回复卡片：秘书会话里**每一条**模型回复渲染成一张柔和浅色卡片
 * （标题行「个人秘书」+ 正文），不再以普通气泡/纯文本段落出现。
 *
 * 实现方式（不碰其它会话）：
 *   - 挂在 conversation.chat.turnTail（每轮一个），只对固定秘书会话渲染；
 *   - 正文从同一轮的 DOM 里取（[data-chat-turn] 下非 reasoning 的 assistant-step），
 *     所以读到的就是模型真实回复，TTS 与展示同源；
 *   - CSS 在秘书会话里把原始 assistant-step 文本隐藏（body[data-dsh-secretary="1"]），
 *     原始 markdown 气泡消失，只剩这张卡；工具行 / 轨迹行不受影响。
 */
import { useEffect, useRef, useState } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import { collectTurnText, stripSessionRefs } from './secretary-cards.ts'

export function SecretaryReplyCard({ sessionId }: { sessionId?: string }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  const wrapRef = useRef<HTMLElement | null>(null)
  const [turn, setTurn] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    if (!isSecretary) return
    const el = wrapRef.current
    if (el === null) return
    let alive = true
    const read = (): void => {
      if (!alive) return
      const turnNo = el.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
      setTurn(turnNo)
      setBody(collectTurnText(document, turnNo))
    }
    read()
    // 尾节点与正文同帧挂载，但投影/分页可能晚一拍：400ms 后再读一次兜底
    const timer = window.setTimeout(read, 400)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [isSecretary])

  if (!isSecretary) return null
  const display = stripSessionRefs(body).trim()
  // 注意：根节点必须无条件渲染（ref 要靠它定位轮次），内容为空时只渲染空壳
  return (
    <article ref={wrapRef as any} data-dsh-scard="card" data-dsh-scard-turn={turn} data-empty={display === '' ? '1' : '0'}>
      {display !== '' && (
        <>
          <div data-dsh-scard="head">
            <span data-dsh-scard="badge">个人秘书</span>
            <span data-dsh-scard="title">回复</span>
          </div>
          <div data-dsh-scard="body">{display}</div>
        </>
      )}
    </article>
  )
}
