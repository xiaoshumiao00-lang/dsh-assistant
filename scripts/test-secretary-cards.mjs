/**
 * 秘书卡片共享逻辑单测（纯函数 + 状态机 + 控制器，不启动浏览器/宿主）：
 *   node scripts/test-secretary-cards.mjs
 *
 * 覆盖（对应需求逐条）：
 *   ① 朗读文本规范化：去 markdown/列表/表情/代码块，单位与区间念读（8–14℃ → 8 到 14 摄氏度）；
 *   ② 会话引用解析 [[session:id|标题]] 与朗读剔除；
 *   ③ 朗读状态机：play/playing/pause/resume/toggle/restart/ended/error/stop；
 *   ④ 控制器：默认播放、暂停继续、长按重读、**切 key 停上一条**（只读当前卡片）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
const cardShared = lib.secretCardSharedTestSurface

const cases = []

cases.push(['朗读规范化：markdown / 列表 / 表情 / 代码块全去掉', () => {
  const raw = '## 结论\n- **带伞**\n- 外套\n`code` 和 😀 不要\n```\nblock\n```'
  const out = surface.normalizeForSpeech(raw)
  assert.match(out, /结论/)
  assert.match(out, /带伞/)
  assert.match(out, /外套/)
  assert.ok(!out.includes('**'), '加粗符号被去掉')
  assert.ok(!out.includes('`'), '代码围栏被去掉')
  assert.ok(!out.includes('##'), '标题符被去掉')
  assert.ok(!out.includes('😀'), '表情被去掉')
}])

cases.push(['朗读规范化：单位与区间念读（8–14℃ → 8 到 14 摄氏度）', () => {
  assert.match(surface.normalizeForSpeech('武汉明日 8–14℃'), /8 到 14 摄氏度/)
  assert.match(surface.normalizeForSpeech('高 1.72m，重 70kg'), /1.72 米/)
  assert.match(surface.normalizeForSpeech('高 1.72m，重 70kg'), /70 公斤/)
  assert.match(surface.normalizeForSpeech('时速 60km/h'), /60 公里每小时/)
}])

cases.push(['朗读规范化：引用标记不念出来', () => {
  const raw = '材料在 [[session:s1|高珂中文论文]] 里，记得看。'
  const out = surface.normalizeForSpeech(raw)
  assert.ok(!out.includes('[['), '引用标记被剔除')
  assert.match(out, /材料在/)
  assert.match(out, /里，记得看/)
}])

cases.push(['引用解析：[[session:id|标题]] 逐条解析', () => {
  const refs = surface.parseSessionRefs('A [[session:s1|高珂中文论文]] B [[session:s2|]] C')
  assert.deepEqual(refs, [
    { sessionId: 's1', title: '高珂中文论文' },
    { sessionId: 's2', title: 's2' },
  ])
  assert.deepEqual(surface.parseSessionRefs('没有引用'), [])
}])

cases.push(['状态机：play → playing → 暂停/继续 → 播完回 idle', () => {
  const idle = surface.SPEECH_IDLE
  let s = surface.reduceSpeech(idle, { type: 'play', key: 't1' })
  assert.deepEqual(s.status, 'loading')
  s = surface.reduceSpeech(s, { type: 'playing', key: 't1' })
  assert.equal(s.status, 'playing')
  s = surface.reduceSpeech(s, { type: 'pause' })
  assert.equal(s.status, 'paused')
  s = surface.reduceSpeech(s, { type: 'resume' })
  assert.equal(s.status, 'playing')
  s = surface.reduceSpeech(s, { type: 'ended' })
  assert.deepEqual(s, idle)
}])

cases.push(['状态机：toggle 在 playing/paused 间切换，换 key 重新 loading', () => {
  let s = { status: 'playing', key: 't1', error: '' }
  s = surface.reduceSpeech(s, { type: 'toggle', key: 't1' })
  assert.equal(s.status, 'paused')
  s = surface.reduceSpeech(s, { type: 'toggle', key: 't1' })
  assert.equal(s.status, 'playing')
  s = surface.reduceSpeech(s, { type: 'toggle', key: 't2' })
  assert.equal(s.status, 'loading')
  assert.equal(s.key, 't2')
}])

cases.push(['状态机：restart 回 loading；error 记原因；stop 回 idle', () => {
  let s = { status: 'paused', key: 't1', error: '' }
  s = surface.reduceSpeech(s, { type: 'restart', key: 't1' })
  assert.equal(s.status, 'loading')
  s = surface.reduceSpeech(s, { type: 'error', error: 'TTS 503' })
  assert.equal(s.status, 'error')
  assert.equal(s.error, 'TTS 503')
  s = surface.reduceSpeech(s, { type: 'stop' })
  assert.deepEqual(s, surface.SPEECH_IDLE)
}])

cases.push(['控制器：播放/暂停/继续/重读，播放器方法按序被调', async () => {
  const calls = []
  const player = {
    play: async () => { calls.push('play') },
    pause: () => { calls.push('pause') },
    resume: () => { calls.push('resume') },
    restart: () => { calls.push('restart') },
    stop: () => { calls.push('stop') },
    onEnded: (cb) => { player._ended = cb },
  }
  const ctl = surface.createSpeechController(() => player)
  ctl.request('t1', '你好')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(ctl.getSnapshot().status, 'playing')
  ctl.toggle('t1', '你好')
  assert.equal(ctl.getSnapshot().status, 'paused')
  ctl.toggle('t1', '你好')
  assert.equal(ctl.getSnapshot().status, 'playing')
  ctl.restart('t1', '你好')
  assert.equal(ctl.getSnapshot().status, 'loading')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['play', 'pause', 'resume', 'restart'])
}])

cases.push(['控制器：换 key（切卡片）先停上一条、只读当前卡片', async () => {
  const players = []
  const make = () => {
    const p = {
      stopped: false,
      play: async () => {},
      pause: () => {},
      resume: () => {},
      restart: () => {},
      stop: () => { p.stopped = true },
      onEnded: () => {},
    }
    players.push(p)
    return p
  }
  const ctl = surface.createSpeechController(make)
  ctl.request('t1', '第一条')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(players.length, 1)
  ctl.request('t2', '第二条')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(players.length, 2)
  assert.equal(players[0].stopped, true, '上一条被停止')
  assert.equal(ctl.getSnapshot().key, 't2')
  assert.equal(ctl.getSnapshot().status, 'playing')
}])

cases.push(['控制器：toggle 必须用传入文本（历史卡点击不回退到最新一条）', async () => {
  const received = []
  const make = (key, text) => {
    const p = {
      play: async () => { received.push([key, text]) },
      pause: () => {},
      resume: () => {},
      restart: () => {},
      stop: () => {},
      onEnded: () => {},
    }
    return p
  }
  const ctl = surface.createSpeechController(make)
  // 模拟「自动朗读最末一轮」（pendingText 因此 = 最新一条的文本）
  ctl.request('turn:9', '最新一条：武汉明天下雨')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(received[0], ['turn:9', '最新一条：武汉明天下雨'])
  // 点历史卡 toggle：必须读历史卡自己的文本，绝不能是 pendingText
  ctl.toggle('turn:2', '第一条：天气 8 到 14 度')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(received[1], ['turn:2', '第一条：天气 8 到 14 度'], '历史卡读的是自己的文本')
  assert.equal(ctl.getSnapshot().key, 'turn:2')
  // 点另一张卡：读第二张自己的文本
  ctl.toggle('turn:3', '第二条：车次 G1545')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(received[2], ['turn:3', '第二条：车次 G1545'])
  // 状态机语义不变：同 key playing 时 toggle = 暂停，再 toggle = 继续（不传新文本也不重启）
  ctl.toggle('turn:3', '第二条：车次 G1545')
  assert.equal(ctl.getSnapshot().status, 'paused')
  assert.equal(received.length, 3, '暂停不产生新的 TTS 请求')
  ctl.toggle('turn:3', '第二条：车次 G1545')
  assert.equal(ctl.getSnapshot().status, 'playing')
  assert.equal(received.length, 3, '继续也不产生新的 TTS 请求')
  // 长按从头读：换卡长按时也必须读所按卡片自己的文本
  ctl.restart('turn:2', '第一条：天气 8 到 14 度')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(received[3], ['turn:2', '第一条：天气 8 到 14 度'])
  assert.equal(ctl.getSnapshot().key, 'turn:2')
}])

cases.push(['控制器：长按重读 → loading → onPlaying 回到 playing', async () => {
  const p = {
    play: async () => {},
    pause: () => {},
    resume: () => {},
    restart: () => { p._playing?.() },
    stop: () => {},
    onEnded: () => {},
    onPlaying(cb) { p._playing = cb },
  }
  const ctl = surface.createSpeechController(() => p)
  ctl.request('t1', '你好')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(ctl.getSnapshot().status, 'playing')
  // 状态机层面 restart 先回 loading（reduceSpeech 已单测）；这里验证整条链路
  // 播放器 restart 后由 onPlaying 把状态带回 playing（fake 里同步触发）
  ctl.restart('t1', '你好')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(ctl.getSnapshot().status, 'playing', 'onPlaying 把状态带回 playing')
  assert.equal(ctl.getSnapshot().key, 't1')
}])

cases.push(['胶囊色调：按类型词归类（关心/完成/探索/授权/默认服务）', () => {
  assert.equal(surface.badgeTone('主动服务', '主动关心 · 明日武汉出差'), 'care')
  assert.equal(surface.badgeTone('主动服务', '任务完成 · 备份已归档'), 'done')
  assert.equal(surface.badgeTone('主动服务', '主动探索 · 新文献'), 'explore')
  assert.equal(surface.badgeTone('征求授权', '需要你确认'), 'auth')
  assert.equal(surface.badgeTone('主动服务', '每日汇总'), 'serve')
  assert.equal(surface.badgeTone('', ''), 'serve')
}])

cases.push(['要点拆分：「天气：…」前缀加粗，无冒号整行是值', () => {
  assert.deepEqual(surface.splitItemPrefix('天气：武汉明日 8–14℃'), { prefix: '天气：', rest: '武汉明日 8–14℃' })
  assert.deepEqual(surface.splitItemPrefix('10:30 实验室开会'), { prefix: '', rest: '10:30 实验室开会' })
  assert.deepEqual(surface.splitItemPrefix(''), { prefix: '', rest: '' })
}])

cases.push(['要点图标：天气/车次/时间/地点关键词，默认小圆点', () => {
  assert.equal(surface.itemIcon('天气：多云'), '🌤')
  assert.equal(surface.itemIcon('车次：G1545'), '🚄')
  assert.equal(surface.itemIcon('时间：10:30'), '🕐')
  assert.equal(surface.itemIcon('地点：华工'), '📍')
  assert.equal(surface.itemIcon('建议带伞'), '·')
}])

cases.push(['一句话摘要：首行截断加省略号', () => {
  assert.equal(surface.summarize('明天去武汉开会。\n第二段'), '明天去武汉开会。')
  assert.equal(surface.summarize('一二三四五六七八九〇一二三四五六七八九〇一二三四五六七八九〇'), '一二三四五六七八九〇一二三四五六七八九〇一二…')
  assert.equal(surface.summarize(''), '')
}])

cases.push(['卡片时间：卡脚只写 HH:MM（去「今天」字样）、昨天/更早仍带日期、非法输入为空', () => {
  const now = new Date(2026, 10, 21, 12, 0)
  assert.equal(surface.formatClock('2026-11-21T07:40:00', now), '7:40')
  assert.equal(surface.formatClock('2026-11-21T09:08:00', now), '9:08')
  assert.equal(surface.formatClock('2026-11-20T23:05:00', now), '昨天 23:05')
  assert.equal(surface.formatClock('2026-11-18T08:30:00', now), '11月18日 8:30')
  assert.equal(surface.formatClock('not-a-date', now), '')
  assert.equal(surface.formatClock('', now), '')
  assert.equal(surface.formatClock(null, now), '')
  // 组件送的是 epoch 字符串（SecretaryReplyCard 用它量 turn 结束时间）
  assert.equal(surface.formatClock(String(new Date(2026, 10, 21, 9, 8).getTime()), now), '9:08')
}])

cases.push(['自动朗读目标：空白合成尾轮不能挡住最近一条真实回复', () => {
  const el = (turn, empty = '0') => ({ getAttribute: (name) => name === 'data-dsh-scard-turn' ? turn : name === 'data-empty' ? empty : null })
  const doc = { querySelectorAll: () => [el('8'), el('10'), el('11', '1')] }
  assert.equal(surface.latestReplyTurnNo(doc), '10')
}])

cases.push(['卡片正文保留宿主的重点句：<strong> 还原成 **…**', () => {
  const step = {
    nodeType: 1,
    tagName: 'P',
    getAttribute: () => null,
    childNodes: [
      { nodeType: 3, textContent: '型号 ' },
      { nodeType: 1, tagName: 'STRONG', childNodes: [{ nodeType: 3, textContent: '重点' }] },
      { nodeType: 3, textContent: '。' },
    ],
  }
  const doc = { querySelectorAll: () => [step] }
  assert.equal(surface.collectTurnText(doc, '3'), '型号 **重点**。')
  assert.deepEqual(surface.answerInlineTokens('型号 **重点**。').map((token) => token.kind), ['text', 'strong', 'text'])
}])

cases.push(['用户卡判据：合成通知不做成用户卡（系统通知首行 / 独立 [[session:…]] 引用行）', () => {
  assert.equal(surface.isSyntheticNoticeUserText('（系统通知，不是用户说的话）\n电脑操作会话「备份」这一轮已经完成。\n最后单独一行原样输出：[[session:s1|备份]]'), true)
  assert.equal(surface.isSyntheticNoticeUserText('[系统通知，不是用户说的话] 电脑操作会话已完成'), true)
  assert.equal(surface.isSyntheticNoticeUserText('材料在\n[[session:s1|论文]]\n记得看'), true)
  assert.equal(surface.isSyntheticNoticeUserText('帮我看看今天天气'), false)
  assert.equal(surface.isSyntheticNoticeUserText('回复里引用了 [[session:s1|论文]] 这一行不用单独成行'), false)
  assert.equal(surface.isSyntheticNoticeUserText(''), false)
}])

cases.push(['用户卡正文：显示用户原文（按空行分段，不截断不改写）', () => {
  assert.deepEqual(surface.parseUserCardBody('你好，帮我把今天下午的安排理一遍'), ['你好，帮我把今天下午的安排理一遍'])
  assert.deepEqual(surface.parseUserCardBody('第一行\n第二行\n\n第三段'), ['第一行\n第二行', '第三段'])
  assert.deepEqual(surface.parseUserCardBody('   '), [])
  assert.deepEqual(surface.parseUserCardBody('行一\r\n行二'), ['行一\n行二'])
}])

cases.push(['用户卡朗读 key：每张卡按自己那条消息，不与秘书卡串', () => {
  assert.equal(surface.userCardSpeechKey('13:input-message-abc', '8'), 'user:13:input-message-abc')
  assert.equal(surface.userCardSpeechKey('', '8'), 'user:turn:8')
}])

cases.push(['用户卡时间：宿主「今天 20:24」/「20:24」都收成「20:24」，昨天/日期形式原样用', () => {
  assert.equal(surface.formatUserCardClock('20:24'), '20:24')
  assert.equal(surface.formatUserCardClock('今天 20:24'), '20:24')
  assert.equal(surface.formatUserCardClock('今天 9:08'), '9:08')
  assert.equal(surface.formatUserCardClock('昨天 23:05'), '昨天 23:05')
  assert.equal(surface.formatUserCardClock('11月18日 08:30'), '11月18日 08:30')
  assert.equal(surface.formatUserCardClock(''), '')
}])

cases.push(['自动朗读目标只看秘书卡：用户卡不许挡住最近一条真实回复', () => {
  const el = (turn, kind) => ({ getAttribute: (name) => (name === 'data-dsh-scard-turn' ? turn : name === 'data-dsh-scard-kind' ? kind : name === 'data-empty' ? '0' : null) })
  const doc = { querySelectorAll: () => [el('8', 'assistant'), el('10', 'assistant'), el('11', 'user')] }
  assert.equal(surface.latestReplyTurnNo(doc), '10')
}])

cases.push(['卡片 kind 常量：秘书卡 assistant / 用户卡 user / 通知卡 notice（三种卡互不串味）', () => {
  assert.equal(surface.CARD_KIND_ASSISTANT, 'assistant')
  assert.equal(surface.CARD_KIND_USER, 'user')
  assert.equal(surface.CARD_KIND_NOTICE, 'notice')
  assert.equal(surface.FOLD_BODY_LINE_BUDGET, 3)
  assert.equal(surface.FOLD_TITLE_LINE_BUDGET, 2)
  assert.equal(surface.FOLD_BLOCK_GAP, 10)
  assert.equal(surface.FOLD_FALLBACK_LINE_HEIGHT_PX, 26)
  // 折叠态固定上限（2026-11-23 新字号档：结论 18px/1.5 两行 54px + 间距 10px + 详情 14px/26px 三行 78px + 两个块间距 20px = 162px；
  // 旧的「17px/1.5 标题 + 15px/1.8 正文」那档算出来也是 162px —— 总量口径一个字没动）
  assert.equal(surface.foldCollapsedCapPx({ lineHeight: 26, titleLineHeight: 27, hasTitle: true }), 162)
  assert.equal(surface.foldCollapsedCapPx({ lineHeight: 26, hasTitle: false }), 98)
  // 通知卡 10 秒过期口径（2026-11-24 用户改档：原 10 分钟）：同一天的钟面、带日期的钟面、认不出时间，三种判据分开断言
  // 改档后钟面兜底的误差上界是 59.999 秒（钟面把发送时刻最多往前推一分钟），绝不提前收。
  assert.equal(surface.NOTICE_CARD_TTL_MS, 10 * 1000, '通知卡 TTL = 10 秒（2026-11-24 改档）')
  {
    const sentAt = new Date(2026, 10, 22, 9, 8, 0, 0).getTime()
    const at908 = sentAt + 1000
    const at918 = sentAt + 11 * 60 * 1000
    const at919 = sentAt + 12 * 60 * 1000
    const fresh = surface.noticeExpiryFromClock('9:08', at908)
    assert.equal(fresh.reason, 'same-day')
    assert.equal(fresh.expired, false, '刚发送的不到 10 秒不许收')
    assert.equal(fresh.expiresAt, sentAt + surface.NOTICE_CLOCK_MINUTE_MS - 1 + surface.NOTICE_CARD_TTL_MS)
    // 分钟粒度只能估：宁可晚一句钟收，绝不提前一秒——10 秒整还在钟面那一分钟里，收不了；到「分钟末 + 10 秒」才铁定到期
    assert.equal(surface.noticeExpiryFromClock('9:08', sentAt + 10 * 1000).expired, false, '满 10 秒也不许提前收（钟面兜底等分钟末）')
    assert.equal(surface.noticeExpiryFromClock('9:08', at918).expired, true, '到点就收（分钟末 + 10 秒）')
    assert.equal(surface.noticeExpiryFromClock('今天 9:08', at919).expired, true)
    assert.equal(surface.noticeExpiryFromClock('11月22日 9:08', at908).expired, true, '带日期的钟面必然远超 10 秒')
    assert.equal(surface.noticeExpiryFromClock('昨天 9:08', at908).reason, 'dated-label')
    assert.equal(surface.noticeExpiryFromClock('', at908).expired, false, '认不出时间不动卡）')
    assert.equal(surface.noticeExpiryFromClock('乱码', at908).reason, 'unknown-time')
    assert.equal(surface.noticeCardExpired({ kind: 'user', clockText: '11月22日 9:08' }, at908), false, '用户卡永不过期')
    assert.equal(surface.noticeCardExpired({ kind: 'notice', clockText: '11月22日 9:08' }, at908), true)
  }
}])

cases.push(['通知卡正文：剥掉合成头（「（系统通知…）」与「最后单独一行原样输出：」），首行做标题、其余成段落', () => {
  const raw = '（系统通知，不是用户说的话）\n电脑操作会话「备份」这一轮已经完成。\n最后单独一行原样输出：[[session:s1|备份]]'
  assert.equal(surface.stripNoticeSyntheticHead(raw), '电脑操作会话「备份」这一轮已经完成。\n[[session:s1|备份]]')
  assert.equal(surface.stripNoticeSyntheticHead('（系统通知，不是用户说的话）\n[系统通知，不是用户说的话] 已完成\n最后单独一行原样输出：[[session:s2|会话]]'), '[[session:s2|会话]]')
  assert.equal(surface.stripNoticeSyntheticHead(''), '')
  const parsed = surface.parseNoticeCardBody('（系统通知，不是用户说的话）\n这一轮已经完成。\n第二段正文。')
  assert.equal(parsed.title, '这一轮已经完成。')
  assert.deepEqual(parsed.paragraphs, ['第二段正文。'])
  assert.deepEqual(surface.parseNoticeCardBody('（系统通知，不是用户说的话）\n\n\n').paragraphs, [])
}])

cases.push(['新措辞的通知正文照旧解析成通知卡（模板改了行，客户端解析不破）', () => {
  const watch = lib.assistantCuWatchTestSurface
  const raw = watch.buildCompletionNotice({
    sessionId: 'session-cu-1',
    title: '派活：帮我看一下磷石膏 SCI',
    summary: '结论：改了三处。\n文件 src/a.ts，提交 259e27d，门禁 npm test 全绿。',
  })
  assert.equal(surface.isSyntheticNoticeUserText(raw), true, '仍被认成合成通知')
  const stripped = surface.stripNoticeSyntheticHead(raw)
  assert.ok(!stripped.startsWith('（系统通知'), '只剥头一行')
  assert.match(stripped, /电脑操作会话「派活：帮我看一下磷石膏 SCI」这一轮已经完成。/)
  assert.ok(stripped.includes('src/a.ts') && stripped.includes('259e27d'), 'CU 原文里的文件名与提交号留在通知卡正文里')
  const parsed = surface.parseNoticeCardBody(raw)
  assert.equal(parsed.title, '电脑操作会话「派活：帮我看一下磷石膏 SCI」这一轮已经完成。')
  assert.ok(parsed.paragraphs.some((p) => p.includes('禁止整大段原封不动照抄') && p.includes('先给结论')), '整理不照抄口径那行进了卡片正文')
  assert.ok(parsed.paragraphs.some((p) => p.includes('动手类工具已禁用')), '工具禁用那行也照实显示')
  const refs = surface.parseSessionRefs(raw)
  assert.equal(refs.length, 1, '末尾引用仍被抽成可点跳 chip')
  const ref = refs[0] ?? {}
  assert.ok(Object.values(ref).includes('session-cu-1'), `引用里要带会话 id：${JSON.stringify(ref)}`)
  assert.ok(Object.values(ref).includes('派活：帮我看一下磷石膏 SCI'), `引用里要带会话标题：${JSON.stringify(ref)}`)
  assert.ok(!raw.includes('一两句'), '客户端喂进去的这条通知本身已无长度限制措辞')
  assert.ok(surface.normalizeForSpeech(raw).length > 0, '通知卡正文可被朗读口径规范化')
}])

cases.push(['三种行分类不串味：真实用户行=user、合成通知行=notice、助手回答行不是用户行', () => {
  function fakeRow(text, kind) {
    // 2026-11-24 附件批次之后扫描层读的是块顺序，这条老用例改成宿主机械的假行（正文文本照旧）
    const bubble = fakeTextBubble(text)
    const clock = fakeEl('div', { 'data-clock': 'start' }, ['20:24'])
    const chat = fakeEl('div', { 'data-slot': 'conversation.chat.node' }, [fakeEl('div', {}, [bubble, clock])])
    return fakeEl('div', { 'data-chat-flow-kind': kind, 'data-chat-node-key': `13:${text.slice(0, 4)}`, 'data-chat-turn': '7' }, [chat])
  }
  const doc = { querySelectorAll: (sel) => (sel.includes('data-chat-flow-kind="user"')
    ? [
      fakeRow('你好，帮我看看今天下午', 'user'),
      fakeRow('（系统通知，不是用户说的话）\n电脑操作会话「备份」这一轮已经完成。', 'user'),
    ]
    : [fakeRow('秘书自己的回答不应该进用户卡', 'assistant-step')]) }
  const cardRows = surface.collectSecretaryCardRows(doc)
  assert.equal(cardRows.length, 2)
  assert.equal(cardRows[0].kind, surface.CARD_KIND_USER)
  assert.equal(cardRows[1].kind, surface.CARD_KIND_NOTICE)
  assert.equal(cardRows[0].clockText, '20:24')
  const userOnly = surface.collectSecretaryUserRows(doc)
  assert.equal(userOnly.length, 1)
  assert.equal(userOnly[0].kind, surface.CARD_KIND_USER)
}])

cases.push(['卡片 key：秘书卡 assistant:turn:N，通知卡 notice:<消息 key> / notice:turn:N，互不撞', () => {
  assert.equal(surface.assistantCardSpeechKey('7'), 'assistant:turn:7')
  assert.equal(surface.assistantCardSpeechKey(''), '')
  assert.equal(surface.noticeCardSpeechKey('14:input-message-cu-01', '9'), 'notice:14:input-message-cu-01')
  assert.equal(surface.noticeCardSpeechKey('', '9'), 'notice:turn:9')
  assert.notEqual(surface.noticeCardSpeechKey('14:input-message-cu-01', '9'), surface.userCardSpeechKey('14:input-message-cu-01', '9'))
}])

cases.push(['折叠几何（三种卡共用一套算术）：卡标题也进预算（最多 2 行）、正文最多 3 行、落点不切半行、固定高度封顶', () => {
  const lineHeight = 27
  const titleLine = 25.5
  const blocks = [
    { kind: 'title', top: 0, height: 26 },
    { kind: 'para', top: 36, height: 54 },   // 2 行
    { kind: 'para', top: 100, height: 81 },  // 3 行
    { kind: 'para', top: 191, height: 54 },
  ]
  const natural = 245
  // 预算 3 行：第一个块 2 行（bottom 90），第二个块只切 1 行 → 100 + 27 = 127
  const out = surface.foldClipFromBlocks({ blocks, naturalHeight: natural, lineHeight, titleLineHeight: titleLine })
  assert.equal(out.collapsedMaxHeight, 127)
  assert.equal(out.overflow, true)
  assert.equal(out.bodyLines, 3)
  assert.equal(out.clip, 127)
  assert.equal(out.cap, 162)
  // 不溢出：正文只有 3 行 → 不截断，collapsedMaxHeight 为 undefined（自然高度）
  const short = surface.foldClipFromBlocks({ blocks: [{ kind: 'para', top: 0, height: 81 }], naturalHeight: 81, lineHeight, titleLineHeight: titleLine })
  assert.equal(short.collapsedMaxHeight, undefined)
  assert.equal(short.overflow, false)
  assert.equal(short.bodyLines, 3)
  // 只有标题、且标题只有一行（没被裁）：不折叠
  assert.deepEqual(surface.foldClipFromBlocks({ blocks: [{ kind: 'title', top: 0, height: 26 }], naturalHeight: 26, lineHeight, titleLineHeight: titleLine }).collapsedMaxHeight, undefined)
  // 引用 chip 整块不可切一半（chip 算 1 行）
  const withRef = surface.foldClipFromBlocks({ blocks: [{ kind: 'para', top: 0, height: 27 }, { kind: 'ref', top: 37, height: 36 }], naturalHeight: 100, lineHeight, titleLineHeight: titleLine })
  assert.equal(withRef.collapsedMaxHeight, undefined)
  assert.equal(withRef.bodyLines, 2)
  // 现网实测的坏情形（2026-11-22 手机截图）：整段首段被排版成 230px 长标题（9 行）。
  // 旧口径「标题永远露出、不计预算」把它整段留在折叠态里 → max-height 321–346px；新口径只让标题出 2 行。
  const longTitle = [
    { kind: 'title', top: 0, height: 230 },
    { kind: 'para', top: 240, height: 81 },
    { kind: 'para', top: 331, height: 27 },
  ]
  const folded = surface.foldClipFromBlocks({ blocks: longTitle, naturalHeight: 358, lineHeight, titleLineHeight: titleLine })
  assert.equal(folded.collapsedMaxHeight, 51, '标题按自己的行高切在第 2 行行尾（17px/1.5 × 2）')
  assert.equal(folded.overflow, true)
  assert.equal(folded.bodyLines, 0)
  // 整条回复只有一段连续文字（正文块只剩标题一个）：标题被行夹裁过时也必须折叠，绝不再整段平铺
  const onlyTitle = surface.foldClipFromBlocks({ blocks: [{ kind: 'title', top: 0, height: 51 }], naturalHeight: 51, lineHeight, titleLineHeight: titleLine, titleClippedHidden: true })
  assert.equal(onlyTitle.overflow, true)
  assert.equal(onlyTitle.collapsedMaxHeight, 51)
  // 行高量不出来（字体没落、块被宿主藏起来）：按兜底行高 26 折叠，不许因为量不到就平铺
  const bad = surface.foldClipFromBlocks({ blocks, naturalHeight: natural, lineHeight: 0 })
  assert.equal(bad.collapsedMaxHeight, 126)
  assert.equal(bad.overflow, true)
  assert.equal(bad.cap, 160)
  // 卡体内联样式三态：没量过不放开（CSS 首帧固定上限顶住）→ 量过且没溢出才放开 → 溢出就写真实落点
  assert.equal(surface.cardFoldStyle(false, false, undefined), undefined)
  assert.deepEqual(surface.cardFoldStyle(false, true, undefined), { maxHeight: 'none' })
  assert.deepEqual(surface.cardFoldStyle(false, true, 142), { maxHeight: '142px' })
  assert.deepEqual(surface.cardFoldStyle(true, false, undefined), { maxHeight: 'none' })
}])

cases.push(['已读集合：cardKey 归一（坏值丢掉、去重、截上限）', () => {
  assert.equal(surface.normalizeCardKey(' assistant:turn:7 '), 'assistant:turn:7')
  assert.equal(surface.normalizeCardKey('带 空格 的 key'), '')
  assert.equal(surface.normalizeCardKey(''), '')
  assert.deepEqual(surface.normalizeReadKeys(['a:1', 'a:1', '', '坏 值', 'b:2']), ['a:1', 'b:2'])
  const many = Array.from({ length: surface.MAX_READ_KEYS + 20 }, (_, i) => `k${i}`)
  const capped = surface.normalizeReadKeys(many)
  assert.equal(capped.length, surface.MAX_READ_KEYS)
  assert.equal(capped[capped.length - 1], 'k419')
}])

cases.push(['已读 store：宿主真值优先、宿主答不上降级 localStorage、不阻塞渲染', async () => {
  const seen = []
  const hostCards = new Map()
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    const route = url.split('?')[0]
    if (route !== surface.ASSISTANT_SECRETARY_READ_ROUTE) return { ok: false }
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      const list = hostCards.get(body.sessionId) ?? []
      if (!list.includes(body.cardKey)) list.push(body.cardKey)
      hostCards.set(body.sessionId, list)
      return { ok: true, json: async () => ({ ok: true, sessionId: body.sessionId, cards: list.slice(), count: list.length }) }
    }
    const sessionId = new URL(`http://x${url}`).searchParams.get('sessionId') ?? ''
    const cards = hostCards.get(sessionId) ?? []
    return { ok: true, json: async () => ({ ok: true, sessionId, cards: cards.slice(), count: cards.length }) }
  }
  const store = surface.createSecretaryReadStore({ fetchImpl, storage: null })
  store.setSession('session-1')
  assert.equal(store.isRead('assistant:turn:7'), false)
  store.markRead('assistant:turn:7')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(store.isRead('assistant:turn:7'), true)
  assert.equal(store.markRead(''), false, '空 key 不许污染集合')
  const post = seen.find((item) => item.init?.method === 'POST')
  assert.equal(post !== undefined, true, '已读必须发给宿主，不能只靠 localStorage')
  assert.equal(post.url, surface.ASSISTANT_SECRETARY_READ_ROUTE)
  assert.deepEqual(JSON.parse(post.init.body), { sessionId: 'session-1', cardKey: 'assistant:turn:7', mark: 'read' })

  // 刷新页面 = 新的 store（宿主 GET 送集合）→ 已读卡不再未读
  const again = surface.createSecretaryReadStore({ fetchImpl, storage: null })
  again.setSession('session-1')
  const hydrated = await again.hydrate()
  assert.equal(hydrated.hostOk, true)
  assert.equal(hydrated.count >= 1, true)
  const got = seen.find((item) => item.init?.method === undefined)
  assert.equal(got !== undefined, true, 'hydrate 必须先问宿主拿真值集合')
  assert.equal(got.url, `${surface.ASSISTANT_SECRETARY_READ_ROUTE}?sessionId=session-1`)
  assert.equal(again.isRead('assistant:turn:7'), true)
  assert.equal(again.isRead('assistant:turn:8'), false)

  // 宿主 404（route 不在当前构建的宿主上）→ 降级用 localStorage 缓存，且不许阻塞
  const cache = new Map()
  const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } }
  storage.setItem(surface.READ_STORAGE_PREFIX + 'session-2', JSON.stringify(['notice:turn:9']))
  const degraded = surface.createSecretaryReadStore({ fetchImpl: async () => ({ ok: false }), storage })
  degraded.setSession('session-2')
  const degradedHydrated = await degraded.hydrate()
  assert.equal(degradedHydrated.ok, true)
  assert.equal(degradedHydrated.hostOk, false)
  assert.equal(degraded.isRead('notice:turn:9'), true)
  const throwingStore = surface.createSecretaryReadStore({ fetchImpl: async () => { throw new Error('网络断了') }, storage })
  throwingStore.setSession('session-2')
  const thrown = await throwingStore.hydrate()
  assert.equal(thrown.ok, true, '宿主答不上不许阻塞渲染')
  assert.equal(thrown.hostOk, false)
  assert.equal(throwingStore.isRead('notice:turn:9'), true)

  // 没有 fetch（非浏览器环境）也只是不查宿主，不抛
  const none = surface.createSecretaryReadStore({ fetchImpl: null, storage: null })
  none.setSession('session-3')
  none.markRead('assistant:turn:1')
  const noneHydrated = await none.hydrate()
  assert.equal(noneHydrated.hostOk, false)
  assert.equal(none.isRead('assistant:turn:1'), true)
}])

cases.push(['通知卡过期算术（2026-11-24 改档 10 秒）：钟面兜底仍然只晚不早', () => {
  const sentAt = new Date(2026, 10, 22, 9, 8, 0, 0).getTime()
  const fresh = surface.noticeExpiryFromClock('9:08', sentAt + 1000)
  assert.equal(fresh.reason, 'same-day')
  assert.equal(fresh.expired, false, '刚发送的不许收')
  assert.equal(fresh.sentAt, sentAt, '发送时刻按那一分钟的起点算')
  assert.equal(fresh.expiresAt, sentAt + surface.NOTICE_CLOCK_MINUTE_MS - 1 + surface.NOTICE_CARD_TTL_MS, '过期时点宁可晚一句钟，绝不提前')
  assert.equal(surface.noticeExpiryFromClock('9:08', sentAt + 10 * 1000).expired, false, '刚好 10 秒还不收（钟面兜底等到分钟末 + 10 秒）')
  assert.equal(surface.noticeExpiryFromClock('9:08', sentAt + 70 * 1000).expired, true, '分钟末 + 10 秒铁定收')
  assert.equal(surface.noticeExpiryFromClock('今天 9:08', sentAt + 11 * 60 * 1000).expired, true, '「今天」写法同一套判据')
  assert.equal(surface.noticeExpiryFromClock('11月22日 9:08', sentAt).reason, 'dated-label', '带日期即远超 10 秒')
  assert.equal(surface.noticeExpiryFromClock('11月22日 9:08', sentAt).expired, true, '带日期的通知卡直接过期')
  assert.equal(surface.noticeExpiryFromClock('昨天 9:08', sentAt).expired, true)
  for (const clock of ['', '乱码', '上午九点']) {
    const out = surface.noticeExpiryFromClock(clock, sentAt)
    assert.equal(out.reason, 'unknown-time', `${clock} 认不出时间`)
    assert.equal(out.expired, false, '认不出时间不许把消息收掉')
    assert.equal(out.expiresAt, null)
  }
  assert.equal(surface.noticeCardExpired({ kind: 'user', clockText: '11月22日 9:08' }, sentAt), false, '用户卡永不过期')
  assert.equal(surface.noticeCardExpired({ kind: 'notice', clockText: '11月22日 9:08' }, sentAt), true, '通知卡走同一判据')
  const rows = [{ kind: 'notice', clockText: '9:08' }, { kind: 'user', clockText: '9:08' }]
  assert.equal(surface.nearestNoticeExpiryMs(rows, sentAt + 1000), sentAt + surface.NOTICE_CLOCK_MINUTE_MS - 1 + surface.NOTICE_CARD_TTL_MS, '挂载层按最近一个到点的通知卡排定时器')
  assert.equal(surface.nearestNoticeExpiryMs([{ kind: 'notice', clockText: '9:08' }], sentAt + 12 * 60 * 1000), null, '全都过期了就不必再排定时器')
  const future = surface.noticeExpiryFromClock('23:41', new Date(2026, 10, 22, 9, 0, 0, 0).getTime())
  assert.equal(future.sentAt, new Date(2026, 10, 22, 9, 0, 0, 0).getTime(), '钟面跑到未来（跨午夜/钟面偏差）按现在算，不许算成已过期')
  assert.equal(future.expired, false)
}])

// 2026-11-24 用户原话「通知的存活时间由 10 分钟改为 10 秒钟」：
// 分钟粒度的钟面最多会晚 60 秒才收，那不是 10 秒——所以补一条秒级来源（首次观察时刻，落 localStorage），
// 两条判据都只晚不早，取更早的那个。下面两条用例把「秒级 10 秒」和「只有钟面时不早收」分开锁死。
cases.push(['通知卡 10 秒（秒级来源）：到达时刻 + 10 秒到点，9.5 秒还在、10.5 秒已收', () => {
  const storage = (() => { const cache = new Map(); return { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } } })()
  const arrivals = surface.createSecretaryNoticeArrivalStore({ storage })
  const sentAt = new Date(2026, 10, 22, 9, 8, 0, 0).getTime()
  const key = 'notice:16:input-message-cu-01'
  // 首次观察比真实发送晚 300ms（扫描去抖 120ms + 渲染一帧）：只让过期更晚，绝不更早
  assert.equal(arrivals.observe(key, sentAt + 300), sentAt + 300, '首次观察即记到达时刻')
  assert.equal(arrivals.at(key), sentAt + 300)
  assert.equal(arrivals.observe(key, sentAt + 8000), sentAt + 300, '幂等：再观察一次不许把到达时刻往后挪（更不许往前挪成过期）')
  const row = { kind: 'notice', clockText: '9:08', key }
  const arrival = arrivals.at(key)
  assert.ok(arrival >= sentAt, '到达时刻只会晚于发送时刻')
  const at9500 = surface.noticeExpiry(row, sentAt + 9500, surface.NOTICE_CARD_TTL_MS, arrival)
  assert.equal(at9500.precision, 'seconds', '有到达时刻就是秒级判据')
  assert.equal(at9500.expired, false, '9.5 秒还在（10 秒没到就不许收）')
  const at10500 = surface.noticeExpiry(row, sentAt + 10500, surface.NOTICE_CARD_TTL_MS, arrival)
  assert.equal(at10500.expired, true, '10.5 秒已经收了')
  assert.equal(at10500.expiresAt, arrival + surface.NOTICE_CARD_TTL_MS, '过期时点 = 到达时刻 + 10 秒')
  assert.equal(surface.noticeCardExpired(row, arrival + 9999, surface.NOTICE_CARD_TTL_MS, arrival), false, '差 1ms 还不收')
  assert.equal(surface.noticeCardExpired(row, arrival + 10000, surface.NOTICE_CARD_TTL_MS, arrival), true, '整整 10 秒到点就收')
  assert.equal(surface.noticeCardExpired({ kind: 'user', clockText: '9:08', key }, arrival + 60000, surface.NOTICE_CARD_TTL_MS, arrival), false, '用户卡永不过期')
  // 挂载层定时器按「到达 + 10 秒」排，不是按「分钟末 + 10 秒」
  assert.equal(surface.nearestNoticeExpiryMs([row], arrival + 1000, surface.NOTICE_CARD_TTL_MS, () => arrival), arrival + surface.NOTICE_CARD_TTL_MS, '秒级来源可用时按 10 秒排定时器')
  // 整页刷新：换一个 store 实例读同一份 storage，到达时刻仍在（不需要重读日志）
  const afterReload = surface.createSecretaryNoticeArrivalStore({ storage })
  assert.equal(afterReload.at(key), arrival, '刷新后沿用第一次观察到的到达时刻')
  assert.equal(surface.noticeCardExpired(row, arrival + 10500, surface.NOTICE_CARD_TTL_MS, afterReload.at(key)), true, '刷新后照样按 10 秒收')
  // 修剪：条目上限照 MAX_NOTICE_ARRIVAL_KEYS 兜住，绝不让缓存无限长
  assert.equal(surface.MAX_NOTICE_ARRIVAL_KEYS >= 50, true)
}])

cases.push(['通知卡 10 秒（只有钟面文本）：刚好 3 秒仍显示，误差上界 59.999 秒且只晚不早', () => {
  const sentAt = new Date(2026, 10, 22, 9, 8, 0, 0).getTime()
  const row = { kind: 'notice', clockText: '9:08' }
  const at3s = surface.noticeExpiry(row, sentAt + 3000, surface.NOTICE_CARD_TTL_MS, null)
  assert.equal(at3s.precision, 'minute', '没有到达时刻就退到钟面判据')
  assert.equal(at3s.expired, false, '刚好 3 秒必须仍显示（钟面兜底不许提前收）')
  const trueExpiry = sentAt + surface.NOTICE_CARD_TTL_MS
  const minuteExpiry = sentAt + surface.NOTICE_CLOCK_MINUTE_MS - 1 + surface.NOTICE_CARD_TTL_MS
  assert.ok(minuteExpiry >= trueExpiry, '钟面兜底的过期时点只会晚于真实过期时点')
  assert.ok(minuteExpiry - trueExpiry <= 60000, `误差上界 ≤ 60 秒，实际 ${minuteExpiry - trueExpiry}`)
  assert.equal(at3s.expiresAt, minuteExpiry)
  // 认不出钟面 + 没有到达时刻 → 永不过期（没有证据不许把消息收掉）
  assert.equal(surface.noticeCardExpired({ kind: 'notice', clockText: '' }, sentAt + 3600 * 1000, surface.NOTICE_CARD_TTL_MS, null), false)
  // 两条判据都在：取更早的那个过期时点；两条都只晚不早，合起来仍然不早
  const arrival = sentAt + 200
  const both = surface.noticeExpiry(row, sentAt + 5000, surface.NOTICE_CARD_TTL_MS, arrival)
  assert.equal(both.expired, false, '一条到点也算不到点：两条都没到就不收')
  assert.equal(both.expiresAt, arrival + surface.NOTICE_CARD_TTL_MS, '两条取更早的过期时点（到达 + 10 秒）')
  assert.equal(both.precision, 'seconds', '有秒级来源就按秒级口径报告')
  // 钟面已经过期时照旧收（钟面那条只会晚于真实过期，所以它说收了就是真收了）
  const late = surface.noticeExpiry(row, sentAt + 80 * 1000, surface.NOTICE_CARD_TTL_MS, sentAt + 79 * 1000)
  assert.equal(late.expired, true, '钟面判据已过期就收，不管到达时刻多晚')
}])

cases.push(['compact 提示判据（第 3 项）：那两行文本按已核实的宿主文字认，别的文字不误伤', () => {
  assert.equal(surface.isCompactHintText('compact 已压缩 41 条历史记录（约 19692 tokens）'), true)
  assert.equal(surface.isCompactHintText('compact·已压缩41条历史记录(19692 tokens)'), true, '用户原话里那种没有空格的写法也认')
  assert.equal(surface.isCompactHintText('compact: Compaction could not produce a useful summary. The attempt is recorded in the session log.'), true)
  assert.equal(surface.isCompactHintText('compact · Compacted 12 history items (~4200 tokens)'), true, '英文 i18n 同一判据')
  assert.equal(surface.isCompactHintText('你好，帮我看看今天下午'), false, '普通用户消息不许被误判')
  assert.equal(surface.isCompactHintText('这轮已经压缩完了，接着说'), false, '模型自己说「压缩完了」不许算成那两行')
  assert.equal(surface.isCompactHintText(''), false)
}])

// 2026-11-24 第 5 项（用户原话「秘书执行任务的过程可以展示，只展示最新用户一条任务」）：
// 扫描层按 DOM 里最后一条 user/steering 行定位「最新一轮」，把那一轮的过程行打上
// data-dsh-process-visible="1"；新消息一来标记整体后移，上一轮的标记一个都不许留。
cases.push(['最新一轮过程行可见（第 5 项）：标记跟着最后一条用户行移动，历史轮次不标', () => {
  const makeNode = (attrs) => {
    const a = { ...attrs }
    return {
      getAttribute: (name) => (name in a ? a[name] : null),
      setAttribute: (name, value) => { a[name] = String(value) },
      removeAttribute: (name) => { delete a[name] },
      hasAttribute: (name) => name in a,
      querySelector: () => null,
      attrs: a,
    }
  }
  const rows = [
    makeNode({ 'data-chat-turn': '10', 'data-chat-flow-kind': 'user' }),
    makeNode({ 'data-chat-turn': '10', 'data-chat-flow-kind': 'tool-call' }),
    makeNode({ 'data-chat-turn': '10', 'data-chat-flow-kind': 'assistant-step' }),
    makeNode({ 'data-chat-turn': '11', 'data-chat-flow-kind': 'user' }),
    makeNode({ 'data-chat-turn': '11', 'data-chat-flow-kind': 'tool-call' }),
    makeNode({ 'data-chat-turn': '11', 'data-chat-flow-kind': 'context' }),
    makeNode({ 'data-chat-turn': '11', 'data-chat-flow-kind': 'assistant-step', 'data-chat-group-part': 'reasoning' }),
    makeNode({ 'data-chat-turn': '12', 'data-chat-flow-kind': 'steering' }),
    makeNode({ 'data-chat-turn': '12', 'data-chat-flow-kind': 'tool-call' }),
  ]
  const doc = {
    querySelectorAll: (selector) => (selector.includes('data-chat-flow-kind]')
      ? rows
      : rows.filter((row) => row.hasAttribute('data-dsh-process-visible'))),
  }
  const first = surface.tagLatestTurnProcessRows(doc)
  assert.equal(first.turnNo, '12', '锚点 = 最后一条用户/插话行的轮次，不是写死的号')
  assert.equal(first.anchorKind, 'steering', '插话行也算用户侧锚点')
  assert.equal(first.marked, 1, '只标最新一轮的那条过程行')
  assert.equal(rows[8].hasAttribute('data-dsh-process-visible'), true, '最新一轮的 tool-call 被打标')
  assert.equal(rows[4].hasAttribute('data-dsh-process-visible'), false, '上一轮的 tool-call 不许标')
  assert.equal(rows[5].hasAttribute('data-dsh-process-visible'), false, '上一轮的 context 不许标')
  assert.equal(rows[6].hasAttribute('data-dsh-process-visible'), false, '上一轮 reasoning 叙述也不算最新轮')
  assert.equal(rows[2].hasAttribute('data-dsh-process-visible'), false, '历史轮的 assistant-step 不许标')
  assert.equal(rows[0].hasAttribute('data-dsh-process-visible'), false, '用户行自己不打这个标')

  // 追加一条新用户消息 + 它这一轮的过程行 → 标记整体后移，上一轮立刻收回
  rows.push(makeNode({ 'data-chat-turn': '13', 'data-chat-flow-kind': 'user' }))
  rows.push(makeNode({ 'data-chat-turn': '13', 'data-chat-flow-kind': 'tool-call' }))
  rows.push(makeNode({ 'data-chat-turn': '13', 'data-chat-flow-kind': 'turn-process' }))
  rows.push(makeNode({ 'data-chat-turn': '13', 'data-chat-flow-kind': 'assistant-step' }))
  const second = surface.tagLatestTurnProcessRows(doc)
  assert.equal(second.turnNo, '13')
  assert.equal(second.marked, 2, '新一轮的两条过程行都标上')
  assert.equal(rows[8].hasAttribute('data-dsh-process-visible'), false, '上一轮（12）的标记必须收回')
  assert.equal(rows[10].hasAttribute('data-dsh-process-visible'), true)
  assert.equal(rows[11].hasAttribute('data-dsh-process-visible'), true)
  assert.equal(rows[12].hasAttribute('data-dsh-process-visible'), false, 'assistant-step（回复正文）永远不标——卡片已经展示同一段文字')

  // 没有任何用户行 → 一个都不标；清标记接口可用
  const emptyDoc = { querySelectorAll: () => [makeNode({ 'data-chat-flow-kind': 'tool-call' })] }
  assert.equal(surface.tagLatestTurnProcessRows(emptyDoc).marked, 0)
  assert.equal(surface.clearLatestTurnProcessTags(doc) >= 2, true, '离开秘书页要能把自己的标记全清掉')
  assert.equal(rows.filter((row) => row.hasAttribute('data-dsh-process-visible')).length, 0)
  assert.equal(surface.PROCESS_VISIBLE_ATTRIBUTE, 'data-dsh-process-visible')
}])

cases.push(['引用登记（第 4 项）：归一 + store 口径 + 宿主真值优先', async () => {
  const base = { cardKey: 'notice:14:msg-cu-01', kind: 'notice', turnNo: '9', preview: '结论：改了三处。', refSessionIds: ['session-cu-1', 'session-cu-1', '带 空 格', 'x'.repeat(130)] }
  const record = surface.normalizeQuoteRecord(base)
  assert.equal(record.cardKey, 'notice:14:msg-cu-01')
  assert.equal(record.kind, 'notice')
  assert.deepEqual(record.refSessionIds, ['session-cu-1'], '坏值丢掉、按序去重')
  assert.equal(record.preview, '结论：改了三处。')
  assert.equal(surface.normalizeQuoteRecord({ cardKey: '', kind: 'notice' }), null, '没卡 key 整条丢')
  assert.equal(surface.normalizeQuoteRecord({ cardKey: 'a:1', kind: 'unknown-kind' }), null, '种类不在这三种整条丢')
  const long = surface.normalizeQuoteRecord({ cardKey: 'a:1', kind: 'assistant', preview: '甲'.repeat(surface.QUOTE_PREVIEW_MAX_CHARS + 30) })
  assert.equal(long.preview.length, surface.QUOTE_PREVIEW_MAX_CHARS, '摘录截到上限、末尾补省略号')
  assert.equal(long.preview.endsWith('…'), true)
  const old = surface.normalizeQuoteRecord({ cardKey: 'a:1', kind: 'assistant', preview: 'x', updatedAt: 1234 })
  assert.equal(surface.quoteAlive(old, 1234), true)
  assert.equal(surface.quoteAlive(old, 1234 + surface.QUOTE_TTL_MS + 1), false, '超过 30 分钟不挂着')
  assert.equal(surface.quoteAlive(null), false)

  const seen = []
  const hostQuote = new Map()
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    if (!url.startsWith(surface.ASSISTANT_SECRETARY_QUOTE_ROUTE)) return { ok: false }
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.mark === 'clear') hostQuote.delete(body.sessionId)
      else hostQuote.set(body.sessionId, { ...body, refSessionIds: body.refSessionIds ?? [] })
      return { ok: true }
    }
    return { ok: true, quote: hostQuote.get(new URL(url).searchParams.get('sessionId')) ?? null }
  }
  const store = surface.createSecretaryQuoteStore({ fetchImpl, storage: null })
  store.setSession('session-secretary')
  assert.equal(store.setQuote({ cardKey: 'assistant:turn:7', kind: 'assistant', turnNo: '7', preview: '今天武汉 8 到 14 摄氏度', refSessionIds: [] }), true)
  assert.equal(store.isQuoted('assistant:turn:7'), true)
  assert.equal(store.isQuoted('notice:14:msg-cu-01'), false)
  assert.equal(store.setQuote({ cardKey: 'notice:14:msg-cu-01', kind: 'notice', preview: '电脑操作会话已完成。', refSessionIds: ['session-cu-1'] }), true)
  assert.equal(store.isQuoted('notice:14:msg-cu-01'), true, '一张卡只能挂着一条当前引用')
  const posted = seen.filter((item) => item.init?.method === 'POST')
  assert.equal(posted.length, 2, '每次登记都落宿主')
  assert.equal(posted[0].init.url ?? posted[0].url, surface.ASSISTANT_SECRETARY_QUOTE_ROUTE)
  assert.equal(JSON.parse(posted[0].init.body).sessionId, 'session-secretary')
  assert.equal(JSON.parse(posted[1].init.body).refSessionIds[0], 'session-cu-1', '卡片里的会话 id 一起登记')
  assert.equal(store.clearQuote('assistant:turn:7'), false, 'key 不匹配当前引用不许乱清')
  assert.equal(store.clearQuote('notice:14:msg-cu-01'), true)
  assert.equal(store.isQuoted('notice:14:msg-cu-01'), false)

  // 宿主答不上 → 降级用 localStorage 缓存，且不阻塞
  const cache = new Map()
  const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } }
  storage.setItem(surface.QUOTE_STORAGE_PREFIX + 'session-2', JSON.stringify({ cardKey: 'notice:turn:9', kind: 'notice', preview: 'x', refSessionIds: [], updatedAt: Date.now() }))
  const degraded = surface.createSecretaryQuoteStore({ fetchImpl: async () => ({ ok: false }), storage })
  degraded.setSession('session-2')
  const degradedHydrated = await degraded.hydrate()
  assert.equal(degradedHydrated.ok, true)
  assert.equal(degradedHydrated.hostOk, false)
  assert.equal(degraded.isQuoted('notice:turn:9'), true)
  const throwing = surface.createSecretaryQuoteStore({ fetchImpl: async () => { throw new Error('网络断了') }, storage: null })
  throwing.setSession('session-3')
  const thrown = await throwing.hydrate()
  assert.equal(thrown.ok, true, '宿主答不上不许阻塞渲染')
  assert.equal(thrown.hostOk, false)
  assert.equal(surface.secretaryQuoteStore() !== null, true, '进程内引用 store 懒创建')
}])

cases.push(['输入框「带引用」提示文案（追加需求）：轮次 + 卡片种类 + 正文开头一小段，没引用回 null', () => {
  const assistant = surface.quoteChipParts({
    cardKey: 'assistant:turn:12',
    kind: 'assistant',
    turnNo: '12',
    preview: '主动关心 · 明日武汉出差\n第二行不该出现\n结论：早上 7 点走高速，车上带保温杯和身份证。',
    refSessionIds: [],
    updatedAt: 1,
  })
  assert.equal(assistant.flag, surface.QUOTE_CHIP_FLAG_TEXT, '第一句就是「带引用」')
  assert.equal(assistant.turnLabel, '第 12 轮', '提示带轮次号')
  assert.equal(assistant.kindLabel, surface.QUOTE_CHIP_KIND_LABELS.assistant, '提示说清是哪张卡')
  assert.equal(assistant.meta, '第 12 轮 · 秘书回复卡')
  assert.ok(assistant.preview.startsWith('主动关心 · 明日武汉出差'), '摘要接的是那张卡正文开头')
  assert.ok(!assistant.preview.includes('身份证'), '只截开头那一小段，不把整段贴出来')
  assert.ok(assistant.preview.length <= surface.QUOTE_CHIP_PREVIEW_MAX_CHARS, '摘要在上限内')
  assert.equal(surface.quoteChipParts(null), null, '没引用 → 组件什么都不渲染')

  const notice = surface.quoteChipParts({ cardKey: 'notice:8:1:msg', kind: 'notice', turnNo: '8', preview: '  第一行  第二行 ', refSessionIds: [], updatedAt: 1 })
  assert.equal(notice.kindLabel, surface.QUOTE_CHIP_KIND_LABELS.notice)
  assert.equal(notice.preview, '第一行 第二行', '换行压成空格')
  const long = surface.quoteChipParts({ cardKey: 'assistant:turn:9', kind: 'assistant', turnNo: '9', preview: '甲'.repeat(surface.QUOTE_CHIP_PREVIEW_MAX_CHARS + 20), refSessionIds: [], updatedAt: 1 })
  assert.equal(long.preview.length, surface.QUOTE_CHIP_PREVIEW_MAX_CHARS, '超上限补省略号')
  assert.ok(long.preview.endsWith('…'))
  const unknownTurn = surface.quoteChipParts({ cardKey: 'assistant:turn:9', kind: 'assistant', turnNo: '', preview: '甲', refSessionIds: [], updatedAt: 1 })
  assert.equal(unknownTurn.turnLabel, '第 9 轮', 'turnNo 空、但 key 里有轮次号 → 补上（不是瞎猜）')
  const trulyUnknown = surface.quoteChipParts({ cardKey: 'assistant:turn:abc', kind: 'assistant', turnNo: '', preview: '正文', refSessionIds: [], updatedAt: 1 })
  assert.equal(trulyUnknown.turnLabel, '轮次未知', 'key 里没有轮次号形状才说「轮次未知」，不硬凑')
  // 卡片 key 里带轮次号时（宿主那种 user:13:input-message…），提示要把轮次号补上
  assert.equal(surface.quoteTurnFromCardKey('assistant:turn:12'), '12')
  assert.equal(surface.quoteTurnFromCardKey('user:13:input-message1747b10f-06ad-4dcd'), '13')
  assert.equal(surface.quoteTurnFromCardKey('notice:8:1:msg'), '8')
  assert.equal(surface.quoteTurnFromCardKey('user:msg-1'), '', 'key 没有轮次号形状就不硬凑')
  assert.equal(surface.quoteTurnFromCardKey(''), '')
  const fromKey = surface.quoteChipParts({ cardKey: 'user:13:input-message1747b10f', kind: 'user', turnNo: '', preview: '帮我把这份稿子核一遍', refSessionIds: [], updatedAt: 1 })
  assert.equal(fromKey.turnLabel, '第 13 轮', 'turnNo 空、但 key 里有轮次号 → 补上')
  assert.equal(fromKey.kindLabel, surface.QUOTE_CHIP_KIND_LABELS.user)


  assert.equal(surface.quoteChipPreview('第一条\n\t第二条   第三条', 12), '第一条 第二条 第三条', '换行与连续空白压成单个空格')
  assert.equal(surface.quoteChipPreview('第一条\n\t第二条   第三条', 6), '第一条 第…', '超过上限才截断、末尾加省略号')
  assert.equal(surface.quoteChipPreview('   '), '')
  assert.equal(surface.quoteChipVisible('session-83bca3e3', 'session-83bca3e3'), true, '只在固定秘书会话那条输入框显示')
  assert.equal(surface.quoteChipVisible('session-83bca3e3', 'session-other'), false)
  assert.equal(surface.quoteChipVisible('', 'session-other'), false, '不知道固定会话就不显示')
  assert.equal(surface.quoteChipVisible('session-83bca3e3', ''), false, '槽位没给会话 id 也不显示')
  assert.equal(surface.QUOTE_CHIP_CANCEL_TEXT, '取消引用', '那颗 × 的说法')
  assert.equal(surface.QUOTE_CHIP_PREVIEW_MAX_CHARS, 34, '摘要上限就这么多')
}])

cases.push(['引用吃掉判据（追加需求）：轮次号可比按轮次号，同轮换 key 不误收，页面没投影用户行不吃', () => {
  const baseline = { cardKey: 'user:8:1:msg-a', turnNo: '8' }
  assert.equal(surface.quoteConsumedByUserRow(null, { cardKey: 'user:8:1:msg-a', turnNo: '8' }), false, '基线没定：这一次只立基线')
  assert.equal(surface.quoteConsumedByUserRow(baseline, { cardKey: 'user:8:1:msg-a', turnNo: '8' }), false, '同一轮没动 → 没收')
  assert.equal(surface.quoteConsumedByUserRow(baseline, { cardKey: 'user:9:2:msg-b', turnNo: '9' }), true, '第 9 轮的新消息 → 那条消息发出去了')
  assert.equal(surface.quoteConsumedByUserRow(baseline, { cardKey: 'user:8:99:re-keyed', turnNo: '8' }), false, '宿主重新投影换了 node key 也不算发过')
  assert.equal(surface.quoteConsumedByUserRow(baseline, { cardKey: '', turnNo: '' }), false, '页面还没投影出用户行，不许凭空收引用')
  assert.equal(surface.quoteConsumedByUserRow({ cardKey: 'user:x', turnNo: '' }, { cardKey: 'user:y', turnNo: '' }), true, '轮次号比不了才退回比 key')
  assert.equal(surface.quoteConsumedByUserRow({ cardKey: 'user:x', turnNo: '' }, { cardKey: 'user:x', turnNo: '' }), false)
  assert.equal(surface.quoteTurnNumber('12'), 12)
  assert.equal(surface.quoteTurnNumber(''), null)
  assert.equal(surface.quoteTurnNumber('abc'), null)

  const fakeDoc = (rowList) => ({
    // 与 collectSecretaryCardRows 共用同一份 kind 白名单（写死旧选择器会让这条用例瞎掉）
    querySelectorAll: (selector) => {
      const kinds = [...String(selector).matchAll(/data-chat-flow-kind="([^"]+)"/g)].map((match) => match[1])
      return rowList.filter((row) => kinds.includes(row.getAttribute('data-chat-flow-kind')))
    },
  })
  const userElements = [
    fakeUserRow('msg-1', '7', '真实用户消息一条', '11:01'),
    fakeUserRow('msg-2', '8', '（系统通知，不是用户说的话）\n电脑操作会话「备份」这一轮已经完成。', '11:02'),
  ]
  const rows = surface.collectSecretaryCardRows(fakeDoc(userElements))
  const newest = surface.latestRealUserCardRef(rows)
  assert.equal(newest.cardKey, 'user:msg-1', '只认真实用户行：那条通知行一律不算（口径同「通知轮不吃引用」）')
  assert.equal(newest.turnNo, '7')
  assert.deepEqual(surface.latestRealUserCardRef(surface.collectSecretaryCardRows(fakeDoc([userElements[1]]))), { cardKey: '', turnNo: '' }, '只有通知行 → 没有基线')
  const withUser = surface.collectSecretaryCardRows(fakeDoc([
    ...userElements,
    fakeUserRow('msg-3', '9', '真实用户消息二条', '11:03'),
  ]))
  assert.equal(surface.latestRealUserCardRef(withUser).cardKey, 'user:msg-3', '最末那条真实用户消息才算基线')
}])

cases.push(['引用 store 吃掉口径（追加需求）：真实用户消息发出去即收；宿主那侧不抢先清', async () => {
  const seen = []
  const hostQuote = new Map()
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.mark === 'clear') hostQuote.delete(body.sessionId)
      else hostQuote.set(body.sessionId, body)
      return { ok: true }
    }
    return { ok: true, quote: hostQuote.get(new URL(url).searchParams.get('sessionId')) ?? null }
  }
  const store = surface.createSecretaryQuoteStore({ fetchImpl, storage: null })
  store.setSession('session-secretary')
  // 页面先投影出两条真实用户消息 + 一条通知行
  store.noteLatestUserCard({ cardKey: 'user:8:msg-old', turnNo: '8' })
  assert.equal(store.isQuoted('assistant:turn:8'), false)
  assert.equal(store.setQuote({ cardKey: 'assistant:turn:8', kind: 'assistant', turnNo: '8', preview: '秘书回答正文', refSessionIds: [] }), true)
  const postedAfterQuote = seen.filter((item) => item.init?.method === 'POST').length
  assert.equal(postedAfterQuote, 1, '登记引用落宿主一次')
  assert.deepEqual(store.baselineUserCard(), { cardKey: 'user:8:msg-old', turnNo: '8' }, '基线 = 那一刻最末那条真实用户消息')

  // 通知行随后来了（CU 完成通知）：不许把引用吃掉
  assert.equal(store.noteLatestUserCard({ cardKey: 'user:8:msg-old', turnNo: '8' }), false)
  assert.equal(store.isQuoted('assistant:turn:8'), true, '通知轮不吃引用')
  // 用户把下一条消息发出去了：最末真实用户卡换成了更新的轮次
  assert.equal(store.noteLatestUserCard({ cardKey: 'user:9:msg-new', turnNo: '9' }), true, '这一看判成「已经发出去了」')
  assert.equal(store.isQuoted('assistant:turn:8'), false, '输入框提示该收')
  assert.equal(store.active(), null)
  const postedAfterSend = seen.filter((item) => item.init?.method === 'POST').length
  assert.equal(postedAfterSend, 1, '客户端不抢先 POST clear：宿主那一轮自己 turn/end 收，别把它喂到一半就摘掉')
  assert.equal(hostQuote.has('session-secretary'), true, '宿主那份还在（等 turn/end）')

  // 用户主动按取消 → 本地 + 服务端一起清
  assert.equal(store.setQuote({ cardKey: 'notice:9:msg-n', kind: 'notice', turnNo: '9', preview: '通知正文', refSessionIds: [] }), true)
  assert.equal(store.clearQuote('notice:9:msg-n'), true)
  const clears = seen.filter((item) => item.init?.method === 'POST' && JSON.parse(item.init.body).mark === 'clear')
  assert.equal(clears.length, 1, '取消引用请宿主也清一次')
  assert.equal(hostQuote.has('session-secretary'), false)
}])

cases.push(['引用 TTL 到期自动清除（追加需求）：到点本地收掉并请宿主清', async () => {
  const seen = []
  const cache = new Map()
  const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } }
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.mark === 'clear') void body.sessionId
      return { ok: true }
    }
    return { ok: true, quote: null }
  }
  const store = surface.createSecretaryQuoteStore({ fetchImpl, storage, ttlMs: 60 })
  store.setSession('session-ttl')
  store.setQuote({ cardKey: 'assistant:turn:3', kind: 'assistant', turnNo: '3', preview: '正文', refSessionIds: [] })
  assert.equal(store.isQuoted('assistant:turn:3'), true)
  // 等到那颗到期定时器真的跑过（不靠固定 sleep：本机负载高时 node 的定时器会漂，测试只等它落定）
    const waitOut = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const posted = seen.filter((item) => item.init?.method === 'POST' && JSON.parse(item.init.body).mark === 'clear')
        if (posted.length > 0) return true
        await new Promise((resolve) => { setTimeout(resolve, 40) })
      }
      return false
    })()
    assert.equal(waitOut, true, 'TTL 到期要把本地引用收干净并请宿主清（不许只等下一次 DOM 变化）')
  assert.equal(store.isQuoted('assistant:turn:3'), false, '到期自动收（不用等下一次 DOM 变化）')
  assert.equal(store.active(), null)
  const clears = seen.filter((item) => item.init?.method === 'POST' && JSON.parse(item.init.body).mark === 'clear')
  assert.equal(clears.length, 1, '到期也请宿主清一份')
  assert.equal(cache.get(surface.QUOTE_STORAGE_PREFIX + 'session-ttl'), 'null', '本地缓存也收干净')

  // 还剩多少算多少：quoteExpiryDelayMs
  const record = { cardKey: 'assistant:turn:3', kind: 'assistant', turnNo: '3', preview: '', refSessionIds: [], updatedAt: 1000 }
  assert.equal(surface.quoteExpiryDelayMs(record, 1000, 30 * 60 * 1000), 30 * 60 * 1000)
  assert.equal(surface.quoteExpiryDelayMs(record, 1000 + 30 * 60 * 1000 + 1, 30 * 60 * 1000), 0, '已经过期回 0')
  assert.equal(surface.quoteExpiryDelayMs(null), 0)
}])

cases.push(['刷新页面不复活已发出去的引用（追加需求）：基线落 localStorage，宿主 404 也认', async () => {
  const cache = new Map()
  const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } }
  const hostFirst = surface.createSecretaryQuoteStore({ fetchImpl: async () => ({ ok: false }), storage })
  hostFirst.setSession('session-404')
  hostFirst.noteLatestUserCard({ cardKey: 'user:5:msg-a', turnNo: '5' })
  hostFirst.setQuote({ cardKey: 'assistant:turn:5', kind: 'assistant', turnNo: '5', preview: '秘书正文', refSessionIds: [] })
  assert.equal(cache.has(surface.QUOTE_BASELINE_STORAGE_PREFIX + 'session-404'), true, '基线也落本地缓存')
  assert.equal(hostFirst.isQuoted('assistant:turn:5'), true)

  // 用户在消息发出去之前刷新了页面：引用还在，最末用户卡也没变 → 提示继续挂着
  const reloaded = surface.createSecretaryQuoteStore({ fetchImpl: async () => ({ ok: false }), storage })
  reloaded.setSession('session-404')
  await reloaded.hydrate()
  assert.equal(reloaded.isQuoted('assistant:turn:5'), true, 'TTL 没到、消息没发 → 引用还在')
  assert.equal(reloaded.noteLatestUserCard({ cardKey: 'user:5:msg-a', turnNo: '5' }), false)
  assert.equal(reloaded.isQuoted('assistant:turn:5'), true)

  // 刷新发生在消息发出去之后：基线还在、最末用户卡换成更新的轮次 → 收掉，不留过期提示
  assert.equal(reloaded.noteLatestUserCard({ cardKey: 'user:6:msg-b', turnNo: '6' }), true)
  assert.equal(reloaded.isQuoted('assistant:turn:5'), false)
  assert.equal(JSON.parse(cache.get(surface.QUOTE_STORAGE_PREFIX + 'session-404')), null, '本地那份也收干净')
}])

cases.push(['过期通知卡不进卡片窗口（第 1 项）：buildSecretaryPagerCards 只数还没到点的通知', () => {
  const now = Date.now()
  const pad = (value) => String(value).padStart(2, '0')
  const clock = `${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}`
  const rows = [
    fakeUserRow('8:11:msg-new', '8', '（系统通知，不是用户说的话）\n电脑操作会话「备份」这一轮已经完成。', clock),
    fakeUserRow('8:12:msg-old', '8', '（系统通知，不是用户说的话）\n老的通知正文。', '11月22日 9:08'),
    fakeUserRow('8:13:user', '8', '真实用户消息正文', clock),
  ]
  const doc = {
    querySelectorAll: (selector) => {
      const kinds = [...String(selector).matchAll(/data-chat-flow-kind="([^"]+)"/g)].map((match) => match[1])
      if (kinds.length > 0) return rows.filter((row) => kinds.includes(row.getAttribute('data-chat-flow-kind')))
      if (selector === '[data-chat-turn]') return [{ getAttribute: () => '8' }]
      if (selector.includes('data-dsh-scard')) return []
      return []
    },
  }
  const cards = surface.buildSecretaryPagerCards(doc)
  const keys = cards.map((card) => card.cardKey)
  assert.ok(keys.includes('notice:8:11:msg-new'), '没过期的通知卡仍然占一个卡位')
  assert.ok(!keys.some((key) => key.includes('msg-old')), '过期通知卡不再计入窗口（也不会被折叠行还原）')
  assert.ok(keys.includes('user:8:13:user'), '真实用户消息不受过期口径影响')
}])

function fakeUserRow(nodeKey, turnNo, text, clockText) {
  // 2026-11-24 附件批次之后，扫描层读的是「块列表」，这条老用例改成宿主机械的假行（正文文本照旧）
  return fakeHostUserRow(nodeKey, turnNo, clockText, [fakeTextBubble(text)])
}

cases.push(['扫描层打标（第 3 项）：compact 两行按 kind 与文字判据打标，我们的卡一律不碰', () => {
  const tagged = []
  const rows = [
    { kind: 'manual-compaction', text: 'compact 已压缩 41 条历史记录（约 19692 tokens）', ownCard: false },
    { kind: 'compaction', text: '独立摘要行', ownCard: false },
    { kind: 'command', text: 'compact: Compaction could not produce a useful summary. The attempt is recorded in the session log.', ownCard: false },
    { kind: 'user', text: '用户自己说：已压缩 41 条历史记录（约 19692 tokens）', ownCard: true },
    { kind: 'assistant-step', text: '好的，我看完了', ownCard: true },
    { kind: 'context', text: '普通上下文行', ownCard: false },
  ].map((row) => ({
    getAttribute: (name) => (name === 'data-chat-flow-kind' ? row.kind : null),
    textContent: row.text,
    querySelector: (inner) => (inner === '[data-dsh-scard="card"]' && row.ownCard ? {} : null),
    setAttribute: (name, value) => { tagged.push({ name, value, kind: row.kind }) },
    removeAttribute: () => {},
  }))
  const out = surface.tagSecretaryCompactHintRows({ querySelectorAll: () => rows })
  assert.equal(out.kindRows, 2, 'compaction / manual-compaction 两行按 kind 打标')
  assert.equal(out.textRows, 1, '文字判据只命中那一条 command 行')
  assert.deepEqual(tagged.filter((item) => item.kind === 'user'), [], '用户卡里出现同样字样不许打标')
  assert.equal(tagged.every((item) => item.name === surface.COMPACT_HINT_ATTRIBUTE && item.value === 'hint'), true, '打的都是那一个标记')
  assert.equal(surface.COMPACT_HINT_ATTRIBUTE, 'data-dsh-scard-compact')
}])

cases.push(['秘书页只显示卡片：assistant-step（含 reasoning 分组行）一律不出图、放行 reasoning 的 :not 已删、用户消息仍由卡片接管气泡、观感口径 900/600/200 一个没变', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  // ① 过程行（截图里带放大镜那两行）的根因：旧规则用 :not([data-chat-group-part="reasoning"]) 把 reasoning 分组行放过来了
  assert.ok(!css.includes('[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])'),
    '样式表里不许再留放行 reasoning 分组的 :not 排除——那正是「已搜索代码并调用工具」冒出来的原因')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-chat-flow-kind="assistant-step"\],\s*\nbody\[data-dsh-secretary="1"\] \[data-chat-group-part="reasoning"\] \{\s*\n\s*display: none !important;/,
    'assistant-step 与 reasoning 分组行都要被 display:none !important 压掉（含 group-part 兜底）')
  // ② 用户消息必须是卡片（2026-11-24 附件批次改了口径）：
  //   - 完整卡（用户卡/通知卡）现在接管**整条**宿主行：原生气泡与原生附件芯片都不许再出图，
  //     因为图片/文件已经嵌进卡片内部（见本文件末那两组附件回归用例）；
  //   - 分页窗口外压成折叠行的那些老卡仍保留宿主气泡里的附件芯片（:not(:has(img)) 例外不许摘掉，
  //     否则老消息的附件就彻底看不见了）。
  assert.match(css,
    /\[data-chat-flow-kind="user"\]:has\(> \[data-dsh-scard="card"\]\[data-dsh-scard-kind="user"\], > \[data-dsh-scard="card"\]\[data-dsh-scard-kind="notice"\]\) > \[data-slot="conversation\.chat\.node"\] \{/,
    '完整卡必须把宿主用户行整个压掉（这一条不许带 :not(:has(img)) 例外）')
  assert.match(css,
    /\[data-chat-flow-kind="user"\]:has\(\[data-dsh-scard="card"\]\[data-dsh-scard-kind="user"\], \[data-dsh-scard="card"\]\[data-dsh-scard-kind="notice"\]\) > \[data-slot="conversation\.chat\.node"\] \{/,
    '还要有按后代匹配的兜底：卡片被包进更深一层时也不许让原生气泡与附件冒回来')
  assert.match(css,
    /\[data-dsh-scard="collapsed-row"\]\[data-dsh-scard-kind="user"\][^\n]*\n?[^\n{]*:not\(:has\(img\)\)/,
    '折叠行那一条仍带 :not(:has(img)) 例外：窗口外老卡的附件芯片不许丢')
  // 带附件的用户行只在「折叠行」那种情况下才保留宿主气泡：:not(:has(img)) 至少还留着两处
  assert.equal((css.match(/:not\(:has\(img\)\)/g) ?? []).length >= 2, true, '折叠行保留带附件行气泡的例外')
  // ③ 卡片观感口径三个数一个都没变（本批只动过程行隐藏，不许顺手改观感）
  assert.equal(cardShared.HISTORY_PREVIEW_MAX_CHARS, 900, '列表预览上限仍是 900')
  assert.equal(surface.QUOTE_PREVIEW_MAX_CHARS, 600, '引用预览上限仍是 600')
  const registrySource = readFileSync(join(ROOT, 'vendor/computer-use/code-agent-registry-DDJfS2Fl.js'), 'utf8')
  assert.match(registrySource, /const BOOKMARK_OUTCOME_MAX_CHARS = 200;/, '书签出口仍是 200')
}])

// ── 用户卡附件回归（2026-11-24 bug）：宿主把一条用户消息按 block 顺序渲染成
//    「文本气泡 / 附件行 / 文本气泡」，卡片必须把三段文字全收下来、顺序不错，
//    并把图片/文件嵌在卡片内部（不再单独出附件卡）。DOM 形状照 2026-11-24 现网 dump：
//    flowItem > [data-slot=conversation.chat.node] > userRow > userStack > (bubble|attachmentRow) > …
function fakeEl(tag, attrs, kids) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: { ...(attrs ?? {}) },
    children: [],
    parentElement: null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? String(node.attrs[name]) : null },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) },
    matches(raw) { return selectorMatches(node, raw) },
    closest(raw) {
      let step = node
      while (step !== null && step !== undefined) {
        if (step.matches(raw)) return step
        step = step.parentElement
      }
      return null
    },
    querySelectorAll(raw) { return descendantsMatching(node, raw) },
    querySelector(raw) { return node.querySelectorAll(raw)[0] ?? null },
    get textContent() {
      return (kids ?? []).map((child) => (typeof child === 'string' ? child : child.textContent)).join('')
    },
  }
  for (const child of kids ?? []) {
    if (typeof child === 'string') continue
    child.parentElement = node
    node.children.push(child)
  }
  return node
}

function selectorMatches(node, raw) {
  for (const part of String(raw).split(',')) {
    const sel = part.trim()
    if (sel === '') continue
    const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(sel)
    if (attr !== null) {
      const name = attr[1]
      if (attr[2] === undefined) { if (node.hasAttribute(name)) return true } else if (node.getAttribute(name) === attr[2]) return true
      continue
    }
    if (node.tagName === sel.toUpperCase()) return true
  }
  return false
}

function descendantsMatching(node, raw) {
  const out = []
  const walk = (el) => { for (const child of el.children) { if (child.matches(raw)) out.push(child); walk(child) } }
  walk(node)
  return out
}

/** 宿主文本气泡：bubble > rootSpan > span[data-slot="conversation.user.text.node"]（一条气泡里可能不止一个 run） */
function fakeTextBubble(text) {
  return fakeEl('div', {}, [fakeEl('span', {}, [fakeEl('span', { 'data-slot': 'conversation.user.text.node' }, [text])])])
}
/** 宿主图片附件行：照现网 dump（attachmentRow > images 槽 > gallery > button[title] > img[src][alt]） */
function fakeImageAttach(src, alt) {
  return fakeEl('div', { 'data-message-attachments': 'true' }, [
    fakeEl('div', { 'data-slot': 'conversation.chat.user.images' }, [
      fakeEl('div', { 'data-align': 'end' }, [
        fakeEl('button', { title: '查看原图', 'aria-label': `${alt}，点击查看原图` }, [fakeEl('img', { src, alt })]),
      ]),
    ]),
  ])
}
/** 宿主文件附件行：fileCard[title=文件名] > fileName + fileMeta */
function fakeFileAttach(name, meta) {
  return fakeEl('div', { 'data-message-attachments': 'true' }, [
    fakeEl('span', { title: name }, [fakeEl('span', {}, [name]), fakeEl('span', {}, [meta])]),
  ])
}
/** 整条宿主用户行（真实结构：flowItem > chat.node > userRow > userStack > 块… + actions[data-clock]） */
function fakeHostUserRow(nodeKey, turnNo, clockText, blocks) {
  return fakeFlowRow('user', nodeKey, turnNo, clockText, blocks)
}
/**
 * 同上，但 flow-kind 可给。现场 dump（2026-11-24，.tmp/dom-dump-live3.txt / dom-dump-live4.txt）：
 * 跑任务途中那条插话宿主持的是 `data-chat-flow-kind="steering"`（宿主在 conversation.chat.node 上
 * key="user" 与 key="steering" 注册的是同一个 UserMessageNodeView，内层 userRow/bubble 完全同一套）。
 */
