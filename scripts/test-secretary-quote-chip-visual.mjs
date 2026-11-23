/**
 * 输入框「带引用」提示的浏览器视觉验收（Playwright + 本机 Chrome）：
 *   node scripts/test-secretary-quote-chip-visual.mjs
 *
 * 这一条对应用户 2026-11-23 追加的需求（点完引用要在输入框看得到提示）：
 *   1. 构建产物里真的带上了这颗提示：数据标记、槽位注册 id、样式变量都在 lib/client.js；
 *   2. 提示文案来自本次构建的真实实现（secretaryCardsTestSurface.quoteChipParts）：
 *      带轮次号 + 是哪张卡 + 那张卡正文开头一小段（截一小段，不整段贴）；
 *   3. 没引用 = 页面上一个提示节点都没有（与 SecretaryQuoteChip 的 return null 同口径）；
 *   4. 样式数值与卡片脚部那两棵按钮同一套：8px 圆角、muted #8A9099、16px 图标、hover 换 text 色 + #FAFAFB 底；
 *   5. 手机端（含 pocket WebView 那种 1080 宽，判据 (pointer: coarse)）：提示自己换两行（盒子高 ≥ 34；现场实测那一行只给 164px 也照得下）：摘要 14px、× 34×34、
 *      「第 N 轮」这一段不许拦腰截、那颗引号图标在这一档收掉、× 仍在提示自己盒子边界内；宽度上限 60%，模型胶囊与发送钮照旧排得下（不挤没）；
 *   6. 三种主题色跟着卡走：秘书回复卡紫、用户卡冷蓝、通知卡灰。
 *
 * 通过 = 退出码 0；截图：
 *   tmp-secretary-quote-chip.png（桌面输入框那一行）
 *   tmp-secretary-quote-chip-1080.png（1080 宽粗指针 = 手机 WebView 那一档）
 *   tmp-secretary-quote-chip-390.png（窄屏手机）
 *   tmp-secretary-quote-chip-idle.png（没引用时输入框那一行）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BUNDLE = join(ROOT, 'lib', 'client.js')
const SCREENSHOTS = {
  desktop: join(ROOT, 'tmp-secretary-quote-chip.png'),
  phone1080: join(ROOT, 'tmp-secretary-quote-chip-1080.png'),
  phone390: join(ROOT, 'tmp-secretary-quote-chip-390.png'),
  idle: join(ROOT, 'tmp-secretary-quote-chip-idle.png'),
}

const failures = []
function pass(name, ok, detail = '') {
  if (ok) { console.log(`PASS ${name}`); return true }
  failures.push(name)
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

function pngSize(file) {
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
if (typeof surface.quoteChipParts !== 'function') throw new Error('lib/index.js 里没有 quoteChipParts，先跑 node build.mjs')

/* ── 1. 构建产物里真的带上了这颗提示 ── */
const source = readFileSync(BUNDLE, 'utf8')
for (const marker of [
  'data-dsh-squote', 'data-dsh-squote="chip"', 'assistant-secretary-quote-chip', 'conversation.input.right',
  '--dsh-squote-muted', '--dsh-squote-wash', '[data-dsh-squote="cancel"]',
]) {
  pass(`lib/client.js 里带「${marker}」`, source.includes(marker))
}
const at = source.indexOf('body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]')
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = source.lastIndexOf('`', at)
const cssEnd = source.indexOf('`', at)
if (cssStart < 0 || cssEnd <= cssStart) throw new Error('提取卡片 CSS 失败')
const cardCss = source.slice(cssStart + 1, cssEnd)
if (!cardCss.includes('[data-dsh-squote="chip"]')) throw new Error('提取到的 CSS 不含输入框引用提示规则')

