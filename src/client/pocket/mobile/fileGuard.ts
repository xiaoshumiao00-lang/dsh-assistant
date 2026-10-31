// 移动端文件守卫（issue #17）：dsh-web 在手机上点「文件链接」会触发桌面端
// workspaces.openPath(open <path>)，既打不开（文件在电脑上），又会抛
// "path open failed". 这里做两件事：
//   1) 捕获阶段拦截这类激活（点击 / 键盘），改为弹一个提示；
//   2) 在每个文件链接旁注入一个「复制」按钮，点它经主机 RPC 读文件正文再写剪贴板。
// 另外隐藏「添加工作区」入口（手机上配工作区无意义）。
// 移植自 dsh-web-mobile（MIT）。
//
// 识别方式：不依赖 dsh-web 的 hash 类名（每次构建都变），只认「文本像文件路径的
// <button>/<a>」——文件链接按钮的文案就是路径（如 lib/proxy.mjs / /Users/.../x.ts）。
//
// 例外：本插件自己的界面（[data-pocket-orb] 子树：悬浮球页、电脑路径浏览器、
// 电脑文件选择器）一律不碰。那里的「文案就是路径」的按钮是地址栏和面包屑盘符，
// 既不该被拦成「手机上打不开」，也不该被塞一个多余的第二复制按钮——它们自己
// 就带复制，守卫再插一个等于把地址栏撑成两行。

import { copyTextToClipboard } from '../../clipboard.ts'
import { domGate, insideComposer } from '../../compositionGate.ts'

/** 手机上点击文件时弹出的提示。 */
const GUARD_MSG = '手机上无法直接打开电脑上的文件'
/** 「添加工作区」入口的文案（随语言变化），两种都覆盖。 */
const WS_LABELS = ['添加工作区', '添加工作区…', 'Add workspace', 'Add workspace…']
/** 让路窗口结束后再来一次（合并到 400ms 一次，和原来的节流同量级）。 */
const ADDITIONS_RETRY_MS = 400
/** 复制按钮文案。 */
const COPY_LABEL = '复制'

/** 主机 fileRead 回调返回结构（与 client/api.js 的 FileReadResult 对齐）。 */
interface ReadFileResponse {
  ok: boolean;
  value?: { content: string; path: string; size: number };
  error?: { message: string };
}

/** 文本是否像文件路径：绝对路径 / 相对路径 / 带扩展名的目录路径。 */
function looksLikeFilePath(text: string | null): boolean {
  const t = (text ?? '').trim()
  if (t.length < 3 || t.length > 320) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(t)) return true
  if (/\/[\w.\-]+\.\w{1,12}$/.test(t)) return true
  if (/[\w.\-]+\/[\w.\-]+\.\w{1,12}/.test(t)) return true
  return false
}

/** 是否本插件自己的界面（悬浮球页 / 电脑路径浏览器 / 电脑文件选择器）：
 *  这些按钮的文案本身就是路径（地址栏、面包屑盘符），守卫既不拦截也不注入复制按钮。 */
function isOwnUi(el: HTMLElement): boolean {
  return el.closest('[data-pocket-orb]') !== null
}

/** 写剪贴板统一走 clipboard.ts（http 页面走 execCommand 兜底，iOS 选中整段）。 */

