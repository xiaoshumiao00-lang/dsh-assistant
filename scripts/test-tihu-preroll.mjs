#!/usr/bin/env node
/**
 * 播报预录缓存单测（`src/tihu/preroll.ts`）。
 *
 * 钉住四件事：
 *   1. 键＝音色＋文本（换音色必须重合成，否则念出来是别人的声音）；
 *   2. 命中/没命中都只影响「要不要合成」，**绝不抛错**（缓存坏了不能把播报搞挂）；
 *   3. 两个上限（条数 / 总字节）真的生效，超了删最老的；
 *   4. 超过 20 秒的音频不进缓存（那不是「一句短话」）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PREROLL_MAX_AUDIO_MS,
  PREROLL_MAX_BYTES,
  PREROLL_MAX_FILES,
  PREROLL_SAMPLE_RATE,
  TihuPreroll,
  defaultPrerollDir,
  prerollAudioMs,
  prerollKeyOf,
} from '../src/tihu/preroll.ts'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tihu-preroll-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 造一段「时长 ms」的静音 PCM（16 bit 单声道 24 kHz）。 */
function pcmOfMs(ms) {
  return Buffer.alloc(Math.round((PREROLL_SAMPLE_RATE * 2 * ms) / 1000))
}

test('缓存键：同一句话同一个键，换音色就换键，空白差别被折叠', () => {
  const a = prerollKeyOf('default', '把磷石膏那组图重画——三张图已更新')
  const b = prerollKeyOf('default', '把磷石膏那组图重画——三张图已更新')
  assert.equal(a, b)
  assert.equal(a.length, 16)
  assert.notEqual(prerollKeyOf('default', '同一句话'), prerollKeyOf('chenpan', '同一句话'), '换音色必须重新合成')
  assert.equal(prerollKeyOf('default', '你好   鹈鹕'), prerollKeyOf('default', '你好 鹈鹕'), '空白折叠')
  assert.equal(prerollKeyOf('', '一句话'), prerollKeyOf('default', '一句话'), '空音色按 default 算')
})

test('PCM 字节数 → 毫秒（16 bit 单声道 24 kHz）', () => {
  assert.equal(prerollAudioMs(0), 0)
  assert.equal(prerollAudioMs(PREROLL_SAMPLE_RATE * 2), 1000)
  assert.equal(prerollAudioMs(PREROLL_SAMPLE_RATE * 2 * 3), 3000)
})

test('目录：$TIHU_PREROLL_DIR 优先，其次 $DSH_HOME/tihu/preroll', () => {
  const before = { dir: process.env.TIHU_PREROLL_DIR, home: process.env.DSH_HOME }
  try {
    process.env.TIHU_PREROLL_DIR = 'D:/tmp/preroll-x'
    assert.equal(defaultPrerollDir(), 'D:/tmp/preroll-x')
    delete process.env.TIHU_PREROLL_DIR
    process.env.DSH_HOME = 'D:/dsh-home'
    assert.equal(defaultPrerollDir(), join('D:/dsh-home', 'tihu', 'preroll'))
  } finally {
    if (before.dir === undefined) delete process.env.TIHU_PREROLL_DIR
    else process.env.TIHU_PREROLL_DIR = before.dir
    if (before.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before.home
  }
})

test('存了一次就能命中，且拿回来的是同一段 PCM', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  const pcm = pcmOfMs(1200)
  assert.equal(cache.put('default', '设备联调通过', pcm), true)
  const got = cache.get('default', '设备联调通过')
  assert.ok(got !== undefined)
  assert.equal(got.length, pcm.length)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 0)
  assert.equal(stats.files, 1)
  assert.equal(stats.hitRate, 1)
}))

test('没命中返回 undefined 并记一次 miss（不抛错）', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  assert.equal(cache.get('default', '从没念过的一句'), undefined)
  assert.equal(cache.stats().misses, 1)
  assert.equal(cache.stats().hitRate, 0)
}))