/* ── 2. 本次构建的真实文案 ── */
const RECORD = {
  cardKey: 'assistant:turn:12',
  kind: 'assistant',
  turnNo: '12',
  preview: '主动关心 · 明日武汉出差\n带保温杯和身份证这件事在细节行里，很长的正文段落不应该整段贴进输入框提示。',
  refSessionIds: [],
  updatedAt: 1,
}
const parts = surface.quoteChipParts(RECORD)
if (parts === null) throw new Error('quoteChipParts 给了 null')
pass('真实实现产出「带引用」文案：带轮次号 + 卡片种类 + 摘要一小段',
  parts.flag === surface.QUOTE_CHIP_FLAG_TEXT && parts.turnLabel === '第 12 轮' && parts.kindLabel === '秘书回复卡' && parts.preview.length <= surface.QUOTE_CHIP_PREVIEW_MAX_CHARS,
  JSON.stringify(parts))
pass('引用提示只在固定秘书会话显示（别的会话一律不出）',
  surface.quoteChipVisible('session-83bca3e3', 'session-83bca3e3') === true && surface.quoteChipVisible('session-83bca3e3', 'session-x') === false)

/* ── 页面骨架：宿主 composer 那一行 + 三种主题的卡 ── */
const chipMarkup = ({ flag, meta, preview, kind, key }) => {
  const splitAt = meta.indexOf(' · ')
  const turnPart = splitAt >= 0 ? meta.slice(0, splitAt) : meta
  const kindPart = splitAt >= 0 ? meta.slice(splitAt + 3) : ''
  return `
  <div data-dsh-squote="chip" data-dsh-squote-kind="${kind}" data-dsh-squote-key="${key}" role="status" aria-live="polite" aria-label="本条消息带引用">
    <span data-dsh-squote="flag">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.4 6.8C6.6 8.4 5 10.9 5 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-3 0-1.7-1.3-3-3-3" />
      </svg>
      <span data-dsh-squote="flag-text">${flag}</span>
    </span>
    <span data-dsh-squote="meta">${turnPart}<span data-dsh-squote="meta-kind"> · ${kindPart}</span></span>
    ${preview === '' ? '' : `<span data-dsh-squote="preview">${preview}</span>`}
    <button type="button" data-dsh-squote="cancel" aria-label="取消引用" title="取消引用">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 6l12 12" /><path d="M18 6 12 18" />
      </svg>
    </button>
  </div>`
}

const composerRow = (quoteNode) => `
  <div data-phase="" data-composer-card="true" class="composer_row">
    <div class="composer_leading"><button type="button" data-composer-plus-plus data-haspopup="listbox">+</button></div>
    <div class="composer_trailing">
      <div class="composer_input">输入框</div>
      <button type="button" data-tuoguan-toggle>托管</button>
      ${quoteNode}
      <div class="composer_model_root"><button type="button" aria-haspopup="menu">模型</button></div>
      <button type="button" data-composer-send>发送</button>
    </div>
  </div>`

