# 秘书三处修复报告（2026-11-24）

仓库：`D:\dsh-assistant`　分支：`main`　origin/main：`5843725`（**未 push**）
改前本地已有四条未 push 提交：`6649baf` / `5e46298` / `6a54b80` / `e24f5e3`（本次一个都没动、没 rebase、没 amend）。

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 改动一：通知截断 | 只裁尾 → **保留头 15000 字 + 保留尾 5000 字 + 中间省略标注（写明省略字数与位置）+ 完整原文落盘并给绝对路径**；三条链路（秘书通知 / code_agent 完成通知 / GUI 回传桥）同一套语义 |
| 改动二：秘书口径 | 撤掉「完整展示、原样转述、不许精简」旧口径，改成「先给结论、自己整理成简短中文、保留硬事实、禁止整大段原封不动照抄」；`SECRETARY_SPEECH_STYLE_TEXT` 补第四条；通知回合 deny 文案同步 |
| 改动三：目标语义 | `dispatchPromptSection` 增加硬规则：秘书会话里立的目标必须是「派活驱动」目标，objective 必须写明动手由 `secretary_dispatch` 派 Computer Use 会话完成、秘书只做读回与汇报；复杂任务先派再读 |
| 验证 | `node build.mjs` 0 退出；`npm run check` 0 退出；七个指定脚本全绿（16/16、12/12、18 cases、23/23、5/5、32/32、41/41）；全量 76 个测试脚本 75 通过 / 1 失败，唯一失败是**改前就存在**的 `test-secretary-pagination-context`（已用 HEAD 的 `lib/index.js` 复现同样失败） |
| 本地提交 | 代码与测试：`e9aa68a`（完整 `e9aa68abc65ad0a78f6d3fca03fbf4f25d0d4163`）；本报告：紧随其后的独立提交，只含本文件（哈希见 `git log -1`；正文不写死以免自我引用） |

---

## 1. 根因（先调查后改）

`superpowers-debugging` Phase 1 逐条读源码核对，用户给的行号全部逐一验证（不盲信）：

- `src/assistant-cu-watch.ts`（改前 576 行）：
  - `:193` `export const CU_NOTICE_RESULT_MAX_CHARS = 20000` —— 确认。
  - `:196` `CU_NOTIFY_ROUTE_BODY_MAX_CHARS = CU_NOTICE_RESULT_MAX_CHARS * 10` —— 确认。
  - `:205-213` `summarizeCompletion()`：`clean.length <= MAX` 返回整段，否则 `return clean.slice(0, MAX) + '…'` —— **只保留开头、丢掉结尾**，这就是那份 346 行联合基金报告被切在「路径中段」、结论与末尾路径被吃掉的直接原因。
  - `:137` `const truncated = summary.endsWith('…')`：截断判定依赖省略号，改成保留尾段后这个判据不再成立（顺手改成显式 `truncation` 元数据）。
  - `:145` 通知正文写「按插件上限截断到 20000 字（末尾带 …，后半段不在通知里）」。
  - `:150` 「向用户汇报时把上面这条结果完整展示出来：原样转述，不许精简、不许合并或删细节……」——2026-11-22 旧口径，与 2026-11-24 用户反转冲突。
  - 收集端 `:274-293` 已不砍块、`reportText = collected.join('\n\n')` 已按顺序拼接，**唯一问题在裁切方向**。
- `vendor/computer-use/code-agent-registry-DDJfS2Fl.js`（改前 447 行）：
  - `:290` `const CODE_AGENT_NOTICE_MAX_CHARS = 20000`，`:291-295` `capNoticeOutcome` 同样是 `slice(0, MAX) + '…'` —— 第三条链路里**只裁尾**。
- `src/cu-bridge-core.mjs`（改前 455 行）：
  - `:28` `export const MAX_RESULT_CHARS = 20000`，`:70-74` `capText` 是 `…${value.slice(value.length - (max - 1))}` —— 这一条是「只留结尾、开头全丢」，方向相反但同样是单边裁。
- `src/assistant-secretary.ts`：
  - `:157` `SECRETARY_GOAL_TOOLS`（create_goal/update_goal/get_goal 放行）、`:146` `SECRETARY_READONLY_TOOLS`、`:240-246` `secretaryNoticeTurnAllowed` —— 确认存在，**本次未改**。
  - `:928-934` `SECRETARY_SPEECH_STYLE_TEXT`（改前 3 条），`:774` 通知回合 deny 文案里仍写着「原样转述…不许为简短而删」——与改法二同一处旧口径，必须一起改，否则模型在通知回合收到互相矛盾的指令。
- `src/assistant-dispatch.ts`：
  - `:413` 确认原句：「……立长期目标（create_goal / update_goal / get_goal）也不算动手，预计几十轮工具调用的长任务先立目标吃 goal-round-driver 的自动续跑兜底。」——这就是「秘书在秘书会话里立目标后自己一步步跑完」的口径来源。

---

## 2. 改动一：通知截断根治（头 + 尾 + 落盘）

### 2.1 before / after（`src/assistant-cu-watch.ts`）

改前（HEAD）：

```ts
193: export const CU_NOTICE_RESULT_MAX_CHARS = 20000
196: export const CU_NOTIFY_ROUTE_BODY_MAX_CHARS = CU_NOTICE_RESULT_MAX_CHARS * 10

205: export function summarizeCompletion(text: string): string {
206:   const clean = String(text ?? '')
207:     .replace(/[ \t]+/g, ' ')
208:     .replace(/\n{3,}/g, '\n\n')
209:     .trim()
210:   if (clean === '') return ''
211:   if (clean.length <= CU_NOTICE_RESULT_MAX_CHARS) return clean
212:   return `${clean.slice(0, CU_NOTICE_RESULT_MAX_CHARS)}…`   // ← 只留头，结尾整段丢
213: }

137:   const truncated = summary.endsWith('…')                    // ← 靠省略号猜截断
145:         ? `它这一轮的返回原文按顺序拼接，其中按插件上限截断到 ${CU_NOTICE_RESULT_MAX_CHARS} 字（末尾带 …，后半段不在通知里）：${summary}`
150:       : '向用户汇报时把上面这条结果完整展示出来：原样转述，不许精简、不许合并或删细节……'
```

改后（当前 `src/assistant-cu-watch.ts`，行号即文件真实行号）：

