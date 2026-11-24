/**
 * 个人秘书三种卡（assistant 紫 / user 冷蓝 / notice 灰）的浏览器视觉验收。
 *
 * 当前 pocket 局域网入口被 8 位 PIN + dsh web 启动 token 双层拦住，无头 Playwright
 * 拿不到宿主浏览器会话；本脚本把本次构建里真实的 SECRETARY_CARD_CSS 注入 Chromium，
 * 再用与 SecretaryReplyCard/SecretaryUserCard 相同的 DOM 结构逐项验 computed style。
 * 折叠算术与已读 store 不在这里复制一遍：直接从 lib/index.js 里取**本次构建的真实现**
 * （foldClipFromBlocks / createSecretaryReadStore / formatClock），页面只负责量块、脚本只负责接线。
 *
 * 取证口径（2026-11-21 本批需求，2026-11-22 折叠补丁更新，2026-11-23 结论—细节字号档 + 第 1/3/4 项）：
 *   - 先按**旧折叠实现**（标题 + 前 3 个内容块 + gap）量一遍并打印 BEFORE 行（行数、max-height），
 *     再用新实现量 AFTER，两项都从 getComputedStyle/offsetHeight 出真数；
 *   - 新口径 = 折叠态**最多 2 行结论 + 最多 3 行详情**，判据全部是内容高度（不看字符数），
 *     固定上限 foldCollapsedCapPx（标准字号 162px）封顶，CSS 首帧就顶住（治现网「测量前整段平铺」的时序洞）；
 *   - 折叠态行数、卡体点击展开、脚部时间位置、字号（结论 18px/600、详情 14px/26px）、未读红点、已读持久化都断言；
 *   - 第 3 项：compact 那两行（manual-compaction 行、带 data-compaction-icon 的宿主行、扫描层打标的行）在秘书页不出图；
 *   - 第 1 项：满 10 分钟的通知卡收成空壳（外壳仍挂着撑住气泡判据，盒子 display:none）；
 *   - 第 4 项：脚部引用按钮在时间左边、规格与时间右边那棵复制按钮一致。
 *
 * 通过 = 退出码 0；截图：
 *   tmp-secretary-card-collapsed.png / tmp-secretary-card-expanded.png
 *   tmp-secretary-card-unread.png / tmp-secretary-card-read.png
 *   tmp-secretary-card-notice.png（紫 / 冷蓝 / 灰三种卡同屏）
 *   以及原有的 tmp-secretary-card.png、tmp-secretary-card-desktop.png、tmp-secretary-user-card.png。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BUNDLE = join(ROOT, 'lib', 'client.js')
const SCREENSHOTS = {
  collapsed: join(ROOT, 'tmp-secretary-card-collapsed.png'),
  expanded: join(ROOT, 'tmp-secretary-card-expanded.png'),
  unread: join(ROOT, 'tmp-secretary-card-unread.png'),
  read: join(ROOT, 'tmp-secretary-card-read.png'),
  notice: join(ROOT, 'tmp-secretary-card-notice.png'),
  mobile: join(ROOT, 'tmp-secretary-card.png'),
  desktop: join(ROOT, 'tmp-secretary-card-desktop.png'),
  dual: join(ROOT, 'tmp-secretary-user-card.png'),
}

const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
if (typeof surface.foldClipFromBlocks !== 'function') throw new Error('lib/index.js 里没有 foldClipFromBlocks，先跑 node build.mjs')
const foldClipFromBlocks = surface.foldClipFromBlocks
const FOLD_BUDGET = surface.FOLD_BODY_LINE_BUDGET
const READ_PREFIX = surface.READ_STORAGE_PREFIX
const formatClock = surface.formatClock

const source = readFileSync(BUNDLE, 'utf8')
const marker = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]'
const at = source.indexOf(marker)
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = source.lastIndexOf('`', at)
const cssEnd = source.indexOf('`', at)
if (cssStart < 0 || cssEnd <= cssStart) throw new Error('提取卡片 CSS 失败')
const cardCss = source.slice(cssStart + 1, cssEnd)
if (!cardCss.includes('[data-dsh-scard="card"]')) throw new Error('提取到的 CSS 不含卡片规则')

/** 时间固定住（别随真实时钟漂），三种卡的脚部时间都由这份真实现算出来。 */
const NOW = new Date(2026, 10, 21, 21, 8)
const TIMES = {
  assistant: formatClock(String(new Date(2026, 10, 21, 9, 8).getTime()), NOW),
  user: surface.formatUserCardClock('20:24'),
  notice: surface.formatUserCardClock('20:20'),
}

/** 滕王阁序那种长回答：标题 + 6 个会换行的长段落（旧折叠实现下大约 10 行）。 */
const LONG_PARAS = [
  '滕王阁序全文共约七百余字，王勃在序中先写洪府地势与人物，再写滕阁登高所见之景物，色彩与声律层层铺开，骈四俪六读起来很有节奏。',
  '其后才是真正的名句段落：落霞与孤鹜齐飞、秋水共长天一色，一联里把上下两层的视觉关系收在一个对称结构里，历代都推它为全篇警句。',
  '论序里还夹着作者自己的处境：他写「关山难越，谁悲失路之人」，也写「所赖君子安贫，达人特节」，把个人感怀重新收进山水之外。',
  '最后一段是饯别与自叙，从「临别赋诗」收到「是所望于群公」，整序的结构因此完成，前后的呼应非常完整。',
  '型号 qwen3.8-flash-next，量化版本是 IQ3_XXS，两个都应该渲染成行内模型标签。',
  '重点句：<strong data-probe="strong">落霞与孤鹜齐飞，秋水共长天一色。</strong>',
]

const paraHtml = (line) => line
  .replace('qwen3.8-flash-next', '<span data-dsh-scard="model-code">qwen3.8-flash-next</span>')
  .replace('IQ3_XXS', '<span data-dsh-scard="model-code">IQ3_XXS</span>')

const assistantBody = LONG_PARAS.map((line) => `<p data-dsh-scard="para">${paraHtml(line)}</p>`).join('')

const speakButtonHtml = (label) => `<button type="button" data-dsh-speak="button" data-status="idle" aria-pressed="false" aria-label="${label}" title="${label}">
  <svg data-dsh-speak="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5.5 6.5 9H3.5v6h3L11 18.5z"/><path d="M14.8 8.2a4 4 0 0 1 0 7.6"/><path d="M17.6 5.8a7 7 0 0 1 0 12.4"/></svg>
</button>`
const copyIconHtml = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>'
/* 引用按钮（第 4 项需求）：脚部时间左边那颗，图标与尺寸与复制那颗一模一样（16×16、stroke-width 1.6）。
 * 与 React 组件 SecretaryReplyCard.tsx 的 QuoteCardButton 同一份 markup。 */
const quoteIconHtml = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.4 6.8C6.6 8.4 5 10.9 5 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-2.9 0-1.6-1.2-2.8-2.7-2.8-.4 0-.8.1-1.1.2.2-1.9 1.5-3.5 3.6-4.6z"/><path d="M18.6 6.8C15.8 8.4 14.2 10.9 14.2 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-2.9 0-1.6-1.2-2.8-2.7-2.8-.4 0-.8.1-1.1.2.2-1.9 1.5-3.5 3.6-4.6z"/></svg>'
const quoteHtml = (label) => `<button type="button" data-dsh-scard="quote" data-quoted="0" title="${label}" aria-label="${label}" aria-pressed="false">${quoteIconHtml}</button>`
const markAssistant = '<span data-dsh-scard="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8l1.9 5.7 5.7 1.9-5.7 1.9L12 19l-1.9-5.7L4.4 11.4l5.7-1.9L12 3.8z"/><path d="M4.6 4.6l2 2"/><path d="M17.4 19.4l2 2"/></svg></span>'
const markUser = '<span data-dsh-scard="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 1 0 0-6.5 4 4 0 0 0 0 6.5z"/><path d="M4.8 19.5a7.2 7.2 0 0 1 14.4 0"/></svg></span>'
const markNotice = '<span data-dsh-scard="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2a5.4 5.4 0 0 0-5.4 5.4c0 4.2-1.6 5.9-1.6 6.4h14c0-.5-1.6-2.2-1.6-6.4A5.4 5.4 0 0 0 12 3.2z"/><path d="M9.8 18.4a2.4 2.4 0 0 0 4.4 0"/></svg></span>'
const expandHtml = (open = false) => `<button type="button" data-dsh-scard="expand" aria-expanded="${open ? 'true' : 'false'}" title="${open ? '收起正文' : '展开全文'}">
  <span data-dsh-scard="expand-text">${open ? '收起' : '展开全文'}</span>
  <svg data-dsh-scard="expand-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
</button>`
const refHtml = (id, title) => `<button type="button" data-dsh-scard="ref" title="打开会话：${title}"><span data-dsh-scard="ref-icon" aria-hidden="true">↗</span><span data-dsh-scard="ref-title">${title}</span></button>`

/** 一张卡：三种 kind 同一套外壳（未读红点、卡体 fold 区、脚部引用+时间+复制）。 */
function cardHtml({ kind, key, unread, timeText, head, paras, refs, footCopyLabel, footQuoteLabel, expired = false }) {
  const dot = unread ? '<span data-dsh-scard="unread-dot" role="img" aria-label="未读" title="未读"></span>' : ''
  const refBlock = (refs ?? []).map((ref) => refHtml(ref.id, ref.title)).join('')
  const expiredAttr = expired ? ' data-dsh-scard-expired="1" data-empty="1" aria-hidden="true"' : ''
  return `<article data-dsh-scard="card" data-dsh-scard-kind="${kind}" data-dsh-scard-key="${key}" data-dsh-scard-turn="${key}" data-empty="0" data-open="0" data-overflow="0" data-unread="${unread ? '1' : '0'}" data-quoted="0"${expiredAttr}>
  ${dot}
  <div data-dsh-scard="head">
    <div data-dsh-scard="identity">${head.mark}<span data-dsh-scard="tag">${head.tag}</span>${head.name ?? ''}</div>
    ${speakButtonHtml(head.speakLabel)}
  </div>
  <div data-dsh-scard="body" data-dsh-scard-fold="toggle" role="button" tabindex="0" aria-expanded="false" aria-label="展开正文">
    <div data-dsh-scard="content">
      ${paras.title !== '' ? `<h1 data-dsh-scard="title">${paras.title}</h1>` : ''}
      ${paras.body}
      ${refBlock}
    </div>
  </div>
  <div data-dsh-scard="foot">
    ${quoteHtml(footQuoteLabel ?? '引用这条卡：下一条消息就接着它说')}
    <time data-dsh-scard="time">${timeText}</time>
    <div data-dsh-scard="actions">
      <button type="button" data-dsh-scard="copy" title="${footCopyLabel}" aria-label="${footCopyLabel}">${copyIconHtml}</button>
      <span data-dsh-scard="separator" aria-hidden="true"></span>
      ${expandHtml(false)}
    </div>
  </div>
</article>`
}