export function startFileGuard(
  readFile: (path: string) => Promise<ReadFileResponse>,
): () => void {
  // 轻量 toast：自包含，不依赖 dsh-pocket 面板的 React 状态。
  let toastEl: HTMLElement | null = null
  let toastTimer: number | null = null
  const showToast = (text: string): void => {
    if (toastEl === null) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('data-mobile-nav', 'file-guard-toast')
      Object.assign(toastEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '64px',
        transform: 'translateX(-50%)',
        maxWidth: '84vw',
        zIndex: '9999',
        padding: '10px 14px',
        borderRadius: '10px',
        background: 'rgba(20,22,28,.92)',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.4',
        textAlign: 'center',
        fontFamily: 'inherit',
        boxShadow: '0 4px 16px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity .18s ease',
      } as CSSStyleDeclaration)
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    requestAnimationFrame(() => {
      if (toastEl !== null) toastEl.style.opacity = '1'
    })
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      if (toastEl !== null) toastEl.style.opacity = '0'
    }, 2600)
  }

  // 捕获阶段拦截文件链接的激活。按钮的键盘激活（Enter/Space）会派发 click，
  // 因此只拦 click 即可同时覆盖鼠标与键盘，避免重复处理。
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    if (target === null) return
    const el = target.closest('button, a') as HTMLElement | null
    if (el === null) return
    if (isOwnUi(el)) return // 本插件的路径浏览器/悬浮球：地址栏、面包屑不是文件链接
    if (!looksLikeFilePath(el.textContent)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showToast(GUARD_MSG)
  }
  document.addEventListener('click', onClick, true)

  // 在文件链接旁注入「复制」按钮：点它经主机 RPC 读文件正文再写剪贴板。
  // 用 data-mobile-nav-copy 标记已处理的链接，避免重复注入；React 重渲染会
  // 产生新元素（无标记），MutationObserver 只增量处理**新增节点**。
  //
  // 性能（2026-10-19）：旧实现每次 mutation 都 querySelectorAll('button,a')
  // 并对每个元素读 textContent。超长会话详情有 ~1600 个按钮、渲染期一帧上百条
  // mutation → O(节点数 × mutation 数) 的文本复制，正是把手机 WebView 顶崩的
  // 主要 CPU/内存尖峰。现在改为：首屏全量一次 + 之后只看 addedNodes，并按
  // 400ms 合并。
  const processLink = (el: HTMLElement): void => {
    if (el.getAttribute('data-mobile-nav-copy') === '1') return
    if (el.getAttribute('data-mobile-nav') === 'copy-file') return
    if (isOwnUi(el)) return // 地址栏/面包屑自己有复制，别再插一个
    // 一律不往输入框里塞东西：插件在宿主 Lexical contenteditable 里改 DOM，
    // 手机语音输入法（微信键盘 / 讯飞的实时转写）的组合就被打断，说几个词就自己停。
    if (insideComposer(el)) return
    const txt = (el.textContent ?? '').trim()
    if (!looksLikeFilePath(txt)) return
    el.setAttribute('data-mobile-nav-copy', '1')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-mobile-nav', 'copy-file')
    btn.textContent = COPY_LABEL
    btn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const filePath = (el.textContent ?? '').trim()
      btn.disabled = true
      btn.textContent = '…'
      try {
        const res = await readFile(filePath)
        if (!res?.ok) {
          showToast(res?.error?.message ?? '复制失败')
          return
        }
        const content = res.value?.content ?? ''
        const copied = await copyTextToClipboard(content)
        if (copied) {
          const kb = Math.max(1, Math.round((res.value?.size ?? content.length) / 1024))
          showToast(`已复制文件内容（${kb} KB）`)
        } else {
          showToast('复制失败，请手动选择')
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : '复制失败')
      } finally {
        btn.disabled = false
        btn.textContent = COPY_LABEL
      }
    })
    el.parentElement?.insertBefore(btn, el.nextSibling)
  }

  const scanAll = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>('button, a')) processLink(el)
  }

  /** 待处理的新增节点（合并到 400ms 一次；上限防止无限堆积）。 */
  const pending = new Set<Node>()
  let scheduled = false
  const flushAdditions = (): void => {
    // 用户在输入框里打字 / 语音实时转写期间不做任何 DOM 改写；批次不丢，等窗口结束再跑。
    if (domGate.isPaused()) {
      if (pending.size > 0 && !scheduled) {
        scheduled = true
        window.setTimeout(flushAdditions, ADDITIONS_RETRY_MS)
      }
      return
    }
    scheduled = false
    const batch = [...pending]
    pending.clear()
    for (const node of batch) {
      if (node.nodeType === 3) {
        // 文本节点更新：其父元素可能就是文件链接（React 更新文案）。
        const parent = node.parentElement
        if (parent) processLink(parent)
        continue
      }
      if (node.nodeType !== 1) continue
      const el = node as HTMLElement
      if (el.matches('button, a')) processLink(el)
      for (const link of el.querySelectorAll<HTMLElement>('button, a')) processLink(link)
    }
  }
  const scheduleAdditions = (nodes: NodeList): void => {
    for (const node of nodes) {
      pending.add(node)
      if (pending.size >= 400) break
    }
    if (scheduled) return
    scheduled = true
    window.setTimeout(flushAdditions, 400)
  }

  // 旧版本曾把「复制」按钮插到地址栏/面包屑旁（它们也在 [data-pocket-orb] 里）：
  // 启动时先清掉，避免热更或旧页面残留把抽屉撑成两行。
  for (const stale of document.querySelectorAll<HTMLElement>('[data-pocket-orb] [data-mobile-nav="copy-file"]')) {
    stale.remove()
  }

  scanAll()
  const copyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') scheduleAdditions(mutation.addedNodes)
    }
    if (pending.size > 0 && !scheduled) {
      scheduled = true
      window.setTimeout(flushAdditions, 400)
    }
  })
  copyObserver.observe(document.body, { childList: true, subtree: true })

  // 隐藏「添加工作区」入口：图标按钮由 mobile.css.ts 按 aria-label 隐藏；
  // 下拉菜单里的文本项 CSS 选不到，这里按文案兜底（只在新增节点时检查，省开销）。
  const hideWsEntries = (): (() => void) => {
    const checkOne = (node: Node): void => {
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      if (insideComposer(el)) return // 输入框里的节点一律不改（语音 / 拼音输入被打断的老因）
      const txt = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
      if (WS_LABELS.includes(txt)) {
        el.style.display = 'none'
        el.setAttribute('data-mobile-nav-hide', 'add-workspace')
      }
    }
    const sel = '[role="menuitem"],[role="option"],li,button,a'
    document.querySelectorAll(sel).forEach(checkOne)
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return
          checkOne(n)
          ;(n as HTMLElement).querySelectorAll?.(sel).forEach(checkOne)
        })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }
  const disconnectWs = hideWsEntries()

  return () => {
    document.removeEventListener('click', onClick, true)
    copyObserver.disconnect()
    disconnectWs()
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastEl?.remove()
  }
}