```ts
230: export const CU_NOTICE_RESULT_MAX_CHARS = 20000
233: export const CU_NOTICE_HEAD_KEEP_CHARS = 15000
236: export const CU_NOTICE_TAIL_KEEP_CHARS = 5000
239: export const CU_NOTICE_DUMP_DIR_NAME = '.dsh-cu-notices'
242: export const CU_NOTIFY_ROUTE_BODY_MAX_CHARS = CU_NOTICE_RESULT_MAX_CHARS * 10   // 200000，仍按上限×10

272: export function digestCuCompletion(text: string, max = CU_NOTICE_RESULT_MAX_CHARS): CuNoticeDigest {
       const clean = cleanCuText(text)
       const originalChars = clean.length
       if (originalChars <= max) { /* 整段原样，truncated:false */ }
       const headChars = Math.min(CU_NOTICE_HEAD_KEEP_CHARS, Math.max(1, Math.round((max * 3) / 4)))
       const tailChars = Math.min(CU_NOTICE_TAIL_KEEP_CHARS, Math.max(1, max - headChars))
       const head = clean.slice(0, headChars)
       const tail = clean.slice(clean.length - tailChars)          // ← 尾段原样保留
       const omittedFromChar = headChars + 1
       const omittedToChar = clean.length - tailChars
       const omittedChars = omittedToChar - omittedFromChar + 1
       const marker = `\n\n…〔中间省略 ${omittedChars} 字：第 ${omittedFromChar}–${omittedToChar} 字；结论段与末尾路径都在下面这段原文里，完整原文见落盘文件〕…\n\n`
       return { text: `${head}${marker}${tail}`, fullText: clean, truncated: true, ... }
     }

313: export function summarizeCompletion(text: string): string { return digestCuCompletion(text).text }   // 旧签名保持

329: export function writeCuNoticeDump(input: { dir, text, sessionId, title?, turn?, now? }): string | null
     // 真写盘：mkdirSync + writeFileSync；文件头记会话/轮次/时间/总字数/口径，正文是**裁切前完整原文**
394: export function cuNoticeDumpDirOf(session: any, profileDir = ''): string
     // cwd → <cwd>\.dsh-cu-notices；无 cwd 或 cwd 在插件仓库（含 Junction 真实路径）→ <profile>\.dsh-cu-notices
     // 绝不退回 process.cwd()

151: export function buildCompletionNotice(input: { ..., truncation?: CuNoticeTruncation }): string
163:   const truncated = input.truncation !== undefined || summary.endsWith('…')   // 显式元数据优先，兼容旧触发口
173:         ? truncationNoticeLine(summary, input.truncation)
185: function truncationNoticeLine(...)  // 原文 N 字 / 保留头 X + 后 Y / 中间省略 Z 字（第 A–B 字）/ 完整原文已落盘：<绝对路径>
```

事件控制器里超上限才落盘（`createCuWatch` 内）：

```ts
        const digest = digestCuCompletion(reportText)
        let truncation: CuNoticeTruncation | undefined
        if (digest.truncated) {
          const dumpDirOf = deps.dumpDirOf ?? ((target: any) => cuNoticeDumpDirOf(target))
          const fullTextPath = dump({ dir, text: digest.fullText, sessionId, title, turn })
          truncation = { originalChars, keptHeadChars, keptTailChars, omittedChars, omittedFromChar, omittedToChar, fullTextPath: fullTextPath ?? '' }
          // 落盘失败 → fullTextPath:''，通知里写「（落盘失败，这一轮没给出路径）」，绝不编造路径
        }
```

### 2.2 新字数口径（最终数值）

| 链路 | 上限 | 保留头 | 保留尾 | 触发条件 | 省略标注 | 落盘 |
| --- | --- | --- | --- | --- | --- | --- |
| 秘书通知 `CU_NOTICE_RESULT_MAX_CHARS` | **20000 字** | **15000 字** | **5000 字** | 整段 > 20000 才裁 | `…〔中间省略 N 字：第 A–B 字；…〕…` | `<CU 会话 cwd>\.dsh-cu-notices\cu-notice-full-YYYYMMDD-HHMMSS.md` |
| code_agent 通知 `CODE_AGENT_NOTICE_MAX_CHARS` | 20000 | 15000 | 5000 | 同上 | `...[N characters omitted (chars A-B); ...]...` | 同上（`watch.cwd || code.session.header.cwd`） |
| GUI 回传桥 `MAX_RESULT_CHARS` | 20000 | 15000 | 5000 | 同上 | 同秘书通知的中文标注 | `bridgeDumpDirOf(parent) = <前台 CU 会话 cwd>\.dsh-cu-notices` |

- 头 + 尾 = 20000，与上限对齐；裁切后正文长度 = 20000 + 省略标注（约 45–60 字，实测样例 ≤ 20100），远小于「只裁尾」时代价。
- `CU_NOTIFY_ROUTE_BODY_MAX_CHARS` 保持 `20000 × 10 = 200000`，手动触发口不会把长报告判 too-large（有测试断言 `>= 2 × 上限`）。
- 落盘目录选择（探针实测）：
  - `cwd = D:\dsh-assistant`（仓库根）→ `C::\Users\<ACCOUNT>\.dsh\profiles\desktop\.dsh-cu-notices`（**不写仓库根**，Junction 真实路径也认）
  - `cwd = D:\dsh-assistant\src` → 同上
  - `cwd = D:\hpg`（用户项目）→ `D:\hpg\.dsh-cu-notices`（只新建独立子目录，**不覆盖任何现有用户文件**）
  - 无 cwd → profile 目录；无 profile → `DSH_HOME`/`~\.dsh`
  - 落盘实测：25000 字原文 → `cu-notice-full-20261124-101455.md`，文件内 `content.includes(完整原文) === true`，文件总长 25152（含 152 字头信息）。

### 2.3 另外两条链路的关键改法

`vendor/computer-use/code-agent-registry-DDJfS2Fl.js`：