function fakeFlowRow(flowKind, nodeKey, turnNo, clockText, blocks) {
  const stack = fakeEl('div', {}, blocks)
  const userRow = fakeEl('div', {}, [stack, fakeEl('div', { 'data-clock': 'start' }, [clockText])])
  return fakeEl('div', { 'data-chat-flow-kind': flowKind, 'data-chat-node-key': nodeKey, 'data-chat-turn': turnNo }, [
    fakeEl('div', { 'data-slot': 'conversation.chat.node' }, [userRow]),
  ])
}
/** 假对话流文档：按收集器实际问到的 kind 列表放行（写死「只有 user」时插话那条会被漏掉 → RED）。 */
const fakeHostDoc = (rows) => ({
  querySelectorAll: (selector) => {
    const kinds = [...String(selector).matchAll(/data-chat-flow-kind="([^"]+)"/g)].map((match) => match[1])
    return rows.filter((row) => {
      const kind = row.getAttribute('data-chat-flow-kind')
      return kind !== null && kind !== '' && kinds.includes(kind)
    })
  },
})

cases.push(['附件回归①：文字 + 图片 + 后续文字 → 卡片拿到全部三段文字（顺序不错、字也不丢）', () => {
  const row = fakeHostUserRow('13:input-messagee74d0783', '361', '15:12', [
    fakeTextBubble('我看个人秘书回复的文本，把数字用汉字表示的，'),
    fakeImageAttach('blob:http://127.0.0.1:3081/c7cd64d5', 'image.png'),
    fakeTextBubble('，这样阅读起来很吃力，我建议还是保留为数字。'),
  ])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([row]))
  assert.equal(rows.length, 1, '这条带附件的用户行必须出卡片')
  const text = rows[0].text
  assert.ok(text.includes('我看个人秘书回复的文本，把数字用汉字表示的，'), '附件之前的文字必须在')
  assert.ok(text.includes('我建议还是保留为数字。'), '附件后面的文字也不许再被截掉')
  assert.ok(text.indexOf('把数字用汉字') < text.indexOf('保留为数字'), '顺序必须还是「前段 → 后段」')
  const runs = rows[0].runs
  assert.deepEqual(runs.map((run) => run.type), ['text', 'attachment', 'text'], '块顺序照宿主页面的顺序：文本/附件/文本')
  const body = surface.buildUserCardBody(runs)
  assert.deepEqual(body.map((block) => block.type), ['para', 'attachment', 'para'], '卡片正文按原顺序排布')
  assert.equal(body[0].text, '我看个人秘书回复的文本，把数字用汉字表示的，')
  assert.equal(body[2].text, '，这样阅读起来很吃力，我建议还是保留为数字。')
  assert.equal(body[1].attachment.kind, 'image', '图片附件嵌在卡片内部')
  assert.equal(body[1].attachment.name, 'image.png', '文件名要从宿主那张 img 的 alt 读出来')
  assert.equal(body[1].attachment.src, 'blob:http://127.0.0.1:3081/c7cd64d5', '缩略图用宿主那份 src')
}])

