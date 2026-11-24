/**
 * 手机端「设置」面板（宿主 dialog）的离线回归：拿 mobile.css.ts 里真正导出的
 * MOBILE_CSS，套到一份**照 DSH 0.2.2 实测结构复刻**的对话框 DOM 上，在真 Chrome
 * 里量宽度 / 可见性 / 命中。
 *
 * 为什么要有这一层（2026-11-25 用户报「手机端设置，个人助手设置页一片空白」）：
 * 设置页的手机样式整块挂在 ":has(> :first-child > :last-child > button)" 上，
 * 而 0.2.2 把 tab 列表从标题行搬进了独立的 <nav>，这条门控永远为假 —— 面板还是
 * 100vh 的桌面网格、tab 条变成横向滚动（6 个 tab 有 4 个落在面板外）、
 * 「手机访问」卡片右列 (nowrap) 把标题/说明列挤成 42.6px（≈4 字一行）。宿主里量
 * 到的是「整页还在、内容读不到/够不到」，离线这份用同样的 DOM 形状把三条判据钉住。
 *
 * 结构来源（真机测量，2026-11-25 390×844 / 360×740 手机视口）：
 *   div[aria-modal=true][data-shortcut-modal=settings].AnXs9G_panel
 *     ├ .AnXs9G_navTitle / nav.AnXs9G_nav > .AnXs9G_navList > button.AnXs9G_navCell
 *     ├ .AnXs9G_header / .AnXs9G_options
 * 断言失败会打印实测数字；退出码 0 = 全绿。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { MOBILE_CSS } = await import('../src/client/pocket/mobile/mobile.css.ts')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (ok) console.log(`PASS ${name}${detail ? `  — ${detail}` : ''}`)
  else console.error(`FAIL ${name}${detail ? `  — ${detail}` : ''}`)
}
const must = (name, fn) => {
  try { const detail = fn(); check(name, true, detail) } catch (error) { check(name, false, String(error.message).split('\n')[0].slice(0, 300)) }
}

/** CSS 文本去掉注释 —— 注释里会贴历史选择器，按全文 includes 判会误报。 */
const CSS_CODE = MOBILE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
/** 设置面板那一节（起点 = 面板锚点，终点 = 紧随其后的下一节规则）。 */
const SHEET_BLOCK = CSS_CODE.slice(
  CSS_CODE.indexOf('[aria-modal="true"][data-shortcut-modal="settings"]'),
  CSS_CODE.indexOf('[data-aionui-explorer-col]'),
)

/* ---------------- 1. 选择器契约（不跑浏览器也能钉住的部分） ---------------- */

must('MOBILE_CSS 里设置面板锚点是 _navList / data-shortcut-modal（不是子元素序号）', () => {
  assert.ok(CSS_CODE.includes('[aria-modal="true"]:is([aria-modal="true"][data-shortcut-modal="settings"], [aria-modal="true"]:has([class$="_navList"]))')
    || /:is\(\[aria-modal="true"\]\[data-shortcut-modal="settings"\], \[aria-modal="true"\]:has\(\[class\$="_navList"\]\)\)/.test(CSS_CODE),
  '没找到设置面板锚点')
  assert.ok(!CSS_CODE.includes(':has(> :first-child > :last-child > button)'), '旧的子元素序号门控还在生效的 CSS 里')
  return '_navList + data-shortcut-modal'
})
must('MOBILE_CSS 里设置面板规则按类名后缀挂：_nav/_navList/_navCell/_header/_options', () => {
  for (const suffix of ['_nav', '_navList', '_navCell', '_header', '_options']) {
    assert.ok(SHEET_BLOCK.includes(`[class$="${suffix}"]`), `缺 [class$="${suffix}"]`)
  }
  return '5 个后缀'
})
must('设置面板不许被钉成 position:absolute/left:8px（历史上会把整块拖出屏）', () => {
  assert.ok(SHEET_BLOCK.length > 0, '找不到 Settings sheet 那节')
  assert.ok(!/position:\s*absolute/.test(SHEET_BLOCK), '面板块里又出现 position:absolute')
  return 'no absolute'
})
must('面板显式声明可见性（visibility/opacity/pointer-events）', () => {
  for (const decl of ['visibility: visible !important', 'opacity: 1 !important', 'pointer-events: auto !important']) {
    assert.ok(SHEET_BLOCK.includes(decl), `面板块缺 ${decl}`)
  }
  return '3 条'
})
must('「手机访问」卡片的身份标记在插件自己的渲染里（data-dsh-pocket-card / data-part）', () => {
  assert.ok(SHEET_BLOCK.includes('[data-dsh-pocket-card="hero"]'), '缺卡片标记规则')
  assert.ok(SHEET_BLOCK.includes('[data-part="intro"]') && SHEET_BLOCK.includes('[data-part="credit"]'), '缺左右列标记规则')
  return 'hero/intro/credit'
})

