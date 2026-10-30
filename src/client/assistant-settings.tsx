/**
 * 个人助手设置：手机访问 / 它记下了什么（记忆）/ Computer Use / 托管（默认状态），统一收在一处。
 *
 * - 手机访问：直接复用 pocket 的实现（同一个 RPC、同一份配置）。
 * - 它记下了什么：读宿主 GET /api/assistant{,-memory} 的条目与体积，能删某一条 / 清空一侧
 *   （写回要重启 DSH Desktop 才生效，见 assistant-memory-panel.tsx 顶部说明）。
 * - Computer Use：**不依赖 dsh-orb**。模型直接取宿主模型目录
 *   （ctx.remote.session.modelCatalog），选择结果写进本插件自己的偏好
 *   （dsh-assistant.model.cu.v1 / dsh-assistant.model.background.v1）——就是
 *   「＋ 电脑操作」新建会话与后台 code_agent 会用的那份配置。Computer Use 能力本身
 *   由 DSH 内置的 computer-use 预设提供，不需要额外插件。
 *   「使用千分比坐标」原在 dsh-orb 设置里，现迁到这里：写宿主
 *   /api/assistant/coordinate-mode（profile 的 millifraction-coordinates.json），
 *   新建 Computer Use 会话时由 assistantCoordinateMode 服务决定点击坐标系。
 * - 托管：新会话默认是否开启托管（写 `/.dsh-tuoguan/state`，跨端同步）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PocketSettingsTab } from './pocket/index.jsx'
import { setTuoguanDefault, useTuoguanDefaultOn } from './tuoguan.tsx'
import { getAssistantApi, readModelPref, writeModelPref, readBgPref, writeBgPref, ballConfigStore } from './orb-bridge.ts'
import { DEFAULT_ORB_AVATAR } from './pocket/orb/defaultAvatar.ts'
import { AssistantMemoryPanel } from './assistant-memory-panel.tsx'
import { showFirstRunGuide } from './firstRunGuide.ts'
import { downloadText } from './download.ts'

type HubSection = 'phone' | 'memory' | 'cu' | 'tuoguan'

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
  // 千分比坐标（dsh-orb 迁入）：true = 0–1000 比例，false = 截图像素。
  const [milli, setMilli] = useState<boolean | null>(null)
  const [milliBusy, setMilliBusy] = useState(false)
  const [milliNote, setMilliNote] = useState('')
  const [milliError, setMilliError] = useState(false)

  const loadCoordinateMode = (): void => {
    setMilliNote('')
    setMilliError(false)
    void fetch('/api/assistant/coordinate-mode', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => {
        if (typeof d?.enabled === 'boolean') setMilli(d.enabled)
        else throw new Error('bad payload')
      })
      .catch(() => {
        setMilli(null)
        setMilliNote('坐标设置接口还没加载：重启 DSH Desktop 后可用。')
      })
  }
  const pickMilli = (next: boolean): void => {
    setMilliBusy(true)
    setMilliNote('')
    setMilliError(false)
    void fetch('/api/assistant/coordinate-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => {
        setMilli(typeof d?.enabled === 'boolean' ? d.enabled : next)
        setMilliNote('已保存：新建的 Computer Use 会话按新坐标方式点击（已开会话不变）。')
      })
      .catch((err: unknown) => {
        setMilliError(true)
        setMilliNote(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setMilliBusy(false))
  }
  useEffect(() => { loadCoordinateMode() }, [])

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
            <p style={desc}>关闭后界面内悬浮球与桌面外悬浮球一起隐藏（控制室仍可从设置页或 ?assistant=console 打开）。桌面端默认窗口内、窗口外各一颗，点击都打开控制室。</p>
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
            <p style={desc}>从项目卡片「＋ 电脑操作」新建会话时默认用它；只影响之后新建的会话。</p>
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

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>使用千分比坐标（0–1000）</div>
            <p style={desc}>
              打开：模型按截图的 0–1000 比例给点击位置（x=500 是画面中线）。
              关闭：按截图原始像素给位置。<b>GUI 点击经常偏就关掉它</b>，再新建一个 Computer Use 会话。
            </p>
          </div>
          <Toggle
            checked={milli ?? true}
            disabled={milli === null || milliBusy}
            label="使用千分比坐标"
            onChange={pickMilli}
          />
        </div>
        {milli !== null ? (
          <p style={{ ...desc, marginTop: 8 }}>
            当前：{milli ? '千分比 0–1000' : '截图像素'}。坐标方式在会话创建时固定，只影响之后新建的会话；
            已打开的会话保持原样。
          </p>
        ) : null}
        {milliNote ? (
          <p style={milliError ? errText : { ...desc, marginTop: 4 }}>{milliNote}</p>
        ) : null}
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

/** 本机认识的预设 id：布局预设（src/client/index.tsx 的 PRESET_DEFS）+ 会话预设（standard / computer-use）。
 *  导入档案包时按这份名单判「本机没有的预设」，缺了要明确提示，不静默。 */