cases.push(['附件回归②：文字 + 文件附件 + 后续文字 → 卡片里文件名与大小都在、附件只嵌在卡内', () => {
  const row = fakeHostUserRow('13:input-message-file-1', '363', '15:20', [
    fakeTextBubble('前面这段话'),
    fakeFileAttach('方案报告.pdf', 'PDF 1.2 MB'),
    fakeTextBubble('后面这段话也不许丢'),
  ])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([row]))
  const body = surface.buildUserCardBody(rows[0].runs)
  assert.deepEqual(body.map((block) => block.type), ['para', 'attachment', 'para'])
  assert.equal(body[1].attachment.kind, 'file', '文件附件也嵌在卡片内部')
  assert.equal(body[1].attachment.name, '方案报告.pdf')
  assert.equal(body[1].attachment.meta, 'PDF 1.2 MB', '大小与类型按宿主 fileCard 那份')
  assert.ok(rows[0].text.includes('后面这段话也不许丢'), '文件附件后面的文字也要在')
  assert.deepEqual(rows[0].attachments.map((item) => item.name), ['方案报告.pdf'], '附件清单挂在这张卡上')
}])

cases.push(['附件回归③：只有附件没有文字 → 也要出卡片（不许因为正文空就丢掉）', () => {
  const row = fakeHostUserRow('13:input-message-only-image', '364', '15:22', [fakeImageAttach('blob:http://127.0.0.1:3081/xyz', '照片.png')])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([row]))
  assert.equal(rows.length, 1, '纯附件消息也要挂卡片')
  assert.equal(rows[0].kind, surface.CARD_KIND_USER, '没有文字也不算通知')
  assert.equal(rows[0].text, '', '正文文本口径仍是纯文本（附件不混进文字）')
  const body = surface.buildUserCardBody(rows[0].runs)
  assert.deepEqual(body.map((block) => block.type), ['attachment'], '卡片正文只剩附件那一块')
  assert.equal(body[0].attachment.name, '照片.png')
}])

