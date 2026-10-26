/**
 * 个人助手设置：原 dsh-pocket 的手机访问 / 原 dsh-orb 的 Computer Use / 模型，
 * 统一收在一处。手机访问的设置页直接复用 pocket 的实现（同一个 RPC、同一份配置）。
 */
import { useState } from 'react'
import { PocketSettingsTab } from './pocket/index.jsx'

type HubSection = 'phone' | 'orb' | 'model'

const segWrap: Record<string, any> = {
  display: 'flex', gap: 6, margin: '2px 0 12px', padding: 3,
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))', borderRadius: 10,
  background: 'var(--dsw-alias-fill-l1, rgba(0,0,0,.03))',
}
const segBtn: Record<string, any> = {
  flex: 1, padding: '6px 8px', border: 0, borderRadius: 8, background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #666)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const segOn: Record<string, any> = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'var(--dsw-alias-label-primary, #111)',
  fontWeight: 600,
  boxShadow: '0 1px 3px rgba(0,0,0,.12)',
}
const jumpCard: Record<string, any> = {
  display: 'flex', flexDirection: 'column', gap: 8, width: '100%', textAlign: 'left',
  padding: '14px', marginTop: 4, border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
  borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', font: 'inherit',
}
const linkBtn: Record<string, any> = {
  alignSelf: 'flex-start', padding: '6px 14px', border: 0, borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 12,
  background: 'var(--dsw-alias-state-business-primary, #4f8ef7)', color: '#fff',
}

function clickSettingsTab(label: string): void {
  try {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"], a'))
    const hit = nodes.find((el) => (el.textContent || '').trim() === label && el.offsetParent !== null)
    hit?.click()
  } catch { /* 忽略 */ }
}

export function AssistantSettingsHub({ rpcCall, t }: { rpcCall?: any; t?: any }) {
  const [section, setSection] = useState<HubSection>('phone')
  const tab = (id: HubSection, label: string) => (
    <button
      type="button"
      style={{ ...segBtn, ...(section === id ? segOn : {}) }}
      onClick={() => setSection(id)}
    >
      {label}
    </button>
  )
  return (
    <div style={{ padding: '2px 2px 14px' }}>
      <div style={segWrap}>
        {tab('phone', '📱 手机访问')}
        {tab('orb', '🔮 Computer Use')}
        {tab('model', '🤖 模型')}
      </div>
      {section === 'phone' && (
        rpcCall && t
          ? <PocketSettingsTab rpcCall={rpcCall} t={t} />
          : <div style={{ padding: 12, fontSize: 12, opacity: .6 }}>手机访问设置不可用（宿主 RPC 未就绪）</div>
      )}
      {section === 'orb' && (
        <div style={jumpCard}>
          <b style={{ fontSize: 13 }}>悬浮球与 Computer Use（dsh-orb）</b>
          <span style={{ fontSize: 12, opacity: .7 }}>前后台模型、桌面悬浮球与电脑操作能力由 dsh-orb 提供，配置入口在独立的「悬浮球」页签。</span>
          <button type="button" style={linkBtn} onClick={() => clickSettingsTab('悬浮球')}>打开悬浮球设置</button>
        </div>
      )}
      {section === 'model' && (
        <div style={jumpCard}>
          <b style={{ fontSize: 13 }}>模型</b>
          <span style={{ fontSize: 12, opacity: .7 }}>新增 / 编辑供应商与模型；控制室新建会话时可选，并记住上一次选择。</span>
          <button type="button" style={linkBtn} onClick={() => clickSettingsTab('模型')}>打开模型设置</button>
        </div>
      )}
    </div>
  )
}