```js
// 改前 :290-295
const CODE_AGENT_NOTICE_MAX_CHARS = 20000;
function capNoticeOutcome(text) {
	const value = String(text ?? "");
	if (value.length <= CODE_AGENT_NOTICE_MAX_CHARS) return { text: value, truncated: false };
	return { text: `${value.slice(0, CODE_AGENT_NOTICE_MAX_CHARS)}…`, truncated: true };
}

// 改后 :293-295 常量 + :297 digestNoticeOutcome + :342 writeCodeAgentNoticeDump + :366 noticeDumpDirOf
const CODE_AGENT_NOTICE_MAX_CHARS = 20000;
const CODE_AGENT_NOTICE_HEAD_CHARS = 15000;
const CODE_AGENT_NOTICE_TAIL_CHARS = 5000;
// digestNoticeOutcome: head + marker + tail，返回 fullText/omittedChars/omittedFromChar/omittedToChar
// completionNoticeText(..., options={}) 增加第 7 参；:54 runWatch 传 { dumpDir: noticeDumpDirOf(watch) }
// 截断后缀改为：That reply is N characters; this notice keeps the first 15000 and last 5000 characters,
// omits Z in the middle (chars A-B) ... The full text was cut from this notice and written to <path> — read ...
```

`src/cu-bridge-core.mjs`：

```js
// 改前 :70-74（只留结尾、开头全丢）
export function capText(text, max = MAX_RESULT_CHARS) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `…${value.slice(value.length - (max - 1))}`
}

// 改后 :33/36/39 常量 + :84 digestText + :122 capText（= digestText().text）+ :135 writeBridgeDump
// :437-442 handoffToComputerUse：digestText(outcome) 超上限 → 落盘 → result = 原文 + oversizedResultNotice(path, digest)
export const MAX_RESULT_CHARS = 20000
export const RESULT_HEAD_KEEP_CHARS = 15000
export const RESULT_TAIL_KEEP_CHARS = 5000
```

---

## 3. 改动二：秘书不许整大段照抄（整理不照抄）

### 3.1 `src/assistant-cu-watch.ts:178`（完成轮指令）

改前 `:150`：

```
向用户汇报时把上面这条结果完整展示出来：原样转述，不许精简、不许合并或删细节，文件名、路径、命令、数字、版本号、提交号、判据、结论都必须保留；原文被截断（末尾带 …）就照实说明，不许自己补写。
```

改后 `:178`：

```
向用户汇报时不要整大段原封不动照抄上面这条结果：先给结论，你自己整理成简短的中文回复，保留关键硬事实（文件名、大小、哈希、数字、提交号、判据、结论、待办），禁止整大段原封不动照抄、禁止照抄表格与长路径、禁止重复通知原文；但必须先拿到完整内容再整理——原文被裁就按上面的落盘路径用 read 整段读回，不许只依据被裁的摘录作答，也不许自己补写。
```

`:179` 工具禁用句保留原句「这一回合动手类工具已禁用：不要尝试派活、跑命令或联网查询。」（测试逐字断言），只把「原文被截断时可以读文件核对」改成「原文被裁时可以按上面的落盘路径读文件核对」。

### 3.2 `src/assistant-secretary.ts:928-935`（朗读规范补第四条）

新增 `:934`：

```
四、不许整大段原封不动照抄 Computer Use 会话的回复：先给结论，自己整理成简短的中文回复，保留关键硬事实（文件名、大小、哈希、数字、提交号、判据、结论、待办）；禁止照抄表格与长路径，禁止把通知原文再抄一遍。必须先拿到完整内容再整理——原文被裁就按通知里的落盘路径用 read 整段读回，不许只依据被裁的摘录作答。
```

### 3.3 同一处旧口径的连带修正：`src/assistant-secretary.ts:774`（通知回合 deny 文案）

改前：

```
完成就把那条 Computer Use 会话的结果完整汇报给用户（原样转述，文件名、路径、数字、提交号、判据、结论都不许省略，不许为简短而删）……
```

改后（保留「完整汇报」「动手类工具已禁用」「read/glob/grep」三个被测试依赖的措辞）：

```
完成就把那条 Computer Use 会话的结果完整汇报给用户——先给结论，自己整理成简短的中文回复，保留文件名、大小、哈希、数字、提交号、判据、结论、待办等硬事实；不许整大段原封不动照抄、不许照抄表格与长路径、不许重复通知原文；原文被裁时可以用 read/glob/grep 按通知里的落盘路径把报告文件整段读回来再整理……
```

### 3.4 没动的解析依赖（用户点名）

- `assistant-cu-watch.ts:137` 那套 `truncated` 判定换成了显式元数据 + `endsWith('…')` 兼容，**首行结构、末行 `最后单独一行原样输出：[[session:id|title]]` 一个字没动**。
- `NOTICE_HEAD_LINE_RE` / `NOTICE_SESSION_REF_LINE_RE`（`src/secretary-card-shared.ts`）**未改**，`test-secretary-cards` 41/41 全绿证明卡片解析没破。

---

## 4. 改动三：复杂任务必须下派（派活驱动目标）

`src/assistant-dispatch.ts:413-414`，改前 `:413` 一句含两件事；改后拆成两句并加硬规则：

```ts
413:   lines.push('读文件与搜内容（read / glob / grep）不算动手：Computer Use 会话把报告写进文件后，要直接把它读回来再汇报，不许只根据通知里的片段作答。')
414:   lines.push('立长期目标（create_goal / update_goal / get_goal）也必须是「派活驱动」的目标：秘书会话里 create_goal 的 objective 必须写明动手部分由 secretary_dispatch 派 Computer Use 会话完成、你只做读回与汇报（例：「objective：由 Computer Use 会话改完 X 并跑测试；秘书只读回报告并整理成简短回复」）。需要看屏幕、操作应用、读写本机文件、生成文件的复杂任务，不许你在秘书会话里亲自一步步做完，必须先派 secretary_dispatch 再读回结果，先派再读。')
```

保持不动（改前改后一致，测试断言仍在）：

- A/B/C 三层分层规则、`分层 A 直接回答`／`kind=existing`／`kind=new-folder` 判据；
- `SECRETARY_READONLY_TOOLS`（`src/assistant-secretary.ts:146`）与 `SECRETARY_GOAL_TOOLS`（`:157`）仍放行；
- 通知回合闸 `secretaryNoticeTurnAllowed`（`:240-246`）与 `agent/pre-step`／`tools/pre-execute` 的放行逻辑（`:771`、`:764-782`）——「通知 → 再派活 → 再通知」那道闸没动。

---

## 5. RED → GREEN（同一套新断言）

先写测试、在**改前实现**上跑出 RED（日志在 `C::\Users\<ACCOUNT>\.dsh\repro\cu-notice-fix\red-*.log`）：

