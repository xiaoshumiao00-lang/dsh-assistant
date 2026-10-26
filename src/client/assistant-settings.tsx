/**
 * 个人助手设置：手机访问 / Computer Use / 托管（默认状态），统一收在一处。
 *
 * - 手机访问：直接复用 pocket 的实现（同一个 RPC、同一份配置）。
 * - Computer Use：**不依赖 dsh-orb**。模型直接取宿主模型目录
 *   （ctx.remote.session.modelCatalog），选择结果写进本插件自己的偏好
 *   （dsh-assistant.model.cu.v1 / dsh-assistant.model.background.v1）——就是
 *   「＋ CU」新建会话与后台 code_agent 会用的那份配置。Computer Use 能力本身
 *   由 DSH 内置的 computer-use 预设提供，不需要额外插件。
 * - 托管：新会话默认是否开启托管（写 `/.dsh-tuoguan/state`，跨端同步）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PocketSettingsTab } from './pocket/index.jsx'
import { setTuoguanDefault, useTuoguanDefaultOn } from './tuoguan.tsx'
import { getAssistantApi, readModelPref, writeModelPref, readBgPref, writeBgPref, ballConfigStore } from './orb-bridge.ts'
import { DEFAULT_ORB_AVATAR } from './pocket/orb/defaultAvatar.ts'

type HubSection = 'phone' | 'cu' | 'tuoguan'

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
const card: Record<string, any> = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  borderRadius: 12, padding: '12px 14px', marginBottom: 10,
}
const row: Record<string, any> = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const title: Record<string, any> = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' }
const desc: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '3px 0 0', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' }
const errText: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '6px 0 0', color: 'var(--dsw-alias-state-danger, #e5484d)' }
const selectStyle: Record<string, any> = {
  height: 30, padding: '0 8px', borderRadius: 8, maxWidth: 260, minWidth: 180,
  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', font: 'inherit', fontSize: 12,
}

function Toggle(props: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  const { checked, disabled, label, onChange } = props
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked) }}
      style={{
        flex: 'none', width: 44, height: 24, padding: 0, borderRadius: 999, border: 'none', position: 'relative',
        background: checked ? 'var(--dsw-alias-state-accent-primary, #4f8ef7)' : 'rgba(128,128,128,.35)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
      }} />
    </button>
  )
}

/* ---------------- Computer Use（宿主模型目录 + 本插件偏好，不依赖 dsh-orb） ---------------- */

type Choice = { provider: string; model: string; name?: string }

const SEP = '\u0000'
const keyOf = (c: Choice | null): string => (c ? `${c.provider}${SEP}${c.model}` : '')

