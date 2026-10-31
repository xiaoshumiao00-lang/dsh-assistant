// dsh-web-mobile 移植（MIT，见 LICENSE.dsh-web-mobile）：移动端适配的 client 侧实现。
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MobileNavToggle } from './MobileNavToggle.tsx'
import { MobileNavOverlay } from './MobileNavOverlay.tsx'
import { MobileDrawerFooter } from './MobileDrawerFooter.tsx'
import { startFileGuard } from './fileGuard.ts'
import { createModelSettingsNoticePatcher } from './modelSettingsNotice.ts'
import { MOBILE_CSS } from './mobile.css.ts'
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../api.js'
import { NS, en, zh } from './locales.ts'
import type { MobileNavKey } from './locales.ts'
import {
  COARSE_POINTER_MEDIA,
  LAYOUT_ATTR,
  LAYOUT_SRC_ATTR,
  LAYOUT_URL_PARAM,
  NARROW_MEDIA,
  clearStoredLayout,
  persistLayoutFromUrl,
  readLayoutUserMark,
  resolveLayoutMode,
  shouldShowLayoutBadge,
} from './layout-mode.mjs'
import { createDrawerController, findFrame } from './drawer-state.mjs'
import { startFeaturePresenceWatch } from './featurePresence.mjs'
import { mountDrawerChrome, showHealToast } from './drawer-chrome.ts'
import { domGate, createGatedThrottle, insideComposer, setVoiceReporter, createVoiceTally } from '../../compositionGate.ts'
import { reportMobileError, reportMobileStage, schedulePostMobileProbes } from '../orb/diag.ts'

/** dsh-web-ui 的 explorer/preview 列最长等待窗口：过了就不为它保留整页观察。 */
const AIONUI_PRESENCE_MS = 15000

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Directory-drawer controls copy. */
    'mobileNav': MobileNavKey
  }
}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */

/**
 * 把 MutationObserver 的回调从「每次 DOM 变更都跑」降到「每 ms 最多跑一次」。
 *
 * 手机上这不是微优化：会话详情页实测有 ~2 万个 DOM 节点，下面几处观察者里有
 * 按 `body *` 全量扫 textContent 的（一次 ~19ms，手机上更慢）。render 期间
 * 一帧里可能有成百上千条 mutation 记录，原样触发就是 O(N×M) 的 CPU 尖峰——
 * 页面越重越卡，正是长会话详情把 WebView 顶到被系统杀掉、整页 reload 的推手之一。
 * 合并成每帧/每 300~500ms 一次后，观察者本身的开销可以忽略。
 *
 * 2026-10-31：这条老节流器不再自己算时间，统一交给 createGatedThrottle ——
 * 用户在输入框里打字（含手机语音输入法的实时转写）或抽屉正在开合时它先让路，
 * 到点不跑但也不丢：批次留到窗口结束照样补跑。
 */
function throttleByFrame(run: () => void, waitMs = 300): () => void {
  return createGatedThrottle({ run, gate: domGate, waitMs })
}

/**
 * pocket 命名空间的 t()（文案只在 client/pocket-locales.js 里 —— 布局徽章和
 * auto-heal 提示都归 pocket 管，不属于 mobileNav）。
 * 取不到 / 词典还没注册就回落成 key，绝不因为翻译层把逃生舱徽章搞崩。
 * @param ctx - client root context。
 * @param key - pocket 词典 key。
 */
function pocketTranslate(ctx: ClientContext, key: string): string {
  try {
    const bind = (ctx.locale as unknown as { bind?: (ns: string) => (k: string) => unknown }).bind
    const bound = typeof bind === 'function' ? bind.call(ctx.locale, 'pocket') : undefined
    const value = typeof bound === 'function' ? bound(key) : undefined
    return typeof value === 'string' && value !== '' ? value : key
  } catch {
    return key
  }
}

/**
 * Mobile-adaptive shell, browser half: injects the mobile stylesheet, then
 * contributes the directory toggle to the session header and the backdrop +
 * floating button to the shell overlay.
 * @param ctx - client root context.
 */