cases.push(['附件回归④：一条气泡里多个 run（引用 chip 切开的那种）不许被拆成多段', () => {
  const bubble = fakeEl('div', {}, [fakeEl('span', {}, [
    fakeEl('span', { 'data-slot': 'conversation.user.text.node' }, ['前面 ']),
    fakeEl('span', { title: '另一个会话' }, ['@[会话]']),
    fakeEl('span', { 'data-slot': 'conversation.user.text.node' }, ['后面']),
  ])])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([fakeHostUserRow('13:input-message-multi-run', '365', '15:24', [bubble])]))
  assert.equal(rows[0].text, '前面 @[会话]后面', '同一条气泡里的片段必须拼回一段')
  assert.deepEqual(surface.buildUserCardBody(rows[0].runs).map((block) => block.type), ['para'], '不许因为 chip 生成第二段正文')
}])

/* ═════════ 2026-11-24「秘书执行任务期间用户插话」两个显示 bug（现场 DOM dump 取证）═════════
 * 现场证据（scripts 的连接口径，真页 http://127.0.0.1:3081，落盘 .tmp/dom-dump-live3.txt、dom-dump-live4.txt）：
 *   ① 插话行：data-chat-flow-kind="steering" / data-chat-flow-key="13:input-message08ae5714-…"
 *     data-chat-node-key 同 key / data-chat-turn="390" / 行高 398px / hasCard=false（原生气泡冒了出来）
 *   ② 漏出来的过程行（三种，都在 [data-slot="conversation.chat.flow"] 那一层里，跟卡片行是兄弟）：
 *     · 过程分组行：class="_9YPp_G_root"、data-chat-group-key=["process","14:assistant-step390:1","reasoning"]
 *       这种行本身没有 data-chat-flow-kind，行高 20px，文字就是「已读取文件」「已搜索代码，已读取文件，已调用工具」；
 *     · 单条工具行：data-chat-flow-kind="tool-call" + data-turn-process-member="true"，行高 28px；
 *     · 回合尾槽 [data-slot="conversation.chat.turnTail"]：同一个容器里既挂我们的 assistant 卡（kind=turn-tail 行），
 *       也挂 dsh-mnemon 的「本回合记忆 / 召回 1」widget（截图那行「本回合记忆召回 1」），一压就连带把卡压没了。
 */