| 脚本 | RED 结果 | RED 原因（原始断言/错误） |
| --- | --- | --- |
| `test-assistant-cu-watch.mjs` | 3 FAIL / 16 | `TypeError: watch.digestCuCompletion is not a function`；`AssertionError: 超上限的汇报要带裁切元数据`；`AssertionError: 要写清「先给结论」` |
| `test-cu-code-agent-notice.mjs` | 0/12（脚本级失败） | `ReferenceError: digestNoticeOutcome is not defined` |
| `test-cu-bridge.mjs` | 0/18（脚本级失败） | `SyntaxError: The requested module '../src/cu-bridge-core.mjs' does not provide an export named 'RESULT_HEAD_KEEP_CHARS'` |
| `test-assistant-secretary.mjs` | 1 FAIL / 23 | `AssertionError: The input did not match the regular expression /自己整理\|整理成简短/`（朗读规范只有三条） |
| `test-secretary-notice-turn.mjs` | 2 FAIL / 5 | `AssertionError: 闸的措辞还在要求「原样转述」…`；`AssertionError: 正文要求先给结论、自己整理` |
| `test-assistant-dispatch.mjs` | 1 FAIL / 32 | `AssertionError: 立目标的语义必须是「派活驱动」` |
| `test-secretary-cards.mjs` | 1 FAIL / 41 | `AssertionError: 整理不照抄口径那行进了卡片正文` |

改后 GREEN（同一批断言，未放宽）：见 §7 原始输出，全部 PASS。

---

## 6. 构建与静态检查原始输出

### 6.1 `node build.mjs`

```


  lib\index.js      485.8kb
  lib\index.js.map    1.2mb

Done in 18ms

  lib\client.js      1.6mb
  lib\client.js.map  5.3mb

Done in 67ms

  lib\computer-use.js      172.3kb
  lib\computer-use.js.map  342.3kb

Done in 10ms

  lib\computer-use-code-agent.js       59.3kb
  lib\computer-use-code-agent.js.map  125.3kb

Done in 4ms

  lib\computer-use-code-agent-registry.js       9.4kb
  lib\computer-use-code-agent-registry.js.map  34.5kb

Done in 2ms

  .pocket-build-SZ36y7\pocket.js      207.5kb
  .pocket-build-SZ36y7\pocket.js.map  537.3kb

Done in 6ms
[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
```

### 6.2 `npm run check`

```

> dsh-assistant@0.2.40 check
> node --check lib/index.js && node --check lib/pocket.js && node --check lib/client.js && node --check lib/computer-use.js && node --check lib/computer-use-code-agent.js && node --check lib/computer-use-code-agent-registry.js
```

（退出码 0。`npm run typecheck` 是另一条**改前就过不了**的闸：480 个 TS 错误，全部是缺 `@types/node`／`@deepseek-ai/*` 的 `.d.ts` 造成的 `TS2591`，见 §10。）

---

## 7. 七个指定脚本的原始输出全文

### 7.1 `node scripts\test-assistant-cu-watch.mjs`

```
PASS CU 判定：投影优先、header 兜底、空按标准
PASS 汇报闸：CU + completed / error / aborted / interrupted / blocked 都报，标准会话与 max-tokens 不报
PASS 控制器：CU 完成触发 notify（带会话 id 与标题），同一轮只报一次
PASS 控制器：CU 失败轮（error + UNKNOWN_MODEL）→ notify 带 outcome=failed 与错误原文，同一轮只报一次
PASS 控制器：秘书自身的失败轮不汇报（防止自循环）
PASS 失败轮通知正文：照实说「这一轮失败了」并带错误码/错误原文，不许说成已完成，卡片两处结构不变
PASS 控制器：标准会话完成 → 不收集、不汇报；子代理不汇报
PASS 控制器：长报告整段落进通知（收集端不再按 900 砍块、汇报不再只取最后一段）
PASS 长通知保留头 + 保留尾：结论段与末尾路径都不被吃掉，并写明省略多少字、省略在哪
PASS 超上限时落盘完整原文：文件真存在、内容完整、通知里带绝对路径
PASS 通知正文：整理不照抄口径（2026-11-24 反转 11-22 的「原样转述」）+ 末尾可点跳引用标记
PASS 投递：只走宿主 agent.followup，不自己写 turn/step 事件
PASS 分层 B：续接该项目最近的 CU 会话（标准会话/子代理/秘书自身都不算）
PASS 分层 A：只有纯知识随口问直接回答，不建会话
PASS 分层 B（无 CU 可续）/ C：新建 computer-use 会话并核对回执预设
PASS 项目卡数据源：注册表给显示名、removed/hidden 排除、会话归并补集
PASS 16/16 assistant-cu-watch
```

### 7.2 `node scripts\test-cu-code-agent-notice.mjs`

```
  ok   自己那一轮结束就回传，不等整条会话 idle（会话还在跑也算完成）
  ok   没有 snapshotEvents 时旧路径（whenIdle）照旧能用
  ok   abort 之后不追通知
  ok   通知文案：会话还在跑后续轮时按「这一片段交付完了」讲，并允许前台继续
  ok   通知文案：会话空了才回传时仍按「finished this task」讲
  ok   用户从主窗口停掉的会话：文案按 stopped 讲，且不许自动重开
  ok   前台被别的 Computer Use 会话占着时仍带屏幕忙后缀（旧行为）
  ok   lastTurnEndIndex：只数真正关闭的轮，缺 snapshotEvents 读 -1
  ok   completionNoticeText 新口径：后台长结果保留头 + 保留尾（不再只裁尾），中间省略写明字数与位置
  ok   后台通知超上限时落盘完整原文：文件真存在、内容完整、通知里带绝对路径
  ok   后台结果跨消息交回时按顺序拼接进通知（改前只取最新一条 assistant，前面几整段丢掉）
  ok   提示词口径也不再要求「为简短而裁」：code_agent 工具描述、CU 提示词、cordis 预设三处同步
PASS 12/12
```

### 7.3 `node scripts\test-cu-bridge.mjs`

