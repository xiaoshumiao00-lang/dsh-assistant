/**
 * 鐩綍杈圭晫锛圥0-5锛夛細宸ヤ綔鍙扮殑鍐呭绐楁暟鎹矾鐢憋紙鍒楃洰褰?/ 璇诲啓鏂囦欢 / git 鐘舵€?/ 闈欐€佹墭绠?/ 鎵撳紑鏂囦欢澶?/ 鎶€鑳芥竻鍗曪級
 * 涔嬪墠瀵逛换浣曞彲鍐欒矾寰勯兘鐓у崟鍏ㄦ敹 鈥斺€?鎵嬫満璁块棶锛堝眬鍩熺綉鎴?SSH 闅ч亾锛夎兘鎶婃彃浠剁殑杩欏嚑鏉¤矾鐢卞綋銆屾湰鏈烘枃浠舵祻瑙堝櫒銆嶇敤锛? * 瓒婄晫璇诲埆鐨勭敤鎴风洰褰曘€佸啓绯荤粺璺緞閮藉彲琛屻€傝繖閲屾妸鍏ュ弬璺緞鏀惰繘涓€浠?allowlist锛岃秺鐣屼竴寰?403銆? *
 * 榛樿鏍癸紙鏈満琛屼负涓嶅彉锛屽彧鏄妸鑼冨洿璁叉竻妤氾級锛? *   - 鍔╂墜鐩綍            ~/.dsh/assistant
 *   - DSH 鏁版嵁鏍圭洰褰?      $DSH_HOME锛堥粯璁?~/.dsh锛? *   - 骞冲彴 Desktop 鐩綍     锛圵indows 涓婂父鏄噸瀹氬悜鍚庣殑妗岄潰锛? *   - 鏂板缓椤圭洰鐨勯粯璁ょ埗鐩綍   鏈満閰嶇疆閲岀殑 newProjectParent锛堟湭閰嶇疆鍗冲洖钀界洰鏍囷級
 *   - 鎶€鑳芥牴鐩綍           鏈満閰嶇疆閲岀殑 skillRoot锛堟湭閰嶇疆鍗?<DSH_HOME>/skills锛? *   - 绯荤粺涓存椂鐩綍 / 鎻掍欢浠撳簱 cwd
 *   - 鐢ㄦ埛涓荤洰褰曟湰韬紙鎻掍欢涓庡涓昏窇鍦ㄥ悓涓€鐢ㄦ埛涓嬶紝娴忚鍣ㄨ兘鐪嬪埌鐨勮嚜宸卞鐩綍涓嶇畻瓒婄晫锛? *   - 鏈満閰嶇疆 allowedRoots 杩藉姞鐨勬牴锛堜緥濡傛煇涓嫭绔嬬洏鐨勯」鐩垎缁勶級
 * 閫冪敓寮€鍏筹細鏈満閰嶇疆 `allowAllLocalPaths: true` 鏃朵笉鍋氳竟鐣屾鏌ワ紙榛樿 false锛夈€? */
import { homedir, tmpdir } from 'node:os'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { assistantHomeDir } from './assistant-home.ts'
import { dshHome, loadAssistantConfig, platformDesktopDir, resolveNewProjectParent } from './assistant-config.ts'

export interface PathCheckResult {
  ok: boolean
  /** 瓒婄晫鏃剁殑璇存槑锛堣繘 403 鐨勫搷搴斾笌鏃ュ織锛屼究浜庢帓鏌ユ槸鍝釜鏍规病閰嶏級 */
  reason: string
  /** 褰掍竴鍖栧悗鐨勭洰鏍囩粷瀵硅矾寰?*/
  target: string
}

export interface PathGuard {
  roots: string[]
  /** 鍏ㄥ眬鏀捐锛堟湰鏈洪厤缃?allowAllLocalPaths: true锛?*/
  open: boolean
  check(rawPath: string): PathCheckResult
}

/** `~` / `~\` / `~/` 灞曞紑涓虹敤鎴蜂富鐩綍銆?*/
export function expandHome(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (value === '~') return homedir()
  if (value === '~\\' || value === '~/') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolvePath(homedir(), value.slice(2))
  return value
}

/** 姣旇緝鐢ㄧ殑褰掍竴鍖栵細缁熶竴鍒嗛殧绗︺€佸幓鎺夊熬閮ㄥ垎闅旂銆乄indows 涓婁笉鍖哄垎澶у皬鍐欍€?*/
function comparable(raw: string): string {
  let value = String(raw).replace(/[\\/]+/g, '/')
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  if (process.platform === 'win32') value = value.toLowerCase()
  return value
}