cases.push(['插话卡片化①：宿主执行中把用户插话挂成 kind="steering" 的行（现场 dump 的那个 kind）必须被收集器收成一条 user 卡行', () => {
  const interrupt = fakeFlowRow('steering', '13:input-message08ae5714-059e-407d-8ae0-40df53983508', '390', '今天 17:22', [
    fakeTextBubble('workbuddy 是桌面的软件程序'),
  ])
  const normal = fakeHostUserRow('13:input-message-normal-1', '391', '17:25', [fakeTextBubble('普通用户消息')])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([interrupt, normal]))
  assert.equal(rows.length, 2, '插话行与普通用户行都得收成卡行（现网漏的就是插话那条）')
  const card = rows.find((row) => row.key === '13:input-message08ae5714-059e-407d-8ae0-40df53983508')
  assert.ok(card !== undefined, 'steering 行必须有自己的卡片行')
  assert.equal(card.kind, surface.CARD_KIND_USER, '插话是真实用户消息，必须是冷蓝用户卡（不是灰底通知卡、也不是只有气泡）')
  assert.equal(card.text, 'workbuddy 是桌面的软件程序', '原话照搬进卡片，不改写')
  assert.equal(card.turnNo, '390', '插话挂在进行中那一轮，轮次号必须带回来（卡片底行与朗读 key 都要用）')
  assert.deepEqual(surface.collectSecretaryUserRows(fakeHostDoc([interrupt])).map((row) => row.key),
    ['13:input-message08ae5714-059e-407d-8ae0-40df53983508'], '只取真实用户行的那条路径也要认 steering')
}])

