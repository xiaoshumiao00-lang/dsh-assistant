/**
 * 秘书回复卡「附件标记 + 打开方式」离线单测（2026-11-26 需求）。
 *
 * 验四件事：
 *   1. `[[attach:<绝对路径>|<显示名>]]` 的解析与剔除（同一轮重复路径去重、显示名兜底、朗读文本不许带路径）；
 *   2. 卡片上那几种展示口径：图片扩展名判定、类型角标、大小文案、只读文件路由地址的编码；
 *   3. `/api/worktable/file` 的 content-disposition 组装（图片/pdf/svg/文本 inline，docx/xlsx/pptx/zip 等 attachment，
 *      中文名走 RFC 5987 的 filename*，ASCII 兜底不夹 CR/LF）；
 *   4. 渲染层与样式层确实接上了：卡片有附件区（data-dsh-scard="attachments"）、CSS 有缩略图与 44px 触控目标、
 *      秘书提示词第八条写明了标记格式。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
const disposition = lib.fileDispositionTestSurface
const secretary = lib.assistantSecretaryTestSurface

let failures = 0
function case_(name, fn) {
  try { fn(); console.log('PASS', name) } catch (error) { failures++; console.error('FAIL', name, error?.message ?? error) }
}

/* ---------- 1. 解析 / 剔除 ---------- */

case_('exports attach ref surface', () => {
  for (const name of ['parseAttachRefs', 'stripAttachRefs', 'isAttachImage', 'attachTypeBadge', 'attachFileUrl', 'formatFileSize', 'attachExtensionOf', 'ATTACH_IMAGE_EXTENSIONS']) {
    assert.equal(typeof surface[name] !== 'undefined', true, `secretaryCardsTestSurface 必须有 ${name}`)
  }
})

case_('parseAttachRefs 解析路径与显示名', () => {
  const refs = surface.parseAttachRefs('结论一行\n[[attach:D:\\dsh-assistant\\docs\\报告.docx|申报书 v4.docx]]')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].path, 'D:\\dsh-assistant\\docs\\报告.docx')
  assert.equal(refs[0].name, '申报书 v4.docx')
})

case_('parseAttachRefs 同一轮重复路径去重（正反斜杠、大小写视为同一条）', () => {
  const refs = surface.parseAttachRefs([
    '[[attach:D:\\A\\b.png|第一张]]',
    '[[attach:d:/a/B.PNG|重复的同一张]]',
    '[[attach:D:\\A\\c.docx|另一个文件]]',
  ].join('\n'))
  assert.equal(refs.length, 2, '同一路径只留第一条')
  assert.equal(refs[0].name, '第一张')
  assert.equal(refs[1].path, 'D:\\A\\c.docx')
})

case_('parseAttachRefs 显示名缺省取文件名、空路径忽略', () => {
  const refs = surface.parseAttachRefs('[[attach:D:\\out\\无名字.pdf]] [[attach: |空路径]]')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].path, 'D:\\out\\无名字.pdf')
  assert.equal(refs[0].name, '无名字.pdf')
  assert.deepEqual(surface.parseAttachRefs('没有附件'), [])
})

case_('stripAttachRefs 剔除标记但保留正文', () => {
  const raw = '第一行结论\n\n详情一段。\n[[attach:D:\\x\\图.png|图.png]]'
  assert.equal(surface.stripAttachRefs(raw).trim(), '第一行结论\n\n详情一段。')
  assert.equal(surface.stripAttachRefs(raw).includes('[['), false)
  assert.equal(surface.stripAttachRefs(raw).includes('D:\\x'), false)
})

case_('朗读文本不含附件标记与路径（TTS 不许念路径）', () => {
  const speech = surface.normalizeForSpeech('已生成报告。\n[[attach:D:\\dsh-assistant\\docs\\报告.docx|报告.docx]]')
  assert.equal(speech.includes('[['), false, '朗读文本不许留标记')
  assert.equal(speech.includes('D:'), false, '朗读文本不许留盘符路径')
  assert.equal(speech.includes('已生成报告'), true, '正文照旧要念')
})