/* ---------------- 2. 真 Chrome：0.2.2 形状的对话框上量 ---------------- */

const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
if (!existsSync(CHROME)) {
  console.log(`SKIP 没有 Chrome（${CHROME}）：只跑了上面的选择器契约`)
} else {
  const require = createRequire(join(ROOT, 'package.json'))
  const { chromium } = require('playwright')

  /** 宿主 0.2.2 设置对话框的 DOM 形状 + 官方桌面样式（数值来自真机测量）。 */
  const FIXTURE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  /* ---- 宿主（DSH 0.2.2）原始样式：桌面 800px 网格、100vh、tab 横向滚动 ---- */
  html, body { margin: 0; height: 100%; background: #f5f6f8; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  .AnXs9G_drawer { position: fixed; inset: 0 auto 0 0; width: 280px; background: #fff; z-index: 1200; }
  .AnXs9G_overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .AnXs9G_mask { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); }
  .AnXs9G_panel { position: relative; z-index: 1; display: grid; grid-template-columns: 202px 156px; grid-template-rows: 48px 66px minmax(0, 1fr); width: 800px; max-width: 800px; height: 100vh; overflow: hidden; background: #fff; }
  .AnXs9G_navTitle { grid-column: 1; grid-row: 1; display: flex; align-items: center; padding: 0 16px; font-size: 18px; overflow: hidden; }
  .AnXs9G_nav { grid-column: 1 / -1; grid-row: 2; display: flex; min-width: 0; overflow: hidden; }
  .AnXs9G_navList { display: flex; gap: 8px; padding: 8px 20px; overflow-x: auto; overflow-y: hidden; }
  .AnXs9G_navCell { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; white-space: nowrap; border: 0; background: transparent; font: inherit; font-size: 14px; }
  .AnXs9G_header { grid-column: 2; grid-row: 1; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 12px; }
  .AnXs9G_options { grid-column: 1 / -1; grid-row: 3; overflow: auto; padding: 0 20px; min-height: 0; }
  .AnXs9G_card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; }
</style>
<style id="mobile-css">${MOBILE_CSS}</style>
</head><body data-dsh-pocket-layout="mobile">
  <div class="AnXs9G_drawer" aria-hidden="true"></div>
  <div class="AnXs9G_overlay" id="overlay">
    <div class="AnXs9G_mask"></div>
    <div class="AnXs9G_panel" role="dialog" aria-modal="true" aria-labelledby="t" data-shortcut-modal="settings" id="panel">
      <div class="AnXs9G_navTitle" id="t">设置</div>
      <nav class="AnXs9G_nav"><div class="AnXs9G_navList" id="navList">
        <button type="button" class="AnXs9G_navCell">账号与余额</button>
        <button type="button" class="AnXs9G_navCell">通用设置</button>
        <button type="button" class="AnXs9G_navCell" aria-current="true">个人助手</button>
        <button type="button" class="AnXs9G_navCell">模型</button>
        <button type="button" class="AnXs9G_navCell">内置插件</button>
        <button type="button" class="AnXs9G_navCell">Agent 预设</button>
      </div></nav>
      <div class="AnXs9G_header"><button type="button" class="AnXs9G_navCell">打开配置文件</button><button type="button" class="AnXs9G_navCell" aria-label="关闭">×</button></div>
      <div class="AnXs9G_options" id="options">
        <div data-slot="settings.section" style="display:contents">
          <div style="padding:2px 2px 14px">
            <div class="AnXs9G_card">
              <div data-dsh-pocket-card="hero" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div data-part="intro">
                  <strong>📱 手机访问</strong>
                  <div style="font-size:12px;line-height:1.5;color:#8b93a1">手机扫码打开的就是电脑上的这个界面，实时同步</div>
                </div>
                <div data-part="credit" style="font-size:12px;color:#8b93a1;text-align:right">
                  <div style="white-space:nowrap">开发者：程序员少北晨</div>
                  <div style="white-space:nowrap">⭐ 顺手留颗 Star，作者能高兴一整天</div>
                  <a href="#" style="font-size:12px;color:#4f6ef7">行，给你一颗 Star</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`

  const browser = await chromium.launch({ headless: true, executablePath: CHROME })
  try {
    for (const [W, H] of [[390, 844], [360, 740], [320, 568]]) {
      const page = await browser.newPage({ viewport: { width: W, height: H } })
      await page.setContent(FIXTURE, { waitUntil: 'load' })
      await page.waitForTimeout(120)
      const m = await page.evaluate(() => {
        const rect = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), display: s.display, visibility: s.visibility, opacity: s.opacity, pointerEvents: s.pointerEvents, zIndex: s.zIndex, overflowX: s.overflowX, paddingLeft: s.paddingLeft } }
        const panel = document.getElementById('panel')
        const navList = document.getElementById('navList')
        const options = document.getElementById('options')
        const tabs = [...navList.querySelectorAll('button')].map((el) => ({ label: el.textContent.trim(), ...rect(el) }))
        const card = options.querySelector('[data-dsh-pocket-card="hero"]')
        const intro = options.querySelector('[data-part="intro"]')
        const credit = options.querySelector('[data-part="credit"]')
        const panelRect = panel.getBoundingClientRect()
        const chain = []
        for (let cur = panel; cur; cur = cur.parentElement) {
          const s = getComputedStyle(cur)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) chain.push(`${cur.tagName}.${String(cur.className).slice(0, 24)}`)
        }
        const ob = options.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(ob.x + ob.width / 2), Math.round(ob.y + 40))
        return {
          vw: window.innerWidth, vh: window.innerHeight,
          panel: rect(panel), panelRight: +panelRect.right.toFixed(1),
          overlayZ: Number(getComputedStyle(document.getElementById('overlay')).zIndex) || 0,
          navList: rect(navList), tabs,
          options: { ...rect(options), scrollWidth: options.scrollWidth, clientWidth: options.clientWidth },
          card: card ? { ...rect(card), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth } : null,
          intro: intro ? rect(intro) : null, credit: credit ? rect(credit) : null,
          hiddenChain: chain,
          hitInside: hit !== null && panel.contains(hit),
          hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 30)}` : null,
        }
      })

      const tag = `${W}×${H}`
      check(`[${tag}] 设置面板宽度非 0`, m.panel.w > 0, `${m.panel.w}px`)
      check(`[${tag}] 面板是手机尺寸的浮层（宽 ≤ 视口-8、高 ≤ 视口-12、完整在视口内）`,
        m.panel.w <= m.vw - 8 && m.panel.h <= m.vh - 12 && m.panel.x >= 0 && m.panel.y >= 0,
        `panel ${m.panel.w}×${m.panel.h} at (${m.panel.x},${m.panel.y}) vw=${m.vw} vh=${m.vh}`)
      check(`[${tag}] 面板自身与祖先链都没被隐藏规则命中`,
        m.hiddenChain.length === 0 && m.panel.display !== 'none' && m.panel.visibility === 'visible' && Number(m.panel.opacity) === 1 && m.panel.pointerEvents !== 'none',
        `display=${m.panel.display} visibility=${m.panel.visibility} opacity=${m.panel.opacity} pe=${m.panel.pointerEvents} hidden=${JSON.stringify(m.hiddenChain)}`)
      check(`[${tag}] tab 条换行排布（不再是横向滚动）`, m.navList.display === 'grid' && m.navList.overflowX !== 'auto',
        `display=${m.navList.display} overflowX=${m.navList.overflowX}`)
      const outside = m.tabs.filter((t) => t.x < m.panel.x - 0.5 || t.x + t.w > m.panelRight + 0.5)
      check(`[${tag}] 6 个设置 tab 全落在面板内（不被裁掉）`, outside.length === 0,
        `outside=${JSON.stringify(outside.map((t) => `${t.label}(${t.x}+${t.w})`))} panelRight=${m.panelRight}`)
      check(`[${tag}] 内容区宽度非 0 且无横向溢出`, m.options.w > 0 && m.options.scrollWidth <= m.options.clientWidth + 1,
        `w=${m.options.w} scrollWidth=${m.options.scrollWidth} clientWidth=${m.options.clientWidth}`)
      check(`[${tag}] 「手机访问」卡片左列拿到可读宽度（≥ 120px）`, m.intro !== null && m.intro.w >= 120,
        m.intro ? `intro ${m.intro.w}px / credit ${m.credit ? m.credit.w : 'n/a'}px` : '左列不存在')
      check(`[${tag}] 内容区中心命中面板内部（没被抽屉/遮罩盖住）`, m.hitInside === true, `${m.hit}`)
      check(`[${tag}] 浮层压在抽屉之上（overlay z-index > 抽屉 1200）`, m.overlayZ > 1200, `overlay z=${m.overlayZ}`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

const passed = checks.filter((c) => c.ok).length
const failed = checks.length - passed
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${checks.length} mobile-settings-sheet`)
process.exit(failed === 0 ? 0 : 1)