cases.push(['插话卡片化②：steering 行走「文本 run + 附件」的同一套块口径（附件前后的文字一样不许丢）', () => {
  const interrupt = fakeFlowRow('steering', '13:input-message-steer-att-1', '392', '17:31', [
    fakeTextBubble('插话前面这段'),
    fakeImageAttach('blob:http://127.0.0.1:3081/steer-img', '截图.png'),
    fakeTextBubble('插话后面这段也不许丢'),
  ])
  const rows = surface.collectSecretaryCardRows(fakeHostDoc([interrupt]))
  assert.equal(rows.length, 1, '带附件的插话行也要出卡片')
  const body = surface.buildUserCardBody(rows[0].runs)
  assert.deepEqual(body.map((block) => block.type), ['para', 'attachment', 'para'], '块顺序与真 user 行同一套')
  assert.equal(body[1].attachment.name, '截图.png', '图片嵌在卡片内部')
  assert.equal(surface.userCardAttachments(rows[0].runs).length, 1, '附件清单也要带回来')
}])

cases.push(['插话卡片化③：卡片必须接管 steering 行的原生气泡（CSS 那一套 :has 判据要给 steering 也写一份，带后代兜底）', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css,
    /\[data-chat-flow-kind="steering"\]:has\([^)]*\[data-dsh-scard="card"\]\[data-dsh-scard-kind="user"\][^)]*\)\s*>\s*\[data-slot="conversation\.chat\.node"\]/,
    'steering 行挂了用户卡以后，宿主那条气泡必须 display:none（现场 dump 里它行高 398px 就是原生气泡）')
  assert.ok((css.match(/\[data-chat-flow-kind="steering"\]/g) ?? []).length >= 2,
    '直接子代判据与按后代兜底的判据都要有（React 把卡包进更深一层时不许漏）')
}])