case_('老会话引用标记与新附件标记互不干扰', () => {
  const raw = '看这条 [[session:session-abc|老会话]] 和这个文件 [[attach:D:\\a\\b.docx|b.docx]]'
  assert.deepEqual(surface.parseSessionRefs(raw).map((ref) => ref.sessionId), ['session-abc'])
  assert.deepEqual(surface.parseAttachRefs(raw).map((ref) => ref.path), ['D:\\a\\b.docx'])
  const stripped = surface.stripSessionRefs(surface.stripAttachRefs(raw))
  assert.equal(stripped.includes('[['), false)
})

/* ---------- 2. 卡片展示口径 ---------- */

case_('图片扩展名判定', () => {
  for (const path of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.svg']) {
    assert.equal(surface.isAttachImage(`D:\\x\\${path}`), true, `${path} 应走缩略图`)
  }
  for (const path of ['a.docx', 'a.pdf', 'a.zip', 'a.xlsx', 'noext']) {
    assert.equal(surface.isAttachImage(`D:\\x\\${path}`), false, `${path} 应走文件条`)
  }
})

case_('类型角标与扩展名', () => {
  assert.equal(surface.attachExtensionOf('D:\\x\\报告.DOCX'), 'docx')
  assert.equal(surface.attachTypeBadge('D:\\x\\报告.docx'), 'DOCX')
  assert.equal(surface.attachTypeBadge('D:\\x\\图.jpeg'), 'JPG')
  assert.equal(surface.attachTypeBadge('D:\\x\\没有扩展名'), '文件')
  assert.equal(surface.attachExtensionOf('D:\\x\\尾点.'), '')
})

case_('只读文件路由地址：绝对路径整体 encodeURIComponent', () => {
  assert.equal(
    surface.attachFileUrl('D:\\dsh-assistant\\docs\\报告 v4.docx'),
    '/api/worktable/file?path=' + encodeURIComponent('D:\\dsh-assistant\\docs\\报告 v4.docx'),
  )
  // 反斜杠与中文都被编码，查询串里不会出现裸空格
  assert.equal(surface.attachFileUrl('D:\\a b\\c.png').includes(' '), false)
})

case_('文件大小文案', () => {
  assert.equal(surface.formatFileSize(0), '0 B')
  assert.equal(surface.formatFileSize(520), '520 B')
  assert.equal(surface.formatFileSize(2048), '2.0 KB')
  assert.equal(surface.formatFileSize(5 * 1024 * 1024), '5.0 MB')
  assert.equal(surface.formatFileSize(Number.NaN), '')
})

/* ---------- 3. content-disposition ---------- */

case_('content-disposition：图片/pdf/svg/文本 inline，其余 attachment', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'txt', 'md']) {
    assert.equal(disposition.fileDispositionType(ext), 'inline', `${ext} 应 inline`)
  }
  for (const ext of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'zip', 'rar', 'exe', '']) {
    assert.equal(disposition.fileDispositionType(ext), 'attachment', `${ext || '无扩展名'} 应 attachment`)
  }
})

case_('content-disposition：中文名走 RFC 5987，ASCII 兜底不含非 ASCII', () => {
  const value = disposition.contentDispositionHeaderFor('D:\\dsh-assistant\\docs\\中文报告.docx')
  assert.match(value, /^attachment; filename="[^"]+"; filename\*=UTF-8''/, 'docx 必须 attachment + filename*')
  assert.equal(value.includes('filename*=UTF-8\'\'' + encodeURIComponent('中文报告.docx')), true, 'filename* 是百分号编码的原文件名')
  assert.equal(value.includes('中文报告.docx'), false, 'ASCII 那份不许直接塞中文')
  assert.match(value, /filename="_{4}\.docx"/, 'ASCII 兜底按字符换成下划线')
})