export function mobileApply(ctx): void {
  // 布局模式（issue #74）：URL 参数 > localStorage > auto(=matchMedia)。
  // desktop 模式（宽屏手机/平板强制电脑布局）下整段 mobile 效果都不挂——
  // 不加 styles、不挂 slots、不跑 effects，直接走 DSH 原生桌面 UI。
  const urlValue = new URL(window.location.href).searchParams.get(LAYOUT_URL_PARAM) ?? '';
  const narrowMQ = window.matchMedia(NARROW_MEDIA);
  const stored = persistLayoutFromUrl(urlValue);
  // P0 卡死自救：手机截图实测 —— 'desktop' 一旦被写进 localStorage（旧版只能从
  // ?dsh-layout=desktop 来，微信内置浏览器连查询参数一起恢复上次访问），手机上
  // 没有任何入口能改回来（抽屉没挂），官方就把侧栏收成常驻 48px 图标 rail，
  // 会话详情被挤掉 13% 宽。判据分开喂给 resolveLayoutMode：没有 URL 参数、没有
  // user 主动标记、stored='desktop'、而视口宽度 < PHONE_STUCK_VIEWPORT
  // （= 官方 SIDEBAR_AUTO_COLLAPSE 的 1024 那条线；用户已确认是普通直板机，
  // 横屏 740-900 也算手机，取 700 会漏）→ 清掉残留值，本次按手机抽屉走，并弹一次性提示。
  // 人在徽章/设置页上主动选「电脑」（<1024 先二次确认）会写 dsh-pocket.layout.user，
  // 那之后的 desktop 是他自己的选择，heal 不再挡他。
  const decision = resolveLayoutMode({
    urlValue,
    stored,
    userMarked: readLayoutUserMark(),
    narrowMatch: narrowMQ.matches,
    viewportWidth: window.innerWidth,
  });
  const layout = decision.layout;
  if (decision.healed) {
    clearStoredLayout()
    scheduleHealToast(ctx)
  }
  document.body?.setAttribute(LAYOUT_ATTR, layout);
  // 生效路径写进 body，日后在手机上"查看源码"就能直接看出是 url / storage /
  // auto-media 还是 auto-healed（诊断探针也读这两个属性）。
  document.body?.setAttribute(LAYOUT_SRC_ATTR, decision.source);

  // ── 阶段 1：body 属性已写 ──────────────────────────────────────────────
  reportMobileStage('attrs', { ly: layout, src: decision.source, w: window.innerWidth })

  // 电脑布局：不挂抽屉（这条判据保持不变，而且在所有注册之前）。
  if (layout === 'desktop') {
    // 电脑布局是"合法地什么都不挂"，不是死了 —— 也打一条 done，
    // 这样在 diagnostic.jsonl 里能把它和"半路抛异常"区分开。
    reportMobileStage('done', { ly: 'desktop' })
    return;
  }

  // 强制 mobile：narrow 永远 true；宽度变化不再切换（用户已显式选 mobile）
  // auto 模式：narrow 是真实的 matchMedia，宽度变化会触发 effect 挂载/卸载
  let narrow: MediaQueryList = narrowMQ;
  if (layout === 'mobile') {
    narrow = { matches: true, addEventListener: () => {}, removeEventListener: () => {} } as MediaQueryList;
  }

  // ── 本轮的结构性修法：注册在前、effect 在后 ────────────────────────────
  // 手机取证（14:29 截图 + layout-probe）：旧代码里排在 line 91-102 的注册渲染出来了，
  // 但排在 line 419+ 的 toggle / overlay / drawer-actions 一个都没挂上（slots 四项全 0、
  // frame 上 marker 为空、grid 仍是官方 rail 的 55.99px），而 css=true、body 属性都在
  // —— 说明中间那批 ctx.effect 里有一个抛了异常，被**宿主对插件 apply() 的 try/catch
  // 静默吞掉**（因此诊断里连 PAGEERROR 都不会有），它之后的代码整段没执行。
  // 所以：① 所有 slot 注册提到最前（紧跟 body 属性与 desktop 判据之后）；
  // ② 每个 effect 用 safeEffect 包一层，异常就地 catch、beacon 上报，绝不外溢；
  // ③ 关键节点发 mobile-stage beacon，下次刷新就能看到死在哪一段。
  const safeInject = (stage: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      reportMobileError(stage, error)
    }
  }
  /**
   * 包一层 ctx.effect：run 本身抛异常 → 上报并登记一个空 effect（不再打断后面）；
   * 返回的清理函数抛异常 → 同样只上报。effect 的 label 原样透传，宿主面板里仍可辨。
   */
  const safeEffect = (run: () => (void | (() => void)), label: string): void => {
    ctx.effect(() => {
      try {
        const cleanup = run()
        if (typeof cleanup !== 'function') return () => {}
        return () => {
          try {
            cleanup()
          } catch (error) {
            reportMobileError(`${label} (cleanup)`, error)
          }
        }
      } catch (error) {
        reportMobileError(label, error)
        return () => {}
      }
    }, label)
  }

  /**
   * 「宿主真的有 dsh-web-ui 那两列」才挂的整页观察者容器。
   * 本机跑的是纯 DeepSeek Harness：没有 [data-aionui-*] 列，原来这三个观察者等于
   * 永久挂着，每次 DOM 变更都排一批 querySelector + getComputedStyle —— 抽屉开合卡顿
   * 与语音输入中途被打断都有一部分来自这里。见 featurePresence.mjs。
   */
  const presenceWatches: Array<{ recheck: () => void }> = []
  const gatedPageObserver = (
    label: string,
    selectors: string[],
    install: () => (void | (() => void)),
    options: { timeoutMs?: number } = {},
  ): void => {
    safeEffect(() => {
      if (!narrow.matches) return () => {}
      let inner: (() => void) | null = null
      let installed = false
      const stopInner = (): void => {
        const dispose = inner
        inner = null
        installed = false
        try { dispose?.() } catch (error) { reportMobileError(`${label} (observer off)`, error) }
      }
      const watch = startFeaturePresenceWatch({
        selectors,
        timeoutMs: options.timeoutMs,
        onActive: () => {
          if (installed) return () => {}
          installed = true
          try {
            const dispose = install()
            inner = typeof dispose === 'function' ? dispose : null
          } catch (error) {
            reportMobileError(label, error)
          }
          return stopInner
        },
      })
      presenceWatches.push(watch)
      return () => {
        const slot = presenceWatches.indexOf(watch)
        if (slot >= 0) presenceWatches.splice(slot, 1)
        watch.dispose()
        stopInner()
      }
    }, label)
  }

  safeEffect(() => {
    const onPresenceChange = (): void => {
      for (const watch of presenceWatches) {
        try { watch.recheck() } catch { /* 重新确认失败不影响布局切换 */ }
      }
    }
    narrow.addEventListener('change', onPresenceChange)
    return () => narrow.removeEventListener('change', onPresenceChange)
  }, 'dsh-mobile-nav: presence re-arm on layout change')

  // 语音探针：把「说几个词就自己停」变成诊断流水里的数字（说了几段 / 进去多少字 /
  // 有几段没等到 compositionend 就被中止）。探针只读不写，见 compositionGate.ts。
  // 可疑中止立刻发一条；正常打字每 20 段合并发一条，不把 beacon 打成每敲一下一发。
  safeEffect(() => {
    const tally = createVoiceTally()
    const flush = (): void => {
      const snapshot = tally.snapshot()
      if (snapshot.n === 0) return
      tally.reset()
      reportMobileStage('voice-compose', snapshot)
    }
    setVoiceReporter((sample) => {
      if (tally.bump(sample)) flush()
    })
    return () => {
      setVoiceReporter(null)
      try {
        flush()
      } catch { /* 收尾上报失败不影响卸载 */ }
    }
  }, 'dsh-mobile-nav: voice composition probe')

  // 词典先注册（slot 贡献用 locale: NS 拿 t；渲染发生在 apply 返回之后，
  // 但注册失败要让 beacon 看得见，否则三个入口会带着缺失的词典渲染）。
  safeEffect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mobile-nav: dictionaries')

  // 抽屉开合自持（改造 #1/#5）：一个控制器，三个入口（会话头汉堡、浮动按钮、
  // 左边缘手势）共用同一份状态。marker（data-dshp-drawer）+ localStorage
  // （dsh-pocket.drawer）都是我们自己的；官方 layout store 只在"把只剩图标的
  // rail 升成完整菜单列表"时调一次 layout 服务上的 toggleSidebar，绝不降回收起 ——
  // 桌面端那个开关归用户自己，我们不去抢，也不需要它来表达开合。
  // 注意：构造控制器不碰 DOM（drawer-state.mjs 里 findFrame 只在调用时解析），
  // mobileApply 跑得比 AppFrame 挂载早，构造期查 DOM 必然拿到 null。
  const drawer = createDrawerController({
    findFrame,
    // ctx.layout 由 client-ui-layout 在服务端 composition 里提供（asar：同一个包既
    // 注册 'root' 里的 AppFrame，也注册 sidebar.left.toggle 的 web:* 快捷键默认值），
    // 但不能假设它在所有宿主版本 / 所有平台上都在 —— 一律可选链 + try/catch。
    expandSidebar: () => {
      try {
        ctx.layout?.toggleSidebar?.()
      } catch (error) {
        reportMobileError('expandSidebar', error)
      }
    },
  })

  const pocketT = (pocketKey: string): string => pocketTranslate(ctx, pocketKey)
  // 手机端判据（纯函数，可单测）：强制抽屉 / 窄于 1024 / (pointer: coarse) 三者之一。
  // 用 pointer:coarse 而不是 hover:hover —— 手机 WebView（微信 XWEB、小米浏览器）上
  // coarse 为 true，hover 能力报得不可靠。真桌面（≥1024 + fine）不打扰。
  const showHealNotice = shouldShowLayoutBadge({
    innerWidth: window.innerWidth,
    coarsePointer: window.matchMedia?.(COARSE_POINTER_MEDIA)?.matches === true,
    layout,
  })

  // ── 阶段 2：全部 slot 注册（auto-heal 的短暂提示也在这里）───────────────
  // 常驻「布局」浮标胶囊按用户要求已删除：三态开关只留在 pocket 设置页
  // 「手机访问」分区（client/index.jsx），手机上够得着。

  // Session log download, relocated from the session header to the drawer
  // footer on mobile (the header capsule is hidden by CSS); the drawer
  // footer also hosts the Files action that opens the dsh-web-ui explorer
  // sheet, plus the layout quick-cycle button.

  // Drawer chrome is mounted from plain DOM (host slot contributions never
  // render in this DSH build — see drawer-chrome.ts).
  safeEffect(() => mountDrawerChrome({
    findFrame,
    expandSidebar: () => {
      try {
        ctx.layout?.toggleSidebar?.()
      } catch (error) {
        reportMobileError('expandSidebar', error)
      }
    },
    labels: {
      menu: pocketTranslate(ctx, 'drawerMenuAria'),
      sessionLog: pocketTranslate(ctx, 'drawerSessionLogAria'),
    },
    onDownloadSessionLog: () => {
      const sessionId = currentSessionId()
      if (sessionId === '') return
      try {
        ctx.sessionLogDownload?.download?.(sessionId)
      } catch (error) {
        reportMobileError('downloadSessionLog', error)
      }
    },
    // 开抽屉的实测延迟上报（点击 → 真的开始滑）：诊断包里看得见，别只凭猜判断卡顿来源。
    onMeasure: (info) => {
      reportMobileStage('drawer-open', { ms: info.ms, up: info.upgrade === true })
    },
  }), 'dsh-mobile-nav: drawer chrome')

  /** 首屏探针：一次扫描数出三种 chrome 与壳层占位（原来是 4 次全页 querySelectorAll，
   *  在两三万节点的长会话页面上就是四次全树走一遍，正压在首屏那几百毫秒上） */
  const chromeCounts = (): { backdrop: number; fab: number; toggle: number; overlayChildren: number } => {
    let backdrop = 0
    let fab = 0
    let toggle = 0
    let overlayChildren = 0
    for (const el of document.querySelectorAll<HTMLElement>('[data-mobile-nav], [data-shell-overlay] > *')) {
      const nav = el.getAttribute('data-mobile-nav')
      if (nav === 'backdrop') backdrop += 1
      else if (nav === 'fab') fab += 1
      else if (nav === 'toggle') toggle += 1
      if (el.parentElement?.hasAttribute('data-shell-overlay')) overlayChildren += 1
    }
    return { backdrop, fab, toggle, overlayChildren }
  }
  reportMobileStage('slots', (() => {
    const counted = chromeCounts()
    return {
      ly: layout,
      chrome: `${counted.backdrop}/${counted.fab}/${counted.toggle}`,
      ov: counted.overlayChildren,
    }
  })())

  safeEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-external/dsh-mobile-nav'
    tag.dataset.pluginCss = '@dsh-external/dsh-mobile-nav/mobile.css'
    tag.textContent = MOBILE_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-mobile-nav: styles')

  // 微信内置浏览器的顶部栏直接显示 document.title。宿主会把它改成
  // 「当前会话名 — DeepSeek Harness」，长会话名因此占满手机顶部；手机布局固定为产品名。
  // 只观察 head，宿主再次写入会话标题时就地改回；切回电脑布局后交还宿主原标题。
  safeEffect(() => {
    const PRODUCT_TITLE = 'DeepSeek Harness'
    let hostTitle = document.title || PRODUCT_TITLE
    const syncTitle = (): void => {
      if (!narrow.matches) {
        hostTitle = document.title
        return
      }
      if (document.title === PRODUCT_TITLE) return
      hostTitle = document.title || hostTitle
      document.title = PRODUCT_TITLE
    }
    const onLayoutChange = (): void => {
      if (narrow.matches) {
        syncTitle()
      } else if (document.title === PRODUCT_TITLE) {
        document.title = hostTitle
      }
    }
    const observer = new MutationObserver(syncTitle)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    narrow.addEventListener('change', onLayoutChange)
    syncTitle()
    return () => {
      observer.disconnect()
      narrow.removeEventListener('change', onLayoutChange)
      if (document.title === PRODUCT_TITLE && hostTitle !== PRODUCT_TITLE) document.title = hostTitle
    }
  }, 'dsh-mobile-nav: fixed product title')

  // Phone chrome: KEEP the system status bar (no fullscreen) and make it
  // blend into the page. On narrow screens:
  // - The viewport meta gains viewport-fit=cover, so env(safe-area-inset-top)
  //   is the real status-bar / notch height and the stylesheet can push every
  //   surface below it (off notched phones, or in a browser tab where the
  //   layout viewport already sits below the status bar, the inset is 0 and
  //   nothing shifts).
  // - A theme-color meta tracks the shell background (the official theme is
  //   toggled by body[data-ds-dark-theme], which flips --dsw-alias-bg-base):
  //   Android then paints the status bar / URL bar with the page's own base
  //   color, so the status bar reads as part of the UI instead of a foreign
  //   strip. The drawer paints the same strip on iOS / notch displays.
  // - gesturestart is suppressed as the legacy-iOS fallback for double-tap
  //   zoom; modern browsers are covered by the stylesheet's
  //   touch-action: manipulation (which keeps pan and pinch zoom).
  safeEffect(() => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const originalViewport = viewport?.content ?? ''
    const themeMeta = document.createElement('meta')
    themeMeta.name = 'theme-color'
    const bodyBg = (): string => getComputedStyle(document.body).backgroundColor

    const sync = (): void => {
      if (viewport !== null) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover'
      themeMeta.content = bodyBg()
      if (themeMeta.parentElement === null) document.head.appendChild(themeMeta)
    }
    const restore = (): void => {
      if (viewport !== null) viewport.content = originalViewport
      themeMeta.remove()
    }
    const onGestureStart = (event: Event) => event.preventDefault()
    if (narrow.matches) sync()
    const onChange = (event: MediaQueryListEvent) => (event.matches ? sync() : restore())
    narrow.addEventListener('change', onChange)
    const observer = new MutationObserver(() => {
      if (narrow.matches) themeMeta.content = bodyBg()
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    document.addEventListener('gesturestart', onGestureStart)
    return () => {
      narrow.removeEventListener('change', onChange)
      observer.disconnect()
      document.removeEventListener('gesturestart', onGestureStart)
      restore()
    }
  }, 'dsh-mobile-nav: status bar theme + viewport + zoom guard')

  // dsh-web-ui compatibility: the aionui explorer column would render as a
  // sheet over the whole mobile UI whenever its (persisted) expanded state
  // is active — including right after a reload, with no way out (the
  // suite's floating expand button only exists while collapsed). Instead
  // of fighting the suite's store timing, the mobile stylesheet keeps the
  // explorer column hidden by default and the header's Files action (plus
  // the drawer footer entry) opens it via the `data-aionui-explorer-open`
  // marker on the frame. This effect just clears that marker when the
  // sheet's own collapse chevron is tapped, so closing is symmetric with
  // opening.
  safeEffect(() => {
    if (!narrow.matches) return () => {}
    const onChevronClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target === null || !target.closest('.aionui-collapse-chevron')) return
      document.querySelector('[data-mobile-nav="frame"]')?.removeAttribute('data-aionui-explorer-open')
    }
    document.addEventListener('click', onChevronClick, true)
    return () => document.removeEventListener('click', onChevronClick, true)
  }, 'dsh-mobile-nav: aionui explorer close marker')

  // The mobile "Files" entries (header icon + drawer footer) open the
  // dsh-web-ui **aionui explorer column** — a host-side component that plain
  // DeepSeek Harness does NOT ship (issue #48). Without it the entries are
  // dead buttons (they only toggle a frame attribute; nothing ever renders).
  // Detect whether the host provides the column and mark the frame with
  // `data-mobile-nav-explorer="1|0"` so the stylesheet can hide the entries
  // on hosts without it (dsh-web-ui installs keep the feature).
  safeEffect(() => {
    if (!narrow.matches) return () => {}
    const frame = (): HTMLElement | null => document.querySelector('[data-mobile-nav="frame"]')
    const check = () => {
      const has = document.querySelector('[data-aionui-explorer-col]') !== null
      frame()?.setAttribute('data-mobile-nav-explorer', has ? '1' : '0')
      return has
    }
    // 原来这里是「body 全量 childList 观察者 + 每批变更查一次」：本机是纯 DeepSeek
    // Harness，永远等不到那两列，观察者却永久挂着，每次打字 / 流式渲染都排一次整页扫描。
    // 换成有界轮询：窗口内查得到就标记 '1'，查不到就不再观察（零成本）。
    if (check()) return () => {}
    const watch = startFeaturePresenceWatch({
      selectors: ['[data-aionui-explorer-col]'],
      timeoutMs: AIONUI_PRESENCE_MS,
      onActive: () => { check(); return () => {} },
    })
    presenceWatches.push(watch)
    return () => {
      const slot = presenceWatches.indexOf(watch)
      if (slot >= 0) presenceWatches.splice(slot, 1)
      watch.dispose()
    }
  }, 'dsh-mobile-nav: explorer availability (issue #48)')

  // dsh-web-ui compatibility: the aionui preview column persists its open
  // tabs in localStorage and restores them on load, which would pop the
  // preview sheet over the fresh UI after a reload. Gate it like the
  // explorer: the stylesheet keeps the column hidden unless the frame
  // carries `data-aionui-preview-open`; this effect sets that marker when
  // the user actually taps a file row in the explorer sheet, and clears it
  // whenever the suite hides the column again (collapse chevron / tab
  // close), so a restored-but-unwanted sheet never appears.
  gatedPageObserver('dsh-mobile-nav: preview sheet open marker', ['[data-aionui-preview-col]'], () => {
    const frame = (): HTMLElement | null => document.querySelector('[data-mobile-nav="frame"]')
    const onTap = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (target.closest('[data-aionui-explorer-col] [class$="_treeRow"]') === null) return
      frame()?.setAttribute('data-aionui-preview-open', '')
    }
    const sync = (): void => {
      const pv = document.querySelector('[data-aionui-preview-col]')
      if (pv === null) return
      if (getComputedStyle(pv).visibility === 'hidden') frame()?.removeAttribute('data-aionui-preview-open')
    }
    const schedule = createGatedThrottle({ run: sync, gate: domGate, waitMs: 300 })
    document.addEventListener('click', onTap, true)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] })
    sync()
    return () => {
      document.removeEventListener('click', onTap, true)
      observer.disconnect()
    }
  })

  // The official conversation status row (turns / steps / LLM time / TTFT /
  // cache) has a hashed class, so the stylesheet cannot target it directly.
  // Its stable boundary is the official conversation.composer.dock slot. Mark
  // only the metrics root inside that slot; never scan every *_root under the
  // composer because the editor itself is now contenteditable (not textarea)
  // and its root also contains the dock text.
  safeEffect(() => {
    if (!narrow.matches) return () => {}
    // The composer root renders the TPS readout ("TPS 89.4 tok/s") as its
    // own row BELOW the status strip; fold it into the strip so every
    // metric scrolls together. The suite re-renders its own tree, so this
    // must be idempotent and re-run on every mutation.
    const moveTps = (stats: Element): void => {
      if ([...stats.children].some((c) => /^TPS\s+\d/.test((c.textContent ?? '').trim()))) return
      const stack = stats.closest('[class$="_composerStack"]')
      if (stack === null) return
      for (const el of stack.querySelectorAll('div')) {
        const text = (el.textContent ?? '').trim()
        if (!/^TPS\s+\d/.test(text)) continue
        if (el.children.length > 0) continue
        // 一律不碰编辑器自己（contenteditable）里的节点：把里面的东西搬出去 = 宿主
        // Lexical 重建树节点 = 手机语音 / 拼音输入当场中断。
        if (insideComposer(el, '[contenteditable="true"]')) continue
        stats.appendChild(el)
        return
      }
    }
    const dockSelector = '[data-phase] [data-slot="conversation.composer.dock"]'
    const markerSelector = '[class$="_root"]'
    let dock: Element | null = null
    /** dock 被 React 换掉时重新定位；拿不到 dock 就等于原实现「全页找选择器找不到」的情况（同样什么都不标） */
    const ensureDock = (): boolean => {
      if (dock !== null && dock.isConnected) return true
      dock = document.querySelector(dockSelector)
      return dock !== null
    }
    const mark = (): void => {
      if (!ensureDock() || dock === null) return
      // 只在这一棵（输入框旁边的 dock）里找统计行：原来是整页扫 [class$="_root"] 再逐条读 textContent，
      // 一次 ~19ms，长会话页面上每 300ms 就是一发
      for (const root of dock.querySelectorAll<HTMLElement>(markerSelector)) {
        const text = root.textContent ?? ''
        if (!/(turns|steps|\bLLM\b|轮|步)/.test(text)) continue
        root.setAttribute('data-mobile-nav', 'stats')
        moveTps(root)
        return
      }
    }
    // createGatedThrottle：用户在输入框里打字（含语音实时转写）或抽屉正在开合时不跑，
    // 到点了也不会丢——它会自己重来，统计行照样折叠。
    const schedule = createGatedThrottle({ run: mark, gate: domGate, waitMs: 300 })
    const observer = new MutationObserver((mutations) => {
      if (!ensureDock() || dock === null) return
      // 聊天流式更新（消息列表里的节点）与 dock 无关：不在那一棵里就不必重扫
      const touchesDock = mutations.some((m) => m.target === dock || dock!.contains(m.target))
      if (!touchesDock) return
      schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    mark()
    return () => {
      observer.disconnect()
    }
  }, 'dsh-mobile-nav: stats line marker')

  // The dsh-web-ui explorer / preview columns toggle via `visibility`
  // (their inline style), which never restarts a CSS animation — so the
  // sheets would only animate on first mount. Replay the rise animation
  // with the Web Animations API each time a column turns visible, then
  // leave the resting state to the stylesheet.
  gatedPageObserver('dsh-mobile-nav: sheet rise animation replay', ['[data-aionui-explorer-col]', '[data-aionui-preview-col]'], () => {
    const cols = ['[data-aionui-explorer-col]', '[data-aionui-preview-col]']
    const seen = new Map<string, boolean>()
    const play = (el: Element): void => {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(28px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 280, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' },
      )
    }
    const check = (): void => {
      for (const sel of cols) {
        const el = document.querySelector(sel)
        if (el === null) continue
        const visible = getComputedStyle(el).visibility === 'visible'
        const prev = seen.get(sel) ?? false
        if (visible && !prev) play(el)
        seen.set(sel, visible)
      }
    }
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => { frame = null; check() })
    }
    const observer = new MutationObserver(schedule)
    // Visibility flips come through inline style mutations (suite) or the
    // explorer-open marker on the frame; class changes are watched too.
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class', 'data-aionui-explorer-open'] })
    check()
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  })

  // 移动端文件守卫（issue #17 修正）：手机上点 dsh-web 渲染的文件链接会触发桌面
  // 端 workspaces.openPath(open ...) —— 既打不开（路径在电脑上），又会抛
  // "path open failed"。这里在捕获阶段拦截这类点击 / 键盘激活，改为弹一个提示，
  // 并隐藏「添加工作区」入口（手机上配工作区无意义）；同时在文件链接旁注入
  // 「复制」按钮，点它经主机 RPC 读取文件正文再写入剪贴板。只挂窄屏。
  safeEffect(() => {
    if (!narrow.matches) return () => {}
    // 尽量拿到当前工作区 cwd（文件链接文案是相对它的），传给主机 RPC 做精确解析；
    // 拿不到就回退到主机 process.cwd()。dsh-web 的 workspaces 服务暴露当前工作区。
    const getWorkspaceCwd = (): string => {
      try {
        const ws = (ctx as unknown as { get?: (k: string) => unknown }).get?.('workspaces')
          ?? (ctx as unknown as { workspaces?: unknown }).workspaces
        const list = (ws as { list?: unknown })?.list
        const arr: unknown[] | null = Array.isArray(list)
          ? list
          : (list && typeof list === 'object' && 'value' in (list as object)
            ? (list as { value: unknown[] }).value
            : null)
        if (Array.isArray(arr)) {
          for (const w of arr) {
            const c = (w as { cwd?: string; root?: string })?.cwd
              ?? (w as { cwd?: string; root?: string })?.root
            if (typeof c === 'string' && c) return c
          }
        }
      } catch { /* 忽略，回退 process.cwd() */ }
      return ''
    }
    // 手机侧读文件回调：走 dsh-pocket 的 RPC 通道，由主机侧 fileRead 端点处理。
    const readFile = (filePath: string) =>
      ctx.connection.rpc.call(
        POCKET_RPC_CHANNEL,
        POCKET_ENDPOINTS.fileRead,
        { path: filePath, cwd: getWorkspaceCwd() },
      ) as Promise<{ ok: boolean; value?: { content: string; path: string; size: number }; error?: { message: string } }>
    return startFileGuard(readFile)
  }, 'dsh-mobile-nav: file open guard + copy button + hide add-workspace (issue #17)')

  // 手机上模型 / 提供方设置加载失败：上游 dsh-web 会渲染「加载提供方目录失败 /
  // Settings are unavailable in this browser」。这条文案不是 dsh-pocket 的，但手机侧
  // 本就不支持改模型设置，原报错只会吓到用户。窄屏下用 MutationObserver 就地把该报错
  // 文本替换成「去电脑端修改」的引导提示（仅手机，桌面端不受影响）。
  safeEffect(() => {
    if (!narrow.matches) return () => {}
    const patcher = createModelSettingsNoticePatcher()
    // 1.5s 合并一次：提示更新节奏不变，但扫描范围从 document.body 降为实际变更节点。
    // 走闸门版本：用户正在输入框里打字 / 抽屉开合时先让路，队列不丢（见 compositionGate.ts）。
    const schedule = createGatedThrottle({ run: () => patcher.flush(), gate: domGate, waitMs: 1500, skipMs: 1500 })
    const observer = new MutationObserver((mutations) => {
      if (patcher.collect(mutations)) schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    const onVisibility = (): void => {
      if (document.hidden) return
      // 后台期间到达的文本在恢复时补齐；随后清空并处理仍连接的增量节点。
      patcher.patchAll()
      patcher.flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    patcher.patchAll()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'dsh-mobile-nav: replace model-settings load error with mobile hint')

  // ── 阶段 4：effect 全部登记完毕 ────────────────────────────────────────
  // 注意：ctx.effect 的回调通常在登记时就地执行，所以走到这里说明前面每个 effect
  // 要么正常返回，要么被 safeEffect 兜住并上报了（'mobile-stage-error'）。
  reportMobileStage('effects')
  reportMobileStage('done')
  // ── 阶段 5：复检探针（只改时序，不动任何逻辑）─────────────────────────
  // installLayoutProbe 装在 installDiag 里，比 mobileApply 还早，它拿到的可能是
  // "挂载前"的现场（14:58 实测：同一条 layout-probe 报 css=false / marker='' /
  // slots 全 0，而同一秒 mobile-stage 四段全通）。所以这里在 stage:'done' 之后
  // 再排 +1.2s / +3.2s 两次复检，字段与发送函数完全同一套，只多一个 at 标签。
  // 电脑布局在上面就 return 了，不会走到这里 —— 也就不会多发探针。
  schedulePostMobileProbes()
}


/** Session id the log download needs; '' when the store is missing. */
function currentSessionId(): string {
  try {
    const raw = globalThis.localStorage?.getItem('dsh.sessions.current') ?? ''
    const match = /session-[0-9a-zA-Z-]{8,}/.exec(raw)
    return match?.[0] ?? ''
  } catch {
    return ''
  }
}

/** One-shot "layout was healed" toast (sessionStorage deduped, 6s self-dismiss). */
function scheduleHealToast(ctx): void {
  try {
    const key = 'dsh-pocket.layout-healed'
    if (sessionStorage.getItem(key) === '1') return
    sessionStorage.setItem(key, '1')
    setTimeout(() => {
      showHealToast(pocketTranslate(ctx, 'layoutHealedToast'), pocketTranslate(ctx, 'layoutHealedDismiss'))
    }, 800)
  } catch {
    /* toast 失败不影响启动 */
  }
}
// Type-only augmentation imports: pull the layout / conversation / sidebar
// SlotMap merges and the sessionLogDownload service typing into this program
// without any runtime import.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