function ModelSelect(props: {
  label: string
  value: Choice | null
  models: { provider: string; model: string; name: string; groupName: string }[]
  fallback?: { provider: string; model: string }
  disabled?: boolean
  onPick: (next: Choice | null) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof props.models>()
    for (const m of props.models) {
      const list = map.get(m.groupName) ?? []
      list.push(m)
      map.set(m.groupName, list)
    }
    return [...map.entries()]
  }, [props.models])
  const value = keyOf(props.value)
  const known = props.models.some((m) => `${m.provider}${SEP}${m.model}` === value)
  const fallbackLabel = props.fallback ? `跟随默认（${props.fallback.provider} / ${props.fallback.model}）` : '跟随默认'
  return (
    <select
      aria-label={props.label}
      style={selectStyle}
      disabled={props.disabled}
      value={value}
      onChange={(e) => {
        const raw = String(e.target.value)
        if (!raw) { props.onPick(null); return }
        const [provider, model] = raw.split(SEP)
        if (!provider || !model) return
        const hit = props.models.find((m) => m.provider === provider && m.model === model)
        props.onPick({ provider, model, name: hit?.name ?? model })
      }}
    >
      <option value="">{fallbackLabel}</option>
      {!known && props.value ? <option value={value}>{`${props.value.provider} / ${props.value.model}`}</option> : null}
      {groups.map(([groupName, list]) => (
        <optgroup key={groupName} label={groupName}>
          {list.map((m) => (
            <option key={`${m.provider}${SEP}${m.model}`} value={`${m.provider}${SEP}${m.model}`}>{m.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function ComputerUsePanel() {
  const [models, setModels] = useState<{ provider: string; model: string; name: string; groupName: string }[]>([])
  const [fallback, setFallback] = useState<{ provider: string; model: string } | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [front, setFront] = useState<Choice | null>(() => readModelPref('cu'))
  const [background, setBackground] = useState<Choice | null>(() => readBgPref())

  const load = () => {
    setState('loading')
    setError('')
    try {
      const api = getAssistantApi()
      if (!api || typeof (api as any).modelCatalog !== 'function') {
        setState('error')
        setError('宿主模型目录接口还没就绪（稍等几秒再点重试）')
        return
      }
      void (api as any).modelCatalog().then((catalog: any) => {
        const list: any[] = Array.isArray(catalog?.models) ? catalog.models : []
        setModels(list.map((m) => ({
          provider: String(m?.provider ?? ''),
          model: String(m?.model ?? ''),
          name: String(m?.name ?? m?.model ?? ''),
          groupName: String(m?.groupName ?? m?.provider ?? '模型'),
        })).filter((m) => m.provider && m.model))
        const d = catalog?.default
        setFallback(d && typeof d.provider === 'string' && typeof d.model === 'string' ? { provider: d.provider, model: d.model } : undefined)
        setState('ready')
      }).catch((err: unknown) => {
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
      })
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => { load() }, [])

  const ball = useSyncExternalStore(ballConfigStore.subscribe, ballConfigStore.getSnapshot)
  const [avatarError, setAvatarError] = useState('')
  const pickAvatar = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/gif,image/png,image/webp,image/jpeg'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 512 * 1024) { setAvatarError('图片太大（上限 512 KB）'); return }
      const reader = new FileReader()
      reader.onload = () => { ballConfigStore.set({ avatar: String(reader.result ?? '') }); setAvatarError('') }
      reader.onerror = () => setAvatarError('图片读取失败')
      reader.readAsDataURL(file)
    }
    input.click()
  }

  const pickFront = (next: Choice | null): void => {
    setFront(next)
    writeModelPref('cu', next ? { provider: next.provider, model: next.model, name: next.name ?? next.model } : null)
  }
  const pickBackground = (next: Choice | null): void => {
    setBackground(next)
    writeBgPref(next ? { provider: next.provider, model: next.model, name: next.name ?? next.model } : null)
  }

  return (
    <div>
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>启用悬浮球</div>
            <p style={desc}>关闭后页面右下角的悬浮球隐藏（控制室仍可从设置页或 ?assistant=console 打开）。</p>
          </div>
          <Toggle checked={ball.enabled} label="启用悬浮球" onChange={(enabled) => ballConfigStore.set({ enabled })} />
        </div>
      </div>

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>悬浮球头像</div>
            <p style={desc}>可换成任意图片（gif / png / webp / jpg，≤ 512 KB），不设就用默认头像。</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', flex: 'none',
              border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--dsw-alias-fill-l1, rgba(0,0,0,.04))',
            }}>
              <img src={ball.avatar || DEFAULT_ORB_AVATAR} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </span>
            <button type="button" style={{ ...selectStyle, minWidth: 0, height: 28, cursor: 'pointer' }} onClick={pickAvatar}>选择图片</button>
            <button type="button" style={{ ...selectStyle, minWidth: 0, height: 28, cursor: 'pointer' }} onClick={() => ballConfigStore.set({ avatar: '' })}>恢复默认</button>
          </div>
        </div>
        {avatarError ? <p style={errText}>{avatarError}</p> : null}
      </div>

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>前台模型（Computer Use 会话）</div>
            <p style={desc}>从项目卡片「＋ CU」新建会话时默认用它；只影响之后新建的会话。</p>
          </div>
          <ModelSelect
            label="前台模型"
            value={front}
            models={models}
            fallback={fallback}
            disabled={state !== 'ready'}
            onPick={pickFront}
          />
        </div>
      </div>

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>后台模型</div>
            <p style={desc}>后台 code_agent 任务（长任务、并行子任务）默认用它。</p>
          </div>
          <ModelSelect
            label="后台模型"
            value={background}
            models={models}
            fallback={fallback}
            disabled={state !== 'ready'}
            onPick={pickBackground}
          />
        </div>
      </div>

      {state === 'loading' ? <p style={desc}>正在读取模型目录…</p> : null}
      {state === 'error' ? (
        <p style={errText}>
          模型目录读取失败：{error}
          <button type="button" style={{ ...selectStyle, height: 26, minWidth: 0, marginLeft: 8, cursor: 'pointer' }} onClick={load}>重试</button>
        </p>
      ) : null}

      <p style={{ ...desc, padding: '0 2px' }}>
        选择会立即保存，下次新建 Computer Use / 后台会话时生效。Computer Use 能力由 DSH 内置的 computer-use 预设提供，无需另外安装插件。
      </p>
    </div>
  )
}

/* ---------------- 托管：新会话默认状态 ---------------- */

function TuoguanPanel() {
  const defaultOn = useTuoguanDefaultOn()
  return (
    <div>
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>新会话默认开启托管</div>
            <p style={desc}>
              开启后，新建会话默认处于托管中：提问与审批自动按默认项应答，无需人工干预。
              关闭后默认不托管，需要时在输入框旁手动点「托管」。
            </p>
          </div>
          <Toggle checked={defaultOn} label="新会话默认开启托管" onChange={(next) => setTuoguanDefault(next)} />
        </div>
      </div>
      <p style={{ ...desc, padding: '0 2px' }}>
        这里只改「默认值」：已经单独切换过托管状态的会话保持原样；改动会同步到手机端与其它窗口。
      </p>
    </div>
  )
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
        {tab('cu', '🔮 Computer Use')}
        {tab('tuoguan', '🤝 托管')}
      </div>
      {section === 'phone' && (
        rpcCall && t
          ? <PocketSettingsTab rpcCall={rpcCall} t={t} />
          : <div style={{ padding: 12, fontSize: 12, opacity: .6 }}>手机访问设置不可用（宿主 RPC 未就绪）</div>
      )}
      {section === 'cu' && <ComputerUsePanel />}
      {section === 'tuoguan' && <TuoguanPanel />}
    </div>
  )
}
