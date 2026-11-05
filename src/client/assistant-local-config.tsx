/**
 * 设置 →「本机配置」（P0-2，2026-11-05）。
 *
 * 三个分组（都写 `~/.dsh/assistant/config.json`，保存后宿主立即生效）：
 *   ① 目录与路径：newProjectParent / skillRoot（目录选择器，不让人手打路径）
 *   ② 语音词表：asrTerms（增删行 / pattern·replace·flags / 导入导出）
 *   ③ 目录边界：allowedRoots 列表 + allowAllLocalPaths 开关（红字警告 + 确认口令）
 * 另加一个「更新检查」（P0-3）：updateCheckEnabled + updateSource，默认关闭。
 *
 * 为什么要做成设置项：这几项换一台机器/换一个人就全错，而之前只能手改 JSON。
 */
import { useEffect, useRef, useState } from 'react'
import { PathBrowser } from './pocket/orb/PathBrowser.tsx'
import { zh as ORB_ZH, en as ORB_EN } from './pocket/orb/locales.ts'
import { zh as WT_ZH, en as WT_EN } from './locales.ts'
import {
  loadAssistantConfig,
  reloadAssistantConfig,
  saveAssistantConfig,
  type AsrTermRule,
  type AssistantClientConfig,
} from './assistant-config.ts'
import { downloadText } from './download.ts'

/* ------------------------------------------------------------------ 文案 */

function detectEn(): boolean {
  try {
    const lang = String(globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '')
    if (lang) return !lang.toLowerCase().startsWith('zh')
  } catch { /* 非浏览器环境 */ }
  return false
}

const EN = detectEn()
const WT_FALLBACK: Record<string, string> = (EN ? WT_EN : WT_ZH) as unknown as Record<string, string>
const ORB_FALLBACK: Record<string, string> = (EN ? ORB_EN : ORB_ZH) as unknown as Record<string, string>

/** 翻译：优先用宿主 locale 绑定（`tl`），拿不到就退回内置词典，再退回 key。 */
function makeT(tl?: (key: any) => string) {
  return (key: string, params?: Record<string, string | number>): string => {
    let text = ''
    try { text = tl ? String(tl(key as any) ?? '') : '' } catch { text = '' }
    if (!text || text === key) text = WT_FALLBACK[key] ?? key
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
  }
}

function orbT(key: string): string {
  return ORB_FALLBACK[key] ?? key
}

/* ------------------------------------------------------------------ 样式 */

const card: Record<string, any> = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  borderRadius: 12, padding: '12px 14px', marginBottom: 10,
}
const row: Record<string, any> = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }
const title: Record<string, any> = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' }
const desc: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '3px 0 0', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' }
const errText: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '6px 0 0', color: 'var(--dsw-alias-state-danger, #e5484d)' }
const okText: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '6px 0 0', color: 'var(--dsw-alias-state-success, #16a34a)' }
const input: Record<string, any> = {
  height: 28, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', font: 'inherit', fontSize: 12, minWidth: 0, flex: 1,
}
const btn: Record<string, any> = {
  height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
}
const btnPrimary: Record<string, any> = { ...btn, background: 'var(--dsw-alias-state-accent-primary, #4f8ef7)', color: '#fff', border: 'none' }
const kv: Record<string, any> = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', wordBreak: 'break-all' }

/* ------------------------------------------------------------------ 数据 */