test('换音色不命中（同一句话两套缓存）', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  cache.put('default', '一句话', pcmOfMs(600))
  assert.equal(cache.get('chenpan', '一句话'), undefined)
  assert.ok(cache.get('default', '一句话') !== undefined)
  assert.equal(cache.stats().files, 1)
}))

test('空音频不存；超过 20 秒的音频不存', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  assert.equal(cache.put('default', '空', Buffer.alloc(0)), false)
  assert.equal(cache.put('default', '太长', pcmOfMs(PREROLL_MAX_AUDIO_MS + 500)), false)
  assert.equal(cache.put('default', '刚好', pcmOfMs(PREROLL_MAX_AUDIO_MS - 100)), true)
  assert.equal(cache.stats().files, 1)
}))

test(`条数上限 ${PREROLL_MAX_FILES}：超了删最老的，文件数不会失控`, () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  const total = PREROLL_MAX_FILES + 8
  for (let i = 0; i < total; i += 1) cache.put('default', `第 ${i} 句播报`, pcmOfMs(80))
  const files = readdirSync(dir).filter((name) => name.endsWith('.pcm')).length
  assert.ok(files <= PREROLL_MAX_FILES, `文件数 ${files} 不应超过 ${PREROLL_MAX_FILES}`)
  assert.ok(files > 0, '不该全删光')
}))

test(`总字节上限 ${PREROLL_MAX_BYTES}：超了继续删（大块也仍在 20 秒上限内）`, () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  // 每条 900 KB（≈19.2 秒，仍在 20 秒上限内），存 12 条 ≈ 10.8 MB → 必须被砍到 8 MB 以内
  const big = Buffer.alloc(900 * 1024)
  for (let i = 0; i < 12; i += 1) assert.equal(cache.put('default', `大块 ${i}`, big), true, `第 ${i} 条应该存得下`)
  const stats = cache.stats()
  assert.ok(stats.bytes <= PREROLL_MAX_BYTES, `总字节 ${stats.bytes} 不应超过 ${PREROLL_MAX_BYTES}`)
  assert.ok(stats.files >= 1)
}))

test('目录里混进非 .pcm 文件不影响计数与清理', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  cache.put('default', '一句话', pcmOfMs(500))
  writeFileSync(join(dir, 'notes.txt'), 'not a cache', 'utf8')
  const stats = cache.stats()
  assert.equal(stats.files, 1)
  cache.prune()
  assert.equal(readdirSync(dir).includes('notes.txt'), true, '别人的文件不许动')
}))

test('clear() 清空缓存与计数', () => withDir((dir) => {
  const cache = new TihuPreroll(dir)
  cache.put('default', '甲', pcmOfMs(300))
  cache.put('default', '乙', pcmOfMs(300))
  cache.get('default', '甲')
  cache.clear()
  const stats = cache.stats()
  assert.equal(stats.files, 0)
  assert.equal(stats.hits, 0)
  assert.equal(stats.misses, 0)
  assert.equal(cache.get('default', '甲'), undefined)
}))

test('缓存目录不可写时只「不命中」，绝不抛错', () => {
  const cache = new TihuPreroll(join(tmpdir(), 'tihu-preroll-not-exist', 'deep', 'nope'))
  assert.equal(cache.put('default', '一句话', pcmOfMs(400)), true, 'put 会自己建目录')
  // 指向一个文件路径当目录：读写都会失败，但只能是 undefined/false
  const broken = new TihuPreroll(join(tmpdir(), 'tihu-preroll-broken.txt'))
  writeFileSync(join(tmpdir(), 'tihu-preroll-broken.txt'), 'x', 'utf8')
  try {
    assert.equal(broken.get('default', '一句话'), undefined)
    assert.equal(broken.put('default', '一句话', pcmOfMs(400)), false)
    assert.doesNotThrow(() => broken.prune())
  } finally {
    rmSync(join(tmpdir(), 'tihu-preroll-broken.txt'), { force: true })
    rmSync(join(tmpdir(), 'tihu-preroll-not-exist'), { recursive: true, force: true })
  }
})

console.log(`\n${passed} tests passed（tihu preroll）`)