cases.push(['插话卡片化④：扫描层（分页窗口/朗读 key）也要认出挂在 steering 行里的卡', () => {
  const interrupt = fakeFlowRow('steering', '13:input-message-steer-1', '393', '17:33', [fakeTextBubble('插话的原话')])
  const card = fakeEl('article', { 'data-dsh-scard': 'card', 'data-dsh-scard-kind': 'user', 'data-dsh-scard-key': 'user:13:input-message-steer-1', 'data-dsh-scard-turn': '393' }, [fakeEl('p', { 'data-dsh-scard': 'para' }, ['插话的原话'])])
  interrupt.children[0].children.push(card)
  card.parentElement = interrupt.children[0]
  const scanned = surface.collectSecretaryCardElements({ querySelectorAll: () => [card] })
  assert.equal(scanned.length, 1, '扫描层必须把这张插话卡算进去（分页窗口与朗读都靠它）')
  assert.equal(scanned[0].text, '插话的原话', '卡的文本要从它挂着的那条 steering 行读回来，不许因为找不到行而变空')
  assert.equal(scanned[0].timeText, '17:33', '底行时间也要从那条 steering 行的 [data-clock] 读回来（找不到行就是空 → RED）')
}])

cases.push(['过程行隐藏①：单条工具行（现场 dump 的 kind="tool-call"）与上下文行一律不出图', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-chat-flow-kind="tool-call"\]/,
    'dump 出来 display=block、行高 28px 的那一类就是 kind="tool-call"，必须补进隐藏列表')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-chat-flow-kind="context"\]/,
    '宿主 kind="context"（跨会话召回/上下文注入那类行）同样算过程行，秘书页一律不出图')
}])

