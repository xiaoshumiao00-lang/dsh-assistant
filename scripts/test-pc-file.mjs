/** 手机端会话「电脑文件」附件纯逻辑回归：node scripts/test-pc-file.mjs */
import assert from 'node:assert/strict'
import { PC_FILE_MAX_BYTES, isPcFileTooLarge, pcFileMime, pcFileStartPath, sessionCwdOf } from '../src/client/pcFile.ts'

const cases = []

cases.push(['默认从会话项目文件夹开始，保留盘符与中文路径', () => {
  assert.equal(pcFileStartPath('D:\\陈潘HBEU\\项目 A'), 'D:\\陈潘HBEU\\项目 A')
  assert.equal(pcFileStartPath('  C:/work  '), 'C:/work')
}])

cases.push(['无项目目录时不造伪路径，交给主机默认目录兜底', () => {
  assert.equal(pcFileStartPath(''), '')
  assert.equal(pcFileStartPath(null), '')
  assert.equal(pcFileStartPath(undefined), '')
  assert.equal(pcFileStartPath('   '), '')
}])

cases.push(['会话行 cwd 支持顶层/投影两种宿主形状', () => {
  assert.equal(sessionCwdOf({ cwd: 'D:/top' }), 'D:/top')
  assert.equal(sessionCwdOf({ projectionValues: { cwd: 'D:/flat' } }), 'D:/flat')
  assert.equal(sessionCwdOf({ projections: { values: { cwd: 'D:/nested' } } }), 'D:/nested')
  assert.equal(sessionCwdOf({}), '')
  assert.equal(sessionCwdOf(null), '')
}])

cases.push(['20MB 边界：等于上限可传，超过 1 字节即拒绝', () => {
  assert.equal(isPcFileTooLarge(PC_FILE_MAX_BYTES), false)
  assert.equal(isPcFileTooLarge(PC_FILE_MAX_BYTES + 1), true)
  assert.equal(isPcFileTooLarge(0), false)
  assert.equal(isPcFileTooLarge(undefined), false)
  assert.equal(isPcFileTooLarge(Number.NaN), false)
}])

cases.push(['本地路由给出具体 MIME 时直接使用（含参数剥离）', () => {
  assert.equal(pcFileMime('x.bin', 'image/png'), 'image/png')
  assert.equal(pcFileMime('x.bin', 'text/plain; charset=utf-8'), 'text/plain')
  assert.equal(pcFileMime('x.bin', 'IMAGE/JPEG'), 'image/jpeg')
}])

cases.push(['泛型 octet-stream / 空类型按扩展名补全，图片能进入官方图片草稿', () => {
  assert.equal(pcFileMime('photo.JPG', 'application/octet-stream'), 'image/jpeg')
  assert.equal(pcFileMime('图纸 final.PNG', ''), 'image/png')
  assert.equal(pcFileMime('说明.docx', null), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(pcFileMime('no-extension', 'application/octet-stream'), 'application/octet-stream')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + String((err && err.message) || err))
  }
}
console.log('')
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAILED ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