```
ok   请求文本带任务、只做一步、回结果、不要再转 code_agent
ok   capText 新口径：保留头 + 保留尾（不再只裁尾），结论与末尾路径都留下；lastAssistantText 支持只看注入之后的消息
ok   回传结果超上限时落盘完整原文：文件真存在、内容完整、工具结果里带绝对路径
ok   firstAssistantTextAfter：notice 之后的几整段按顺序拼接（改前只取第一条），用户插话仍是硬边界
ok   isQueued 只认自己那条消息
ok   工具定义：名称 / 必需参数 / 输出结构
ok   execute 把 notice 交给前台并返回它的新结果
ok   同一前台串行：两个后台请求不会交错，各拿各的结果
ok   找不到前台会话：明确失败并要求继续用现有工具
ok   registry 里的归属优先于创建时父会话（可换前台）
ok   前台一直不开始：移除排队 notice 并失败
ok   排队的 notice 被清空（用户停止前台）：明确失败而不是返回空结果
ok   前台一直不结束：超时失败，不重复追同一步
ok   后台被停止：AbortError 原样抛出
ok   回传次数有上限
ok   resolveCallerId：registry 缺行时退回创建时的父会话
ok   回传那一步的点击必须落在前台会话看到的那块截图上（同一个 rect）
ok   前台会话本来就在前台时，回传这一步不该去抢焦点

18 cases passed
```

### 7.4 `node scripts\test-assistant-secretary.mjs`

```
PASS 插件 inject 声明 tools：宿主才会在秘书回合注册派活工具
PASS GET 初始为空
PASS 非法 sessionId 拒绝且不落盘
PASS POST 原子持久化并回读
PASS 工具闸：只禁动手类（写/编辑/补丁/终端/屏幕/子代理），纯读与目标类一律放行
PASS 读类与 goal 类真的穿过 tools/pre-execute（不只是谓词层放行）
PASS 用户原话「明天天气」：只读联网工具真的能跑到，不再被只读闸拦死
PASS 只读工具闸显式放行派活：secretary_dispatch 可建/续独立 CU 会话
PASS 工具闸只对固定秘书会话生效
PASS 重新注册会从文件恢复固定 id
PASS DELETE 清空并删除文件
PASS 普通 GET 不带 exists（首屏不该去翻两千多行会话表）
PASS ?verify=1 但没有固定会话 → exists=false（不会静默说「在」）
PASS ?verify=1 有固定会话、宿主两路都问不出 → exists=null（客户端按「不新建」处理）
PASS ?verify=1 用宿主活会话表回答存在与否（实测根因的权威判定）
PASS ?verify=1 只剩持久化清单（ctx 没给 sessions.list）也能回答
PASS 坏文件/坏字段按空处理
PASS parseSecretaryRequestQuery：verify 标记 / 候选 id / 非法 id 拒收
PASS ?verify=1&sessionId=<候选>：不问 state 当前值，直接问候选（重建预确认用）
PASS POST 同一个 id 去抖：不重写盘、不重刷 updatedAt（多客户端不互相覆盖）
PASS 语音输入提示段：三行内语义齐全，1785 挂在派活分层（1790）之前
PASS 引用登记段（第 4 项）：路由形状、落盘、吃掉一轮就收、通知轮不吃引用、1783 排在派活分层 1790 之前
PASS 朗读规范补「不照抄、要整理」：先给结论、禁止整大段照抄 CU 回复、硬事实保留、先读完整再整理
PASS 23/23 assistant-secretary
```

### 7.5 `node scripts\test-secretary-notice-turn.mjs`

```
PASS 投递只走 agent.followup，一个会话事件都不写
PASS 拿不到 agent.followup → false，且绝不退回写事件
PASS notifySecretary 按固定 id 取到 agent 并投递
PASS 通知回合只禁动手类；用户真实回合恢复放行
PASS 摘要带整段原文（不再只取首句）、缺标题时兜底
PASS 5/5 secretary-notice-turn
```

### 7.6 `node scripts\test-assistant-dispatch.mjs`

```
PASS 模型给合法目录 → 采用模型判断
PASS 模型目录末尾分隔符被归一
PASS 模型没给目录 → 规则兜底：旧项目
PASS 模型没给目录 → 规则兜底：简单动手活也新建专项文件夹
PASS 模型没给目录 → 规则兜底：复杂新活新建专项文件夹
PASS 非法目录（相对路径/空）不采用，退回规则
PASS 纯知识随口问不派活（今天几号）
PASS 用户 QQ 原话：看屏问题默认走分层 C，不许直接终答
PASS 工具定义：名字/schema/渲染齐全
PASS 宿主注册：secretary_dispatch 真的注册进工具清单
PASS tools 服务晚就绪：延迟注册，不静默跳过
PASS 用户原话「明天天气」：派活兜底也能成功建 CU 会话
PASS 提示词段落：A/B/C 分层 + 新项目父目录 + 项目清单
PASS 派活驱动目标：立目标必须写明动手部分由 secretary_dispatch 完成、秘书只做读回与汇报，不许亲自逐步跑完
PASS 用户 QQ 原话：工具产生 computer-use 派活并投递原话
PASS 纯知识问题不建会话、不投 prompt
PASS 工具执行：非秘书会话调用被拒
PASS 全景段：实时快照注明 + 目录行数 = 当次取到的项目数（临时注册表）
PASS 全景段与派活段同源：同一快照引用、会话行同次组装只读一次
PASS 提示词路径绕过 30s 缓存：控制室新建/删除文件夹 + 新会话目录都当轮收紧
PASS 回执文案：确认在跑才写「已派活」，只入队写「已入队（未确认在跑）」
PASS 入队失败（宿主 prompt 抛错）：execute 抛错、绝不新建、绝不出「已派活」
PASS 只入队、窗口内没证据：verification=unverified，文案不是「已派活」
PASS 观测到会话接上话（消费 → 起轮 → 起步）：verification=confirmed 才出「已派活（续接）」
PASS 续接的会话这一轮失败（UNKNOWN_MODEL）：自动改新建并如实写「续接失败已改新建」
PASS aborted 轮口径：同样算失败、也自动改新建（不许说成已派活）
PASS 候选会话钉着已退役模型 → 排除它、改新建（回执写清跳过了哪条）
PASS 读不到模型清单 → 不排除（不许猜），照旧续接
PASS 读不到模型选择 → 也不排除（不猜）
PASS 纯观测器：入队抛错=failed(queue-throw)、队列还排着=unverified+pending、起轮 0 步就崩=failed
PASS 观测确认走宽限期：起了轮、跑出一 step 才算已派活（grace 内没等到失败）
PASS 宿主既没事件流也没活队列：立刻判未确认，不空等 10 秒
PASS 32/32 assistant-dispatch
```

### 7.7 `node scripts\test-secretary-cards.mjs`（观感口径没被动的证据）

