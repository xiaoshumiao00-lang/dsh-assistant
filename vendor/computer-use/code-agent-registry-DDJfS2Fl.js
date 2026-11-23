import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
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
				text: completionNoticeText(watch.sessionId, watch.task, outcome, anotherComputerUseRunning(watch), userStopped, stillRunning)
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
 * 改前是 4e3：逐条核实参考文献、批量改稿那种长报告普遍上万字，4000 一刀把报告拦腰截掉，
 * 前台 Computer Use 只能依据半截的摘录往下走。宿主这条通道本身不裁正文
 * （@deepseek-ai/dsh-agent-loop `send` 只做 `inbox.splice`，:800-808），所以放大上限即可，
 * 不需要多条通知分段送达。卡片那一行的一行话另有口径：@deepseek-ai/dsh-llm
 * `CONTEXT_SUMMARY_MAX_CHARS = 120`（`boundContextSummary`）与书签列表的 200（`BOOKMARK_OUTCOME_MAX_CHARS`），
 * 那两个是观感口径，不裁模型看到的正文。
 */
const CODE_AGENT_NOTICE_MAX_CHARS = 20000;
function capNoticeOutcome(text) {
	const value = String(text ?? "");
	if (value.length <= CODE_AGENT_NOTICE_MAX_CHARS) return { text: value, truncated: false };
	return { text: `${value.slice(0, CODE_AGENT_NOTICE_MAX_CHARS)}…`, truncated: true };
}
function completionNoticeText(sessionId, task, outcome, screenBusy, userStopped, stillRunning = false) {
	const capped = capNoticeOutcome(outcome);
	const body = userStopped ? `The user stopped background Code agent session ${sessionId} from the main window:\n${task}\n\nLast output before it stopped:\n${capped.text}` : `Background Code agent session ${sessionId} ${stillRunning ? "completed the stretch you dispatched (its own turns are still running)" : "finished this task"}:\n${task}\n\n${capped.text}`;
	return `${body}${capped.truncated ? `\n\nThat reply is cut here at ${CODE_AGENT_NOTICE_MAX_CHARS} characters (the tail after the \`…\` is missing). Do not conclude from the excerpt alone: read the full text back from the file that Code session wrote, or open session ${sessionId} in the app. Dispatch another stretch to that session only when the user asked you to.` : ""}${userStopped ? "\n\nDo not restart this task and do not call code_agent for it again unless the user asks." : stillRunning ? "\n\nThat Code session is still working on later rounds. Use this result to decide your next step now; call code_agent_status to check progress, and only dispatch another stretch to the same session_id when this one is not the answer you needed." : ""}${screenBusy ? `\n\n${SCREEN_BUSY_SUFFIX}` : ""}`;
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
