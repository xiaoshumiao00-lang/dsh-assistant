import { assistantHome, archiveRoot as ARCHIVE_ROOT, accountPath as ACCOUNT_PATH } from './personal-context-lib.mjs'
/**
 * 个人秘书「派活目录」规则单测（纯函数，不启动 DSH、不碰真实目录）：
 *   node scripts/test-secretary-dispatch.mjs
 * 规则来源：用户 2026-11-21 实测反馈——
 *   纯知识随口问直接答；其余任务：相关项目 / 旧任务延续 → 该项目目录；没有项目 → 新建专项文件夹 + CU。
 */
import assert from 'node:assert/strict'
import {
  absolutePathsIn,
  complexityOf,
  decideDispatchTarget,
  hasTaskIntent,
  matchProject,
  slugFolderName,
  uniqueFolderName,
} from '../src/client/secretary-dispatch.ts'
import { basenameOf } from '../src/client/pathutil.ts'

const ASSISTANT = assistantHome()
const PARENT = 'D:\\Projects'
const NOW = new Date(2026, 10, 20, 23, 30)
const QQ_SCREEN_QUESTION = '你看我打开的 QQ 页面，他们说的 38 fn 指什么模型？'

const projects = [
  { dir: 'D:\\hpg', name: 'hpg 小程序', titles: ['修店铺详情页白屏'], lastUsedAt: 3 },
  { dir: ARCHIVE_ROOT() + '\\15 高珂中文论文', name: '高珂中文论文', titles: ['第5章算法改用SCI完整算法'], lastUsedAt: 2 },
  { dir: 'D:\\dsh-assistant', name: 'dsh-assistant', titles: ['修手机端长按悬浮球'], lastUsedAt: 1 },
]

const decide = (text, extra = {}) => decideDispatchTarget({
  text,
  projects,
  assistantHome: ASSISTANT,
  newFolderParent: PARENT,
  now: NOW,
  ...extra,
})

const cases = []

cases.push(['纯知识/闲聊不派活；看屏问话必须派活', () => {
  assert.equal(decide('个人秘书是干什么的').kind, 'chat')
  assert.equal(decide('为什么只读权限没确认？').kind, 'chat')
  assert.equal(decide('今天几号').kind, 'chat')
  assert.equal(hasTaskIntent('今天几号'), false)
  assert.equal(hasTaskIntent(QQ_SCREEN_QUESTION), true, '看当前 QQ 页面不是纯知识随口问')
  const screen = decide(QQ_SCREEN_QUESTION)
  assert.notEqual(screen.kind, 'chat', '不许把看屏问题交给秘书直接终答')
  assert.notEqual(screen.kind, 'assistant', '看屏问题不能落入会被工具拒绝的旧 A 类杂活')
  assert.equal(screen.kind, 'new-folder')
  assert.match(screen.cwd, /^D:\\Projects\\/)
}])

cases.push(['与既有项目相关 → 派到旧项目目录', () => {
  const r = decide('把 hpg 小程序的门店详情页再改一下')
  assert.equal(r.kind, 'existing')
  assert.equal(r.cwd, 'D:\\hpg')
  assert.match(r.reason, /相关/)
  const t = decide('继续改高珂中文论文第5章的表')
  assert.equal(t.kind, 'existing')
  assert.equal(t.cwd, ARCHIVE_ROOT() + '\\15 高珂中文论文')
}])

cases.push(['旧任务延续（会话标题命中）→ 旧项目目录', () => {
  const r = decide('接着上次修店铺详情页白屏那条继续')
  assert.equal(r.kind, 'existing')
  assert.equal(r.cwd, 'D:\\hpg')
  assert.match(r.reason, /continuation|相关/)
}])

cases.push(['原话里写了绝对路径 → 命中该项目', () => {
  const r = decide('把 D:\\dsh-assistant\\src\\client 里的输入框换成官方 composer')
  assert.equal(r.kind, 'existing')
  assert.equal(r.cwd, 'D:\\dsh-assistant')
  assert.deepEqual(absolutePathsIn('看 D:\\a\\b 和 E:/c/d'), ['D:\\a\\b', 'E:/c/d'])
}])

cases.push(['不相关且复杂 → 新建专项文件夹（默认父目录下）', () => {
  const r = decide('新建一个爬虫工程：先抓数据，然后合并，最后导出 Excel，所有文件都要加日志')
  assert.equal(r.kind, 'new-folder')
  assert.equal(r.cwd, 'D:\\Projects\\新建一个爬虫工程-先抓数据-然后合并')
  assert.equal(r.folderName, '新建一个爬虫工程-先抓数据-然后合并')
  assert.ok(r.signals.includes('multi-step'))
  assert.ok(r.signals.includes('build-project'))
}])

cases.push(['复杂关键词判定', () => {
  assert.equal(complexityOf('把所有文件统一改名').level, 'complex')   // 跨文件
  assert.equal(complexityOf('先统计再导出').level, 'complex')         // 多步骤
  assert.equal(complexityOf('帮我把这句话翻译成英文').level, 'simple')
  assert.equal(complexityOf('把报告润色一下').level, 'simple')
}])

cases.push(['简单动手杂活也走分层 C：新建专项文件夹 + CU', () => {
  const r = decide('帮我把桌面那张截图裁一下')
  assert.equal(r.kind, 'new-folder')
  assert.match(r.cwd, /^D:\\Projects\\/)
  assert.match(r.reason, /动手|新建专项文件夹|看屏|本机/)
}])

cases.push(['上网查证不是秘书页直接回答', () => {
  const r = decide('帮我上网查证一下这个模型的官方名称')
  assert.equal(r.kind, 'new-folder')
  assert.match(r.cwd, /^D:\\Projects\\/)
}])

cases.push(['没给新项目父目录 → 用助手目录的父目录', () => {
  const r = decide('新建一个工程，先建目录再写脚本最后部署，所有文件都要有说明', { newFolderParent: '' })
  assert.equal(r.kind, 'new-folder')
  assert.equal(r.cwd, ACCOUNT_PATH() + '\\.dsh\\' + r.folderName)
}])

cases.push(['纯知识问题不依赖派活目录', () => {
  const r = decide('今天几号', { assistantHome: '', newFolderParent: '' })
  assert.equal(r.kind, 'chat')
  assert.equal(r.cwd, '')
}])

cases.push(['文件夹名清洗 + 重名追加序号', () => {
  assert.equal(slugFolderName('【新项目】爬虫/抓数据: 第1版', NOW), '新项目-爬虫-抓数据-第1版')
  assert.equal(slugFolderName('做', NOW), '202611202330')
  assert.equal(uniqueFolderName('爬虫', ['爬虫']), '爬虫-2')
  assert.equal(uniqueFolderName('爬虫', ['爬虫', '爬虫-2']), '爬虫-3')
  assert.equal(uniqueFolderName('爬虫', []), '爬虫')
}])

cases.push(['项目名短于 2 字不参与匹配；目录名参与匹配', () => {
  assert.equal(matchProject('随便说两句', [{ dir: 'D:\\x', name: '甲' }]), null)
  const hit = matchProject('去 dsh-assistant 里改', projects)
  assert.ok(hit && basenameOf(hit.project.dir) === 'dsh-assistant')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-dispatch`)