```
PASS 朗读规范化：markdown / 列表 / 表情 / 代码块全去掉
PASS 朗读规范化：单位与区间念读（8–14℃ → 8 到 14 摄氏度）
PASS 朗读规范化：引用标记不念出来
PASS 引用解析：[[session:id|标题]] 逐条解析
PASS 状态机：play → playing → 暂停/继续 → 播完回 idle
PASS 状态机：toggle 在 playing/paused 间切换，换 key 重新 loading
PASS 状态机：restart 回 loading；error 记原因；stop 回 idle
PASS 控制器：播放/暂停/继续/重读，播放器方法按序被调
PASS 控制器：换 key（切卡片）先停上一条、只读当前卡片
PASS 控制器：toggle 必须用传入文本（历史卡点击不回退到最新一条）
PASS 控制器：长按重读 → loading → onPlaying 回到 playing
PASS 胶囊色调：按类型词归类（关心/完成/探索/授权/默认服务）
PASS 要点拆分：「天气：…」前缀加粗，无冒号整行是值
PASS 要点图标：天气/车次/时间/地点关键词，默认小圆点
PASS 一句话摘要：首行截断加省略号
PASS 卡片时间：卡脚只写 HH:MM（去「今天」字样）、昨天/更早仍带日期、非法输入为空
PASS 自动朗读目标：空白合成尾轮不能挡住最近一条真实回复
PASS 卡片正文保留宿主的重点句：<strong> 还原成 **…**
PASS 用户卡判据：合成通知不做成用户卡（系统通知首行 / 独立 [[session:…]] 引用行）
PASS 用户卡正文：显示用户原文（按空行分段，不截断不改写）
PASS 用户卡朗读 key：每张卡按自己那条消息，不与秘书卡串
PASS 用户卡时间：宿主「今天 20:24」/「20:24」都收成「20:24」，昨天/日期形式原样用
PASS 自动朗读目标只看秘书卡：用户卡不许挡住最近一条真实回复
PASS 卡片 kind 常量：秘书卡 assistant / 用户卡 user / 通知卡 notice（三种卡互不串味）
PASS 通知卡正文：剥掉合成头（「（系统通知…）」与「最后单独一行原样输出：」），首行做标题、其余成段落
PASS 新措辞的通知正文照旧解析成通知卡（模板改了行，客户端解析不破）
PASS 三种行分类不串味：真实用户行=user、合成通知行=notice、助手回答行不是用户行
PASS 卡片 key：秘书卡 assistant:turn:N，通知卡 notice:<消息 key> / notice:turn:N，互不撞
PASS 折叠几何（三种卡共用一套算术）：卡标题也进预算（最多 2 行）、正文最多 3 行、落点不切半行、固定高度封顶
PASS 已读集合：cardKey 归一（坏值丢掉、去重、截上限）
PASS 已读 store：宿主真值优先、宿主答不上降级 localStorage、不阻塞渲染
PASS 通知卡过期算术（第 1 项）：10 分钟只从卡片自己那份钟面算
PASS compact 提示判据（第 3 项）：那两行文本按已核实的宿主文字认，别的文字不误伤
PASS 引用登记（第 4 项）：归一 + store 口径 + 宿主真值优先
PASS 输入框「带引用」提示文案（追加需求）：轮次 + 卡片种类 + 正文开头一小段，没引用回 null
PASS 引用吃掉判据（追加需求）：轮次号可比按轮次号，同轮换 key 不误收，页面没投影用户行不吃
PASS 引用 store 吃掉口径（追加需求）：真实用户消息发出去即收；宿主那侧不抢先清
PASS 引用 TTL 到期自动清除（追加需求）：到点本地收掉并请宿主清
PASS 刷新页面不复活已发出去的引用（追加需求）：基线落 localStorage，宿主 404 也认
PASS 过期通知卡不进卡片窗口（第 1 项）：buildSecretaryPagerCards 只数还没到点的通知
PASS 扫描层打标（第 3 项）：compact 两行按 kind 与文字判据打标，我们的卡一律不碰
PASS 41/41 secretary-cards
```

---

## 8. `npm test` 全量

`npm test` 是一条 `&&` 链（76 个脚本）。本次运行的**原始尾部**（完整日志 338 行，在 `C::\Users\<ACCOUNT>\.dsh\repro\cu-notice-fix\final\npm-test.log`）：

```
ok   合成通知与 [[session:…]] 引用行不进「原文轮数」窗口
ok   摘要生成失败/超时降级：只带最近 N 轮原文继续跑，并记一条诊断
  真会话注入轮数 = 2 字符长度 = 1329
ok   送进模型的注入段：原文轮数 ≤10（实测定 8）且含摘要文本
ok   宿主上下文模块（假 ctx 真接线）：session/event turn/end 增量更新文件 + systemPrompt.section 注入段
ok   挤出：滚动摘要同触发点（每 12 轮增量）调宿主 compactNow，且只认固定秘书会话
ok   挤出：服务从 ctx.compaction 属性取（cordis 挂法，ctx.get 取不到也成立）
ok   挤出：插件 ctx 不可见时改从 agent.ctx 取 compaction 服务（cordis 分支可见性）
ok   挤出：compactNow busy 按 idle 重试到上限后放下次触发点
ok   挤出：宿主没装 compaction 服务时静默降级，滚动摘要照旧
ok   挤出：总会话轮数低于门槛不要求（词数触发点同样受门槛约束）
FAIL 真会话 surface 折叠读回：宿主压缩 shadow 的旧轮不在模型投影里、卡片事件仍在日志里
     卡片取数不受 compaction 影响
FAIL 1/26 secretary-pagination-context
```

- npm test 退出码：**1**，卡在第 **24** 个脚本 `scripts/test-secretary-pagination-context.mjs`，**FAIL 1/26**；它前面 23 个脚本全 PASS，链在这里断开，后面 52 个脚本没有跑到。
- 该失败**改前就存在**：把 `HEAD:e24f5e3` 的 `lib/index.js` 取到临时目录（`%TEMP%\dsh-head-pagination`）跑同一个脚本，结果一模一样：`FAIL 真会话 surface 折叠读回：宿主压缩 shadow 的旧轮不在模型投影里、卡片事件仍在日志里` + `FAIL 1/26`。它与本次三处改动无交集（读的是现网秘书会话真实日志分页/摘要，涉及 compaction shadow）。
- 为给出全量数字，改为**逐脚本独立运行**（同一 `lib/` 产物），结果：

