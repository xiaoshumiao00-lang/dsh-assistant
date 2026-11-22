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

const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface

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
  assert.equal(surface.FOLD_FALLBACK_LINE_HEIGHT_PX, 27)
  // 折叠态固定上限（标准字号：标题 17px/1.5 两行 51px + 间距 10px + 正文 15px/1.8 三行 81px + 两个块间距 20px）
  assert.equal(surface.foldCollapsedCapPx({ lineHeight: 27, titleLineHeight: 25.5, hasTitle: true }), 162)
  assert.equal(surface.foldCollapsedCapPx({ lineHeight: 27, hasTitle: false }), 101)
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
  assert.ok(parsed.paragraphs.some((p) => p.includes('完整展示') && p.includes('不许精简')), '完整转述口径那行进了卡片正文')
  assert.ok(parsed.paragraphs.some((p) => p.includes('工具已全部禁用')), '工具禁用那行也照实显示')
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
    return {
      getAttribute: (name) => (name === 'data-chat-flow-kind' ? kind
        : name === 'data-clock' ? '20:24'
          : name === 'data-chat-turn' ? '7'
            : name === 'data-chat-node-key' ? `13:${text.slice(0, 4)}` : null),
      textContent: text,
      querySelector: (sel) => (sel === '[data-slot="conversation.user.text.node"]'
        ? { querySelectorAll: () => [{ nodeType: 3, textContent: text }], textContent: text }
        : sel === '[data-clock]' ? { textContent: '20:24' } : null),
    }
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
  // 行高量不出来（字体没落、块被宿主藏起来）：按兜底行高 27 折叠，不许因为量不到就平铺
  const bad = surface.foldClipFromBlocks({ blocks, naturalHeight: natural, lineHeight: 0 })
  assert.equal(bad.collapsedMaxHeight, 127)
  assert.equal(bad.overflow, true)
  assert.equal(bad.cap, 165)
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
