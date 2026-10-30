// 私人助手卡片（纯逻辑）：
//   - 首次建卡：固定 id、文件夹=助手目录、图标 🤖、排第一；
//   - 同目录已有项目（用户手工加过）→ 不重复建；
//   - 删除墓碑 → 不再重建；
//   - 空目录 → 什么都不做。
import assert from 'node:assert/strict'
import {
  ASSISTANT_PROJECT_ID, ASSISTANT_CARD_ICON,
  shouldAddAssistantCard, withAssistantCard, hasAssistantFolder,
} from '../src/client/assistant-card.ts'

const home = 'C:\\Users\\me\\.dsh\\assistant'
const empty = () => ({ layouts: [], folders: {}, iconOverrides: {}, order: [], removed: [] })
const layout = { id: ASSISTANT_PROJECT_ID, title: '私人助手', icon: ASSISTANT_CARD_ICON }

// 1. 首次建卡
const first = empty()
assert.equal(shouldAddAssistantCard(first, home), true)
const added = withAssistantCard(first, home, layout)
assert.equal(added.layouts.length, 1)
assert.equal(added.layouts[0].id, ASSISTANT_PROJECT_ID)
assert.equal(added.folders[ASSISTANT_PROJECT_ID], home)
assert.equal(added.iconOverrides[ASSISTANT_PROJECT_ID], ASSISTANT_CARD_ICON)
assert.deepEqual(added.order, [ASSISTANT_PROJECT_ID])
assert.equal(hasAssistantFolder(added, home), true)
// 原状态不改（纯函数）
assert.equal(first.layouts.length, 0)

// 2. 同目录已有项目（别的 id、分隔符/大小写不同）→ 不重复建
const manual = { ...empty(), layouts: [{ id: 'layout-x' }], folders: { 'layout-x': 'c:/users/me/.dsh/ASSISTANT/' } }
assert.equal(shouldAddAssistantCard(manual, home), false)
assert.equal(withAssistantCard(manual, home, layout), manual, '返回同一对象，调用方据此跳过写盘')

// 3. 删除墓碑 → 不重建
const deleted = { ...empty(), removed: [ASSISTANT_PROJECT_ID] }
assert.equal(shouldAddAssistantCard(deleted, home), false)

// 4. 空目录（宿主没给 / 旧版本）→ 不建卡
assert.equal(shouldAddAssistantCard(empty(), ''), false)
assert.equal(hasAssistantFolder(empty(), ''), false)

// 5. 已有助手卡时再加：原样返回
assert.equal(withAssistantCard(added, home, layout), added)

console.log('ok test-assistant-card: 12 assertions')