- **总计 76 个脚本：75 通过，1 失败**（唯一失败 = 上面那个改前就失败的脚本，退出码 1）。
- 逐脚本原始数字（`退出码 <TAB> 脚本 <TAB> 末行`）：

```
0	scripts/test-mobile-uplink-history.mjs	
0	scripts/test-mobile-session-pagination.mjs	
0	scripts/test-assistant-home.mjs	
0	scripts/test-assistant-memory.mjs	PASS 7/7
0	scripts/test-assistant-card.mjs	
0	scripts/test-assistant-secretary.mjs	PASS 23/23 assistant-secretary
0	scripts/test-secretary-dispatch.mjs	PASS 12/12 secretary-dispatch
0	scripts/test-assistant-dispatch.mjs	PASS 32/32 assistant-dispatch
0	scripts/test-assistant-cu-watch.mjs	PASS 16/16 assistant-cu-watch
0	scripts/test-secretary-notice-turn.mjs	PASS 5/5 secretary-notice-turn
0	scripts/test-secretary-session-log-write.mjs	PASS 8/8 secretary-session-log-write
0	scripts/test-secretary-log-repair.mjs	
0	scripts/test-secretary-card-render.mjs	
0	scripts/test-assistant-proactive.mjs	PASS 9/9 assistant-proactive
0	scripts/test-secretary-open-guard.mjs	PASS 5/5 secretary-open-guard
0	scripts/test-secretary-open-recovery.mjs	PASS 10/10 secretary-open-recovery
0	scripts/test-secretary-open-rebuild.mjs	PASS 12/12 secretary-open-rebuild
0	scripts/test-assistant-open-diag.mjs	PASS 5/5 assistant-open-diag
0	scripts/test-desktop-ball-gestures.mjs	PASS 6/6 desktop-ball-gestures
0	scripts/test-secretary-cards.mjs	PASS 41/41 secretary-cards
0	scripts/test-secretary-quote-chip-visual.mjs	
0	scripts/test-secretary-speech-chunks.mjs	PASS 16/16 secretary-speech-chunks
0	scripts/test-assistant-tts-worker.mjs	PASS 7/7 assistant-tts-worker
1	scripts/test-secretary-pagination-context.mjs	FAIL 1/26 secretary-pagination-context
0	scripts/test-assistant-tts.mjs	PASS 5/5 assistant-tts
0	scripts/test-web-routes.mjs	
0	scripts/test-console-assets.mjs	
0	scripts/test-split-observer.mjs	
0	scripts/test-model-settings-notice.mjs	
0	scripts/test-session-list-filter.mjs	
0	scripts/test-pocket-session.mjs	
0	scripts/test-pocket-runtime.mjs	
0	scripts/test-mobile-boot.mjs	
0	scripts/test-mobile-proxy.mjs	
0	scripts/test-session-focus.mjs	PASS 13/13
0	scripts/test-session-folder.mjs	PASS 21/21
0	scripts/test-session-status.mjs	PASS 8/8
0	scripts/test-session-index.mjs	PASS 4/4
0	scripts/test-session-rank.mjs	PASS 21/21
0	scripts/test-mobile-scan-facts.mjs	PASS 10/10
0	scripts/test-perf-counters.mjs	PASS 9/9
0	scripts/test-composition-gate.mjs	test-composition-gate: PASS 27/27
0	scripts/test-composer-focus-gate.mjs	
0	scripts/test-composer-ledger.mjs	test-composer-ledger: PASS 10/10
0	scripts/test-bottom-overlay.mjs	PASS 15/15
0	scripts/test-local-store.mjs	PASS 7/7
0	scripts/test-face-cache.mjs	PASS 6/6
0	scripts/test-pc-file.mjs	PASS 9/9
0	scripts/test-new-project-default.mjs	PASS 11/11
0	scripts/test-path-guard.mjs	PASS 8/8
0	scripts/test-first-run-guide.mjs	PASS 5/5
0	scripts/test-pocket-first-run.mjs	PASS 5/5
0	scripts/test-uninstall-plan.mjs	PASS 5/5
0	scripts/test-clipboard.mjs	PASS 6/6
0	scripts/test-split-entry.mjs	PASS 4/4
0	scripts/test-project-exit.mjs	PASS 11/11
0	scripts/test-coordinate-mode.mjs	
0	scripts/test-tuoguan-autocontinue.mjs	PASS 19/19
0	scripts/test-tuoguan-autoanswer.mjs	PASS 19/19
0	scripts/test-console-filter.mjs	
0	scripts/test-quality-gate.mjs	PASS 7/7
0	scripts/test-assistant-diagnostics.mjs	PASS 6/6
0	scripts/test-assistant-archive.mjs	PASS 10/10
0	scripts/test-downlink-lanes.mjs	PASS 11/11
0	scripts/test-mobile-perf-policy.mjs	PASS 5/5
0	scripts/test-native-input-policy.mjs	
0	scripts/test-release-consistency.mjs	PASS 6/6
0	scripts/test-mobile-toggle-zone.mjs	
0	scripts/test-mobile-drawer-chrome.mjs	
0	scripts/test-turn-guard.mjs	
0	scripts/test-assistant-config-write.mjs	PASS 11/11
0	scripts/test-cu-bridge.mjs	18 cases passed
0	scripts/test-cu-observation-surface.mjs	PASS 15/15
0	scripts/test-cu-capture-scale.mjs	PASS 14/14
0	scripts/test-cu-code-agent-notice.mjs	PASS 12/12
0	scripts/test-cu-title-bold.mjs
```

---

## 9. 没碰的东西（确认）

- **卡片观感口径未动**：`HISTORY_PREVIEW_MAX_CHARS = 900`（`src/secretary-card-shared.ts` 未出现在本次 diff）、`QUOTE_PREVIEW_MAX_CHARS = 600`（`src/assistant-secretary.ts:308`，diff 只改 774 与 928-935）、`BOOKMARK_OUTCOME_MAX_CHARS = 200`（vendor `:308` 区域未改）、`CONTEXT_SUMMARY_*`（`boundContextSummary` 120 字，未改）。
  这三个观感常量**没有被当成长度依据**，本报告也不声称「修好了」它们的截断行为。
