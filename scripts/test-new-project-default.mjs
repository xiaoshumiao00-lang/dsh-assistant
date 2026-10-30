/** 新建项目「选择位置」起始目录 + 本机默认父目录外置解析的回归：node scripts/test-new-project-default.mjs */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configuredNewProjectParent,
  defaultProjectFolder,
  defaultProjectName,
  isAutoProjectFolder,
  projectFolderBrowseStart,
  resolveNewProjectParent,
  stampFolderName,
} from '../src/client/newProjectDefault.ts'
import { primeAssistantConfig, skillFileOf, skillRootSync } from '../src/client/assistant-config.ts'

/** 通用示例目录：仓库里不再有本机个人目录，测试也不再借用真人目录 */
const PARENT = 'D:\\Users\\me\\Projects'

const cases = []

cases.push(['默认父目录来自本机配置（不是仓库常量）', () => {
  primeAssistantConfig({ newProjectParent: PARENT, skillRoot: 'D:\\Users\\me\\.dsh\\skills', assistantHome: 'D:\\Users\\me\\.dsh\\assistant' })
  assert.equal(configuredNewProjectParent(), PARENT)
  assert.equal(skillRootSync(), 'D:\\Users\\me\\.dsh\\skills')
  assert.equal(skillFileOf('paper-10step/references/02-十步自纠清单.md'), 'D:\\Users\\me\\.dsh\\skills\\paper-10step\\references\\02-十步自纠清单.md')
}])

cases.push(['技能根未配置时用通用回落（不写用户名）', () => {
  primeAssistantConfig({ newProjectParent: PARENT, skillRoot: '', assistantHome: '' })
  assert.equal(skillRootSync(), '~/.dsh/skills')
  assert.ok(!skillFileOf('paper-10step/references/01-个人写作基准.md').includes('Users\\\\'))
}])

cases.push(['空值 → 本机配置的默认父目录（不造伪路径）', () => {
  primeAssistantConfig({ newProjectParent: PARENT })
  assert.equal(projectFolderBrowseStart(''), PARENT)
  assert.equal(projectFolderBrowseStart(null), PARENT)
  assert.equal(projectFolderBrowseStart(undefined), PARENT)
  assert.equal(projectFolderBrowseStart('   '), PARENT)
}])

cases.push(['未配置本机默认目录时：不猜路径（空串，调用方决定退让）', () => {
  primeAssistantConfig({ newProjectParent: '' })
  assert.equal(configuredNewProjectParent(), '')
  assert.equal(projectFolderBrowseStart(''), '')
  assert.equal(isAutoProjectFolder('D:\\someone\\202610271930'), false)
}])

cases.push(['待创建的时间戳目录 → 从它的父目录开始浏览（否则一打开就 ENOENT）', () => {
  primeAssistantConfig({ newProjectParent: PARENT })
  const auto = PARENT + '\\202610271930'
  assert.equal(isAutoProjectFolder(auto), true)
  assert.equal(projectFolderBrowseStart(auto), PARENT)
  assert.equal(projectFolderBrowseStart(auto + '\\'), PARENT)
  assert.equal(isAutoProjectFolder(PARENT + '\\202610271930-2'), true)
  assert.equal(projectFolderBrowseStart(PARENT + '\\202610271930-2'), PARENT)
}])

cases.push(['混合分隔符 / 大小写：自动目录判定与父目录都按 Windows 规则', () => {
  primeAssistantConfig({ newProjectParent: PARENT })
  const mixed = PARENT.replace(/\\/g, '/') + '/202610271930'
  assert.equal(projectFolderBrowseStart(mixed), PARENT)
  assert.equal(projectFolderBrowseStart(PARENT.toUpperCase() + '\\202610271930'), PARENT)
}])

cases.push(['用户选过的真实目录原样作为起点（可继续往下浏览）', () => {
  primeAssistantConfig({ newProjectParent: PARENT })
  assert.equal(projectFolderBrowseStart('D:\\Users\\me\\Desktop\\论文 A'), 'D:\\Users\\me\\Desktop\\论文 A')
  assert.equal(projectFolderBrowseStart('  D:/work/project  '), 'D:/work/project')
  const named = PARENT + '\\论文写作'
  assert.equal(projectFolderBrowseStart(named), named)
  const outside = 'D:\\work\\202610271930'
  assert.equal(isAutoProjectFolder(outside), false)
  assert.equal(projectFolderBrowseStart(outside), outside)
}])