case_('content-disposition：图片是 inline 且文件名照原样传', () => {
  const value = disposition.contentDispositionValue('D:\\x\\图 1.png')
  assert.match(value, /^inline; filename="/, '图片要 inline（标签页里直接看）')
  assert.equal(value.endsWith("filename*=UTF-8''" + encodeURIComponent('图 1.png')), true)
})

case_('content-disposition：RFC 5987 保留字符额外编码，CR/LF 注入被挡', () => {
  const value = disposition.contentDispositionValue("D:\\x\\it's(1).pdf")
  const encodedPart = value.slice(value.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length)
  assert.equal(encodedPart.includes("'"), false, '单引号必须编码成 %27（RFC 5987）')
  assert.equal(encodedPart.includes('('), false, '括号也按 RFC 5987 编码')
  const injected = disposition.contentDispositionValue('D:\\x\\a\r\nSet-Cookie: x=1.txt')
  assert.equal(injected.includes('\r'), false, '响应头里不许出现 CR')
  assert.equal(injected.includes('\n'), false, '响应头里不许出现 LF')
})

/* ---------- 4. 渲染层 / 样式层 / 提示词确实接上了 ---------- */

case_('卡片渲染层：附件区在折叠区之外、走只读文件路由', () => {
  const card = readFileSync(join(ROOT, 'src/client/pocket/orb/SecretaryReplyCard.tsx'), 'utf8')
  assert.equal(card.includes('parseAttachRefs(body)'), true, '卡片要解析附件标记')
  assert.equal(card.includes('stripAttachRefs(stripSessionRefs(body))'), true, '展示文本必须剔除附件标记')
  assert.equal(card.includes('data-dsh-scard="attachments"'), true, '必须有附件区容器')
  assert.equal(/attachFileUrl\(attachment\.path\)/.test(card), true, '点开要走 /api/worktable/file')
  assert.equal(card.includes("window.open(url, '_blank')"), true, '点开是新标签页打开')
  assert.equal(card.includes('loading="lazy"'), true, '缩略图必须 lazy')
  // 附件区必须在折叠区（foldProps 那个 div）之后、脚部之前，且不拿 mainRef
  const foldEnd = card.indexOf('{overflow && !open && <span data-dsh-scard="ellipsis"')
  const attachAt = card.indexOf('data-dsh-scard="attachments"')
  const footAt = card.indexOf('data-dsh-scard="foot"')
  assert.equal(foldEnd > 0 && attachAt > foldEnd, true, '附件区要排在折叠区之后')
  assert.equal(footAt > attachAt, true, '附件区要排在脚部之前')
  const attachBlock = card.slice(attachAt, footAt)
  assert.equal(attachBlock.includes('ref={mainRef}'), false, '附件区不许进折叠测量')
})

case_('卡片渲染层：折叠卡兜底文本也用剔除标记后的正文', () => {
  const card = readFileSync(join(ROOT, 'src/client/pocket/orb/SecretaryReplyCard.tsx'), 'utf8')
  assert.match(card, /fallbackText=\{display\}/, '折叠行兜底文本必须用 display（已剔除附件标记）')
})

case_('样式层：缩略图最大高 180px、文件条 44px 触控目标、≤520px 有手机档', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css, /\[data-dsh-scard="attachments"\]/, '附件区样式要用 data-dsh-scard 属性选择器')
  assert.match(css, /\[data-dsh-scard="attach-thumb"\][\s\S]{0,200}max-height:\s*180px/, '缩略图最大高 180px')
  assert.match(css, /\[data-dsh-scard="attach-file"\][\s\S]{0,220}min-height:\s*44px/, '文件条触控高度 ≥44px')
  assert.match(css, /\[data-dsh-scard="attach-thumb"\][\s\S]{0,120}object-fit:\s*cover/, '缩略图超出裁剪')
  assert.match(css, /@media \(max-width: 520px\)[\s\S]{0,400}attach-thumb/, '手机档样式要有缩略图')
})

case_('秘书提示词第八条：交付物用 [[attach:绝对路径|显示名]]，正文不贴裸路径', () => {
  const text = secretary.SECRETARY_SPEECH_STYLE_TEXT
  assert.match(text, /八、交付文件或图片时/, '提示词必须有一条讲附件标记')
  assert.match(text, /\[\[attach:绝对路径\|显示名\]\]/, '标记格式要写清')
  assert.match(text, /正文里不要再贴裸路径/, '正文不许贴裸路径')
  assert.match(text, /没有交付物就不写这一行/, '没有交付物不写标记')
  // 原有七条编号顺序不许动（新口径只往后加）
  for (const n of ['一、', '二、', '三、', '四、', '五、', '六、', '七、']) {
    assert.equal(text.includes(n), true, `${n} 条还在`)
  }
})

process.exit(failures === 0 ? 0 : 1)
