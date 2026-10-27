/** 新建项目「选择位置」起始目录纯逻辑回归：node scripts/test-new-project-default.mjs */
import assert from 'node:assert/strict'
import { DEFAULT_NEW_PROJECT_PARENT, isAutoProjectFolder, projectFolderBrowseStart } from '../src/client/newProjectDefault.ts'

const cases = []

cases.push(['空值 → 默认父目录（不造伪路径）', () => {
  assert.equal(projectFolderBrowseStart(''), DEFAULT_NEW_PROJECT_PARENT)
  assert.equal(projectFolderBrowseStart(null), DEFAULT_NEW_PROJECT_PARENT)
  assert.equal(projectFolderBrowseStart(undefined), DEFAULT_NEW_PROJECT_PARENT)
  assert.equal(projectFolderBrowseStart('   '), DEFAULT_NEW_PROJECT_PARENT)
}])

cases.push(['待创建的时间戳目录 → 从它的父目录开始浏览（否则一打开就 ENOENT）', () => {
  const auto = DEFAULT_NEW_PROJECT_PARENT + '\\202610271930'
  assert.equal(isAutoProjectFolder(auto), true)
  assert.equal(projectFolderBrowseStart(auto), DEFAULT_NEW_PROJECT_PARENT)
  assert.equal(projectFolderBrowseStart(auto + '\\'), DEFAULT_NEW_PROJECT_PARENT)
  // 同分钟重复建项目的 -2 后缀同样算自动目录
  assert.equal(projectFolderBrowseStart(DEFAULT_NEW_PROJECT_PARENT + '\\202610271930-2'), DEFAULT_NEW_PROJECT_PARENT)
}])

cases.push(['混合分隔符 / 大小写：自动目录判定与父目录都按 Windows 规则', () => {
  const mixed = DEFAULT_NEW_PROJECT_PARENT.replace(/\\/g, '/') + '/202610271930'
  assert.equal(projectFolderBrowseStart(mixed), DEFAULT_NEW_PROJECT_PARENT)
  const upper = DEFAULT_NEW_PROJECT_PARENT.toUpperCase() + '\\202610271930'
  assert.equal(projectFolderBrowseStart(upper), DEFAULT_NEW_PROJECT_PARENT)
}])

cases.push(['用户选过的真实目录原样作为起点（可继续往下浏览）', () => {
  assert.equal(projectFolderBrowseStart('D:\\陈潘HBEU\\Desktop\\论文 A'), 'D:\\陈潘HBEU\\Desktop\\论文 A')
  assert.equal(projectFolderBrowseStart('  D:/work/project  '), 'D:/work/project')
  // 默认父目录下但不是时间戳命名的目录：也是真实目录，不从父目录重新开始
  const named = DEFAULT_NEW_PROJECT_PARENT + '\\论文写作'
  assert.equal(projectFolderBrowseStart(named), named)
  // 时间戳数字但不在默认父目录下：不当作自动目录
  const outside = 'D:\\work\\202610271930'
  assert.equal(isAutoProjectFolder(outside), false)
  assert.equal(projectFolderBrowseStart(outside), outside)
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