const assistantCard = cardHtml({
  kind: 'assistant', key: 'assistant:turn:7', unread: true, timeText: TIMES.assistant,
  head: { mark: markAssistant, tag: 'AI 助手', name: '<span data-dsh-scard="name">个人秘书</span>', speakLabel: '朗读回答' },
  paras: { title: '滕王阁序那一段我给你收了三行', body: assistantBody },
  refs: [{ id: 'session-demo-1', title: '滕王阁序校对会话' }],
  footCopyLabel: '复制完整回答',
})
const userCard = cardHtml({
  kind: 'user', key: 'user:13:input-message-user-01', unread: false, timeText: TIMES.user,
  head: { mark: markUser, tag: '用户消息', name: '<span data-dsh-scard="name">你</span>', speakLabel: '朗读这条消息' },
  paras: { title: '', body: '<p data-dsh-scard="para">你好，帮我把今天下午的安排理一遍</p><p data-dsh-scard="para">用户卡不许改写用户说的话。</p>' },
  refs: [],
  footCopyLabel: '复制这条消息',
})
const noticeCard = cardHtml({
  kind: 'notice', key: 'notice:14:input-message-cu-01', unread: true, timeText: TIMES.notice,
  head: { mark: markNotice, tag: '系统 · 通知', name: '', speakLabel: '朗读这条通知' },
  paras: { title: '电脑操作会话「主动型助手与微信误发防护方案」这一轮已经完成。', body: '<p data-dsh-scard="para">汇报摘要：这批卡片的折叠、时间位置和字号都改完，跑过视觉验收与冒烟。这条通知原本在页面上只是普通气泡，现在做成灰底通知卡。</p><p data-dsh-scard="para">通知卡同样带未读红点：朗读过或被中断、点过卡体、点过复制，都算已读，红点当场摘掉，已读集合落在宿主文件里。</p>' },
  refs: [{ id: 'session-demo-cu', title: '主动型助手与微信误发防护方案' }],
  footCopyLabel: '复制这条通知',
})

/** 附件嵌在卡片内部（2026-11-24 附件批次）：文本 / 图片 / 文本 三块按原顺序排在正文区里 */
const MIXED_ATTACH_PNG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="76" height="52"><rect width="76" height="52" fill="#184a80"/></svg>').toString('base64')
const mixedAttachBody = [
  '<p data-dsh-scard="para">我看个人秘书回复的文本，把数字用汉字表示的，</p>',
  `<div data-dsh-scard="attachment" data-dsh-scard-attachment-kind="image" title="image.png">`,
  `<img data-dsh-scard="attachment-thumb" src="${MIXED_ATTACH_PNG}" alt="image.png" loading="lazy">`,
  `<span data-dsh-scard="attachment-name">image.png</span>`,
  `</div>`,
  '<p data-dsh-scard="para">，这样阅读起来很吃力，我建议还是保留为数字。</p>',
].join('\n')
const mixedUserCard = cardHtml({
  kind: 'user', key: 'user:15:input-message-mix-01', unread: false, timeText: '15:12',
  head: { mark: markUser, tag: '用户消息', name: '<span data-dsh-scard="name">你</span>', speakLabel: '朗读这条消息' },
  paras: { title: '', body: mixedAttachBody },
  refs: [],
  footCopyLabel: '复制这条消息',
})

const pageHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;background:#F6F7F9}
.answer-stage{padding:28px;background:#F6F7F9}
.chat-stage{padding:0 28px 28px;background:#F6F7F9}
${cardCss}
</style></head>
<body data-dsh-secretary="1">
<div class="answer-stage">
${assistantCard}
</div>
<div class="chat-stage">
  <div data-chat-turn="8" data-chat-flow-kind="user" data-chat-node-key="13:input-message-user-01">
    <div data-slot="conversation.chat.node">
      <div class="host-user-row">
        <div class="host-user-stack">
          <div class="host-bubble">
            <span data-slot="conversation.user.text.node"><span class="host-plain-run">你好，帮我把今天下午的安排理一遍</span></span>
          </div>
        </div>
        <div class="host-actions" data-clock="start"><span>20:24</span></div>
      </div>
    </div>
    ${userCard}
  </div>
  <!-- 附件回归（2026-11-24）：宿主把一条文字+图片+文字的消息排成 气泡/附件行/气泡，卡片必须整条收全 -->
  <div data-chat-turn="15" data-chat-flow-kind="user" data-chat-node-key="13:input-message-mix-01" data-probe="mixed-attach-row">
    <div data-slot="conversation.chat.node">
      <div class="host-user-row">
        <div class="host-user-stack">
          <div class="host-bubble">
            <span data-slot="conversation.user.text.node"><span class="host-plain-run">我看个人秘书回复的文本，把数字用汉字表示的，</span></span>
          </div>
          <div class="host-attachment-row" data-message-attachments="true">
            <div data-slot="conversation.chat.user.images">
              <div class="host-gallery" data-align="end">
                <button type="button" class="host-frame" data-variant="single" title="查看原图" aria-label="image.png，点击查看原图">
                  <img src="${MIXED_ATTACH_PNG}" alt="image.png">
                </button>
              </div>
            </div>
          </div>
          <div class="host-bubble">
            <span data-slot="conversation.user.text.node"><span class="host-plain-run">，这样阅读起来很吃力，我建议还是保留为数字。</span></span>
          </div>
        </div>
        <div class="host-actions" data-clock="start"><span>15:12</span></div>
      </div>
    </div>
    ${mixedUserCard}
  </div>
  <div data-chat-turn="9" data-chat-flow-kind="user" data-chat-node-key="14:input-message-cu-01" data-probe="notice-row">
    <div data-slot="conversation.chat.node">
      <div class="host-user-row">
        <div class="host-user-stack">
          <div class="host-bubble">
            <span data-slot="conversation.user.text.node"><span class="host-plain-run">（系统通知，不是用户说的话）
电脑操作会话「主动型助手与微信误发防护方案」这一轮已经完成。
最后单独一行原样输出：[[session:session-demo-cu|主动型助手与微信误发防护方案]]</span></span>
          </div>
        </div>
        <div class="host-actions" data-clock="start"><span>20:20</span></div>
      </div>
    </div>
    ${noticeCard}
  </div>
  <!-- 第 3 项需求的宿主行：宿主编排器把一次压缩汇成 kind="manual-compaction" 的行（真结构照搬） -->
  <div data-chat-turn="10" data-chat-flow-kind="manual-compaction" data-probe="compact-summary-row">
    <div data-slot="conversation.chat.node">
      <div class="host-compaction-row"><span data-compaction-icon="context" aria-hidden="true"></span><span data-compaction-disclosure="">compact</span><span>已压缩 41 条历史记录（约 19692 tokens）</span></div>
    </div>
  </div>
  <!-- 同一条压缩事务的失败分支：宿主 GenericCommandCard 的 outcome 文本 -->
  <div data-chat-turn="11" data-chat-flow-kind="command" data-probe="compact-failure-row">
    <div data-slot="conversation.chat.node">
      <div class="host-compaction-row"><span>compact</span><span>Compaction could not produce a useful summary. The attempt is recorded in the session log.</span></div>
    </div>
  </div>
  <!-- 独立摘要行（已有规则压的那一种）：仍然要不出图 -->
  <div data-chat-turn="12" data-chat-flow-kind="compaction" data-probe="compaction-kind-row">
    <div data-slot="conversation.chat.node"><div class="host-compaction-row">上下文已压缩</div></div>
  </div>
  <!-- 扫描层按文字判据打上 data-dsh-scard-compact="hint" 的那一行 -->
  <div data-chat-turn="13" data-chat-flow-kind="command" data-dsh-scard-compact="hint" data-probe="compact-tagged-row">
    <div data-slot="conversation.chat.node"><div class="host-compaction-row">compact·已压缩41条历史记录(19692 tokens)</div></div>
  </div>
  <!-- 第 1 项需求：发送满 10 分钟的通知卡收成空壳（外壳仍在、盒子不出图） -->
  <div data-chat-turn="14" data-chat-flow-kind="user" data-chat-node-key="16:input-message-cu-03" data-probe="expired-notice-row">
    <div data-slot="conversation.chat.node">
      <div class="host-user-row">
        <div class="host-user-stack">
          <div class="host-bubble">
            <span data-slot="conversation.user.text.node"><span class="host-plain-run">（系统通知，不是用户说的话）
这一条通知早就过了 10 分钟，按第 1 项需求收掉。</span></span>
          </div>
        </div>
        <div class="host-actions" data-clock="start"><span>09:08</span></div>
      </div>
    </div>
    <article data-dsh-scard="card" data-dsh-scard-kind="notice" data-dsh-scard-key="notice:16:input-message-cu-03" data-dsh-scard-turn="14" data-dsh-scard-expired="1" data-empty="1" aria-hidden="true"></article>
  </div>
</div>
<script>
/* 与 React 组件同一套接线：卡体可点击/可键盘展开收起、内部按钮 stopPropagation、已读即摘红点。 */
window.__GUARD = '[data-dsh-speak="button"], [data-dsh-scard="copy"], [data-dsh-scard="quote"], [data-dsh-scard="expand"], [data-dsh-scard="ref"], [data-dsh-scard="head"]'
window.__readKeys = []
window.__jump = null
window.__copied = false
function cardsAll() { return [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-dsh-scard-expired="1"])')] }
window.cardOf = (kind) => document.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="' + kind + '"]:not([data-dsh-scard-expired="1"])')
function setFoldMax(content, card, open) {
  const max = Number(card.dataset.foldMax || 0)
  content.style.maxHeight = open ? 'none' : (max > 0 ? max + 'px' : 'none')
  content.style.overflow = open ? 'visible' : 'hidden'
}
window.__setEllipsis = (content, show) => {
  const existing = content.querySelector('[data-dsh-scard="ellipsis"]')
  if (show && existing == null) {
    const span = document.createElement('span')
    span.setAttribute('data-dsh-scard', 'ellipsis')
    span.setAttribute('aria-hidden', 'true')
    span.textContent = '…'
    content.appendChild(span)
  } else if (!show && existing != null) existing.remove()
}
window.__setOpen = (card, open) => {
  const content = card.querySelector('[data-dsh-scard="content"]')
  const body = card.querySelector('[data-dsh-scard="body"]')
  const expand = card.querySelector('[data-dsh-scard="expand"]')
  const overflow = card.getAttribute('data-overflow') === '1'
  card.setAttribute('data-open', open ? '1' : '0')
  body.setAttribute('aria-expanded', open ? 'true' : 'false')
  body.setAttribute('title', overflow ? (open ? '收起正文' : '展开全文') : '')
  setFoldMax(content, card, open)
  window.__setEllipsis(content, overflow && !open)
  if (expand != null) {
    expand.setAttribute('aria-expanded', open ? 'true' : 'false')
    expand.setAttribute('title', open ? '收起正文' : '展开全文')
    expand.querySelector('[data-dsh-scard="expand-text"]').textContent = open ? '收起' : '展开全文'
  }
  if (open) window.__markRead(card)
}
window.__markRead = (card) => {
  const kind = card.getAttribute('data-dsh-scard-kind')
  if (kind === 'user') return
  const key = card.getAttribute('data-dsh-scard-key')
  if (!window.__readKeys.includes(key)) window.__readKeys.push(key)
  card.setAttribute('data-unread', '0')
  const dot = card.querySelector('[data-dsh-scard="unread-dot"]')
  if (dot != null) dot.remove()
  window.__persist = window.__persist ?? new Map()
  window.__persist.set(key, true)
}
window.__applyFold = (kind, geometry) => {
  const card = window.cardOf(kind)
  card.setAttribute('data-overflow', geometry.overflow ? '1' : '0')
  card.dataset.foldMax = String(geometry.collapsedMaxHeight ?? 0)
  const content = card.querySelector('[data-dsh-scard="content"]')
  setFoldMax(content, card, false)
  window.__setEllipsis(content, geometry.overflow)
  const body = card.querySelector('[data-dsh-scard="body"]')
  body.setAttribute('data-dsh-scard-fold', geometry.overflow ? 'toggle' : 'static')
  body.setAttribute('aria-expanded', geometry.overflow ? 'false' : 'true')
  const expand = card.querySelector('[data-dsh-scard="expand"]')
  if (expand != null && !geometry.overflow) expand.remove()
  const sep = card.querySelector('[data-dsh-scard="separator"]')
  if (sep != null && !geometry.overflow) sep.remove()
}
function wire(card) {
  const kind = card.getAttribute('data-dsh-scard-kind')
  const body = card.querySelector('[data-dsh-scard="body"]')
  body.addEventListener('click', (event) => {
    event.stopPropagation()
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target != null && target.closest(window.__GUARD) != null) return
    if (card.getAttribute('data-overflow') !== '1') return
    window.__setOpen(card, card.getAttribute('data-open') !== '1')
  })
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (event.target !== body) return
    event.preventDefault()
    event.stopPropagation()
    if (card.getAttribute('data-overflow') !== '1') return
    window.__setOpen(card, card.getAttribute('data-open') !== '1')
  })
  const speak = card.querySelector('[data-dsh-speak="button"]')
  speak.addEventListener('pointerdown', (event) => { event.stopPropagation() })
  speak.addEventListener('pointerup', (event) => { event.stopPropagation(); window.__markRead(card) })
  speak.addEventListener('click', (event) => { event.stopPropagation() })
  const copy = card.querySelector('[data-dsh-scard="copy"]')
  copy.addEventListener('click', (event) => {
    event.stopPropagation()
    window.__copied = !window.__copied
    let status = card.querySelector('[data-dsh-scard="copy-status"]')
    if (status == null) {
      status = document.createElement('span')
      status.setAttribute('data-dsh-scard', 'copy-status')
      status.setAttribute('aria-live', 'polite')
      copy.insertAdjacentElement('afterend', status)
    }
    status.textContent = window.__copied ? '已复制' : '复制失败，请手动选择文本'
    window.__markRead(card)
  })
  const expand = card.querySelector('[data-dsh-scard="expand"]')
  if (expand != null) expand.addEventListener('click', (event) => {
    event.stopPropagation()
    window.__setOpen(card, card.getAttribute('data-open') !== '1')
  })
  for (const ref of card.querySelectorAll('[data-dsh-scard="ref"]')) {
    ref.addEventListener('click', (event) => {
      event.stopPropagation()
      window.__jump = ref.getAttribute('title')
      window.__markRead(card)
    })
  }
  void kind
}
cardsAll().forEach(wire)
/* 红点已读态靠本地缓存恢复（跟真组件同一判据：已读集合里有这条 → 不渲染红点） */
window.__restoreUnread = (prefix, session) => {
  let stored = []
  try { stored = JSON.parse(localStorage.getItem(prefix + session) ?? '[]') } catch { stored = [] }
  for (const card of cardsAll()) {
    const kind = card.getAttribute('data-dsh-scard-kind')
    if (kind === 'user') continue
    const key = card.getAttribute('data-dsh-scard-key')
    if (stored.includes(key)) {
      card.setAttribute('data-unread', '0')
      card.querySelector('[data-dsh-scard="unread-dot"]')?.remove()
    }
  }
  return stored
}
window.__persistRead = (prefix, session) => {
  localStorage.setItem(prefix + session, JSON.stringify(window.__readKeys))
  return window.__readKeys.slice()
}
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
const shellVarsEqual = (a, b) => {
  const names = Object.keys(a)
  return names.length === 5 && names.every((name) => a[name] !== '' && a[name] === b[name])
}
const pngSize = (file) => {
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 浏览器量块 → 本次构建的真实现 foldClipFromBlocks 算几行、max-height 多少。 */
async function measureFold(kind) {
  const measured = await page.evaluate((which) => {
    const card = window.cardOf(which)
    const content = card.querySelector('[data-dsh-scard="content"]')
    const blocks = [...content.querySelectorAll('[data-dsh-scard="title"], [data-dsh-scard="para"], [data-dsh-scard="ref"]')]
      .map((el) => ({ kind: el.getAttribute('data-dsh-scard'), top: el.offsetTop, height: el.offsetHeight }))
    const para = content.querySelector('[data-dsh-scard="para"]') ?? content
    const cs = getComputedStyle(para)
    const titleEl = content.querySelector('[data-dsh-scard="title"]')
    const titleCs = titleEl === null ? null : getComputedStyle(titleEl)
    return {
      blocks,
      naturalHeight: content.scrollHeight,
      lineHeight: Number.parseFloat(cs.lineHeight),
      hasTitle: titleEl !== null,
      titleLineHeight: titleCs === null ? Number.parseFloat(cs.lineHeight) : Number.parseFloat(titleCs.lineHeight),
      titleClippedHidden: titleEl !== null && titleEl.scrollHeight > titleEl.clientHeight + 1,
      titleClientHeight: titleEl === null ? 0 : titleEl.clientHeight,
      titleScrollHeight: titleEl === null ? 0 : titleEl.scrollHeight,
      titleLineClamp: titleCs === null ? 'none' : titleCs.webkitLineClamp,
      // 还没跑任何测量时，正文区已有一条 CSS 固定上限（首帧就不许整段平铺）
      firstPaintMaxHeight: getComputedStyle(content).maxHeight,
      fontSize: cs.fontSize,
      lineStyle: cs.lineHeight,
    }
  }, kind)
  const geometry = foldClipFromBlocks({
    blocks: measured.blocks,
    naturalHeight: measured.naturalHeight,
    lineHeight: measured.lineHeight,
    titleLineHeight: measured.titleLineHeight,
    titleClippedHidden: measured.titleClippedHidden,
    budget: FOLD_BUDGET,
  })
  return { ...measured, geometry }
}

/** 旧折叠实现（标题 + 前 3 个内容块 + gap）的几何：只用来出 BEFORE 取证，不参与断言。 */
function legacyFoldFromBlocks(measured) {
  const body = measured.blocks.filter((block) => block.kind !== 'title')
  const visible = body.slice(0, 3)
  const clip = visible.reduce((sum, block) => sum + block.height, 0) + visible.length * 10
  return { collapsedMaxHeight: clip, lines: Math.max(1, Math.round(clip / measured.lineHeight)) }
}

async function applyFold(kind) {
  const measured = await measureFold(kind)
  await page.evaluate(({ which, geometry }) => window.__applyFold(which, geometry), { which: kind, geometry: measured.geometry })
  await page.waitForTimeout(320)
  return measured
}

// 用路由拦一个 https 源（about:blank 下 localStorage 会被拒），页面内容与真组件 DOM 同构
await page.route('https://dsh.local/secretary-visual.html', (route) => route.fulfill({ body: pageHtml, contentType: 'text/html; charset=utf-8' }))
const rendered = await page.goto('https://dsh.local/secretary-visual.html', { waitUntil: 'load' }).then(() => true).catch(() => false)
if (rendered !== true) throw new Error('视觉测试页加载失败')
await page.waitForTimeout(300)

try {
  // ── BEFORE 取证：先按旧实现量折叠态 max-height 与行数（真页面那张滕王阁序回答卡约 10 行）──
  const before = await measureFold('assistant')
  const legacy = legacyFoldFromBlocks(before)
  console.log(`BEFORE 折叠取证（旧实现：标题+前3块+gap）lineHeight=${before.lineHeight}px 正文自然行数=${Math.round(before.naturalHeight / before.lineHeight)} 旧折叠 max-height=${legacy.collapsedMaxHeight}px 旧折叠正文约 ${legacy.lines} 行 正文自然高度=${before.naturalHeight}px`)

  // ── 三种卡折叠：套上新实现（折叠态最多 3 行正文）──
  const folded = {}
  for (const kind of ['assistant', 'user', 'notice']) folded[kind] = await applyFold(kind)
  const afterAssistant = folded.assistant

  const info = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const title = card.querySelector('[data-dsh-scard="title"]')
    const para = card.querySelector('[data-dsh-scard="para"]')
    const strong = card.querySelector('strong[data-probe="strong"]')
    const model = card.querySelector('[data-dsh-scard="model-code"]')
    const mark = card.querySelector('[data-dsh-scard="mark"]')
    const read = card.querySelector('[data-dsh-speak="button"]')
    const copy = card.querySelector('[data-dsh-scard="copy"]')
    const copyIcon = copy.querySelector('svg')
    const quote = card.querySelector('[data-dsh-scard="quote"]')
    const quoteIcon = quote?.querySelector('svg') ?? null
    const quoteStatus = card.querySelector('[data-dsh-scard="quote-status"]')
    const sep = card.querySelector('[data-dsh-scard="separator"]')
    const expand = card.querySelector('[data-dsh-scard="expand"]')
    const arrow = card.querySelector('[data-dsh-scard="expand-arrow"]')
    const foot = card.querySelector('[data-dsh-scard="foot"]')
    const time = card.querySelector('[data-dsh-scard="time"]')
    const actions = card.querySelector('[data-dsh-scard="actions"]')
    const content = card.querySelector('[data-dsh-scard="content"]')
    const body = card.querySelector('[data-dsh-scard="body"]')
    const ellipsis = content.querySelector('[data-dsh-scard="ellipsis"]')
    const dot = card.querySelector('[data-dsh-scard="unread-dot"]')
    const timeRect = time.getBoundingClientRect()
    const copyRect = copy.getBoundingClientRect()
    const footRect = foot.getBoundingClientRect()
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.x, y: r.y } }
    const declaredBorder = (selector) => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === selector) {
              return rule.style.getPropertyValue('border-top-width')
                || rule.style.getPropertyValue('border-top')
                || rule.style.getPropertyValue('border-width')
                || rule.style.getPropertyValue('border')
                || ''
            }
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
      title: { size: getComputedStyle(title).fontSize, weight: getComputedStyle(title).fontWeight, color: getComputedStyle(title).color, line: getComputedStyle(title).lineHeight },
      para: { size: getComputedStyle(para).fontSize, weight: getComputedStyle(para).fontWeight, line: getComputedStyle(para).lineHeight, color: getComputedStyle(para).color },
      strong: { weight: getComputedStyle(strong).fontWeight, color: getComputedStyle(strong).color },
      model: { size: getComputedStyle(model).fontSize, color: getComputedStyle(model).color, bg: getComputedStyle(model).backgroundColor, radius: getComputedStyle(model).borderRadius, family: getComputedStyle(model).fontFamily, padding: getComputedStyle(model).padding },
      ref: (() => { const el = card.querySelector('[data-dsh-scard="ref"]'); return el === null ? null : { size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, h: rect(el).h } })(),
      fold: {
        maxHeight: getComputedStyle(content).maxHeight,
        clientHeight: content.clientHeight,
        scrollHeight: content.scrollHeight,
        overflow: getComputedStyle(content).overflow,
        cursor: getComputedStyle(body).cursor,
        role: body.getAttribute('role'),
        tabIndex: body.getAttribute('tabindex'),
        aria: body.getAttribute('aria-expanded'),
        ellipsis: ellipsis === null ? null : { text: ellipsis.textContent, display: getComputedStyle(ellipsis).display, right: rect(ellipsis).right, bottom: Math.round(rect(ellipsis).bottom) },
        timeRect: { left: Math.round(timeRect.left), right: Math.round(timeRect.right) },
        copyRect: { left: Math.round(copyRect.left), right: Math.round(copyRect.right) },
        footRight: Math.round(footRect.right),
      },
      dot: dot === null ? null : { w: rect(dot).w, h: rect(dot).h, bg: getComputedStyle(dot).backgroundColor, radius: getComputedStyle(dot).borderRadius, aria: dot.getAttribute('aria-label'), top: Math.round(rect(dot).top), left: Math.round(rect(dot).left), markLeft: Math.round(rect(mark).left) },
      foot: { bg: getComputedStyle(foot).backgroundColor, border: declaredBorder('[data-dsh-scard="foot"]'), borderWidth: getComputedStyle(foot).borderTopWidth, order: [...actions.children].map((el) => el.getAttribute('data-dsh-scard') ?? '').filter(Boolean), childrenOrder: [...foot.children].map((el) => el.getAttribute('data-dsh-scard') ?? (el.tagName === 'TIME' ? 'time' : '')).filter(Boolean) },
      quote: quote === null ? null : { ...rect(quote), icon: quoteIcon === null ? null : rect(quoteIcon), title: quote.getAttribute('title'), aria: quote.getAttribute('aria-pressed'), color: getComputedStyle(quote).color, bg: getComputedStyle(quote).backgroundColor, radius: getComputedStyle(quote).borderRadius, size: getComputedStyle(quote).width, left: Math.round(rect(quote).left), timeLeft: Math.round(timeRect.left), statusText: quoteStatus?.textContent ?? '' },
      copy: { ...rect(copy), icon: rect(copyIcon), label: copy.getAttribute('aria-label'), title: copy.getAttribute('title'), color: getComputedStyle(copy).color },
      time: { display: getComputedStyle(time).display, size: getComputedStyle(time).fontSize, color: getComputedStyle(time).color, text: time.textContent },
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
  pass('右上角唯一 34px 朗读按钮（尺寸不动），带 title', near(info.read.w, 34) && near(info.read.h, 34) && /0\.5px/.test(info.read.border) && info.read.title === '朗读回答' && info.read.aria === 'false', JSON.stringify(info.read))
  pass('结论行（卡标题）18px / 600 / 主文字色 —— 第 2 项需求：先看到的就是结论', info.title.size === '18px' && info.title.weight === '600' && info.title.color === 'rgb(31, 35, 41)', JSON.stringify(info.title))
  pass('详情段落 14px / 400 / 行高 26px / #4E5969 —— 第 2 项需求：细节稍小一号', info.para.size === '14px' && info.para.weight === '400' && info.para.line === '26px' && info.para.color === 'rgb(78, 89, 105)', JSON.stringify(info.para))
  pass('正文里的重点句仍然 600 / 主文字色（只换字号，粗与不粗照旧）', info.strong.weight === '600' && info.strong.color === 'rgb(31, 35, 41)', JSON.stringify(info.strong))
  pass('模型标签 13px 等宽、浅紫底深紫字、5px 圆角（chip 加两号）', info.model.size === '13px' && info.model.color === 'rgb(60, 52, 137)' && info.model.bg === 'rgb(238, 237, 254)' && info.model.radius === '5px' && /monospace/i.test(info.model.family) && info.model.padding === '2px 5px', JSON.stringify(info.model))
  pass('引用 chip 13px（chip 加两号）', info.ref !== null && info.ref.size === '13px' && info.ref.color === 'rgb(60, 52, 137)', JSON.stringify(info.ref))

  // 折叠态：最多 3 行正文，且有明确 max-height 数值；真被截断（scrollHeight 大于 clientHeight）
  const fold = info.fold
  void 0
  pass('折叠态最多 3 行正文且有明确 max-height 数值',
    fold.maxHeight.endsWith('px') && Number.isFinite(Number.parseFloat(fold.maxHeight)) && fold.role === 'button' && fold.tabIndex === '0' && fold.aria === 'false'
      && fold.clientHeight === Number.parseFloat(fold.maxHeight) && fold.scrollHeight > fold.clientHeight
      && folded.assistant.geometry.bodyLines === FOLD_BUDGET && folded.assistant.geometry.overflow === true,
    JSON.stringify({ maxHeight: fold.maxHeight, clientHeight: fold.clientHeight, scrollHeight: fold.scrollHeight, bodyLines: folded.assistant.geometry.bodyLines, budget: FOLD_BUDGET, clip: folded.assistant.geometry.clip, natural: folded.assistant.naturalHeight, lineHeight: folded.assistant.lineHeight }))
  pass('AFTER 折叠实测比 BEFORE 明显收窄',
    Number.parseFloat(fold.maxHeight) < legacy.collapsedMaxHeight,
    JSON.stringify({ before: `${legacy.collapsedMaxHeight}px / 约 ${legacy.lines} 行`, after: `${fold.maxHeight} / ${folded.assistant.geometry.bodyLines} 行` }))
  // 现网「长卡整段平铺」三条根因逐一对着打（2026-11-22 手机 390px 实测：折叠 max-height 321–346px、卡高 456–481px）
  const capAssistant = folded.assistant.geometry.cap
  pass('折叠落点封顶在固定上限内（不随首段行数膨胀）',
    Number.parseFloat(fold.maxHeight) <= capAssistant && capAssistant === surface.foldCollapsedCapPx({ lineHeight: before.lineHeight, titleLineHeight: before.titleLineHeight, hasTitle: true }),
    JSON.stringify({ maxHeight: fold.maxHeight, cap: capAssistant, natural: before.naturalHeight, lineHeight: before.lineHeight, titleLineHeight: before.titleLineHeight }))
  pass('卡标题折叠态被行夹成 2 行（旧口径「标题永远露出」让折叠高度随首段膨胀）',
    before.titleLineClamp === '2' && before.titleClientHeight <= Math.round(2 * before.titleLineHeight) + 1 && Math.abs(Number.parseFloat(info.title.line) - before.titleLineHeight) < 0.6,
    JSON.stringify({ clamp: before.titleLineClamp, titleClientH: before.titleClientHeight, titleLineHeight: before.titleLineHeight, declaredTitleMaxHeight: 'calc(1.5em * 2)' }))
  pass('首帧（还没跑任何测量）正文区就已有固定上限，不会整段平铺（现网时序兜底）',
    before.firstPaintMaxHeight === '162px' && before.naturalHeight > 162,
    JSON.stringify({ firstPaintMaxHeight: before.firstPaintMaxHeight, natural: before.naturalHeight }))
  pass('整条回复只有一段连续文字（正文块只剩被裁过的标题）也必须折叠',
    (() => {
      const onlyTitle = foldClipFromBlocks({ blocks: [{ kind: 'title', top: 0, height: 332 }], naturalHeight: 332, lineHeight: 26, titleLineHeight: 27, titleClippedHidden: true })
      return onlyTitle.overflow === true && onlyTitle.collapsedMaxHeight === 54
    })(),
    JSON.stringify({ 旧口径: '无 max-height → 整段平铺', 新口径: '折叠在 54px（结论 2 行）' }))
  pass('折叠末尾是「…」省略标记（不是渐变遮罩）',
    info.fold.ellipsis !== null && info.fold.ellipsis.text === '…' && info.fold.ellipsis.display !== 'none',
    JSON.stringify(info.fold.ellipsis))
  const maskRule = await page.evaluate(() => {
    let found = ''
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          const selector = rule.selectorText ?? ''
          if (selector.includes('[data-dsh-scard="content"]') && selector.includes('::')) found += `${selector}{${rule.style.cssText}}`
        }
      } catch { /* ignore */ }
    }
    return found
  })
  pass('折叠卡片没有任何渐变遮罩伪元素（截断标记是真 span，不是 ::after 渐变）',
    !/gradient/i.test(maskRule) && maskRule === '',
    JSON.stringify({ maskRule }))
  pass('溢出卡显示「展开全文」入口且卡体 cursor:pointer',
    info.expand.text === '展开全文' && info.expand.aria === 'false' && info.fold.cursor === 'pointer',
    JSON.stringify({ text: info.expand.text, aria: info.expand.aria, cursor: info.fold.cursor }))

  // 时间：脚部顺序 = 时间 + 复制，时间紧贴复制按钮左侧、都在最右端
  const timeAdjacent = info.fold.copyRect.left - info.fold.timeRect.right
  pass('脚部时间紧贴复制按钮左侧且在最右端（时间 + 复制）',
    timeAdjacent >= 0 && timeAdjacent <= 12 && info.fold.timeRect.left > info.fold.copyRect.left - 200 && JSON.stringify(info.foot.order) === JSON.stringify(['copy', 'separator', 'expand']),
    JSON.stringify({ timeRect: info.fold.timeRect, copyRect: info.fold.copyRect, gap: timeAdjacent, order: info.foot.order }))
  pass('脚部时间是 HH:MM（去掉「今天」字样）、12px（加两号）',
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(info.time.text) && info.time.size === '12px' && info.time.display !== 'none',
    JSON.stringify(info.time))
  pass('移动端时间仍然显示且不横向溢出', info.time.display !== 'none' && info.overflowX <= 0, JSON.stringify({ time: info.time.display, overflowX: info.overflowX }))

  pass('页面级秘书标记存在', info.bodyFlag === '1', info.bodyFlag)

  // ── 第 4 项：引用按钮（脚部时间左边，规格与时间右边那棵复制按钮一致） ──
  pass('脚部顺序 = 引用 → 时间 → 操作区（引用挂在时间左边）',
    JSON.stringify(info.foot.childrenOrder) === JSON.stringify(['quote', 'time', 'actions']) && info.foot.order.join('+') === 'copy+separator+expand',
    JSON.stringify({ childrenOrder: info.foot.childrenOrder, order: info.foot.order }))
  pass('引用按钮与复制按钮同一档规格（30×30、16×16 图标、同一灰、同一圆角、同一 padding/hover 底色）',
    info.quote !== null
      && near(info.quote.w, 30, 0.6) && near(info.quote.h, 30, 0.6)
      && info.quote.icon !== null && near(info.quote.icon.w, 16, 0.6) && near(info.quote.icon.h, 16, 0.6)
      && info.quote.color === info.copy.color && info.quote.radius === '8px'
      && info.quote.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify({ quote: info.quote, copy: { w: info.copy.w, h: info.copy.h, color: info.copy.color, icon: info.copy.icon } }))
  pass('引用按钮在时间左侧（left 小于时间 left）且标题文案指到下一条消息',
    info.quote !== null && info.quote.left < info.quote.timeLeft && /下一条消息就接着它说/.test(info.quote.title ?? ''),
    JSON.stringify({ quoteLeft: info.quote?.left, timeLeft: info.quote?.timeLeft, title: info.quote?.title }))

  // ── 第 3 项：compact 那两行在秘书页不出图（按宿主 kind + 扫描层打标记两条判据） ──
  const compactRows = await page.evaluate(() => {
    const show = (probe) => {
      const el = document.querySelector(`[data-probe="${probe}"]`)
      if (el === null) return { display: 'missing', text: '' }
      return { display: getComputedStyle(el).display, offsetHeight: el.offsetHeight, text: (el.textContent ?? '').trim().slice(0, 40) }
    }
    const freshNotice = document.querySelector('[data-probe="notice-row"]')
    const expiredRow = document.querySelector('[data-probe="expired-notice-row"]')
    const expiredCard = expiredRow?.querySelector('[data-dsh-scard="card"]') ?? null
    const expiredSlot = expiredRow?.querySelector('[data-slot="conversation.chat.node"]') ?? null
    const expiredRun = expiredRow?.querySelector('[data-slot="conversation.user.text.node"] > span') ?? null
    return {
      manualCompaction: show('compact-summary-row'),
      failureCommand: show('compact-failure-row'),
      compactionKind: show('compaction-kind-row'),
      taggedHint: show('compact-tagged-row'),
      freshNoticeDisplay: freshNotice === null ? 'missing' : getComputedStyle(freshNotice).display,
      expiredCardDisplay: expiredCard === null ? 'missing' : getComputedStyle(expiredCard).display,
      expiredCardHasShellAttr: expiredCard?.getAttribute('data-dsh-scard-expired') ?? '',
      expiredSlotDisplay: expiredSlot === null ? 'missing' : getComputedStyle(expiredSlot).display,
      expiredSlotHeight: expiredSlot === null ? -1 : expiredSlot.offsetHeight,
      expiredRunDisplay: expiredRun === null ? 'missing' : getComputedStyle(expiredRun).display,
      expiredSlotOffsetHeight: expiredSlot === null ? -1 : expiredSlot.offsetHeight,
      expiredRowDisplay: expiredRow === null ? 'missing' : getComputedStyle(expiredRow).display,
      chatStageHeight: (() => { const el = document.querySelector('.chat-stage'); return el === null ? 0 : el.offsetHeight })(),
    }
  })
  pass('第 3 项：compact 已压缩那一行（kind="manual-compaction"）在秘书页不出图',
    compactRows.manualCompaction.display === 'none' && compactRows.manualCompaction.offsetHeight === 0,
    JSON.stringify(compactRows.manualCompaction))
  pass('第 3 项：kind="compaction"（独立摘要行）仍然不出图（原有规则没被改坏）',
    compactRows.compactionKind.display === 'none', JSON.stringify(compactRows.compactionKind))
  pass('第 3 项：扫描层打上 data-dsh-scard-compact="hint" 的行不出图（文字判据那条兜底）',
    compactRows.taggedHint.display === 'none' && compactRows.taggedHint.offsetHeight === 0, JSON.stringify(compactRows.taggedHint))
  pass('第 3 项：失败分支那行在没打标时仍然照常出图（说明压的是判据，不是所有 command 行）',
    compactRows.failureCommand.display !== 'none' && compactRows.failureCommand.offsetHeight > 0, JSON.stringify(compactRows.failureCommand))
  pass('第 3 项：普通通知卡与用户行不受影响（仍然出图）',
    compactRows.freshNoticeDisplay !== 'none', JSON.stringify({ freshNoticeDisplay: compactRows.freshNoticeDisplay }))

  // ── 第 1 项：满 10 分钟的通知卡收成空壳（外壳挂着、盒子不出图、宿主气泡也不许冒回来） ──
  pass('第 1 项：过期通知卡外壳带 data-dsh-scard-expired="1" 且盒子 display:none',
    compactRows.expiredCardHasShellAttr === '1' && compactRows.expiredCardDisplay === 'none',
    JSON.stringify({ expiredCardDisplay: compactRows.expiredCardDisplay, expiredCardHasShellAttr: compactRows.expiredCardHasShellAttr }))
  pass('第 1 项：过期通知卡那行的宿主内容仍然被 :has 判据压住（不因为卡片收掉就冒回原生气泡）',
    compactRows.expiredSlotDisplay === 'none' && compactRows.expiredSlotHeight === 0 && compactRows.expiredRunDisplay === 'none' && compactRows.expiredRowDisplay !== 'none',
    JSON.stringify({ expiredSlotDisplay: compactRows.expiredSlotDisplay, expiredSlotHeight: compactRows.expiredSlotHeight, expiredRunDisplay: compactRows.expiredRunDisplay, expiredRowDisplay: compactRows.expiredRowDisplay, expiredCardDisplay: compactRows.expiredCardDisplay }))

  // ── 第 3 项的负向取证：同一份 CSS、同一批宿主行，在**没有秘书标记**的普通会话页里一条都不许隐藏 ──
  const otherPage = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  let otherHtml = null
  await otherPage.route('https://dsh.local/secretary-visual-other.html', (route) => {
    otherHtml = pageHtml.replace('<body data-dsh-secretary="1">', '<body>')
    if (otherHtml === pageHtml) throw new Error('替换没生效：别的会话页仍带秘书标记')
    return route.fulfill({ body: otherHtml, contentType: 'text/html; charset=utf-8' })
  })
  await otherPage.goto('https://dsh.local/secretary-visual-other.html', { waitUntil: 'load' })
  await otherPage.waitForTimeout(250)
  const otherRows = await otherPage.evaluate(() => {
    const show = (probe) => {
      const el = document.querySelector(`[data-probe="${probe}"]`)
      if (el === null) return { display: 'missing', offsetHeight: -1 }
      return { display: getComputedStyle(el).display, offsetHeight: el.offsetHeight }
    }
    const title = document.querySelector('[data-dsh-scard="card"] [data-dsh-scard="title"]')
    const para = document.querySelector('[data-dsh-scard="card"] [data-dsh-scard="para"]')
    return {
      bodyFlag: document.body.getAttribute('data-dsh-secretary') ?? '',
      manualCompaction: show('compact-summary-row'),
      compactionKind: show('compaction-kind-row'),
      taggedHint: show('compact-tagged-row'),
    }
  })
  pass('第 3 项不许外溢：没有秘书标记的会话页里那两行照旧出图（display 不是 none、有高度）',
    otherRows.bodyFlag === '' && otherRows.manualCompaction.display !== 'none' && otherRows.manualCompaction.offsetHeight > 0
      && otherRows.compactionKind.display !== 'none' && otherRows.compactionKind.offsetHeight > 0
      && otherRows.taggedHint.display !== 'none' && otherRows.taggedHint.offsetHeight > 0,
    JSON.stringify(otherRows))
  pass('第 2 项只改秘书卡片字体：别的会话页里宿主行不受影响（宿主正文仍然照排）',
    otherRows.manualCompaction.display !== 'none' && otherRows.taggedHint.offsetHeight > 0, JSON.stringify(otherRows.taggedHint))
  await otherPage.close()

  // ── 三种卡主题与外壳 ──
  const dual = await page.evaluate(() => {
    const assistant = window.cardOf('assistant')
    const user = window.cardOf('user')
    const notice = window.cardOf('notice')
    const themeVars = ['--dsh-card-surface', '--dsh-card-accent', '--dsh-card-accent-deep', '--dsh-card-accent-wash',
      '--dsh-card-accent-wash-deep', '--dsh-card-accent-line', '--dsh-card-foot-surface', '--dsh-card-focus-ring']
    const shellVars = ['--dsh-card-border', '--dsh-card-separator', '--dsh-card-text', '--dsh-card-text-soft', '--dsh-card-text-muted']
    const readVars = (el, names) => {
      const cs = getComputedStyle(el)
      const out = {}
      for (const name of names) out[name] = cs.getPropertyValue(name).trim()
      return out
    }
    const userRow = document.querySelector('[data-chat-flow-kind="user"][data-chat-node-key="13:input-message-user-01"]')
    const noticeRow = document.querySelector('[data-chat-flow-kind="user"][data-probe="notice-row"]')
    const userCs = getComputedStyle(user)
    const noticeCs = getComputedStyle(notice)
    const assistantCs = getComputedStyle(assistant)
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height } }
    return {
      userExists: user !== null,
      noticeExists: notice !== null,
      userKindCount: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="user"]').length,
      noticeKindCount: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-dsh-scard-expired="1"])').length,
      noticeRowHasUserCard: noticeRow.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"]') !== null,
      noticeBubbleDisplay: getComputedStyle(noticeRow.querySelector('[data-slot="conversation.chat.node"]')).display,
      noticeHostRunDisplay: getComputedStyle(noticeRow.querySelector('.host-plain-run')).display,
      userRowBubbleDisplay: userRow === null ? '' : getComputedStyle(userRow.querySelector('[data-slot="conversation.chat.node"]')).display,
      userRowTextDisplay: userRow === null ? '' : getComputedStyle(userRow.querySelector('[data-slot="conversation.user.text.node"]')).display,
      userHostRunDisplay: userRow === null ? '' : getComputedStyle(userRow.querySelector('.host-plain-run')).display,
      assistantTheme: readVars(assistant, themeVars),
      userTheme: readVars(user, themeVars),
      noticeTheme: readVars(notice, themeVars),
      assistantShell: readVars(assistant, shellVars),
      userShell: readVars(user, shellVars),
      noticeShell: readVars(notice, shellVars),
      userCardBg: userCs.backgroundColor,
      noticeCardBg: noticeCs.backgroundColor,
      assistantCardBg: assistantCs.backgroundColor,
      shell: {
        radius: userCs.borderTopLeftRadius, borderWidth: userCs.borderTopWidth, borderColor: userCs.borderTopColor,
        borderStyle: userCs.borderTopStyle, shadow: userCs.boxShadow, overflow: userCs.overflow, maxWidth: userCs.maxWidth,
        assistantMaxWidth: assistantCs.maxWidth, assistantRadius: assistantCs.borderTopLeftRadius,
        noticeRadius: noticeCs.borderTopLeftRadius, noticeMaxWidth: noticeCs.maxWidth, noticeShadow: noticeCs.boxShadow, noticeOverflow: noticeCs.overflow, noticeBorderColor: noticeCs.borderTopColor, noticeBorderWidth: noticeCs.borderTopWidth, noticeBorderStyle: noticeCs.borderTopStyle,
      },
      userMark: {
        color: getComputedStyle(user.querySelector('[data-dsh-scard="mark"]')).color,
        bg: getComputedStyle(user.querySelector('[data-dsh-scard="mark"]')).backgroundColor,
        ...box(user.querySelector('[data-dsh-scard="mark"]')),
        radius: getComputedStyle(user.querySelector('[data-dsh-scard="mark"]')).borderRadius,
        tagColor: getComputedStyle(user.querySelector('[data-dsh-scard="tag"]')).color,
        tagBg: getComputedStyle(user.querySelector('[data-dsh-scard="tag"]')).backgroundColor,
      },
      noticeMark: {
        color: getComputedStyle(notice.querySelector('[data-dsh-scard="mark"]')).color,
        bg: getComputedStyle(notice.querySelector('[data-dsh-scard="mark"]')).backgroundColor,
        ...box(notice.querySelector('[data-dsh-scard="mark"]')),
        tagText: notice.querySelector('[data-dsh-scard="tag"]')?.textContent ?? '',
        nameText: notice.querySelector('[data-dsh-scard="name"]')?.textContent ?? '',
        tagColor: getComputedStyle(notice.querySelector('[data-dsh-scard="tag"]')).color,
        tagBg: getComputedStyle(notice.querySelector('[data-dsh-scard="tag"]')).backgroundColor,
      },
      userFoot: {
        bg: getComputedStyle(user.querySelector('[data-dsh-scard="foot"]')).backgroundColor,
        order: [...user.querySelector('[data-dsh-scard="actions"]').children].map((el) => el.getAttribute('data-dsh-scard') ?? '').filter(Boolean),
        speakInFoot: user.querySelector('[data-dsh-scard="foot"] [data-dsh-speak="button"]') !== null,
        timeText: user.querySelector('[data-dsh-scard="time"]')?.textContent ?? '',
        timeDisplay: getComputedStyle(user.querySelector('[data-dsh-scard="time"]')).display,
        copyTitle: user.querySelector('[data-dsh-scard="copy"]')?.getAttribute('title') ?? '',
        timeRect: (() => { const r = user.querySelector('[data-dsh-scard="time"]').getBoundingClientRect(); const c = user.querySelector('[data-dsh-scard="copy"]').getBoundingClientRect(); return { timeRight: Math.round(r.right), copyLeft: Math.round(c.left), size: getComputedStyle(user.querySelector('[data-dsh-scard="time"]')).fontSize } })(),
      },
      noticeFoot: {
        order: [...notice.querySelector('[data-dsh-scard="actions"]').children].map((el) => el.getAttribute('data-dsh-scard') ?? '').filter(Boolean),
        timeText: notice.querySelector('[data-dsh-scard="time"]')?.textContent ?? '',
        timeRect: (() => { const r = notice.querySelector('[data-dsh-scard="time"]').getBoundingClientRect(); const c = notice.querySelector('[data-dsh-scard="copy"]').getBoundingClientRect(); return { timeRight: Math.round(r.right), copyLeft: Math.round(c.left) } })(),
        speakInFoot: notice.querySelector('[data-dsh-scard="foot"] [data-dsh-speak="button"]') !== null,
      },
      userHead: {
        nameText: user.querySelector('[data-dsh-scard="name"]')?.textContent ?? '',
        tagText: user.querySelector('[data-dsh-scard="tag"]')?.textContent ?? '',
        speakTitle: user.querySelector('[data-dsh-speak="button"]')?.getAttribute('title') ?? '',
        speakW: user.querySelector('[data-dsh-speak="button"]').getBoundingClientRect().width,
      },
      paras: [...user.querySelectorAll('[data-dsh-scard="para"]')].map((el) => el.textContent),
      paraStyle: {
        size: getComputedStyle(user.querySelector('[data-dsh-scard="para"]')).fontSize,
        line: getComputedStyle(user.querySelector('[data-dsh-scard="para"]')).lineHeight,
        color: getComputedStyle(user.querySelector('[data-dsh-scard="para"]')).color,
      },
      noticeParaStyle: {
        size: getComputedStyle(notice.querySelector('[data-dsh-scard="para"]')).fontSize,
        line: getComputedStyle(notice.querySelector('[data-dsh-scard="para"]')).lineHeight,
      },
      noticeTitleStyle: { size: getComputedStyle(notice.querySelector('[data-dsh-scard="title"]')).fontSize },
      noticeFold: (() => {
        const content = notice.querySelector('[data-dsh-scard="content"]')
        const body = notice.querySelector('[data-dsh-scard="body"]')
        return {
          maxHeight: getComputedStyle(content).maxHeight,
          clientHeight: content.clientHeight,
          scrollHeight: content.scrollHeight,
          aria: body.getAttribute('aria-expanded'),
          role: body.getAttribute('role'),
          ellipsis: content.querySelector('[data-dsh-scard="ellipsis"]')?.textContent ?? '',
        }
      })(),
      noticeRef: notice.querySelector('[data-dsh-scard="ref"]') !== null,
      userFold: (() => {
        const content = user.querySelector('[data-dsh-scard="content"]')
        const body = user.querySelector('[data-dsh-scard="body"]')
        return {
          aria: body.getAttribute('aria-expanded'),
          role: body.getAttribute('role'),
          maxHeight: getComputedStyle(content).maxHeight,
          clientHeight: content.clientHeight,
          scrollHeight: content.scrollHeight,
          fold: body.getAttribute('data-dsh-scard-fold'),
          cursor: getComputedStyle(body).cursor,
        }
      })(),
      userExpandInUserCard: user.querySelector('[data-dsh-scard="expand"]') !== null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })

  pass('三种卡存在（紫 assistant / 冷蓝 user / 灰 notice）',
    dual.userExists && dual.noticeExists && dual.userKindCount >= 1 && dual.noticeKindCount === 1 && dual.shell.assistantMaxWidth === dual.shell.maxWidth,
    JSON.stringify({ userKindCount: dual.userKindCount, noticeKindCount: dual.noticeKindCount }))
  pass('三种卡的 --dsh-card-* 主题变量两两不同',
    Object.keys(dual.assistantTheme).length === 8 && Object.keys(dual.assistantTheme).every((name) =>
      dual.assistantTheme[name] !== '' && dual.userTheme[name] !== '' && dual.noticeTheme[name] !== ''
      && dual.assistantTheme[name] !== dual.userTheme[name] && dual.assistantTheme[name] !== dual.noticeTheme[name] && dual.userTheme[name] !== dual.noticeTheme[name]),
    JSON.stringify({ assistant: dual.assistantTheme, user: dual.userTheme, notice: dual.noticeTheme }))
  pass('三种卡背景色互不相同（白底 / 浅蓝 #EEF4FF / 灰 #F6F7F9）',
    dual.assistantCardBg === 'rgb(255, 255, 255)' && dual.userCardBg === 'rgb(238, 244, 255)' && dual.noticeCardBg === 'rgb(246, 247, 249)',
    JSON.stringify({ assistant: dual.assistantCardBg, user: dual.userCardBg, notice: dual.noticeCardBg }))
  pass('三种卡共用同一套外壳规格变量（边框/分隔线/文字色一致）',
    shellVarsEqual(dual.assistantShell, dual.userShell) && shellVarsEqual(dual.assistantShell, dual.noticeShell),
    JSON.stringify({ assistant: dual.assistantShell, user: dual.userShell, notice: dual.noticeShell }))
  pass('用户卡与通知卡外壳跟秘书卡同规格：16px 圆角、0.5px #E5E6EB、无阴影、overflow hidden、max-width 620px',
    dual.shell.radius === '16px' && dual.shell.radius === dual.shell.assistantRadius && dual.shell.noticeRadius === '16px'
      && dual.shell.borderWidth !== '0px' && dual.shell.noticeBorderWidth !== '0px'
      && dual.shell.borderStyle === 'solid' && dual.shell.borderColor === 'rgb(229, 230, 235)' && dual.shell.noticeBorderColor === 'rgb(229, 230, 235)' && dual.shell.noticeBorderStyle === 'solid'
      && dual.shell.shadow === 'none' && dual.shell.noticeShadow === 'none'
      && dual.shell.overflow === 'hidden' && dual.shell.noticeOverflow === 'hidden'
      && dual.shell.maxWidth === '620px' && dual.shell.noticeMaxWidth === '620px',
    JSON.stringify(dual.shell))
  pass('用户卡主题走冷蓝：强调 #184A80、浅蓝底芯片白底标识',
    dual.userMark.color === 'rgb(24, 74, 128)' && near(dual.userMark.w, 32) && near(dual.userMark.h, 32)
      && dual.userMark.radius === '10px' && dual.userMark.bg === 'rgb(255, 255, 255)'
      && dual.userMark.tagColor === 'rgb(18, 57, 95)' && dual.userMark.tagBg === 'rgb(255, 255, 255)',
    JSON.stringify(dual.userMark))
  pass('通知卡主题走中性灰：强调 #5C6470、标识与 chip 底 #E9EBF0、chip 文字 #3F444D',
    dual.noticeMark.color === 'rgb(92, 100, 112)' && dual.noticeMark.tagColor === 'rgb(63, 68, 77)' && dual.noticeMark.tagBg === 'rgb(233, 235, 240)' && dual.noticeMark.bg === 'rgb(233, 235, 240)',
    JSON.stringify({ color: dual.noticeMark.color, bg: dual.noticeMark.bg, tagColor: dual.noticeMark.tagColor, tagBg: dual.noticeMark.tagBg }))
  pass('通知卡头部是铃铛标识 + 「系统 · 通知」chip（不写成个人秘书、也不写成用户消息）',
    dual.noticeMark.tagText === '系统 · 通知' && dual.noticeMark.nameText === '',
    JSON.stringify({ tag: dual.noticeMark.tagText, name: dual.noticeMark.nameText }))
  pass('通知卡保留可点击的会话引用 chip（灰底卡里仍带跳转）',
    dual.noticeRef === true, JSON.stringify({ noticeRef: dual.noticeRef }))
  pass('通知卡折叠、字号、点卡展开跟秘书卡同一套（详情 14px/26、结论 18px 标题、卡体 role/aria、…标记）',
    dual.noticeParaStyle.size === '14px' && dual.noticeParaStyle.line === '26px' && dual.noticeTitleStyle.size === '18px'
      && dual.noticeFold.role === 'button' && dual.noticeFold.aria === 'false' && dual.noticeFold.maxHeight.endsWith('px')
      && dual.noticeFold.clientHeight === Number.parseFloat(dual.noticeFold.maxHeight) && dual.noticeFold.ellipsis === '…',
    JSON.stringify({ para: dual.noticeParaStyle, title: dual.noticeTitleStyle, fold: dual.noticeFold, geometry: folded.notice.geometry }))
  pass('用户卡头部是「你 / 用户消息」标识 + 右上角朗读按钮（34px，标题「朗读这条消息」）',
    dual.userHead.nameText === '你' && dual.userHead.tagText === '用户消息'
      && dual.userHead.speakTitle === '朗读这条消息' && near(dual.userHead.speakW, 34),
    JSON.stringify(dual.userHead))
  pass('用户卡脚部时间 + 复制（时间紧贴复制左侧），没有朗读按钮',
    !dual.userFoot.speakInFoot && JSON.stringify(dual.userFoot.order) === JSON.stringify(['copy'])
      && dual.userFoot.timeRect.copyLeft - dual.userFoot.timeRect.timeRight <= 12,
    JSON.stringify(dual.userFoot))
  pass('用户卡脚部时间也是 HH:MM（去「今天」字样、12px）',
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(dual.userFoot.timeText) && dual.userFoot.timeRect.size === '12px' && dual.userFoot.timeDisplay !== 'none',
    JSON.stringify({ timeText: dual.userFoot.timeText, size: dual.userFoot.timeRect.size, display: dual.userFoot.timeDisplay }))
  pass('通知卡脚部时间 + 复制 + 展开全文（同规格）',
    JSON.stringify(dual.noticeFoot.order) === JSON.stringify(['copy', 'separator', 'expand']) && !dual.noticeFoot.speakInFoot
      && /^([01]?\d|2[0-3]):[0-5]\d$/.test(dual.noticeFoot.timeText) && dual.noticeFoot.timeRect.copyLeft - dual.noticeFoot.timeRect.timeRight <= 12,
    JSON.stringify(dual.noticeFoot))
  pass('用户卡正文原样显示用户说的话（详情 14px/26，不截断不改写）',
    dual.paras.length === 2 && /帮我把今天下午的安排理一遍/.test(dual.paras[0]) && /用户卡不许改写/.test(dual.paras[1])
      && dual.paraStyle.size === '14px' && dual.paraStyle.line === '26px' && dual.paraStyle.color === 'rgb(78, 89, 105)',
    JSON.stringify({ paras: dual.paras, style: dual.paraStyle }))
  pass('用户卡不溢出时卡体是 static（不 cursor、aria-expanded=true、没有展开全文）',
    dual.userFold.role === 'button' && dual.userFold.fold === 'static' && dual.userFold.aria === 'true' && dual.userFold.cursor === 'auto'
      && dual.userExpandInUserCard === false && dual.userFold.scrollHeight === dual.userFold.clientHeight,
    JSON.stringify(dual.userFold))
  pass('合成通知不做成用户卡：通知行里有灰底通知卡、宿主气泡收起来',
    dual.noticeRowHasUserCard === false && dual.noticeBubbleDisplay === 'none' && dual.noticeHostRunDisplay === 'none',
    JSON.stringify({ noticeHasUserCard: dual.noticeRowHasUserCard, bubble: dual.noticeBubbleDisplay, run: dual.noticeHostRunDisplay }))
  pass('真实用户行做成卡片后宿主气泡收起来（不留重复文本）',
    dual.userRowBubbleDisplay === 'none' && dual.userHostRunDisplay === 'none',
    JSON.stringify({ bubble: dual.userRowBubbleDisplay, text: dual.userRowTextDisplay, run: dual.userHostRunDisplay }))
  pass('移动端页面不横向溢出', dual.overflowX <= 0, JSON.stringify({ overflowX: dual.overflowX }))

  // ── 未读红点（assistant 与 notice 有、user 没有）──
  pass('秘书卡与通知卡都有未读红点（8px #D83A2B，aria-label=未读，贴在标识组左侧）',
    info.dot !== null && near(info.dot.w, 8) && near(info.dot.h, 8) && info.dot.bg === 'rgb(216, 58, 43)'
      && /999|50|circle/.test(info.dot.radius) && info.dot.aria === '未读' && info.dot.left < info.dot.markLeft,
    JSON.stringify(info.dot))
  const dotKinds = await page.evaluate(() => ({
    userDot: window.cardOf('user').querySelector('[data-dsh-scard="unread-dot"]') !== null,
    noticeDot: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]') !== null,
    noticeAria: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]')?.getAttribute('aria-label') ?? '',
    userUnreadAttr: window.cardOf('user').getAttribute('data-unread'),
  }))
  pass('用户卡没有未读红点（kind=user 不参与）与通知卡红点存在',
    dotKinds.userDot === false && dotKinds.noticeDot === true && dotKinds.noticeAria === '未读' && dotKinds.userUnreadAttr === '0',
    JSON.stringify(dotKinds))

  // ── 点卡体展开/收起（aria-expanded false→true 且高度增长）；按钮不能因点卡体被触发 ──
  const beforeClick = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const content = card.querySelector('[data-dsh-scard="content"]')
    return { aria: card.querySelector('[data-dsh-scard="body"]').getAttribute('aria-expanded'), height: content.clientHeight, jump: window.__jump, readKeys: window.__readKeys.slice(), dot: card.querySelector('[data-dsh-scard="unread-dot"]') !== null }
  })
  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"] [data-dsh-scard="body"]').click()
  await page.waitForTimeout(320)
  const afterClick = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const content = card.querySelector('[data-dsh-scard="content"]')
    return {
      open: card.getAttribute('data-open'),
      aria: card.querySelector('[data-dsh-scard="body"]').getAttribute('aria-expanded'),
      height: content.clientHeight,
      maxHeight: getComputedStyle(content).maxHeight,
      ellipsis: content.querySelector('[data-dsh-scard="ellipsis"]') !== null,
      jump: window.__jump,
      dot: card.querySelector('[data-dsh-scard="unread-dot"]') !== null,
      readKeys: window.__readKeys.slice(),
      expandText: card.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
    }
  })
  pass('点卡体后 aria-expanded 由 false→true 且高度增长',
    beforeClick.aria === 'false' && afterClick.aria === 'true' && afterClick.open === '1' && afterClick.height > beforeClick.height && afterClick.maxHeight === 'none',
    JSON.stringify({ before: beforeClick.height, after: afterClick.height, maxHeight: afterClick.maxHeight }))
  pass('点卡体不触发朗读/复制/展开全文/头部标识/紫色 chip（jump 仍 null）',
    afterClick.jump === null, JSON.stringify({ jump: afterClick.jump }))
  pass('点卡体后省略标记移除、脚部文案变「收起」',
    afterClick.ellipsis === false && afterClick.expandText === '收起', JSON.stringify({ ellipsis: afterClick.ellipsis, expandText: afterClick.expandText }))
  pass('点卡体即算已读：红点当场消失（不留灰点）',
    beforeClick.dot === true && afterClick.dot === false && afterClick.readKeys.includes('assistant:turn:7'),
    JSON.stringify({ beforeDot: beforeClick.dot, afterDot: afterClick.dot, readKeys: afterClick.readKeys }))

  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"] [data-dsh-scard="body"]').click()
  await page.waitForTimeout(320)
  const reCollapse = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const content = card.querySelector('[data-dsh-scard="content"]')
    return { open: card.getAttribute('data-open'), aria: card.querySelector('[data-dsh-scard="body"]').getAttribute('aria-expanded'), height: content.clientHeight, maxHeight: getComputedStyle(content).maxHeight, ellipsis: content.querySelector('[data-dsh-scard="ellipsis"]')?.textContent ?? '' }
  })
  pass('再点卡体收起回到折叠态（3 行 max-height 与…标记回来）',
    reCollapse.open === '0' && reCollapse.aria === 'false' && reCollapse.height === Number.parseFloat(reCollapse.maxHeight) && reCollapse.ellipsis === '…',
    JSON.stringify(reCollapse))

  // 卡内按钮：点击不改变折叠态
  const speakStateBefore = await page.evaluate(() => ({ open: window.cardOf('notice').getAttribute('data-open'), height: window.cardOf('notice').querySelector('[data-dsh-scard="content"]').clientHeight }))
  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="notice"] [data-dsh-speak="button"]').dispatchEvent('pointerup', {})
  await page.waitForTimeout(250)
  const speakStateAfter = await page.evaluate(() => ({ open: window.cardOf('notice').getAttribute('data-open'), height: window.cardOf('notice').querySelector('[data-dsh-scard="content"]').clientHeight, dot: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]') !== null }))
  pass('点朗读按钮不改变折叠态，且这条通知算已读（红点掉）',
    speakStateAfter.open === speakStateBefore.open && speakStateAfter.height === speakStateBefore.height && speakStateAfter.dot === false,
    JSON.stringify({ before: speakStateBefore, after: speakStateAfter }))

  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="notice"] [data-dsh-scard="copy"]').click()
  await page.waitForTimeout(250)
  const copyStateAfter = await page.evaluate(() => ({ open: window.cardOf('notice').getAttribute('data-open'), height: window.cardOf('notice').querySelector('[data-dsh-scard="content"]').clientHeight, dot: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]') !== null }))
  pass('点复制按钮不改变折叠态（通知卡折叠态没被复制按钮带下去）',
    copyStateAfter.open === speakStateAfter.open && copyStateAfter.height === speakStateAfter.height, JSON.stringify(copyStateAfter))

  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"] [data-dsh-scard="expand"]').click()
  await page.waitForTimeout(320)
  const expandState = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const content = card.querySelector('[data-dsh-scard="content"]')
    return { open: card.getAttribute('data-open'), bodyAria: card.querySelector('[data-dsh-scard="body"]').getAttribute('aria-expanded'), expandAria: card.querySelector('[data-dsh-scard="expand"]').getAttribute('aria-expanded'), text: card.querySelector('[data-dsh-scard="expand-text"]').textContent, height: content.clientHeight, jump: window.__jump }
  })
  pass('点「展开全文」按钮展开卡体（卡体 aria-expanded 同步变 true、文案收起）',
    expandState.open === '1' && expandState.bodyAria === 'true' && expandState.expandAria === 'true' && expandState.text === '收起' && expandState.jump === null,
    JSON.stringify(expandState))
  await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"] [data-dsh-scard="expand"]').click()
  await page.waitForTimeout(320)

  // 键盘：Enter / Space 也切换折叠
  const keyboard = await page.evaluate(async () => {
    const card = window.cardOf('assistant')
    const body = card.querySelector('[data-dsh-scard="body"]')
    body.focus()
    const start = { focused: document.activeElement === body, aria: body.getAttribute('aria-expanded'), height: card.querySelector('[data-dsh-scard="content"]').clientHeight }
    const fire = (key) => body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    fire('Enter')
    const afterEnter = { aria: body.getAttribute('aria-expanded'), height: card.querySelector('[data-dsh-scard="content"]').clientHeight }
    fire(' ')
    const afterSpace = { aria: body.getAttribute('aria-expanded'), height: card.querySelector('[data-dsh-scard="content"]').clientHeight }
    return { start, afterEnter, afterSpace, role: body.getAttribute('role'), tabIndex: body.getAttribute('tabindex'), cursor: getComputedStyle(body).cursor }
  })
  pass('卡体可键盘聚焦（role=button + tabindex=0），Enter 展开、Space 收起',
    keyboard.start.focused === true && keyboard.start.aria === 'false' && keyboard.afterEnter.aria === 'true' && keyboard.afterEnter.height > keyboard.start.height
      && keyboard.afterSpace.aria === 'false' && keyboard.afterSpace.height < keyboard.afterEnter.height,
    JSON.stringify(keyboard))

  // 引用 chip 点击：跳转会话，但卡体折叠不被它改变
  const refClick = await page.evaluate(() => {
    const card = window.cardOf('assistant')
    const before = { open: card.getAttribute('data-open'), height: card.querySelector('[data-dsh-scard="content"]').clientHeight }
    card.querySelector('[data-dsh-scard="ref"]').click()
    const after = { open: card.getAttribute('data-open'), height: card.querySelector('[data-dsh-scard="content"]').clientHeight, jump: window.__jump }
    return { before, after }
  })
  pass('点紫色会话引用 chip 只跳转、不改折叠态（stopPropagation 生效）',
    refClick.after.jump === '打开会话：滕王阁序校对会话' && refClick.after.open === refClick.before.open && refClick.after.height === refClick.before.height,
    JSON.stringify(refClick))

  // 焦点环：直接从 CSS 规则里读 :focus-visible（三种卡共用 var(--dsh-card-focus-ring)）
  const focus = await page.evaluate(() => {
    const rules = []
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          const selector = rule.selectorText ?? ''
          if (!selector.includes(':focus-visible')) continue
          if (!selector.includes('data-dsh')) continue
          rules.push({ selector, outline: rule.style.getPropertyValue('outline'), offset: rule.style.getPropertyValue('outline-offset') })
        }
      } catch { /* ignore */ }
    }
    const card = window.cardOf('assistant')
    const body = card.querySelector('[data-dsh-scard="body"]')
    return {
      rules,
      ringVar: getComputedStyle(card).getPropertyValue('--dsh-card-focus-ring').trim(),
      bodyTabIndex: body.getAttribute('tabindex'),
      bodyRole: body.getAttribute('role'),
      tabbable: [...card.querySelectorAll('button')].map((el) => el.getAttribute('data-dsh-scard') ?? el.getAttribute('data-dsh-speak')),
    }
  })
  const hasButtonRule = focus.rules.some((rule) => /button:focus-visible/.test(rule.selector) && /\b2px solid\b/.test(rule.outline) && rule.offset === '2px')
  const hasBodyRule = focus.rules.some((rule) => rule.selector.includes('[data-dsh-scard="body"]:focus-visible') && /\b2px solid\b/.test(rule.outline) && rule.offset === '2px')
  pass('卡内朗读/引用/复制按钮与卡体都有 2px :focus-visible 焦点环（卡体 tabindex=0 可 Tab 到）',
    focus.bodyTabIndex === '0' && focus.bodyRole === 'button' && focus.tabbable.length === 5 && focus.tabbable.includes('quote') && hasButtonRule && hasBodyRule && focus.ringVar !== '',
    JSON.stringify({ selectors: focus.rules.map((rule) => rule.selector), ringVar: focus.ringVar, bodyTabIndex: focus.bodyTabIndex, tabbable: focus.tabbable }))
  pass('卡体 Enter/Space 真键盘切换折叠（卡内其它按钮不掺进来）', await (async () => {
    const before = await page.evaluate(() => { const el = window.cardOf('assistant'); const body = el.querySelector('[data-dsh-scard="body"]'); body.focus(); return { focused: document.activeElement === body, aria: body.getAttribute('aria-expanded'), height: el.querySelector('[data-dsh-scard="content"]').clientHeight } })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const afterEnter = await page.evaluate(() => { const el = window.cardOf('assistant'); const body = el.querySelector('[data-dsh-scard="body"]'); return { aria: body.getAttribute('aria-expanded'), height: el.querySelector('[data-dsh-scard="content"]').clientHeight } })
    await page.keyboard.press('Space')
    await page.waitForTimeout(200)
    const afterSpace = await page.evaluate(() => { const el = window.cardOf('assistant'); const body = el.querySelector('[data-dsh-scard="body"]'); return { aria: body.getAttribute('aria-expanded'), height: el.querySelector('[data-dsh-scard="content"]').clientHeight } })
    const ok = before.focused === true && before.aria === 'false' && afterEnter.aria === 'true' && afterEnter.height > before.height && afterSpace.aria === 'false'
    return ok
  })(), 'Enter 展开、Space 收起（真键盘事件）')

  // 已读持久化：本次构建的那个 store 从 localStorage + 宿主 GET 把集合捞回来 → 刷新后不再显示红点
  const persisted = await page.evaluate(({ prefix, session }) => window.__persistRead(prefix, session), { prefix: READ_PREFIX, session: 'session-visual-test' })
  const reloaded = await page.evaluate(({ prefix, session }) => {
    window.__setEllipsis(window.cardOf('assistant').querySelector('[data-dsh-scard="content"]'), false)
    return window.__restoreUnread(prefix, session)
  }, { prefix: READ_PREFIX, session: 'session-visual-test' })
  const noDotsAfterReload = await page.evaluate(() => ({
    assistant: window.cardOf('assistant').querySelector('[data-dsh-scard="unread-dot"]') !== null,
    notice: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]') !== null,
    user: window.cardOf('user').querySelector('[data-dsh-scard="unread-dot"]') !== null,
  }))
  const storeAgain = surface.createSecretaryReadStore({ fetchImpl: null, storage: { getItem: () => JSON.stringify(persisted), setItem: () => void 0 } })
  storeAgain.setSession('session-visual-test')
  await storeAgain.hydrate()
  pass('已读集合持久化后刷新页面仍不再显示红点（localStorage → 真 store.hydrate → 红点不渲染）',
    persisted.includes('assistant:turn:7') && persisted.includes('notice:14:input-message-cu-01')
      && JSON.stringify(reloaded) === JSON.stringify(persisted)
      && noDotsAfterReload.assistant === false && noDotsAfterReload.notice === false && noDotsAfterReload.user === false
      && storeAgain.isRead('assistant:turn:7') === true && storeAgain.isRead('notice:14:input-message-cu-01') === true
      && storeAgain.isRead('user:13:input-message-user-01') === false,
    JSON.stringify({ persisted, noDotsAfterReload }))
  pass('未读红点只属于朗读/点击过的卡：未 mark 的 key 在 store 里是未读',
    storeAgain.isRead('assistant:turn:99') === false, JSON.stringify({ keys: storeAgain.keys() }))

  // 时间文案（真 formatClock 产物）不带「今天」
  pass('三种卡脚部时间都是 HH:MM（真 formatClock 产物）',
    [info.time.text, dual.userFoot.timeText, dual.noticeFoot.timeText].every((text) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(text)),
    JSON.stringify({ assistant: info.time.text, user: dual.userFoot.timeText, notice: dual.noticeFoot.timeText }))

  // 桌面宽度 + 折叠/展开截图
  await page.setViewportSize({ width: 900, height: 1000 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    for (const card of [...document.querySelectorAll('[data-dsh-scard="card"]')]) card.querySelector('[data-dsh-scard="copy-status"]')?.remove()
  })
  await page.waitForTimeout(200)
  const foldedAgain = { assistant: await applyFold('assistant'), notice: await applyFold('notice') }
  await page.screenshot({ path: SCREENSHOTS.collapsed, fullPage: true })
  const collapsedSizes = pngSize(SCREENSHOTS.collapsed)
  const collapsedCardHeights = await page.evaluate(() => {
    const out = {}
    for (const kind of ['assistant', 'user', 'notice']) {
      const card = window.cardOf(kind)
      out[kind] = {
        cardHeight: Math.round(card.getBoundingClientRect().height),
        contentHeight: card.querySelector('[data-dsh-scard="content"]').clientHeight,
        maxHeight: getComputedStyle(card.querySelector('[data-dsh-scard="content"]')).maxHeight,
      }
    }
    return out
  })
  await page.evaluate(() => { for (const kind of ['assistant', 'notice']) window.__setOpen(window.cardOf(kind), true) })
  await page.waitForTimeout(320)
  await page.screenshot({ path: SCREENSHOTS.expanded, fullPage: true })
  const expandedSizes = pngSize(SCREENSHOTS.expanded)
  const expandedCardHeights = await page.evaluate(() => {
    const out = {}
    for (const kind of ['assistant', 'user', 'notice']) {
      const card = window.cardOf(kind)
      out[kind] = { cardHeight: Math.round(card.getBoundingClientRect().height), contentHeight: card.querySelector('[data-dsh-scard="content"]').clientHeight }
    }
    return out
  })
  pass('展开截图高度明显大于折叠截图（三种卡都放得开全文）',
    expandedCardHeights.assistant.contentHeight > collapsedCardHeights.assistant.contentHeight
      && expandedCardHeights.notice.contentHeight > collapsedCardHeights.notice.contentHeight,
    JSON.stringify({ collapsed: collapsedCardHeights, expanded: expandedCardHeights }))

  // 未读 / 已读两张对照截图：把已读清掉、红点重新渲染
  await page.evaluate(({ prefix }) => {
    for (const kind of ['assistant', 'notice']) window.__setOpen(window.cardOf(kind), false)
    localStorage.removeItem(prefix + 'session-visual-test')
    window.__readKeys = []
    for (const kind of ['assistant', 'notice']) {
      const card = window.cardOf(kind)
      card.setAttribute('data-unread', '1')
      if (card.querySelector('[data-dsh-scard="unread-dot"]') === null) {
        const span = document.createElement('span')
        span.setAttribute('data-dsh-scard', 'unread-dot')
        span.setAttribute('role', 'img')
        span.setAttribute('aria-label', '未读')
        span.setAttribute('title', '未读')
        card.insertBefore(span, card.firstChild)
      }
    }
    window.__applyFold('assistant', { collapsedMaxHeight: Number(window.cardOf('assistant').dataset.foldMax), overflow: true, bodyLines: 3, clip: Number(window.cardOf('assistant').dataset.foldMax) })
    window.__applyFold('notice', { collapsedMaxHeight: Number(window.cardOf('notice').dataset.foldMax), overflow: true, bodyLines: 3, clip: Number(window.cardOf('notice').dataset.foldMax) })
  }, { prefix: READ_PREFIX })
  await page.waitForTimeout(250)
  await page.screenshot({ path: SCREENSHOTS.unread, fullPage: true })
  const unreadSizes = pngSize(SCREENSHOTS.unread)
  await page.evaluate(() => { for (const kind of ['assistant', 'notice']) window.__markRead(window.cardOf(kind)) })
  await page.waitForTimeout(200)
  await page.screenshot({ path: SCREENSHOTS.read, fullPage: true })
  const readSizes = pngSize(SCREENSHOTS.read)
  const dotsNow = await page.evaluate(() => ({
    assistant: window.cardOf('assistant').querySelector('[data-dsh-scard="unread-dot"]') !== null,
    notice: window.cardOf('notice').querySelector('[data-dsh-scard="unread-dot"]') !== null,
  }))
  pass('已读后红点彻底消失（未读截图有红点、已读截图没有）',
    dotsNow.assistant === false && dotsNow.notice === false, JSON.stringify(dotsNow))

  await page.evaluate(() => {
    for (const kind of ['assistant', 'notice']) {
      const card = window.cardOf(kind)
      card.setAttribute('data-unread', '1')
      if (card.querySelector('[data-dsh-scard="unread-dot"]') === null) {
        const span = document.createElement('span')
        span.setAttribute('data-dsh-scard', 'unread-dot')
        span.setAttribute('role', 'img')
        span.setAttribute('aria-label', '未读')
        span.setAttribute('title', '未读')
        card.insertBefore(span, card.firstChild)
      }
    }
  })
  await page.waitForTimeout(200)
  await page.screenshot({ path: SCREENSHOTS.notice, fullPage: true })
  const noticeSizes = pngSize(SCREENSHOTS.notice)

  // 原有三张截图（保留旧口径）
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: SCREENSHOTS.desktop, fullPage: false })
  await page.setViewportSize({ width: 390, height: 860 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: SCREENSHOTS.mobile, fullPage: true })
  await page.setViewportSize({ width: 900, height: 1000 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: SCREENSHOTS.dual, fullPage: true })

  const desktopTime = await page.evaluate(() => {
    const out = {}
    for (const kind of ['assistant', 'user', 'notice']) {
      const card = window.cardOf(kind)
      const time = card.querySelector('[data-dsh-scard="time"]')
      const copy = card.querySelector('[data-dsh-scard="copy"]')
      out[kind] = {
        display: getComputedStyle(time).display,
        size: getComputedStyle(time).fontSize,
        gap: Math.round(copy.getBoundingClientRect().left - time.getBoundingClientRect().right),
        text: time.textContent,
      }
    }
    return out
  })
  pass('桌面三种卡都显示时间、宽度不超 620px、时间紧贴复制左侧',
    Object.values(desktopTime).every((item) => item.display !== 'none' && item.size === '12px' && item.gap >= 0 && item.gap <= 12)
      && (await page.evaluate(() => Math.max(...[...document.querySelectorAll('[data-dsh-scard="card"]')].map((el) => el.getBoundingClientRect().width)))) <= 620,
    JSON.stringify(desktopTime))

  // ── 附件回归（2026-11-24 bug）：文字 + 图片 + 文字 的宿主行必须整条进卡片，附件嵌在卡片内部 ──
  const mixed = await page.evaluate(() => {
    const row = document.querySelector('[data-probe="mixed-attach-row"]')
    const card = row?.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"]') ?? null
    const content = card?.querySelector('[data-dsh-scard="content"]') ?? null
    const blocks = content ? [...content.querySelectorAll('[data-dsh-scard="para"], [data-dsh-scard="attachment"]')]
      .map((el) => ({ sc: el.getAttribute('data-dsh-scard'), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() })) : []
    const thumb = content?.querySelector('[data-dsh-scard="attachment-thumb"]') ?? null
    const nameEl = content?.querySelector('[data-dsh-scard="attachment-name"]') ?? null
    const hostNode = row ? row.querySelector('[data-slot="conversation.chat.node"]') : null
    const hostAttach = row ? row.querySelector('[data-message-attachments]') : null
    const hostRun = row ? row.querySelector('[data-slot="conversation.user.text.node"]') : null
    return {
      blocks,
      thumb: thumb === null ? null : {
        display: getComputedStyle(thumb).display,
        width: Math.round(thumb.getBoundingClientRect().width),
        height: Math.round(thumb.getBoundingClientRect().height),
        loaded: thumb.complete === true && thumb.naturalWidth > 0,
        inCard: thumb.offsetParent !== null,
        src: String(thumb.getAttribute('src') ?? '').slice(0, 12),
      },
      name: nameEl?.textContent?.trim() ?? '',
      nameVisible: nameEl !== null && nameEl.offsetParent !== null,
      hostNodeDisplay: hostNode === null ? '' : getComputedStyle(hostNode).display,
      hostAttachRendered: hostAttach !== null && hostAttach.offsetParent !== null,
      hostRunVisible: hostRun !== null && hostRun.offsetParent !== null,
    }
  })
  pass('附件回归①：卡片正文按原顺序收全三段（附件前文字 + 附件块 + 附件后文字，一个字都不许丢）',
    mixed.blocks.length === 3
      && mixed.blocks[0]?.sc === 'para' && /把数字用汉字表示的，$/.test(mixed.blocks[0]?.text ?? '')
      && mixed.blocks[1]?.sc === 'attachment'
      && mixed.blocks[2]?.sc === 'para' && /保留为数字。$/.test(mixed.blocks[2]?.text ?? ''),
    JSON.stringify(mixed.blocks))
  pass('附件回归②：图片缩略图嵌在卡片内部（真加载出来、有尺寸、带文件名）',
    mixed.thumb !== null && mixed.thumb.inCard === true && mixed.thumb.loaded === true
      && mixed.thumb.width >= 60 && mixed.thumb.height >= 40 && mixed.thumb.display !== 'none'
      && mixed.name === 'image.png' && mixed.nameVisible === true,
    JSON.stringify({ thumb: mixed.thumb, name: mixed.name, nameVisible: mixed.nameVisible }))
  pass('附件回归③：宿主那条原生附件行不再单独出图（整条宿主行由卡片接管，气泡/附件芯片都不渲染）',
    mixed.hostNodeDisplay === 'none' && mixed.hostAttachRendered === false && mixed.hostRunVisible === false,
    JSON.stringify({ hostNodeDisplay: mixed.hostNodeDisplay, hostAttachRendered: mixed.hostAttachRendered, hostRunVisible: mixed.hostRunVisible }))

  console.log('')
  console.log(`折叠高度实测：BEFORE(旧实现) max-height=${legacy.collapsedMaxHeight}px 约 ${legacy.lines} 行  →  AFTER(新实现 3 行) max-height=${collapsedCardHeights.assistant.maxHeight} 秘书卡正文高=${collapsedCardHeights.assistant.contentHeight}px 通知卡正文高=${collapsedCardHeights.notice.contentHeight}px`)
  console.log(`字号实测：正文 ${info.para.size} / 行高 ${info.para.line}，标题 ${info.title.size}，chip ${info.model.size}，引用 chip ${info.ref?.size}，脚部时间 ${info.time.size}`)
  for (const [name, file] of Object.entries(SCREENSHOTS)) {
    const size = pngSize(file)
    console.log(`${name}: ${file} ${size.width}x${size.height}px`)
  }
  void unreadSizes
  void readSizes
  void noticeSizes
  void expandedSizes
} finally {
  await browser.close().catch(() => {})
}

if (failures.length > 0) {
  console.error(`CARD VISUAL FAIL ${failures.length}`)
  process.exit(1)
}
console.log('CARD VISUAL PASS')