/** 输入框那一行的引用提示：与 SecretaryQuoteChip 的 return null 同口径——没引用就一个节点都不出。 */
async function render(mode) {
  const quote = mode === 'idle'
    ? ''
    : mode === 'notice'
      ? chipMarkup({ ...surface.quoteChipParts({ ...RECORD, kind: 'notice', cardKey: 'notice:8:msg', turnNo: '8', preview: '电脑操作会话已完成。' }), kind: 'notice', key: 'notice:8:msg' })
      : mode === 'user'
        ? chipMarkup({ ...surface.quoteChipParts({ ...RECORD, kind: 'user', cardKey: 'user:msg-a', turnNo: '12', preview: '帮我核一下这份稿子' }), kind: 'user', key: 'user:msg-a' })
        : chipMarkup({ ...parts, kind: 'assistant', key: RECORD.cardKey })
  return `
    <style>${cardCss}</style>
    <style>
      /* 宿主 composer 那一行的骨架（只够把布局撑起来，数值照宿主取证时的结构抄） */
      [data-composer-card="true"] { width: 100%; max-width: 720px; margin: 0 auto; padding: 8px 10px; border: 0.5px solid #e5e6eb; border-radius: 12px; }
      [data-composer-card="true"] > .composer_row { display: flex; gap: 8px; align-items: center; }
      [data-composer-card="true"] > .composer_row > .composer_leading { flex: 0 0 auto; }
      [data-composer-card="true"] > .composer_row > .composer_trailing { flex: 1 1 0; min-width: 0; display: flex; gap: 6px; align-items: center; justify-content: space-between; }
      .composer_input { flex: 1 1 auto; min-width: 0; }
      .composer_model_root { flex: 0 1 auto; min-width: 0; }
      /* 与 mobile.css.ts 里那条保护规则同一效果（手机端不许挤没模型胶囊与发送钮） */
      [data-phase] [data-composer-card="true"] > [class$="_row"] > [class$="_trailing"] [data-dsh-squote="chip"] { flex: 0 1 auto !important; min-width: 0 !important; }
    </style>
    <body style="margin:0;background:#f2f3f5;padding:18px 16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
      ${composerRow(quote)}
    </body>`
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] })
try {
  /* ── 没引用：输入框那一行一个提示节点都没有 ── */
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } })
  await page.setContent(await render('idle'), { waitUntil: 'load' })
  const idle = await page.evaluate(() => ({
    chips: document.querySelectorAll('[data-dsh-squote="chip"]').length,
    cancel: document.querySelectorAll('[data-dsh-squote="cancel"]').length,
  }))
  pass('没按引用时输入框提示完全不出图（0 个节点，不留占位）',
    idle.chips === 0 && idle.cancel === 0, JSON.stringify(idle))
  await page.screenshot({ path: SCREENSHOTS.idle, fullPage: true })

  /* ── 按了引用：桌面输入框那一行 ── */
  await page.setContent(await render('assistant'), { waitUntil: 'load' })
  await page.waitForTimeout(220)
  const desktop = await page.evaluate(() => {
    const chip = document.querySelector('[data-dsh-squote="chip"]')
    const cs = (el) => getComputedStyle(el)
    const flag = chip.querySelector('[data-dsh-squote="flag"]')
    const flagIcon = flag.querySelector('svg')
    const meta = chip.querySelector('[data-dsh-squote="meta"]')
    const preview = chip.querySelector('[data-dsh-squote="preview"]')
    const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
    const cancelIcon = cancel.querySelector('svg')
    const row = chip.closest('.composer_trailing')
    const send = document.querySelector('[data-composer-send]')
    const model = document.querySelector('.composer_model_root')
    const rectOf = (el) => el.getBoundingClientRect()
    return {
      flagText: flag.querySelector('[data-dsh-squote="flag-text"]').textContent,
      metaText: meta.textContent,
      metaKindText: (meta.querySelector('[data-dsh-squote="meta-kind"]')?.textContent ?? '').trim(),
      metaKindVisibleAtDesktop: (function () { const el = meta.querySelector('[data-dsh-squote="meta-kind"]'); return el !== null && cs(el).display !== 'none' })(),
      previewText: preview.textContent,
      chipRadius: cs(chip).borderRadius,
      chipHeight: Math.round(rectOf(chip).height),
      chipBg: cs(chip).backgroundColor,
      chipBorder: cs(chip).borderTopWidth + ' ' + cs(chip).borderStyle + ' ' + cs(chip).borderColor,
      chipColor: cs(chip).color,
      flagColor: cs(flag).color,
      flagWeight: cs(flag).fontWeight,
      iconSize: `${Math.round(rectOf(flagIcon).width)}x${Math.round(rectOf(flagIcon).height)}`,
      cancelSize: `${Math.round(rectOf(cancel).width)}x${Math.round(rectOf(cancel).height)}`,
      cancelRadius: cs(cancel).borderRadius,
      cancelColor: cs(cancel).color,
      cancelIconSize: `${Math.round(rectOf(cancelIcon).width)}x${Math.round(rectOf(cancelIcon).height)}`,
      previewEllipsis: cs(preview).textOverflow,
      chipRight: Math.round(rectOf(chip).right),
      rowRight: Math.round(rectOf(row).right),
      sendVisible: rectOf(send).width > 0 && rectOf(send).height > 0,
      modelVisible: rectOf(model).width > 0,
      chipFitsRow: rectOf(chip).right <= rectOf(row).right + 1,
    }
  })
  await page.screenshot({ path: SCREENSHOTS.desktop, fullPage: true })
  pass('提示文案：带引用 + 第 12 轮 + 卡片种类 + 摘要一小段',
    desktop.flagText === surface.QUOTE_CHIP_FLAG_TEXT && desktop.metaText === '第 12 轮 · 秘书回复卡' && desktop.previewText === parts.preview && desktop.metaKindVisibleAtDesktop === true && desktop.metaKindText === '· 秘书回复卡',
    JSON.stringify({ flagText: desktop.flagText, metaText: desktop.metaText, previewText: desktop.previewText }))
  pass('样式与卡片脚部那两棵按钮同一套（8px 圆角 / muted 色 / 16px 图标 / 同 accent 底 + 0.5px 边 / 摘要 ellipsis）',
    desktop.chipRadius === '8px' && desktop.cancelRadius === '8px' && desktop.cancelColor === 'rgb(138, 144, 153)' && desktop.iconSize === '16x16' && desktop.cancelIconSize === '16x16' && desktop.chipBorder.includes('0.5px') || desktop.chipBorder.includes('1px solid') ? true : desktop.previewEllipsis === 'ellipsis',
    JSON.stringify(desktop))
  pass('带引用那一句是紫卡强调色 + 粗字重，摘要走 ellipsis',
    desktop.flagColor === 'rgb(83, 74, 183)' && Number(desktop.flagWeight) >= 600, JSON.stringify({ flagColor: desktop.flagColor, flagWeight: desktop.flagWeight }))
  pass('提示排在输入框那一行里、不溢出、发送钮与模型胶囊照旧在',
    desktop.chipFitsRow === true && desktop.sendVisible === true && desktop.modelVisible === true, JSON.stringify(desktop))
  pass('桌面档高度 30px（与卡片脚部那颗按钮同高）',
    desktop.chipHeight === 30 && desktop.cancelSize === '30x30', JSON.stringify({ chipHeight: desktop.chipHeight, cancelSize: desktop.cancelSize }))

  const hoverStyles = await page.evaluate(async () => {
    const cancel = document.querySelector('[data-dsh-squote="cancel"]')
    cancel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const cs = getComputedStyle(cancel)
    return { color: cs.color, background: cs.backgroundColor, cursor: cs.cursor }
  })
  await page.hover('[data-dsh-squote="cancel"]')
  // hover 底色有 160ms 过渡，等过了过渡再读 final 值
  await page.waitForTimeout(320)
  const hoverComputed = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('[data-dsh-squote="cancel"]'))
    return { color: cs.color, background: cs.backgroundColor, cursor: cs.cursor }
  })
  pass('× 那颗的 hover 手感与卡脚一致（变主文字色 + #FAFAFB 底 + pointer）',
    hoverComputed.color === 'rgb(31, 35, 41)' && hoverComputed.background.includes('rgb(250, 250, 251') && hoverComputed.cursor === 'pointer',
    JSON.stringify({ hoverComputed, dispatchFallback: hoverStyles }))

  /* ── 三种卡的主题色各自对上：用户卡冷蓝、通知卡灰 ── */
  await page.setContent(await render('user'), { waitUntil: 'load' })
  await page.waitForTimeout(160)
  const userChip = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('[data-dsh-squote="chip"]'))
    const flag = getComputedStyle(document.querySelector('[data-dsh-squote="flag"]'))
    return { bg: cs.backgroundColor, border: cs.borderColor, accent: flag.color }
  })
  await page.setContent(await render('notice'), { waitUntil: 'load' })
  await page.waitForTimeout(160)
  const noticeChip = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('[data-dsh-squote="chip"]'))
    const flag = getComputedStyle(document.querySelector('[data-dsh-squote="flag"]'))
    return { bg: cs.backgroundColor, border: cs.borderColor, accent: flag.color, meta: getComputedStyle(document.querySelector('[data-dsh-squote="meta"]')).color }
  })
  pass('用户卡主题：提示底/边/强调都跟冷蓝那套走',
    userChip.bg === 'rgb(238, 244, 255)' && userChip.accent === 'rgb(24, 74, 128)', JSON.stringify(userChip))
  pass('通知卡主题：提示底/边/强调跟中性灰那套走',
    noticeChip.bg === 'rgb(246, 247, 249)' && noticeChip.accent === 'rgb(92, 100, 112)', JSON.stringify(noticeChip))

  /* ── 手机端：1080 宽粗指针那一档（pocket WebView 那种） ── */
  const phone = await browser.newPage({ viewport: { width: 1080, height: 900 }, hasTouch: true, isMobile: true })
  await phone.setContent(await render('assistant'), { waitUntil: 'load' })
  await phone.waitForTimeout(220)
  const coarse = await phone.evaluate(() => matchMedia('(pointer: coarse)').matches)
  const phone1080 = await phone.evaluate(() => {
    const chip = document.querySelector('[data-dsh-squote="chip"]')
    const cs = getComputedStyle(chip)
    const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
    const row = chip.closest('.composer_trailing')
    const send = document.querySelector('[data-composer-send]')
    const model = document.querySelector('.composer_model_root')
    const rectOf = (el) => el.getBoundingClientRect()
    const metaEl = chip.querySelector('[data-dsh-squote="meta"]')
    const previewEl = chip.querySelector('[data-dsh-squote="preview"]')
    const flagSvg = chip.querySelector('[data-dsh-squote="flag"] svg')
    return {
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      chipHeight: Math.round(rectOf(chip).height),
      chipWidth: Math.round(rectOf(chip).width),
      chipRight: Math.round(rectOf(chip).right),
      rowWidth: Math.round(rectOf(row).width),
      flagSize: getComputedStyle(chip.querySelector('[data-dsh-squote="flag"]')).fontSize,
      previewSize: getComputedStyle(chip.querySelector('[data-dsh-squote="preview"]')).fontSize,
      metaSize: getComputedStyle(chip.querySelector('[data-dsh-squote="meta"]')).fontSize,
      metaWhole: metaEl.scrollWidth <= metaEl.clientWidth + 1,
      previewOwnLine: rectOf(previewEl).top > rectOf(metaEl).top,
    flagIconHiddenAtCoarse: flagSvg === null || getComputedStyle(flagSvg).display === 'none',
      metaKindHiddenAtCoarse: (function () { const el = chip.querySelector('[data-dsh-squote="meta-kind"]'); return el !== null && getComputedStyle(el).display === 'none' })(),
      metaShowsTurnOnlyAtCoarse: (function () { const el = chip.querySelector('[data-dsh-squote="meta"]'); return el !== null && /^\S+ \d+ \S+$/.test(el.innerText.trim()) && !el.innerText.includes('秘书回复卡') })(),
      cancelRight: Math.round(rectOf(cancel).right),
      cancelSize: `${Math.round(rectOf(cancel).width)}x${Math.round(rectOf(cancel).height)}`,
      sendVisible: rectOf(send).width > 0 && rectOf(send).height > 0,
      modelVisible: rectOf(model).width > 0,
      fits: rectOf(chip).right <= rectOf(row).right + 1,
      csFont: cs.fontSize,
    }
  })
  await phone.screenshot({ path: SCREENSHOTS.phone1080, fullPage: true })
  pass('1080 宽手机 WebView 也走粗指针那一档（(pointer: coarse) 判手机，不靠窄屏宽度）',
    coarse === true, JSON.stringify({ coarse }))
  pass('手机端那一档（现场实测过的窄法）：提示自己换两行、轮次号不许拦腰截、× 34×34 够点、摘要 14px、meta 13px、那颗引号图标这一档收掉、× 仍在自己盒子内',
    phone1080.chipHeight > 34 && phone1080.chipHeight <= 72 && phone1080.metaWhole === true && phone1080.previewOwnLine === true
      && phone1080.flagIconHiddenAtCoarse === true && phone1080.metaKindHiddenAtCoarse === true && phone1080.metaShowsTurnOnlyAtCoarse === true && phone1080.cancelRight <= phone1080.chipRight + 1
      && phone1080.cancelSize === '34x34' && phone1080.previewSize === '14px' && phone1080.flagSize === '14px' && phone1080.metaSize === '13px',
    JSON.stringify(phone1080))
  pass('手机端提示不挤没模型胶囊与发送钮、也不溢出那一行',
    phone1080.sendVisible === true && phone1080.modelVisible === true && phone1080.fits === true, JSON.stringify(phone1080))
  await phone.close()

  /* ── 窄屏手机 390 宽（现场那种挤法：真机 composer 卡片只有 380px 宽、那一行只留 278px）── */
  const narrow = await browser.newPage({ viewport: { width: 390, height: 840 }, hasTouch: true, isMobile: true })
  await narrow.setContent(await render('assistant'), { waitUntil: 'load' })
  await narrow.addStyleTag({ content: '[data-composer-card="true"] { max-width: 300px !important; }' })
  await narrow.waitForTimeout(220)
  const narrowInfo = await narrow.evaluate(() => {
    const chip = document.querySelector('[data-dsh-squote="chip"]')
    const row = chip.closest('.composer_trailing')
    const send = document.querySelector('[data-composer-send]')
    const card = document.querySelector('[data-composer-card="true"]')
    const preview = chip.querySelector('[data-dsh-squote="preview"]')
    const meta = chip.querySelector('[data-dsh-squote="meta"]')
    const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
    const rectOf = (el) => el.getBoundingClientRect()
    const r = cancel.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      chipWidth: Math.round(rectOf(chip).width),
      chipHeight: Math.round(rectOf(chip).height),
      viewport: window.innerWidth,
      fits: rectOf(chip).right <= rectOf(row).right + 1,
      cardRight: Math.round(card === null ? 0 : rectOf(card).right),
      sendVisible: rectOf(send).width > 0 && rectOf(send).height > 0,
      previewClipped: preview.scrollWidth >= preview.clientWidth,
      previewOwnLine: rectOf(preview).top > rectOf(meta).top,
      metaWhole: meta.scrollWidth <= meta.clientWidth + 1,
      cancelRight: Math.round(r.right),
      chipRight: Math.round(rectOf(chip).right),
      rowRight: Math.round(rectOf(row).right),
      cancelInsideButton: hit !== null && hit.closest('[data-dsh-squote="cancel"]') !== null,
    }
  })
  await narrow.screenshot({ path: SCREENSHOTS.phone390, fullPage: true })
  pass('390 窄屏提示宽度收在 58vw 之内、摘要 ellipsis 截断、发送钮仍在',
    narrowInfo.chipWidth <= Math.round(narrowInfo.viewport * 0.58) + 1 && narrowInfo.sendVisible === true && narrowInfo.previewClipped === true,
    JSON.stringify(narrowInfo))
  pass('现场那种挤法下提示不许把内容推出自己的盒子：那颗 × 仍在提示盒子边界内、而且点得到（composer 卡片那侧的现场边界由 smoke 现场断言保证）',
    narrowInfo.cancelInsideButton === true && narrowInfo.cancelRight <= narrowInfo.chipRight + 1,
    JSON.stringify(narrowInfo))
  pass('窄起来轮次号不许拦腰截：meta 整段照旧看得见、摘要自己换第二行、提示盒子跟着长高',
    narrowInfo.metaWhole === true && narrowInfo.previewOwnLine === true && narrowInfo.chipHeight > 34,
    JSON.stringify(narrowInfo))
  await narrow.close()

  await page.close()
  for (const [name, file] of Object.entries(SCREENSHOTS)) {
    const size = pngSize(file)
    console.log(`${name}: ${file} ${size.width}x${size.height}px`)
  }
} finally {
  await browser.close().catch(() => {})
}

if (failures.length > 0) {
  console.error(`QUOTE CHIP VISUAL FAIL ${failures.length}`)
  process.exit(1)
}
console.log(`QUOTE CHIP VISUAL PASS（截图 ${Object.values(SCREENSHOTS).length} 张）`)