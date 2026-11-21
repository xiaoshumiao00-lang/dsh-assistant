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
  ctl.toggle('t1')
  assert.equal(ctl.getSnapshot().status, 'paused')
  ctl.toggle('t1')
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