const fsApi = {
  async listFs(path: string) {
    const res = await fetch('/api/worktable/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ path }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`)
    return data
  },
}

type PickerTarget = 'projectParent' | 'skillRoot' | `root:${number}`

interface Draft {
  projectParent: string
  skillRoot: string
  asrTerms: AsrTermRule[]
  allowedRoots: string[]
  allowAll: boolean
  updateSource: string
  updateCheckEnabled: boolean
}

function draftOf(view: AssistantClientConfig | null): Draft {
  return {
    projectParent: view?.newProjectParent ?? '',
    skillRoot: view?.skillRoot ?? '',
    asrTerms: (view?.asrTerms ?? []).map((rule) => ({ ...rule })),
    allowedRoots: [...(view?.allowedRoots ?? [])],
    allowAll: view?.allowAllLocalPaths === true,
    updateSource: view?.updateSource ?? '',
    updateCheckEnabled: view?.updateCheckEnabled === true,
  }
}

/* ------------------------------------------------------------------ 组件 */

export function LocalConfigPanel({ tl }: { tl?: (key: any) => string }) {
  const t = makeT(tl)
  const [view, setView] = useState<AssistantClientConfig | null>(null)
  const [draft, setDraft] = useState<Draft>(() => draftOf(null))
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [picker, setPicker] = useState<{ target: PickerTarget; start: string } | null>(null)
  const [allowAllText, setAllowAllText] = useState('')
  const [caps, setCaps] = useState<any>(null)
  const importRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // 能力自检（P0-7）：koffi 不可用时只影响「前台窗口聚焦」，这里如实显示
    void fetch('/api/assistant/capabilities', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCaps(d))
      .catch(() => setCaps(null))
  }, [])

  const refresh = async (): Promise<void> => {
    setLoadError('')
    const value = await reloadAssistantConfig()
    if (!value) {
      setLoadError(t('localConfig.saveFailed'))
      // 宿主不可达时至少把缓存里的值显示出来（缓存可能为空）
      const cached = await loadAssistantConfig()
      setView(cached)
      setDraft(draftOf(cached))
      return
    }
    setView(value)
    setDraft(draftOf(value))
  }

  useEffect(() => { void refresh() }, [])

  const save = async (patch: Record<string, unknown>, label: string): Promise<void> => {
    setBusy(label)
    setNote(null)
    const result = await saveAssistantConfig(patch)
    setBusy('')
    if (!result.ok) {
      setNote({
        ok: false,
        text: result.field
          ? t('localConfig.saveFailedField', { field: result.field }) + ' — ' + String(result.error)
          : t('localConfig.saveFailed') + ' — ' + String(result.error),
      })
      return
    }
    if (result.config) {
      setView(result.config)
      setDraft(draftOf(result.config))
    } else {
      await refresh()
    }
    setNote({ ok: true, text: t('localConfig.saved') })
  }

  const savePaths = (): Promise<void> => save({
    newProjectParent: draft.projectParent.trim(),
    skillRoot: draft.skillRoot.trim(),
  }, 'paths')

  const saveAsr = (terms: AsrTermRule[]): Promise<void> => save({ asrTerms: terms }, 'asr')

  const saveRoots = (): Promise<void> => {
    if (draft.allowAll) {
      if (allowAllText.trim() !== 'ALLOW-ALL') {
        setNote({ ok: false, text: t('localConfig.allowAllBadConfirm') })
        return Promise.resolve()
      }
    }
    const patch: Record<string, unknown> = { allowedRoots: draft.allowedRoots.map((item) => item.trim()).filter(Boolean) }
    patch.allowAllLocalPaths = draft.allowAll
    if (draft.allowAll) patch.confirm = 'ALLOW-ALL'
    return save(patch, 'roots')
  }

  const saveUpdate = (): Promise<void> => save({
    updateSource: draft.updateSource.trim(),
    updateCheckEnabled: draft.updateCheckEnabled,
  }, 'update')

  const patchDraft = (next: Partial<Draft>): void => setDraft((cur) => ({ ...cur, ...next }))

  const openPicker = (target: PickerTarget, start: string): void => {
    setPicker({ target, start: start || view?.assistantHome || '' })
  }

  const applyPicked = (picked: string): void => {
    if (!picker) return
    if (picker.target === 'projectParent') patchDraft({ projectParent: picked })
    else if (picker.target === 'skillRoot') patchDraft({ skillRoot: picked })
    else {
      const index = Number(String(picker.target).slice('root:'.length))
      setDraft((cur) => {
        const roots = [...cur.allowedRoots]
        roots[index] = picked
        return { ...cur, allowedRoots: roots }
      })
    }
    setPicker(null)
  }

  const sourceLabel = (): string => {
    const source = view?.newProjectParentSource
    if (source === 'config') return t('localConfig.sourceConfig')
    if (source === 'assistant') return t('localConfig.sourceAssistant')
    return t('localConfig.sourceDesktop')
  }

  const skillSourceLabel = (): string => {
    return view?.skillRootSource === 'config' ? t('localConfig.sourceConfig') : t('localConfig.sourceDshHome')
  }

  return (
    <div>
      <p style={{ ...desc, margin: '0 0 10px' }}>{t('localConfig.intro')}</p>
      <p style={{ ...kv, margin: '0 0 10px' }}>
        {t('localConfig.configSource')}：{view?.configSource || t('localConfig.noConfigFile')}
      </p>

      {/* ① 目录与路径 */}
      <div style={card}>
        <div style={title}>{t('localConfig.groupPaths')}</div>
        <p style={desc}>{t('localConfig.groupPathsDesc')}</p>

        <div style={{ marginTop: 10 }}>
          <div style={{ ...desc, margin: '0 0 4px' }}>{t('localConfig.newProjectParent')}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input style={input} value={draft.projectParent} placeholder={view?.newProjectParent || ''}
              onChange={(e) => patchDraft({ projectParent: e.target.value })} />
            <button type="button" style={btn} onClick={() => openPicker('projectParent', draft.projectParent || (view?.newProjectParent ?? ''))}>
              {t('localConfig.pickDir')}
            </button>
            <button type="button" style={btn} onClick={() => patchDraft({ projectParent: '' })}>×</button>
          </div>
          <p style={desc}>{t('localConfig.newProjectParentDesc')}</p>
          <p style={kv}>
            {t('localConfig.effective')}：{view?.newProjectParent || '—'}（{sourceLabel()}）
          </p>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ ...desc, margin: '0 0 4px' }}>{t('localConfig.skillRoot')}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input style={input} value={draft.skillRoot} placeholder={view?.skillRoot || ''}
              onChange={(e) => patchDraft({ skillRoot: e.target.value })} />
            <button type="button" style={btn} onClick={() => openPicker('skillRoot', draft.skillRoot || (view?.skillRoot ?? ''))}>
              {t('localConfig.pickDir')}
            </button>
            <button type="button" style={btn} onClick={() => patchDraft({ skillRoot: '' })}>×</button>
          </div>
          <p style={desc}>{t('localConfig.skillRootDesc')}</p>
          <p style={kv}>
            {t('localConfig.effective')}：{view?.skillRoot || '—'}（{skillSourceLabel()}）
          </p>
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" style={btnPrimary} disabled={busy !== ''} onClick={() => void savePaths()}>
            {busy === 'paths' ? t('localConfig.saving') : t('localConfig.save')}
          </button>
          <button type="button" style={btn} disabled={busy !== ''} onClick={() => void refresh()}>{t('localConfig.reload')}</button>
        </div>
      </div>

      {/* ② 语音词表 */}
      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>{t('localConfig.groupAsr')}</div>
            <p style={desc}>{t('localConfig.groupAsrDesc')}</p>
          </div>
          <span style={{ ...desc, whiteSpace: 'nowrap' }}>{t('localConfig.asrCount', { n: draft.asrTerms.length })}</span>
        </div>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draft.asrTerms.length === 0 ? <p style={desc}>{t('localConfig.asrEmpty')}</p> : null}
          {draft.asrTerms.map((rule, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input style={input} value={rule.pattern} placeholder={t('localConfig.asrPattern')}
                onChange={(e) => {
                  const next = draft.asrTerms.map((item, i) => (i === index ? { ...item, pattern: e.target.value } : item))
                  patchDraft({ asrTerms: next })
                }} />
              <span style={desc}>→</span>
              <input style={input} value={rule.replace} placeholder={t('localConfig.asrReplace')}
                onChange={(e) => {
                  const next = draft.asrTerms.map((item, i) => (i === index ? { ...item, replace: e.target.value } : item))
                  patchDraft({ asrTerms: next })
                }} />
              <input style={{ ...input, flex: 'none', width: 54 }} value={rule.flags ?? ''} placeholder="g"
                onChange={(e) => {
                  const flags = e.target.value.trim()
                  const next = draft.asrTerms.map((item, i) => (i === index
                    ? (flags ? { ...item, flags } : { pattern: item.pattern, replace: item.replace })
                    : item))
                  patchDraft({ asrTerms: next })
                }} />
              <button type="button" style={btn} onClick={() => patchDraft({ asrTerms: draft.asrTerms.filter((_, i) => i !== index) })}>×</button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={btn} onClick={() => patchDraft({ asrTerms: [...draft.asrTerms, { pattern: '', replace: '' }] })}>
            ＋ {t('localConfig.asrAdd')}
          </button>
          <button type="button" style={btnPrimary} disabled={busy !== ''} onClick={() => void saveAsr(draft.asrTerms.filter((rule) => rule.pattern.trim() && rule.replace.trim()))}>
            {busy === 'asr' ? t('localConfig.saving') : t('localConfig.save')}
          </button>
          <button type="button" style={btn} onClick={() => importRef.current?.click()}>{t('localConfig.asrImport')}</button>
          <button type="button" style={btn} onClick={() => downloadText('assistant-asr-terms.json', JSON.stringify(draft.asrTerms, null, 2))}>
            {t('localConfig.asrExport')}
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () => {
                try {
                  const parsed = JSON.parse(String(reader.result ?? '[]'))
                  const rows = Array.isArray(parsed) ? parsed : null
                  if (!rows) throw new Error('not-array')
                  const terms: AsrTermRule[] = rows
                    .filter((item: any) => item && typeof item.pattern === 'string' && typeof item.replace === 'string')
                    .map((item: any) => ({
                      pattern: item.pattern,
                      replace: item.replace,
                      ...(typeof item.flags === 'string' && item.flags ? { flags: item.flags } : {}),
                    }))
                  if (terms.length === 0) throw new Error('empty')
                  patchDraft({ asrTerms: terms })
                  setNote({ ok: true, text: t('localConfig.saved') })
                } catch {
                  setNote({ ok: false, text: t('localConfig.asrImportFail') })
                }
              }
              reader.onerror = () => setNote({ ok: false, text: t('localConfig.asrImportFail') })
              reader.readAsText(file)
              event.target.value = ''
            }}
          />
        </div>
      </div>

      {/* ③ 目录边界 */}
      <div style={card}>
        <div style={title}>{t('localConfig.groupRoots')}</div>
        <p style={desc}>{t('localConfig.groupRootsDesc')}</p>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draft.allowedRoots.length === 0 ? <p style={desc}>{t('localConfig.rootsEmpty')}</p> : null}
          {draft.allowedRoots.map((root, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input style={input} value={root}
                onChange={(e) => {
                  const next = draft.allowedRoots.map((item, i) => (i === index ? e.target.value : item))
                  patchDraft({ allowedRoots: next })
                }} />
              <button type="button" style={btn} onClick={() => openPicker(`root:${index}`, root)}>{t('localConfig.pickDir')}</button>
              <button type="button" style={btn} onClick={() => patchDraft({ allowedRoots: draft.allowedRoots.filter((_, i) => i !== index) })}>×</button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 8 }}>
          <button type="button" style={btn} onClick={() => patchDraft({ allowedRoots: [...draft.allowedRoots, ''] })}>
            ＋ {t('localConfig.rootsAdd')}
          </button>
        </div>

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.allowAll} onChange={(e) => patchDraft({ allowAll: e.target.checked })} />
            <span style={{ ...title, color: draft.allowAll ? 'var(--dsw-alias-state-danger, #e5484d)' : undefined }}>{t('localConfig.allowAll')}</span>
          </label>
          {draft.allowAll ? (
            <div style={{ marginTop: 6 }}>
              <p style={{ ...errText, margin: '0 0 6px' }}>{t('localConfig.allowAllWarn')}</p>
              <input style={input} value={allowAllText} placeholder={t('localConfig.allowAllConfirm')}
                onChange={(e) => setAllowAllText(e.target.value)} />
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" style={btnPrimary} disabled={busy !== ''} onClick={() => void saveRoots()}>
            {busy === 'roots' ? t('localConfig.saving') : t('localConfig.save')}
          </button>
        </div>
      </div>

      {/* ④ 更新检查（P0-3） */}
      <div style={card}>
        <div style={title}>{t('localConfig.groupUpdate')}</div>
        <p style={desc}>{t('localConfig.groupUpdateDesc')}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
          <input type="checkbox" checked={draft.updateCheckEnabled}
            onChange={(e) => patchDraft({ updateCheckEnabled: e.target.checked })} />
          <span style={title}>{t('localConfig.updateEnabled')}</span>
        </label>
        <div style={{ marginTop: 8 }}>
          <div style={{ ...desc, margin: '0 0 4px' }}>{t('localConfig.updateSource')}</div>
          <input style={input} value={draft.updateSource} placeholder="your-name/your-fork"
            onChange={(e) => patchDraft({ updateSource: e.target.value })} />
          <p style={desc}>{t('localConfig.updateSourceDesc')}</p>
          {draft.updateSource.trim() !== '' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(draft.updateSource.trim()) ? (
            <p style={errText}>{t('localConfig.updateBadSource')}</p>
          ) : null}
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" style={btnPrimary} disabled={busy !== ''} onClick={() => void saveUpdate()}>
            {busy === 'update' ? t('localConfig.saving') : t('localConfig.save')}
          </button>
        </div>
      </div>

      {note ? <p style={note.ok ? okText : errText}>{note.text}</p> : null}
      {loadError ? <p style={errText}>{loadError}</p> : null}

      {caps ? (
        <p style={caps.nativeFocus?.available ? okText : desc}>
          {caps.nativeFocus?.available
            ? '✓ 前台窗口聚焦能力可用（koffi 已加载）'
            : `窗口聚焦不可用：${String(caps.nativeFocus?.reason || 'unknown')}（只影响「点球后把 DSH 窗口提到前台」，其它功能不受影响）`}
        </p>
      ) : null}

      {picker ? (
        <PathBrowser
          mode="dir"
          api={fsApi}
          startPath={picker.start}
          t={orbT as any}
          onPick={() => { /* mode=dir 只选目录 */ }}
          onPickDir={applyPicked}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  )
}
