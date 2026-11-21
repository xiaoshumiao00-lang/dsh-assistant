/**
 * 个人秘书回答卡片 v1.0 的浏览器视觉验收。
 *
 * 当前 pocket 局域网入口被 8 位 PIN + dsh web 启动 token 双层拦住，无头 Playwright
 * 拿不到宿主浏览器会话；本脚本把本次构建里真实的 SECRETARY_CARD_CSS 注入 Chromium，
 * 再用与 SecretaryReplyCard 相同的 DOM 结构逐项验 computed style。
 *
 * 通过 = 退出码 0；截图写到 tmp-secretary-card.png 与 tmp-secretary-card-desktop.png。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BUNDLE = join(ROOT, 'lib', 'client.js')
const SCREENSHOT_MOBILE = join(ROOT, 'tmp-secretary-card.png')
const SCREENSHOT_DESKTOP = join(ROOT, 'tmp-secretary-card-desktop.png')

const source = readFileSync(BUNDLE, 'utf8')
const marker = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]'
const at = source.indexOf(marker)
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = source.lastIndexOf('`', at)
const cssEnd = source.indexOf('`', at)
if (cssStart < 0 || cssEnd <= cssStart) throw new Error('无法从 lib/client.js 提取 SECRETARY_CARD_CSS')
const cardCss = source.slice(cssStart + 1, cssEnd)
if (!cardCss.includes('[data-dsh-scard="card"]')) throw new Error('提取到的 CSS 不含卡片规则')

const paragraphs = [
  '普通正文一段，用来检查 13px / 1.8 的行高和 #4E5969 的颜色。',
  '型号 qwen3.8-flash-next，量化版本是 IQ3_XXS，两个都应该渲染成行内模型标签。',
  '重点句：<strong data-probe="strong">这是必须加粗的唯一一句。</strong>',
  '第四段继续填充，确保折叠测量有足够内容。',
  '第五段继续填充，展开全文按钮必须出现。',
  '第六段收尾，展开后能看到完整正文。',
]

const body = paragraphs.map((line) => {
  const html = line
    .replace('qwen3.8-flash-next', '<span data-dsh-scard="model-code">qwen3.8-flash-next</span>')
    .replace('IQ3_XXS', '<span data-dsh-scard="model-code">IQ3_XXS</span>')
  return `<p data-dsh-scard="para">${html}</p>`
}).join('')

const pageHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;background:#F6F7F9}
.answer-stage{padding:28px;background:#F6F7F9}
${cardCss}
</style></head>
<body data-dsh-secretary="1">
<div class="answer-stage">
<article data-dsh-scard="card" data-dsh-scard-turn="7" data-empty="0" data-open="0" data-overflow="1">
  <div data-dsh-scard="head">
    <div data-dsh-scard="assistant">
      <span data-dsh-scard="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8l1.9 5.7 5.7 1.9-5.7 1.9L12 19l-1.9-5.7L4.4 11.4l5.7-1.9L12 3.8z"/><path d="M4.6 4.6l2 2"/><path d="M17.4 19.4l2 2"/></svg>
      </span>
      <span data-dsh-scard="name">个人秘书</span>
      <span data-dsh-scard="tag">AI 助手</span>
    </div>
    <button type="button" data-dsh-speak="button" data-status="idle" aria-pressed="false" aria-label="朗读回答" title="朗读回答">
      <svg data-dsh-speak="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M19 6a9 9 0 0 1 0 12"/></svg>
    </button>
  </div>
  <div data-dsh-scard="body">
    <div data-dsh-scard="content">
      <h1 data-dsh-scard="title">我目前无法查看你打开的 QQ 页面</h1>
      ${body}
    </div>
  </div>
  <div data-dsh-scard="foot">
    <time data-dsh-scard="time">今天 14:39</time>
    <div data-dsh-scard="actions">
      <button type="button" data-dsh-scard="copy" title="复制完整回答" aria-label="复制完整回答">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>
      </button>
      <span data-dsh-scard="separator" aria-hidden="true"></span>
      <button type="button" data-dsh-scard="expand" aria-expanded="false" title="展开全文">
        <span data-dsh-scard="expand-text">展开全文</span>
        <svg data-dsh-scard="expand-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
  </div>
</article>
</div>
<script>
const card = document.querySelector('[data-dsh-scard="card"]')
const content = card.querySelector('[data-dsh-scard="content"]')
const expand = card.querySelector('[data-dsh-scard="expand"]')
const expandText = card.querySelector('[data-dsh-scard="expand-text"]')
const copy = card.querySelector('[data-dsh-scard="copy"]')
let copied = false
copy.addEventListener('click', () => {
  copied = !copied
  let status = card.querySelector('[data-dsh-scard="copy-status"]')
  if (status === null) {
    status = document.createElement('span')
    status.setAttribute('data-dsh-scard', 'copy-status')
    status.setAttribute('aria-live', 'polite')
    copy.insertAdjacentElement('afterend', status)
  }
  status.textContent = copied ? '已复制' : '复制失败，请手动选择文本'
})
expand.addEventListener('click', () => {
  const open = card.getAttribute('data-open') === '1'
  card.setAttribute('data-open', open ? '0' : '1')
  expand.setAttribute('aria-expanded', open ? 'false' : 'true')
  expand.setAttribute('title', open ? '展开全文' : '收起回答')
  expandText.textContent = open ? '展开全文' : '收起'
  content.style.maxHeight = open ? '120px' : 'none'
  content.style.overflow = open ? 'hidden' : 'visible'
})
</script>
</body></html>`

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 390, height: 860 } })
const failures = []
const pass = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const near = (value, want, tolerance = 0.6) => Number.isFinite(value) && Math.abs(value - want) <= tolerance

try {
  await page.setContent(pageHtml, { waitUntil: 'load' })
  await page.waitForTimeout(300)

  const info = await page.evaluate(() => {
    const card = document.querySelector('[data-dsh-scard="card"]')
    const title = card.querySelector('[data-dsh-scard="title"]')
    const para = card.querySelector('[data-dsh-scard="para"]')
    const strong = card.querySelector('strong[data-probe="strong"]')
    const model = card.querySelector('[data-dsh-scard="model-code"]')
    const mark = card.querySelector('[data-dsh-scard="mark"]')
    const read = card.querySelector('[data-dsh-speak="button"]')
    const copy = card.querySelector('[data-dsh-scard="copy"]')
    const copyIcon = copy.querySelector('svg')
    const sep = card.querySelector('[data-dsh-scard="separator"]')
    const expand = card.querySelector('[data-dsh-scard="expand"]')
    const arrow = card.querySelector('[data-dsh-scard="expand-arrow"]')
    const foot = card.querySelector('[data-dsh-scard="foot"]')
    const time = card.querySelector('[data-dsh-scard="time"]')
    const actions = card.querySelector('[data-dsh-scard="actions"]')
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right } }
    const declaredBorder = (selector) => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === selector) return rule.style.getPropertyValue('border-top-width') || rule.style.getPropertyValue('border') || ''
          }
        } catch { /* ignore */ }
      }
      return ''
    }
    const cardRect = rect(card)
    const parentRect = rect(card.parentElement)
    return {
      card: {
        maxWidth: getComputedStyle(card).maxWidth,
        radius: getComputedStyle(card).borderTopLeftRadius,
        declaredBorder: declaredBorder('[data-dsh-scard="card"]'),
        borderWidth: getComputedStyle(card).borderTopWidth,
        borderColor: getComputedStyle(card).borderTopColor,
        shadow: getComputedStyle(card).boxShadow,
        overflow: getComputedStyle(card).overflow,
        bg: getComputedStyle(card).backgroundColor,
        bgImage: getComputedStyle(card).backgroundImage,
        centerDelta: Math.abs((cardRect.right - cardRect.w / 2) - (parentRect.right - parentRect.w / 2)),
      },
      mark: { ...rect(mark), radius: getComputedStyle(mark).borderRadius, color: getComputedStyle(mark).color, bg: getComputedStyle(mark).backgroundColor },
      read: { ...rect(read), radius: getComputedStyle(read).borderRadius, border: declaredBorder('[data-dsh-speak="button"]'), gap: cardRect.right - rect(read).right, title: read.getAttribute('title'), aria: read.getAttribute('aria-pressed') },
      title: { size: getComputedStyle(title).fontSize, weight: getComputedStyle(title).fontWeight, color: getComputedStyle(title).color },
      para: { size: getComputedStyle(para).fontSize, weight: getComputedStyle(para).fontWeight, line: getComputedStyle(para).lineHeight, color: getComputedStyle(para).color },
      strong: { weight: getComputedStyle(strong).fontWeight, color: getComputedStyle(strong).color },
      model: { size: getComputedStyle(model).fontSize, color: getComputedStyle(model).color, bg: getComputedStyle(model).backgroundColor, radius: getComputedStyle(model).borderRadius, family: getComputedStyle(model).fontFamily, padding: getComputedStyle(model).padding },
      foot: { bg: getComputedStyle(foot).backgroundColor, border: declaredBorder('[data-dsh-scard="foot"]'), borderWidth: getComputedStyle(foot).borderTopWidth, order: [...actions.children].map((el) => el.getAttribute('data-dsh-scard') ?? '').filter(Boolean) },
      time: { display: getComputedStyle(time).display, size: getComputedStyle(time).fontSize, color: getComputedStyle(time).color },
      copy: { ...rect(copy), icon: rect(copyIcon), label: copy.getAttribute('aria-label'), title: copy.getAttribute('title') },
      sep: { ...rect(sep), color: getComputedStyle(sep).backgroundColor, margin: getComputedStyle(sep).margin },
      expand: { h: rect(expand).h, padding: getComputedStyle(expand).padding, size: getComputedStyle(expand).fontSize, color: getComputedStyle(expand).color, arrow: rect(arrow), aria: expand.getAttribute('aria-expanded'), title: expand.getAttribute('title'), text: expand.textContent.trim() },
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyFlag: document.body.getAttribute('data-dsh-secretary'),
    }
  })

  pass('卡片最大宽度 620px 且水平居中', info.card.maxWidth === '620px' && info.card.centerDelta <= 2, JSON.stringify({ maxWidth: info.card.maxWidth, centerDelta: info.card.centerDelta }))
  pass('16px 圆角、0.5px 浅灰边框、无阴影、白底无渐变', info.card.radius === '16px' && /0\.5px/.test(info.card.declaredBorder) && info.card.borderWidth !== '0px' && info.card.borderColor === 'rgb(229, 230, 235)' && info.card.shadow === 'none' && info.card.bg === 'rgb(255, 255, 255)' && info.card.bgImage === 'none', JSON.stringify(info.card))
  pass('卡片 overflow:hidden', info.card.overflow === 'hidden', info.card.overflow)
  pass('32px 紫色助手标识与名称/标签', near(info.mark.w, 32) && near(info.mark.h, 32) && info.mark.radius === '10px' && info.mark.color === 'rgb(83, 74, 183)' && info.mark.bg === 'rgb(238, 237, 254)', JSON.stringify(info.mark))
  pass('右上角唯一 34px 朗读按钮，带 title', near(info.read.w, 34) && near(info.read.h, 34) && /0\.5px/.test(info.read.border) && info.read.title === '朗读回答' && info.read.aria === 'false', JSON.stringify(info.read))
  pass('标题 15px / 500 / 主文字色', info.title.size === '15px' && info.title.weight === '500' && info.title.color === 'rgb(31, 35, 41)', JSON.stringify(info.title))
  pass('正文 13px / 400 / 1.8 / #4E5969', info.para.size === '13px' && info.para.weight === '400' && info.para.line === '23.4px' && info.para.color === 'rgb(78, 89, 105)', JSON.stringify(info.para))
  pass('重点句 500 / #1F2329', info.strong.weight === '500' && info.strong.color === 'rgb(31, 35, 41)', JSON.stringify(info.strong))
  pass('模型标签 12px 等宽、浅紫底深紫字、5px 圆角', info.model.size === '12px' && info.model.color === 'rgb(60, 52, 137)' && info.model.bg === 'rgb(238, 237, 254)' && info.model.radius === '5px' && /monospace/i.test(info.model.family) && info.model.padding === '2px 5px', JSON.stringify(info.model))
  pass('底部浅灰操作栏，复制→分隔线→展开全文', info.foot.bg === 'rgb(250, 250, 251)' && /0\.5px/.test(info.foot.border) && JSON.stringify(info.foot.order) === JSON.stringify(['copy', 'separator', 'expand']), JSON.stringify(info.foot))
  pass('复制按钮 30px、图标 16px，带 title', near(info.copy.w, 30) && near(info.copy.h, 30) && near(info.copy.icon.w, 16) && near(info.copy.icon.h, 16) && info.copy.title === '复制完整回答', JSON.stringify(info.copy))
  pass('分隔线 0.5px × 14px #D5D8DD，左右 5px', info.sep.w >= 0.49 && info.sep.w <= 1.05 && near(info.sep.h, 14) && info.sep.color === 'rgb(213, 216, 221)' && info.sep.margin === '0px 5px', JSON.stringify(info.sep))
  pass('展开按钮 30px 高、12px 紫色，箭头 14px', near(info.expand.h, 30) && info.expand.padding === '0px 7px' && info.expand.size === '12px' && info.expand.color === 'rgb(83, 74, 183)' && near(info.expand.arrow.w, 14) && near(info.expand.arrow.h, 14), JSON.stringify(info.expand))
  pass('移动端隐藏时间且不横向溢出', info.time.display === 'none' && info.overflowX <= 0, JSON.stringify({ time: info.time.display, overflowX: info.overflowX }))
  pass('页面级秘书标记存在', info.bodyFlag === '1', info.bodyFlag)

  const focus = await page.evaluate(() => {
    const card = document.querySelector('[data-dsh-scard="card"]')
    const buttons = [...card.querySelectorAll('button')]
    const out = []
    for (const el of buttons) {
      el.focus()
      const cs = getComputedStyle(el)
      out.push({ label: el.getAttribute('aria-label') ?? el.getAttribute('data-dsh-scard'), width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset })
    }
    return out
  })
  pass('朗读→复制→展开均可用键盘聚焦，焦点环 2px #AFA9EC', focus.length === 3 && focus.every((item) => item.width === '2px' && item.color === 'rgb(175, 169, 236)' && item.offset === '2px'), JSON.stringify(focus))

  await page.locator('[data-dsh-scard="expand"]').click()
  await page.waitForTimeout(250)
  const expanded = await page.evaluate(() => {
    const card = document.querySelector('[data-dsh-scard="card"]')
    return {
      open: card.getAttribute('data-open'),
      aria: card.querySelector('[data-dsh-scard="expand"]').getAttribute('aria-expanded'),
      text: card.querySelector('[data-dsh-scard="expand-text"]').textContent,
      maxHeight: getComputedStyle(card.querySelector('[data-dsh-scard="content"]')).maxHeight,
      transform: getComputedStyle(card.querySelector('[data-dsh-scard="expand-arrow"]')).transform,
    }
  })
  pass('展开后文案「收起」、aria-expanded=true、箭头旋转、正文完整', expanded.open === '1' && expanded.aria === 'true' && expanded.text === '收起' && expanded.maxHeight === 'none' && expanded.transform.includes('-1'), JSON.stringify(expanded))
  await page.locator('[data-dsh-scard="expand"]').click()
  await page.waitForTimeout(250)
  const collapsed = await page.evaluate(() => ({
    open: document.querySelector('[data-dsh-scard="card"]').getAttribute('data-open'),
    aria: document.querySelector('[data-dsh-scard="expand"]').getAttribute('aria-expanded'),
    text: document.querySelector('[data-dsh-scard="expand-text"]').textContent,
  }))
  pass('再点恢复「展开全文」与 aria-expanded=false', collapsed.open === '0' && collapsed.aria === 'false' && collapsed.text === '展开全文', JSON.stringify(collapsed))

  await page.locator('[data-dsh-scard="copy"]').click()
  const copyOk = await page.evaluate(() => {
    const el = document.querySelector('[data-dsh-scard="copy-status"]')
    return { text: el?.textContent ?? '', visible: el ? getComputedStyle(el).display !== 'none' : false }
  })
  pass('复制成功显示可见「已复制」', copyOk.text === '已复制' && copyOk.visible === true, JSON.stringify(copyOk))
  await page.locator('[data-dsh-scard="copy"]').click()
  const copyFail = await page.evaluate(() => {
    const el = document.querySelector('[data-dsh-scard="copy-status"]')
    return { text: el?.textContent ?? '', visible: el ? getComputedStyle(el).display !== 'none' : false }
  })
  pass('复制失败显示可见提示', /复制失败|手动选择/.test(copyFail.text) && copyFail.visible === true, JSON.stringify(copyFail))

  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(250)
  const desktop = await page.evaluate(() => {
    const card = document.querySelector('[data-dsh-scard="card"]')
    return { width: card.getBoundingClientRect().width, time: getComputedStyle(card.querySelector('[data-dsh-scard="time"]')).display }
  })
  pass('桌面卡片宽度不超过 620px 且时间可见', desktop.width <= 620 && desktop.time !== 'none', JSON.stringify(desktop))
  await page.evaluate(() => {
    const content = document.querySelector('[data-dsh-scard="content"]')
    const title = content.querySelector('[data-dsh-scard="title"]')
    const visible = [...content.querySelectorAll('[data-dsh-scard="para"]')].slice(0, 3)
    content.style.maxHeight = `${title.offsetHeight + visible.reduce((sum, item) => sum + item.offsetHeight, 0) + visible.length * 10}px`
    document.querySelector('[data-dsh-scard="copy-status"]')?.remove()
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: SCREENSHOT_DESKTOP, fullPage: false })

  await page.setViewportSize({ width: 390, height: 860 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const content = document.querySelector('[data-dsh-scard="content"]')
    const title = content.querySelector('[data-dsh-scard="title"]')
    const visible = [...content.querySelectorAll('[data-dsh-scard="para"]')].slice(0, 3)
    content.style.maxHeight = `${title.offsetHeight + visible.reduce((sum, item) => sum + item.offsetHeight, 0) + visible.length * 10}px`
    document.querySelector('[data-dsh-scard="copy-status"]')?.remove()
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: SCREENSHOT_MOBILE, fullPage: true })
  console.log(SCREENSHOT_DESKTOP)
  console.log(SCREENSHOT_MOBILE)
} finally {
  await browser.close().catch(() => {})
}

if (failures.length > 0) {
  console.error(`CARD VISUAL FAIL ${failures.length}`)
  process.exit(1)
}
console.log('CARD VISUAL PASS')
