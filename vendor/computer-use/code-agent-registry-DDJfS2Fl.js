import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
const NO_ASSISTANT = "The Code agent session ended without a final assistant message.";
/**
* Appended when another Computer Use session holds a turn at delivery time. Without it the woken
* caller would resume GUI work — possibly on a chat the user abandoned — and fight the session the
* user is watching for the mouse and keyboard.
*/
const SCREEN_BUSY_SUFFIX = "Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.";
/**
* Start a caller-owned watch that delivers one plugin notice after the Code
* session's next idle and the Computer Use caller is idle. Does not throw;
* missing context or a disposed caller drops the notice.
* @param watch - live caller, live Code agent, and the accepted prompt.
* @returns the abort controller for this interval, or undefined when the
*   watch could not be owned.
*/
function watchCodeAgentCompletion(watch) {
	const abort = new AbortController();
	try {
		watch.caller.ctx.effect(() => {
			return () => {
				abort.abort();
			};
		});
	} catch {
		return;
	}
	try {
		watch.agents.withoutInitiator(() => {
			runWatch(watch, abort.signal);
		});
	} catch {
		abort.abort();
		return;
	}
	return abort;
}
async function runWatch(watch, signal) {
	try {
		if (await raceAbort(signal, waitUntilIntervalStarts(watch.code, watch.requestId, signal)) === "aborted") return;
		// 自己那一轮跑完就回传，不等整条 Code 会话把后续轮也跑完：后台带着 goal 续跑时 `whenIdle` 会压住几分钟，
		// 前台 Computer Use 只能空等（实测一次任务白等 5.4 分钟）。`whenIdle` 先到的旧路径仍然生效。
		if (await raceAbort(signal, raceCompletionSignals(watch.code, signal)) === "aborted") return;
		const stillRunning = watch.code.status === "running";
		const userStopped = lastTurnEndedUserAborted(watch.code);
		const outcome = lastAssistantText(watch.code, watch.requestId) ?? NO_ASSISTANT;
		if (await raceAbort(signal, watch.caller.whenIdle()) === "aborted") return;
		if (watch.agents.get(watch.caller.id) !== watch.caller) return;
		watch.caller.followup(createUserMessage({
			content: [{
				type: "text",
				text: completionNoticeText(watch.sessionId, watch.task, outcome, anotherComputerUseRunning(watch), userStopped, stillRunning, { dumpDir: noticeDumpDirOf(watch) })
			}],
			source: {
				kind: "computer-use",
				form: "notice",
				summary: boundContextSummary(userStopped ? `Code agent ${watch.sessionId} stopped by the user` : `Code agent ${watch.sessionId} ${stillRunning ? "completed the dispatched stretch" : "finished"}`)
			}
		}));
	} catch (error) {
		if (signal.aborted) return;
		try {
			watch.caller.ctx.logger.warn(`code_agent: completion watch failed: ${String(error)}`);
		} catch {}
	}
}
/**
* The Code interval has started when the driver is running, or when the
* accepted prompt is no longer queued (already claimed or already finished).
*/
function intervalHasStarted(code, requestId) {
	return code.status === "running" || !holdsPrompt(code, requestId);
}
/** Whether the accepted prompt is still parked in the inbox (queued, not started or finished). */
function holdsPrompt(code, requestId) {
	return messageHasRpc(code.inbox.nextTurn, requestId) || messageHasRpc(code.inbox.nextStep, requestId);
}
function messageHasRpc(messages, requestId) {
	return messages.some((message) => message.source.kind === "user" && "rpcId" in message.source && message.source.rpcId === requestId);
}
async function waitUntilIntervalStarts(code, requestId, signal) {
	if (intervalHasStarted(code, requestId) || signal.aborted) return;
	await new Promise((resolve) => {
		let done = false;
		let disposeStatus = () => {};
		let disposeDisposed = () => {};
		const finish = () => {
			if (done) return;
			done = true;
			disposeStatus();
			disposeDisposed();
			signal.removeEventListener("abort", finish);
			resolve();
		};
		disposeStatus = code.ctx.on("agent/status", () => {
			if (intervalHasStarted(code, requestId)) finish();
		});
		disposeDisposed = code.ctx.on("agent/disposed", finish);
		signal.addEventListener("abort", finish, { once: true });
		if (intervalHasStarted(code, requestId) || signal.aborted) finish();
	});
}
async function raceAbort(signal, work) {
	if (signal.aborted) return "aborted";
	const abort = Promise.withResolvers();
	const onAbort = () => {
		abort.resolve("aborted");
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([work.then(() => "done"), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
/** 轮次结束轮询间隔。400 ms 比一整个 GUI 轮次细得多，比 1 s 松得多，两头都不空转。 */
const TURN_END_POLL_MS = 400;
/**
 * 会话里最后一轮关闭的位置；没有 `snapshotEvents`（测试假 agent）读 -1。
 * 日志只追加，所以新轮关闭时这个值必然变大。
 */
function lastTurnEndIndex(code) {
	try {
		const events = code.session?.snapshotEvents?.() ?? [];
		for (let index = events.length - 1; index >= 0; index -= 1) if (asRecord(events[index])?.type === "turn/end") return index;
		return -1;
	} catch {
		return -1;
	}
}
function delayTick(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}
function abortPromise(signal) {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
/**
* 这一轮结束（出现新的 `turn/end`）或者会话空了， whichever settles first。
* 带着 goal 自动续跑的会话不会很快 idle，所以按轮结束算才是快的那条路。
* abort 时两条支路都 settle，留给 `whenIdle` 的 promise 不悬空。
* @param code - 后台 Code agent。
* @param signal - 这个 watch 的 abort。
*/
async function raceCompletionSignals(code, signal) {
	const baseline = lastTurnEndIndex(code);
	const turnWatch = (async () => {
		while (!signal.aborted) {
			if (lastTurnEndIndex(code) > baseline) return;
			await delayTick(TURN_END_POLL_MS, signal);
		}
	})();
	const idle = new Promise((resolve, reject) => {
		signal.addEventListener("abort", resolve, { once: true });
		code.whenIdle().then(resolve, reject);
	});
	await Promise.race([turnWatch, idle, abortPromise(signal)]);
}
/** Newest non-empty assistant text of the session, or undefined when none exists. */
function textBlocksOf(message) {
	const texts = [];
	for (const block of message?.content ?? []) {
		if (block?.type !== "text") continue;
		const text = String(block?.text ?? "").trim();
		if (text !== "") texts.push(text);
	}
	return texts;
}
/**
 * 这一轮 Code 会话交回来的**整段**文字（跨消息按顺序拼接）。
 * 2026-11-23 修第四个 bug：原来只取「最新一条 assistant 消息」的 text 块，
 * 长报告被模型分几条消息交回时（连续输出、max-tokens 续写、按段落发）前面几整段直接丢掉。
 * 先按事件流找派发边界（带 `rpcId` 那条用户消息）之后的所有 assistant 文本；
 * 读不到事件流或边界时退回「最后关闭那一轮」的整段；再不行退回旧口径（最新一条非空 assistant）。
 */
function lastAssistantText(code, requestId) {
	let events = [];
	try {
		events = code.session?.snapshotEvents?.() ?? [];
	} catch {
		events = [];
	}
	let boundary = -1;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = asRecord(events[index]);
		if (event?.type !== "user/message") continue;
		const data = asRecord(event.data);
		const source = asRecord(data?.message?.source) ?? asRecord(data?.source);
		if (requestId !== void 0 && source?.rpcId === requestId) { boundary = index; break; }
		if (requestId === void 0) { boundary = index; break; }
	}
	if (boundary >= 0) {
		const parts = [];
		for (let index = boundary + 1; index < events.length; index += 1) {
			const event = asRecord(events[index]);
			if (event?.type !== "assistant/message") continue;
			const text = textBlocksOf(asRecord(asRecord(event.data)?.message)).join("\n\n");
			if (text !== "") parts.push(text);
		}
		if (parts.length > 0) return parts.join("\n\n");
	}
	const closer = lastTurnEndIndex(code);
	if (closer > 0) {
		const turn = Number(asRecord(asRecord(events[closer])?.data)?.turn);
		const parts = [];
		for (let index = 0; index < closer; index += 1) {
			const event = asRecord(events[index]);
			if (event?.type !== "assistant/message") continue;
			if (Number.isFinite(turn) && Number(asRecord(event.data)?.turn) !== turn) continue;
			const text = textBlocksOf(asRecord(asRecord(event.data)?.message)).join("\n\n");
			if (text !== "") parts.push(text);
		}
		if (parts.length > 0) return parts.join("\n\n");
	}
	return fallbackLastAssistantText(code);
}
/** 旧口径（兜底用）：会话里最新一条非空 assistant 文字。 */
function fallbackLastAssistantText(code) {
	let messages = [];
	try {
		messages = code.session.deriveMessages() ?? [];
	} catch {
		return;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		if (text !== "") return text;
	}
}
/**
* Whether the session's last closed turn was aborted by a user cancellation.
* The main window's stop button cancels with cause 'user' and the durable
* turn/end record carries that cause; repair-synthesized closers flatten it,
* which reads as not-user.
*/
function lastTurnEndedUserAborted(agent) {
	try {
		const events = agent.session.snapshotEvents?.() ?? [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = asRecord(events[index]);
			if (event?.type !== "turn/end") continue;
			const reason = asRecord(event.data)?.reason;
			if (asRecord(reason)?.kind !== "aborted") return false;
			return asRecord(asRecord(reason)?.reason)?.kind === "user";
		}
		return false;
	} catch {
		return false;
	}
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
/**
* Whether a Computer Use session other than the caller currently holds a turn.
* The caller's own background Code sessions are standard-preset, so they never
* count; a registry without `list` (test fakes) reads as an empty screen.
*/
function anotherComputerUseRunning(watch) {
	return (watch.agents.list?.() ?? []).some((other) => other.id !== watch.caller.id && other.status === "running" && presetOf(other) === "computer-use");
}
/** Session preset of a live agent, tolerant of test fakes that carry no header. */
function presetOf(agent) {
	return agent.session?.header?.agentPreset;
}
/**
 * 通知正文里 Code 会话结果那一段的长度口径。
 * 与插件侧秘书通知同一套口径（见 src/assistant-cu-watch.ts 的 CU_NOTICE_RESULT_MAX_CHARS = 20000）。
 *
 * 2026-11-24 用户定案：只裁尾会把结论与末尾路径一起丢掉（346 行的联合基金报告就被切在
 * 路径中段），所以改成**保留头 + 保留尾**：头 15000 + 尾 5000，中间换成「省略多少字、
 * 省略在第几字到第几字」的标注；整段仍超上限时，把裁切前的完整原文落盘（该 CU 会话的
 * 项目目录下 .dsh-cu-notices/），通知正文直接给绝对路径，让前台把整段读回来。
 * 卡片那一行的一行话另有口径：@deepseek-ai/dsh-llm `CONTEXT_SUMMARY_MAX_CHARS = 120` 与
 * 书签列表的 200（`BOOKMARK_OUTCOME_MAX_CHARS`），那两个是观感口径，不裁模型看到的正文。
 */
const CODE_AGENT_NOTICE_MAX_CHARS = 20000;
const CODE_AGENT_NOTICE_HEAD_CHARS = 15000;
const CODE_AGENT_NOTICE_TAIL_CHARS = 5000;
const CODE_AGENT_NOTICE_DUMP_DIR = ".dsh-cu-notices";
function digestNoticeOutcome(text) {
	const value = String(text ?? "");
	const originalChars = value.length;
	if (originalChars <= CODE_AGENT_NOTICE_MAX_CHARS) {
		return {
			text: value,
			fullText: value,
			truncated: false,
			originalChars,
			keptHeadChars: originalChars,
			keptTailChars: 0,
			omittedChars: 0,
			omittedFromChar: 0,
			omittedToChar: 0
		};
	}
	const headChars = Math.min(CODE_AGENT_NOTICE_HEAD_CHARS, Math.max(1, Math.round(CODE_AGENT_NOTICE_MAX_CHARS * 3 / 4)));
	const tailChars = Math.min(CODE_AGENT_NOTICE_TAIL_CHARS, Math.max(1, CODE_AGENT_NOTICE_MAX_CHARS - headChars));
	const head = value.slice(0, headChars);
	const tail = value.slice(value.length - tailChars);
	const omittedFromChar = headChars + 1;
	const omittedToChar = value.length - tailChars;
	const omittedChars = omittedToChar - omittedFromChar + 1;
	const marker = `\n\n...[${omittedChars} characters omitted (chars ${omittedFromChar}-${omittedToChar}); the conclusion and the final paths are kept in the tail below, and the full text is in the dumped file]...\n\n`;
	return {
		text: `${head}${marker}${tail}`,
		fullText: value,
		truncated: true,
		originalChars,
		keptHeadChars: headChars,
		keptTailChars: tailChars,
		omittedChars,
		omittedFromChar,
		omittedToChar
	};
}
function capNoticeOutcome(text) {
	return digestNoticeOutcome(text);
}
/** 落盘文件名：cu-notice-full-YYYYMMDD-HHMMSS.md（本地时区）。 */
function noticeDumpFileName(now = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `cu-notice-full-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
}
/** 把裁切前的完整原文写成一份文件；落盘失败返回 null（通知里不编造路径）。 */
function writeCodeAgentNoticeDump(dir, text, now = new Date()) {
	const base = String(dir ?? "").trim();
	if (base === "") return null;
	const body = String(text ?? "");
	try {
		mkdirSync(base, { recursive: true });
		const file = pathResolve(base, noticeDumpFileName(now));
		writeFileSync(file, [
			"# Background Code session full text (dumped by the plugin before the notice cut it)",
			"",
			`- Written at: ${now.toISOString()}`,
			`- Total characters: ${body.length}`,
			`- Notice cap: ${CODE_AGENT_NOTICE_MAX_CHARS} chars (keeps head ${CODE_AGENT_NOTICE_HEAD_CHARS} + tail ${CODE_AGENT_NOTICE_TAIL_CHARS})`,
			"",
			"---",
			"",
			body
		].join("\n"), "utf8");
		return file;
	} catch {
		return null;
	}
}
/** 落盘目录：CU 会话的项目目录下 .dsh-cu-notices/；没有 cwd 就不落盘（不退回进程 cwd）。 */
function noticeDumpDirOf(watch) {
	const cwd = String(watch?.cwd ?? watch?.code?.session?.header?.cwd ?? "").trim();
	return cwd === "" ? "" : pathJoin(cwd, CODE_AGENT_NOTICE_DUMP_DIR);
}
function completionNoticeText(sessionId, task, outcome, screenBusy, userStopped, stillRunning = false, options = {}) {
	const capped = capNoticeOutcome(outcome);
	const fullTextPath = capped.truncated ? writeCodeAgentNoticeDump(String(options?.dumpDir ?? "").trim(), capped.fullText) : null;
	const body = userStopped ? `The user stopped background Code agent session ${sessionId} from the main window:\n${task}\n\nLast output before it stopped:\n${capped.text}` : `Background Code agent session ${sessionId} ${stillRunning ? "completed the stretch you dispatched (its own turns are still running)" : "finished this task"}:\n${task}\n\n${capped.text}`;
	const cutSuffix = capped.truncated ? `\n\nThat reply is ${capped.originalChars} characters; this notice keeps the first ${capped.keptHeadChars} and last ${capped.keptTailChars} characters, omits ${capped.omittedChars} in the middle (chars ${capped.omittedFromChar}-${capped.omittedToChar}), so the conclusion and the final paths are still in the tail. The full text was cut from this notice${fullTextPath !== null ? ` and written to ${fullTextPath}` : ""} — read the full text back ${fullTextPath !== null ? "from that file" : "from the file that Code session wrote"}, or open session ${sessionId} in the app; do not conclude from the excerpt alone. Dispatch another stretch to that session only when the user asked you to.` : "";
	return `${body}${cutSuffix}${userStopped ? "\n\nDo not restart this task and do not call code_agent for it again unless the user asks." : stillRunning ? "\n\nThat Code session is still working on later rounds. Use this result to decide your next step now; call code_agent_status to check progress, and only dispatch another stretch to the same session_id when this one is not the answer you needed." : ""}${screenBusy ? `\n\n${SCREEN_BUSY_SUFFIX}` : ""}`;
}
//#endregion
//#region src/code-agent-registry.ts
/** Cordis service name the orb host polls the bookmarks from. */
const CODE_AGENT_REGISTRY = "codeAgentRegistry";
/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
const name = "computer-use-code-agent-registry";
/** Cap on the outcome summary one bookmark carries; the full text lives in the session. */
const BOOKMARK_OUTCOME_MAX_CHARS = 200;
/**
* One registry per host process. `code_agent`'s apply may run again (plugin
* re-apply, tests); every caller records into the same instance so the host
* always reads the live set.
*/
let shared;
function sharedCodeAgentRegistry() {
	shared ??= createCodeAgentRegistry();
	return shared;
}
/**
* Publish the process-wide registry as an app-level service.
* Inserted at the top level of the patch (never inside a preset) so the orb
* host — also top level — can read it across the preset boundary.
*/
function apply(ctx) {
	ctx.provide(CODE_AGENT_REGISTRY, sharedCodeAgentRegistry());
}
function createCodeAgentRegistry() {
	const records = /* @__PURE__ */ new Map();
	return {
		record(entry) {
			const previous = records.get(entry.sessionId);
			if (previous !== void 0) detachRecord(previous);
			const record = {
				sessionId: entry.sessionId,
				callerId: entry.callerId,
				task: entry.task,
				cwd: entry.cwd,
				requestId: entry.requestId,
				watch: entry.watch,
				agent: entry.agent,
				startedAt: Date.now(),
				endedAt: void 0,
				state: "running",
				outcome: void 0,
				detach: void 0
			};
			records.set(entry.sessionId, record);
			subscribe(record);
			evaluate(record);
		},
		dropCaller(callerId) {
			for (const [sessionId, record] of records) {
				if (record.callerId !== callerId) continue;
				detachRecord(record);
				records.delete(sessionId);
			}
		},
		markStopped(sessionId) {
			const record = records.get(sessionId);
			if (record !== void 0) stopRecord(record);
		},
		list() {
			const items = [];
			for (const record of records.values()) {
				evaluate(record);
				items.push({
					sessionId: record.sessionId,
					callerId: record.callerId,
					task: record.task,
					cwd: record.cwd,
					startedAt: record.startedAt,
					state: record.state,
					...record.endedAt === void 0 ? {} : { endedAt: record.endedAt },
					...record.outcome === void 0 ? {} : { outcome: record.outcome }
				});
			}
			return items;
		}
	};
}
/** Fold one live status into the record's state. Queued prompts are still running. */
function evaluate(record) {
	if (record.state === "stopped") return;
	if (record.watch?.signal.aborted === true) {
		stopRecord(record);
		return;
	}
	const agent = record.agent;
	if (agent === void 0) return;
	if (agent.status === "running") {
		record.state = "running";
		return;
	}
	if (holdsPrompt(agent, record.requestId)) return;
	completeRecord(record, agent);
}
function stopRecord(record) {
	record.state = "stopped";
	record.endedAt ??= Date.now();
	detachRecord(record);
}
function completeRecord(record, agent) {
	if (lastTurnEndedUserAborted(agent)) {
		stopRecord(record);
		return;
	}
	record.state = "completed";
	record.endedAt ??= Date.now();
	record.outcome = capOutcome(lastAssistantText(agent, record.requestId));
	detachRecord(record);
}
function detachRecord(record) {
	record.detach?.();
	record.detach = void 0;
}
function subscribe(record) {
	detachRecord(record);
	const agent = record.agent;
	if (agent === void 0) return;
	const disposers = [];
	try {
		const off = agent.ctx.on("agent/status", () => evaluate(record));
		if (typeof off === "function") disposers.push(off);
	} catch {}
	try {
		const off = agent.ctx.on("agent/disposed", () => {
			if (record.state === "stopped") return;
			record.state = "completed";
			record.endedAt ??= Date.now();
			try {
				record.outcome = capOutcome(lastAssistantText(agent, record.requestId));
			} catch {}
			detachRecord(record);
		});
		if (typeof off === "function") disposers.push(off);
	} catch {}
	record.detach = () => {
		for (const off of disposers.splice(0)) off();
	};
}
function capOutcome(text) {
	const trimmed = text?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}…`;
}
//#endregion
export { name as a, createCodeAgentRegistry as i, CODE_AGENT_REGISTRY as n, sharedCodeAgentRegistry as o, apply as r, watchCodeAgentCompletion as s, BOOKMARK_OUTCOME_MAX_CHARS as t };