const KNOWN_PRESET_IDS = ['chat', '2h', '3h', 'l2', 'grid', 't3', 'l13', 'g4', 'l23', 'full', 'standard', 'computer-use']
function knownPresetIds(): string[] { return KNOWN_PRESET_IDS }

export function AssistantSettingsHub({ rpcCall, t }: { rpcCall?: any; t?: any }) {
  const [section, setSection] = useState<HubSection>('phone')
  const [diagnosticsLine, setDiagnosticsLine] = useState('')
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)

  /** P1-A：导出诊断包（脱敏）→ 落 ~/.dsh/assistant/outputs/，把路径显示出来给你复制 */
  const exportDiagnosticsBundle = async (): Promise<void> => {
    if (diagnosticsBusy) return
    setDiagnosticsBusy(true)
    setDiagnosticsLine('正在收诊断包…')
    try {
      const res = await fetch('/api/assistant/diagnostics/export', { method: 'POST', cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        setDiagnosticsLine(`没导出来：${data?.error ?? res.status}（旧宿主没有这条路由的话，需要重启 DSH Desktop 升级插件）`)
        return
      }
      setDiagnosticsLine(
        `已写到：${data.savedPath}\n体积 ${data.bytes} 字节 · 脱敏替换 ${data.redactedReplacements} 处 · 想要完整包就在浏览器里下载：`
      )
      try {
        const fileSlug = String(data.savedPath ?? '').split(/[\\/]/).pop() || 'dsh-assistant-diagnostics.json'
        const view = await fetch('/api/assistant/diagnostics', { cache: 'no-store' }).then((r) => r.text())
        downloadText(fileSlug, view)
      } catch { /* 下载失败不影响：文件已经落盘了 */ }
    } catch (err) {
      setDiagnosticsLine('没导出来：' + String(err))
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const [archiveLine, setArchiveLine] = useState('')
  const [archiveBusy, setArchiveBusy] = useState(false)

  const runImport = async (rawText: string): Promise<void> => {
    if (archiveBusy) return
    setArchiveBusy(true)
    setArchiveLine('正在导入…')
    try {
      const res = await fetch('/api/assistant/archive/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: JSON.parse(rawText), knownPresets: knownPresetIds() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) { setArchiveLine(`导入被拒：${data?.error ?? res.status}`); return }
      const written = (data.written ?? []).map((item) => `${item.area}/${item.relPath}`).join('、') || '没有新文件'
      const skipped = (data.skipped ?? []).map((item) => `${item.relPath}（${item.why}）`).slice(0, 8).join('、') || '无'
      const kept = (data.keptBoth ?? []).map((item) => `${item.relPath} → ${item.wroteAs}`).join('、') || '无'
      const missing = Array.isArray(data.missingPresets) && data.missingPresets.length
        ? `⚠️ 本机没有这些预设：${data.missingPresets.join('、')}`
        : ''
      const tombstone = data.tombstonesIgnored ? `删除墓碑：共 ${data.tombstonesIgnored} 项，一律没写回` : ''
      const backup = `备份目录：${data.backupDir ?? '（dryRun：没建备份）'}`
      const report = [
        `导入了 ${data.totals?.items ?? 0} 项 / ${data.totals?.bytes ?? 0} 字节`,
        `新增：${written}`,
        `跳过：${skipped}`,
        `冲突另存：${kept}`,
        backup,
        tombstone,
        missing,
      ].filter((line) => line !== '')
      setArchiveLine(report.join('\n'))
    } catch (err) {
      setArchiveLine('导入失败：' + String(err))
    } finally {
      setArchiveBusy(false)
    }
  }

  const exportArchive = async (): Promise<void> => {
    if (archiveBusy) return
    setArchiveBusy(true)
    setArchiveLine('正在打包…')
    try {
      const res = await fetch('/api/assistant/archive/export', { method: 'POST', cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) { setArchiveLine(`没导出：${data?.error ?? res.status}（旧宿主没有这条路由，需要重启 DSH Desktop）`); return }
      const rel = `assistant/exports/${String(data.savedPath ?? '').split(/[\\/]/).pop()}`
      setArchiveLine(`已写到：${data.savedPath}\n可复制的相对路径（相对 .dsh）：${rel}\n体积 ${data.bytes} 字节 · ${data.items} 个文件`)
      try {
        const bundle = await fetch('/api/assistant/archive', { cache: 'no-store' }).then((r) => r.text())
        downloadText('dsh-assistant-archive.json', bundle)
      } catch { /* 下载失败不影响：文件已经落盘 */ }
    } catch (err) {
      setArchiveLine('没导出：' + String(err))
    } finally {
      setArchiveBusy(false)
    }
  }

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
        {tab('memory', '🧠 它记下了什么')}
        {tab('cu', '🔮 Computer Use')}
        {tab('tuoguan', '🤝 托管')}
      </div>
      {section === 'phone' && (
        rpcCall && t
          ? <PocketSettingsTab rpcCall={rpcCall} t={t} />
          : <div style={{ padding: 12, fontSize: 12, opacity: .6 }}>手机访问设置不可用（宿主 RPC 未就绪）</div>
      )}
      {section === 'memory' && <AssistantMemoryPanel />}
      {section === 'cu' && <ComputerUsePanel />}
      {section === 'tuoguan' && <TuoguanPanel />}

      <p style={{ ...desc, padding: '0 2px', marginTop: 12 }}>
        <button
          type="button"
          style={selectStyle}
          onClick={() => { try { showFirstRunGuide({ auto: false }) } catch { /* 非浏览器环境 */ } }}
        >
          重新看一遍首启引导（三屏）
        </button>
        <button
          type="button"
          style={{ ...selectStyle, marginLeft: 8 }}
          disabled={diagnosticsBusy}
          onClick={() => void exportDiagnosticsBundle()}
        >
          🧰 导出诊断包（脱敏）
        </button>
        <button
          type="button"
          style={{ ...selectStyle, marginLeft: 8 }}
          disabled={archiveBusy}
          onClick={() => void exportArchive()}
        >
          📦 导出助手档案
        </button>
        <label style={{ ...selectStyle, marginLeft: 8, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          📥 导入助手档案
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            disabled={archiveBusy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () => void runImport(String(reader.result ?? ''))
              reader.onerror = () => setArchiveLine('读那个文件失败了')
              reader.readAsText(file)
              event.target.value = ''
            }}
          />
        </label>
      </p>
      {diagnosticsLine && <p style={{ ...desc, padding: '0 2px', marginTop: 0, whiteSpace: 'pre-wrap' }}>{diagnosticsLine}</p>}
      {archiveLine && <p style={{ ...desc, padding: '0 2px', marginTop: 0, whiteSpace: 'pre-wrap' }}>{archiveLine}</p>}
    </div>
  )
}
