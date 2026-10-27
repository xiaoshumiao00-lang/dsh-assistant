/** 控制室「只看进行中」筛选：node scripts/test-console-filter.mjs */
import assert from 'node:assert/strict'
import { filterWorkingCards, isWorkingCard } from '../src/client/consoleFilter.ts'

const cards = [
  { id: 'console', status: 'idle' },
  { id: 'a', status: 'busy' },
  { id: 'b', status: 'need' },
  { id: 'c', status: 'error' },
  { id: 'd', status: 'done' },
]

assert.equal(isWorkingCard({ status: 'busy' }), true, '进行中算在工作')
assert.equal(isWorkingCard({ status: 'need' }), true, '等待决策算在工作（否则会悄悄卡住）')
assert.equal(isWorkingCard({ status: 'error' }), true, '异常终止算在工作（否则会藏起红卡）')
assert.equal(isWorkingCard({ status: 'idle' }), false, '空闲不算')
assert.equal(isWorkingCard({ status: 'done' }), false, '已完成不算（含未确认的完成）')

assert.deepEqual(
  filterWorkingCards(cards, true).map((c) => c.id),
  ['a', 'b', 'c'],
  '只看进行中：只留绿 / 黄 / 红',
)
assert.equal(filterWorkingCards(cards, false), cards, '关闭筛选：原样返回同一引用')
assert.deepEqual(filterWorkingCards(cards, true).map((c) => c.status), ['busy', 'need', 'error'])
assert.deepEqual(filterWorkingCards([{ id: 'x', status: 'idle' }], true), [], '全空闲时筛选结果为空')

console.log('ok test-console-filter: 7 assertions')