cases.push(['默认项目名 = 文件夹名（未填名称时）', () => {
  assert.equal(defaultProjectName('  ' + PARENT + '\\202610271930  '), '202610271930')
  assert.equal(defaultProjectName('D:\\Users\\me\\Projects\\论文写作\\'), '论文写作')
  assert.match(stampFolderName(), /^\d{12}$/)
}])

cases.push(['defaultProjectFolder：本机未配置父目录时返回空串（不猜目录）', async () => {
  primeAssistantConfig({ newProjectParent: '' })
  assert.equal(await defaultProjectFolder(fakeFetch([])), '')
}])

cases.push(['defaultProjectFolder：时间戳目录已占用时追加 -2 / -3', async () => {
  primeAssistantConfig({ newProjectParent: PARENT })
  // 占用判定用的是「现在这一刻」的时间戳，测试必须按同一时刻造桩
  const base = stampFolderName()
  const taken = [base, base + '-2']
  const folder = await defaultProjectFolder(fakeFetch(taken))
  assert.equal(folder, PARENT + '\\' + base + '-3', `实际 = ${folder}`)
}])

cases.push(['宿主侧配置文件：newProjectParent / asrTerms / persona / allowedRoots 都从本地 JSON 读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-config-'))
  const home = join(dir, 'assistant')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    newProjectParent: 'D:\\Users\\me\\Desktop\\默认项目',
    asrTerms: [{ pattern: '示例人|示例人二', replace: '示例规范名' }],
    persona: { title: '本机人设', lines: ['你是示例用户的私人助手'] },
    allowedRoots: ['D:\\Users\\me\\Projects'],
  }), 'utf8')
  const previousHome = process.env.DSH_ASSISTANT_HOME
  const previousConfig = process.env.DSH_ASSISTANT_CONFIG
  process.env.DSH_ASSISTANT_HOME = home
  process.env.DSH_ASSISTANT_CONFIG = join(home, 'config.json')
  // 宿主侧读法走构建产物（与 test-assistant-home 同一口径）
  const assistant = await import('../lib/index.js')
  const configModule = assistant.assistantConfigTestSurface
  try {
    const cfg = configModule.loadAssistantConfig(true)
    assert.equal(cfg.newProjectParent, 'D:\\Users\\me\\Desktop\\默认项目')
    assert.deepEqual(cfg.asrTerms, [{ pattern: '示例人|示例人二', replace: '示例规范名' }])
    assert.deepEqual(cfg.persona?.lines, ['你是示例用户的私人助手'])
    assert.deepEqual(cfg.allowedRoots, ['D:\\Users\\me\\Projects'])
    const resolved = configModule.resolveNewProjectParent(cfg)
    assert.equal(resolved.from, 'config')
    assert.equal(resolved.parent, 'D:\\Users\\me\\Desktop\\默认项目')
    const view = configModule.assistantConfigClientView()
    assert.equal(view.newProjectParent, 'D:\\Users\\me\\Desktop\\默认项目')
    assert.equal(view.assistantHome, home)
    // 没有本机配置文件：仓库默认 = 空词表 + 平台 Desktop / 助手目录回落
    rmSync(join(home, 'config.json'), { force: true })
    configModule.resetAssistantConfigCacheForTests()
    process.env.DSH_ASSISTANT_CONFIG = join(dir, 'does-not-exist.json')
    const empty = configModule.loadAssistantConfig(true)
    assert.equal(empty.newProjectParent, null)
    assert.equal(empty.asrTerms.length, 0)
    const fallback = configModule.resolveNewProjectParent(empty)
    assert.ok(fallback.parent, '回落目录不能为空')
    assert.ok(fallback.from === 'desktop' || fallback.from === 'assistant', `回落来源 = ${fallback.from}`)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_ASSISTANT_HOME
    else process.env.DSH_ASSISTANT_HOME = previousHome
    if (previousConfig === undefined) delete process.env.DSH_ASSISTANT_CONFIG
    else process.env.DSH_ASSISTANT_CONFIG = previousConfig
    rmSync(dir, { recursive: true, force: true })
  }
}])

/** 假 fetch：/api/worktable/fs 返回目录列（父目录 → 该目录里已有的子项名字） */
function fakeFetch(taken) {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const entries = (taken ?? []).map((name) => ({ name }))
    return { ok: true, json: async () => ({ entries }) }
  }
}

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