/** 绗﹀彿閾炬帴 / junction 鏄惁钀藉洖鍏佽鏍癸紙鐪熷疄璺緞涔熺畻鍊欓€夛級銆?*/
function realCandidates(abs: string): string[] {
  const out: string[] = [abs]
  try {
    const real = realpathSync(abs)
    if (real && real !== abs) out.push(real)
  } catch { /* 鐩爣涓嶅瓨鍦ㄦ椂 realpath 鎶涢敊锛氱敤鍘熻矾寰勫垽鏂嵆鍙?*/ }
  return out
}

/** 鍏佽鏍瑰垪琛紙鍘婚噸銆佸幓鎺変笉瀛樺湪涓旀槑鏄炬槸鍗犱綅鐨勯」锛夈€?*/
export function defaultAllowedRoots(config = loadAssistantConfig()): string[] {
  const roots: string[] = []
  const push = (raw: string | null | undefined): void => {
    const value = String(raw ?? '').trim()
    if (!value) return
    roots.push(resolvePath(expandHome(value)))
  }
  push(assistantHomeDir())
  push(dirname(assistantHomeDir())) // ~/.dsh
  push(dshHome())
  push(platformDesktopDir())
  push(resolveNewProjectParent(config).parent)
  push(config.skillRoot)
  push(tmpdir())
  push(process.cwd())
  push(homedir())
  for (const extra of config.allowedRoots) push(extra)
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const key = comparable(root)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** 鐩綍 allowlist 鐨勬墽琛屼綋锛氫竴娆℃瀯寤猴紝澶氭澶嶇敤锛堣矾鐢辨敞鍐屾椂寤轰竴娆★級銆?*/
export function createPathGuard(config = loadAssistantConfig(true)): PathGuard {
  const open = config.allowAllLocalPaths === true
  const roots = defaultAllowedRoots(config)
  return {
    roots,
    open,
    check(rawPath: string): PathCheckResult {
      const raw = String(rawPath ?? '').trim()
      if (!raw) return { ok: false, reason: 'empty-path', target: '' }
      const abs = resolvePath(expandHome(raw))
      if (open) return { ok: true, reason: 'allow-all', target: abs }
      const candidates = realCandidates(abs)
      // 鍏佽鏍规湰韬€佹牴鍐呮枃浠躲€佷互鍙娿€岃鏌愪釜鍏佽鏍瑰寘鍚€嶇殑绗﹀彿閾炬帴鐩爣
      for (const candidate of candidates) {
        const value = comparable(candidate)
        for (const root of roots) {
          const base = comparable(root)
          if (!base) continue
          if (value === base || value.startsWith(base + '/')) return { ok: true, reason: '', target: abs }
        }
      }
      // 瓒婄晫锛氭妸宸摢涓牴鍐欒繘鏃ュ織锛岀敤鎴峰姞涓€鏉?allowedRoots 灏辫兘鏀捐
      return { ok: false, reason: `outside-allowlist: ${abs}`, target: abs }
    },
  }
}

/** 鏄惁瀛樺湪涓旀槸鍙鐩綍锛堣秺鐣屾鏌ヤ箣鍚庨『鎵嬫妸涓嶅瓨鍦ㄧ殑璺緞褰撴嫆缁濆鐞嗭級銆?*/
export function isDirectory(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory()
  } catch { return false }
}

/** 缁堢鏈€灏忕幆澧冨彉閲忥紙P0-5锛夛細涓嶅啀鏁村寘 process.env 浜ょ粰 shell銆? *  榛樿鐧藉悕鍗曞彧鏀?shell 涓?Windows 蹇呴渶椤癸紝鍏跺畠涓€寰嬩笉浼狅紱鏈満閰嶇疆 termEnvAllow 杩藉姞鍙橀噺鍚嶃€?*/
const TERM_ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMDRIVE', 'HOMEPATH',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM',
  'SHELL', 'NODE_VERSION', 'COLUMNS', 'PYTHONPATH',
]

export function minimalTermEnv(config = loadAssistantConfig(), extraNames: string[] = []): Record<string, string> {
  const allow = new Set<string>([...TERM_ENV_ALLOW, ...config.termEnvAllow, ...extraNames].map((name) => String(name).trim().toUpperCase()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const name of allow) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}