cases.push(['过程行隐藏②：过程分组行（[data-chat-group-key]，截图那 3 行的第一行就是它的标题）压掉，但带卡的行不许顺手压掉', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-chat-group-key\]:not\(:has\(\[data-dsh-scard\]\)\)/,
    '现场 dump：分组行 class=_9YPp_G_root 带 data-chat-group-key、没有 data-chat-flow-kind，文字就是「已读取文件」「已搜索代码，已读取文件，已调用工具」')
  assert.ok(css.includes(':not(:has([data-dsh-scard]))'),
    '分组行与分组成员两条判据都要带 :not(:has([data-dsh-scard])) 兜底：卡片挂在哪一档都不许被顺手压没')
}])

cases.push(['过程行隐藏③：分组成员标记 data-turn-process-member 也压掉（现场 dump：tool-call 行都带 data-turn-process-member="true"，turn-tail 行一个都不带）', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-turn-process-member\]:not\(:has\(\[data-dsh-scard\]\)\)/,
    '宿主自己的分组成员标记是兜底判据（以后宿主换 kind 也照样压得住）')
}])

cases.push(['过程行隐藏④：回合尾那一档只压非卡子代——assistant 卡照旧挂着，dsh-mnemon「本回合记忆 召回 1」与 skill turn-tail 一律不出图', () => {
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.match(css,
    /body\[data-dsh-secretary="1"\] \[data-slot="conversation\.chat\.turnTail"\] > :not\(\[data-dsh-scard\]\)/,
    '现场 dump：assistant 卡与 mnemon/skill 的回合尾 widget 挂在同一个 [data-slot="conversation.chat.turnTail"] 里，只能压没带 data-dsh-scard 标记以外的子代')
}])

cases.push(['硬约束确认：折叠预算 3/2/10、首帧上限 162px、朗读 34px 与标识 32px、观感口径 900/600/200 一个都不许动', () => {
  assert.equal(surface.FOLD_BODY_LINE_BUDGET, 3, '折叠态正文预算仍是 3 行')
  assert.equal(surface.FOLD_TITLE_LINE_BUDGET, 2, '卡标题预算仍是 2 行')
  assert.equal(surface.FOLD_BLOCK_GAP, 10, '块间距仍是 10')
  const css = readFileSync(join(ROOT, 'src/client/pocket/orb/secretary-cards.css.ts'), 'utf8')
  assert.ok(css.includes('max-height: var(--dsh-card-fold-cap, 162px)'), '折叠首帧上限 162px 不许换')
  assert.equal(surface.foldCollapsedCapPx({ lineHeight: 26, titleLineHeight: 27, hasTitle: true, budget: 3, titleBudget: 2 }), 162, 'cap 算出来还是 162')
  assert.ok(css.includes('height: 34px') && css.includes('width: 32px'), '朗读按钮 34px 与 32px 标识尺寸不许动')
  assert.equal(cardShared.HISTORY_PREVIEW_MAX_CHARS, 900)
  assert.equal(surface.QUOTE_PREVIEW_MAX_CHARS, 600)
  // 新加的隐藏规则一律只作用于秘书页那一档，别的会话页面一个字都不动
  const newHiddenLines = css.split('\n').filter((line) => /tool-call|data-chat-group-key|turn-process-member|turnTail|flow-kind="steering"/.test(line))
  assert.ok(newHiddenLines.length >= 5, `新加的隐藏规则行数不够（现场 dump 的那几类都得覆盖）：${newHiddenLines.length}`)
  assert.ok(newHiddenLines.every((line) => line.includes('body[data-dsh-secretary="1"]')), '每一条新隐藏规则都必须带 body[data-dsh-secretary="1"] 限定符')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-cards`)