- `CU_NOTIFY_ROUTE_BODY_MAX_CHARS` 仍是「上限 × 10 = 200000」，手动触发口阈值跟着新上限同步（未缩小）。
- 四条既有未 push 提交（`6649baf` / `5e46298` / `6a54b80` / `e24f5e3`）未动、未 rebase、未 amend。
- **未 push**：`origin/main` 仍是 `5843725`（提交后本地 `main` 领先 origin/main）。
- **未重启宿主**、**未跑 `dev:web`**、未启动任何替换服务器。
- 未删除/覆盖任何用户项目文件与 Excel（落盘只新建 `.dsh-cu-notices` 子目录下的新文件；测试用临时目录）。
- 插件运行副本 `C::\Users\<ACCOUNT>\.dsh\profiles\desktop\node_modules\dsh-assistant` 是本仓库 Junction：`build.mjs` 重写 `lib/` 即生效，**没有复制文件**。

---

## 10. 没验到的部分（照实列全）

1. **没有在真实 GUI 里看到新通知卡**：宿主未重启、未跑 `dev:web`，本轮所有验证都是 node 侧单测 + 探针 + 构建；卡片实际排版/折叠/朗读效果未截图核对。`scripts/smoke-secretary-page.mjs` 与 `test-secretary-card-visual.mjs`/`test-secretary-quote-chip-visual.mjs` 属于浏览器视觉冒烟，本次**没有跑**（不在用户指定清单内，且需要页面/浏览器）。
2. **落盘只在注入目录/探针里验过**：真实宿主里 `session.header.cwd` 的读取、`.dsh-cu-notices` 目录创建、秘书 `read` 读回整段的端到端链路，要等宿主重载后由真实 CU 会话才能验；代码层有单测（文件存在 + 内容完整 + 通知带绝对路径）与目录选择探针。
3. **三条链路只对齐了「文本裁切 + 落盘」语义，没有统一成同一个函数**：`assistant-cu-watch.ts` / vendor registry / `cu-bridge-core.mjs` 是三份独立实现（分发渠道不同、不能互相 import），数值与标注格式一致但实现重复；将来改口径要同时改三处（已在各自注释里写明联动关系）。
4. **`npm run typecheck` 仍过不了**：480 个 `TS2591`（缺 `@types/node`、`@deepseek-ai/*` 无 `.d.ts`），改前就是这样（`scripts/typecheck.mjs` 自己写明这是已知缺口）；本次新增的 `node:fs`/`node:os`/`node:path`/`node:url` import 只是同一类 `TS2591`，没有引入新的类型形状错误——人工核对了这 480 条里没有一条是本次改动的逻辑类型错误。
5. **`test-secretary-pagination-context.mjs` 的失败不是本次修的**：已按 §8 证明改前同样失败，但没有修它（不在本次范围，且涉及宿主 compaction shadow/现网日志）。
6. **手动触发路由（`/api/assistant/cu-watch/notify`）没有做真实 HTTP 冒烟**：只保证 body 上限口径与测试断言；该路由不写 `truncation` 元数据（它把 body 里的 summary 原样送进通知），若有人手工灌一条超长 summary，通知会整段内联而不是头尾裁——这是刻意保留的旧行为，未在本次改。

---

## 11. 本地提交

- 代码 + 测试 + 构建产物：``e9aa68a`（完整 `e9aa68abc65ad0a78f6d3fca03fbf4f25d0d4163`）`（本报告正文之外的全部改动）
- 本报告：`紧随其后的独立提交，只含本文件（哈希见 `git log -1`；正文不写死以免自我引用）`（紧随其后，只含本文件）
- `git show --stat` 真实数字：

```
commit e9aa68abc65ad0a78f6d3fca03fbf4f25d0d4163
short e9aa68a
author xiaoshumiao00-lang <<NAME-PINYIN>@<ABBREV>.edu.cn>
date Tue Nov 24 10:17:05 2026 +0800
subject fix(secretary): 通知截断改头尾双保留并落盘原文；秘书改为整理不照抄；目标限定派活驱动

 lib/computer-use-code-agent-registry.js            |   2 +
 lib/computer-use-code-agent.js                     | 193 +++++++++++-
 lib/index.js                                       | 266 ++++++++++++++---
 scripts/test-assistant-cu-watch.mjs                | 134 +++++++--
 scripts/test-assistant-dispatch.mjs                |  13 +
 scripts/test-assistant-secretary.mjs               |  16 +
 scripts/test-cu-bridge.mjs                         |  69 ++++-
 scripts/test-cu-code-agent-notice.mjs              |  63 +++-
 scripts/test-secretary-cards.mjs                   |   2 +-
 scripts/test-secretary-notice-turn.mjs             |   7 +-
 src/assistant-cu-watch.ts                          | 327 ++++++++++++++++++---
 src/assistant-dispatch.ts                          |   3 +-
 src/assistant-secretary.ts                         |   3 +-
 src/cu-bridge-core.mjs                             | 127 +++++++-
 .../computer-use/code-agent-registry-DDJfS2Fl.js   | 100 ++++++-
 15 files changed, 1154 insertions(+), 171 deletions(-)
```

报告提交的 `--stat`：`secretary-fix-20261124.md` 1 个文件、纯新增（插入行数用 `git show --stat` 读该提交即可；哈希不写进正文，避免自我引用）。

---

## 附：改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/assistant-cu-watch.ts` | 头尾裁切 + 落盘 + 通知文案 + 整理不照抄 + 手动口注释；新增 `digestCuCompletion`/`writeCuNoticeDump`/`cuNoticeDumpDirOf`/`cuNoticeDumpFileName`/常量 |
| `vendor/computer-use/code-agent-registry-DDJfS2Fl.js` | `CODE_AGENT_NOTICE_*` 头尾裁切 + 落盘 + 英文截断标注 + `runWatch` 传 dumpDir |
| `src/cu-bridge-core.mjs` | `MAX_RESULT_CHARS`/头尾常量、`digestText`/`capText`/`writeBridgeDump`/`oversizedResultNotice`、`handoffToComputerUse` 落盘 |
| `src/assistant-secretary.ts` | 朗读规范第四条（`:934`）、通知回合 deny 文案（`:774`） |
| `src/assistant-dispatch.ts` | 派活驱动目标硬规则（`:414`） |
| `lib/index.js`、`lib/computer-use-code-agent-registry.js`、`lib/computer-use-code-agent.js` | `node build.mjs` 重新生成 |
| `scripts/test-assistant-cu-watch.mjs` 等 7 个测试 | 新口径断言（头尾保留、落盘、整理不照抄、派活驱动目标） |
