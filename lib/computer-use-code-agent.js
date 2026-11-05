// src/cu-peer.mjs
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
function profileNodeModules() {
  const out = [];
  try {
    const profiles = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles");
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      out.push(join(profiles, entry.name, "node_modules"));
    }
  } catch {
  }
  return out;
}
function bases() {
  const out = [];
  const resources = typeof process !== "undefined" ? process.resourcesPath : "";
  if (resources) {
    out.push(join(resources, "app.asar", "dsh", "node_modules"));
    out.push(join(resources, "app.asar", "node_modules"));
    out.push(join(resources, "app", "dsh", "node_modules"));
    out.push(join(resources, "app", "node_modules"));
  }
  out.push(...profileNodeModules());
  out.push(join(process.cwd(), "node_modules"));
  return out;
}
var cache = /* @__PURE__ */ new Map();
function resolvePeer(name2) {
  for (const base of bases()) {
    try {
      return createRequire(pathToFileURL(pathResolve(base, "__dsh_probe__.js")).href).resolve(name2);
    } catch {
    }
  }
  return "";
}
async function loadPeer(name2) {
  if (cache.has(name2)) return cache.get(name2);
  const resolved = resolvePeer(name2);
  if (!resolved) {
    throw new Error(`dsh-assistant: \u627E\u4E0D\u5230\u5BBF\u4E3B\u6A21\u5757 ${name2}\uFF08Computer Use \u5DE5\u5177\u9700\u8981\u7531 DSH \u5BBF\u4E3B\u52A0\u8F7D\uFF09`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  cache.set(name2, mod);
  return mod;
}

// src/cu-shims/dsh-llm.mjs
var m = await loadPeer("@deepseek-ai/dsh-llm");
var createUserMessage = m.createUserMessage;
var boundContextSummary = m.boundContextSummary;

// vendor/computer-use/code-agent-registry-DDJfS2Fl.js
var NO_ASSISTANT = "The Code agent session ended without a final assistant message.";
var SCREEN_BUSY_SUFFIX = "Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.";
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
    if (await raceAbort(signal, watch.code.whenIdle()) === "aborted") return;
    const userStopped = lastTurnEndedUserAborted(watch.code);
    const outcome = lastAssistantText(watch.code) ?? NO_ASSISTANT;
    if (await raceAbort(signal, watch.caller.whenIdle()) === "aborted") return;
    if (watch.agents.get(watch.caller.id) !== watch.caller) return;
    watch.caller.followup(createUserMessage({
      content: [{
        type: "text",
        text: completionNoticeText(watch.sessionId, watch.task, outcome, anotherComputerUseRunning(watch), userStopped)
      }],
      source: {
        kind: "computer-use",
        form: "notice",
        summary: boundContextSummary(userStopped ? `Code agent ${watch.sessionId} stopped by the user` : `Code agent ${watch.sessionId} finished`)
      }
    }));
  } catch (error) {
    if (signal.aborted) return;
    try {
      watch.caller.ctx.logger.warn(`code_agent: completion watch failed: ${String(error)}`);
    } catch {
    }
  }
}
function intervalHasStarted(code, requestId) {
  return code.status === "running" || !holdsPrompt(code, requestId);
}
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
    let disposeStatus = () => {
    };
    let disposeDisposed = () => {
    };
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
function lastAssistantText(code) {
  const messages = code.session.deriveMessages();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    if (text !== "") return text;
  }
}
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
function anotherComputerUseRunning(watch) {
  return (watch.agents.list?.() ?? []).some((other) => other.id !== watch.caller.id && other.status === "running" && presetOf(other) === "computer-use");
}
function presetOf(agent) {
  return agent.session?.header?.agentPreset;
}
function completionNoticeText(sessionId, task, outcome, screenBusy, userStopped) {
  const body = userStopped ? `The user stopped background Code agent session ${sessionId} from the main window:
${task}

Last output before it stopped:
${outcome}` : `Background Code agent session ${sessionId} finished this task:
${task}

${outcome}`;
  return `${body.length <= 4e3 ? body : `${body.slice(0, 3999)}\u2026`}${userStopped ? "\n\nDo not restart this task and do not call code_agent for it again unless the user asks." : ""}${screenBusy ? `

${SCREEN_BUSY_SUFFIX}` : ""}`;
}
var shared;
function sharedCodeAgentRegistry() {
  shared ??= createCodeAgentRegistry();
  return shared;
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
  record.outcome = capOutcome(lastAssistantText(agent));
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
  } catch {
  }
  try {
    const off = agent.ctx.on("agent/disposed", () => {
      if (record.state === "stopped") return;
      record.state = "completed";
      record.endedAt ??= Date.now();
      try {
        record.outcome = capOutcome(lastAssistantText(agent));
      } catch {
      }
      detachRecord(record);
    });
    if (typeof off === "function") disposers.push(off);
  } catch {
  }
  record.detach = () => {
    for (const off of disposers.splice(0)) off();
  };
}
function capOutcome(text) {
  const trimmed = text?.trim();
  if (trimmed === void 0 || trimmed === "") return void 0;
  return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}\u2026`;
}

// vendor/computer-use/code-agent.js
import { existsSync } from "node:fs";
import { join as join2 } from "node:path";

// src/cu-shims/dsh-tools.mjs
var m2 = await loadPeer("@deepseek-ai/dsh-tools");
var defineTool = m2.defineTool;

// vendor/computer-use/code-agent.js
import { randomUUID } from "node:crypto";

// src/cu-shims/dsh-brand.mjs
var m3 = await loadPeer("@deepseek-ai/dsh-brand");
var brandString = m3.brandString;

// src/cu-bridge-core.mjs
var COMPUTER_USE_TOOL = "computer_use";
var MAX_RESULT_CHARS = 4e3;
var DEFAULT_HANDOFF_TIMEOUT_MS = 20 * 60 * 1e3;
var START_WAIT_MS = 60 * 1e3;
var POLL_MS = 25;
var QUEUES = /* @__PURE__ */ new Map();
function abortError() {
  const error = new Error("computer_use handoff aborted");
  error.name = "AbortError";
  return error;
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
function capText(text, max = MAX_RESULT_CHARS) {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  return `\u2026${value.slice(value.length - (max - 1))}`;
}
function findNoticeIndex(agent, messageId) {
  if (messageId === void 0) return -1;
  let events;
  try {
    events = agent?.session?.snapshotEvents?.() ?? [];
  } catch {
    return -1;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "user/message" && event.data?.id === messageId) return index;
  }
  return -1;
}
function firstAssistantTextAfter(agent, messageId) {
  if (messageId === void 0) return "";
  let events;
  try {
    events = agent?.session?.snapshotEvents?.() ?? [];
  } catch {
    return "";
  }
  const start = findNoticeIndex(agent, messageId);
  if (start < 0) return "";
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const text = (event.data?.message?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("\n").trim();
    if (text !== "") return text;
  }
  return "";
}
function lastAssistantText2(agent, options = {}) {
  const after = Number.isInteger(options.after) ? Math.max(0, options.after) : 0;
  let messages;
  try {
    messages = agent?.session?.deriveMessages?.() ?? [];
  } catch {
    return "";
  }
  for (let index = messages.length - 1; index >= after; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("\n").trim();
    if (text !== "") return text;
  }
  return "";
}
function isQueued(agent, messageId) {
  if (messageId === void 0 || agent?.inbox === void 0) return false;
  try {
    const lists = [agent.inbox.nextTurn ?? [], agent.inbox.nextStep ?? []];
    return lists.some((list) => list.some((message) => message?.id === messageId));
  } catch {
    return false;
  }
}
function buildHandoffText(task) {
  return [
    "\u540E\u53F0 Code agent \u9700\u8981\u4E00\u6B21\u684C\u9762 GUI \u64CD\u4F5C\uFF08\u5B83\u770B\u4E0D\u5230\u5C4F\u5E55\uFF0C\u4E5F\u6CA1\u6709 GUI \u5DE5\u5177\uFF09\u3002",
    `\u4EFB\u52A1\uFF1A${String(task ?? "").trim()}`,
    "",
    "\u8BF7\u5728\u8FD9\u4E2A\u4F1A\u8BDD\u91CC\u76F4\u63A5\u5B8C\u6210\u8FD9\u4E00\u6B65\uFF1A",
    "- \u5148\u622A\u56FE\u786E\u8BA4\u5F53\u524D\u5C4F\u5E55\u72B6\u6001\uFF0C\u9700\u8981\u65F6\u6253\u5F00\u6216\u5207\u6362\u5230\u76EE\u6807\u7A97\u53E3\u3002",
    "- \u4E0D\u8981\u628A\u8FD9\u6B65\u518D\u4EA4\u7ED9 code_agent\uFF0C\u4E5F\u4E0D\u8981\u5199\u62A5\u544A\u6216\u957F\u7BC7\u89E3\u91CA\u3002",
    "- \u5B8C\u6210\u540E\u7528\u4E00\u4E24\u53E5\u8BDD\u56DE\u590D\u5177\u4F53\u7ED3\u679C\uFF1A\u505A\u4E86\u4EC0\u4E48\u3001\u770B\u5230\u4E86\u4EC0\u4E48\u3001\u62FF\u5230\u7684\u6587\u672C/\u6570\u503C/\u6587\u4EF6\u8DEF\u5F84\u3002",
    "- \u5982\u679C\u786E\u5B9E\u9700\u8981\u7528\u6237\u51B3\u5B9A\uFF0C\u7528 ask_user_question \u63D0\u95EE\u3002"
  ].join("\n");
}
function resultText(result) {
  const body = result === "" ? "\uFF08\u524D\u53F0\u4F1A\u8BDD\u6CA1\u6709\u7ED9\u6587\u5B57\u7ED3\u679C\uFF09" : result;
  return `Computer Use \u5DF2\u5B8C\u6210\u8FD9\u4E00\u6B65\uFF1A
${capText(body)}

\u7EE7\u7EED\u539F\u4EFB\u52A1\uFF1B\u540C\u4E00\u4E2A\u6B65\u9AA4\u4E0D\u8981\u518D\u8BF7\u6C42\u4E00\u6B21\u3002`;
}
function failureText(reason) {
  return `Computer Use \u6CA1\u80FD\u5B8C\u6210\u8FD9\u4E00\u6B65\uFF1A${capText(reason, 600)}

\u4E0D\u8981\u91CD\u590D\u8C03\u7528 computer_use \u8FFD\u95EE\u540C\u4E00\u6B65\uFF1B\u7EE7\u7EED\u7528\u4F60\u73B0\u6709\u7684\u5DE5\u5177\u5B8C\u6210\u4EFB\u52A1\uFF0C\u6216\u628A\u9700\u8981\u7528\u6237\u5728\u684C\u9762\u4E0A\u64CD\u4F5C\u7684\u4E8B\u9879\u5199\u6210\u6E05\u5355\u4EA4\u7ED9\u7528\u6237\u3002`;
}
async function withParentLock(key, task) {
  const previous = QUEUES.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  QUEUES.set(key, tail);
  await previous.catch(() => {
  });
  try {
    return await task();
  } finally {
    release();
    if (QUEUES.get(key) === tail) QUEUES.delete(key);
  }
}
async function waitForStart(agent, messageId, options) {
  const signal = options.signal;
  const deadline = Date.now() + (options.startWaitMs ?? START_WAIT_MS);
  for (; ; ) {
    if (signal?.aborted) return "aborted";
    if (agent?.status === "running") return "running";
    if (!isQueued(agent, messageId)) return "claimed";
    if (Date.now() >= deadline) return "pending";
    await sleep(POLL_MS, signal);
  }
}
function waitForSettle(agent, options) {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const offs = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
        }
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(status);
    };
    const onAbort = () => finish("aborted");
    const check = () => {
      if (agent?.status !== "running") finish("idle");
    };
    try {
      offs.push(agent.ctx.on("agent/status", check));
      offs.push(agent.ctx.on("agent/disposed", () => finish("disposed")));
    } catch {
      finish("idle");
      return;
    }
    if (signal?.aborted) {
      finish("aborted");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    check();
  });
}
async function handoffToComputerUse(parent, task, options) {
  const { createUserMessage: createUserMessage2, boundContextSummary: boundContextSummary2, signal, timeoutMs } = options;
  const hasEvents = typeof parent.session?.snapshotEvents === "function";
  const message = createUserMessage2({
    content: [{ type: "text", text: buildHandoffText(task) }],
    source: {
      kind: "computer-use",
      form: "notice",
      summary: boundContextSummary2("Computer Use: background GUI request")
    }
  });
  try {
    parent.followup(message);
  } catch (error) {
    return { ok: false, result: `\u65E0\u6CD5\u628A\u8BF7\u6C42\u4EA4\u7ED9\u524D\u53F0\u4F1A\u8BDD\uFF1A${String(error?.message ?? error)}` };
  }
  const dropQueued = () => {
    try {
      if (isQueued(parent, message.id)) parent.inbox.remove(message.id);
    } catch {
    }
  };
  const start = await waitForStart(parent, message.id, {
    signal,
    startWaitMs: options.startWaitMs ?? START_WAIT_MS
  });
  if (start === "aborted") {
    dropQueued();
    throw abortError();
  }
  if (start === "pending") {
    dropQueued();
    return { ok: false, result: "\u524D\u53F0 Computer Use \u4F1A\u8BDD\u6CA1\u6709\u5F00\u59CB\u5904\u7406\u8FD9\u4E2A\u8BF7\u6C42\uFF08\u53EF\u80FD\u6B63\u5FD9\u6216\u5DF2\u505C\u7528\uFF09\u3002" };
  }
  const settled = await waitForSettle(parent, {
    signal,
    timeoutMs: timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS
  });
  if (settled === "aborted") {
    dropQueued();
    throw abortError();
  }
  if (settled === "disposed") return { ok: false, result: "\u524D\u53F0 Computer Use \u4F1A\u8BDD\u5DF2\u5173\u95ED\u3002" };
  if (settled === "timeout") {
    dropQueued();
    const limit = timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
    const label = limit >= 6e4 ? `${Math.round(limit / 6e4)} \u5206\u949F` : `${Math.round(limit / 1e3)} \u79D2`;
    return {
      ok: false,
      result: `\u7B49\u5F85\u524D\u53F0 Computer Use \u4F1A\u8BDD\u8D85\u65F6\uFF08${label}\uFF09\uFF1B\u5B83\u53EF\u80FD\u4ECD\u5728\u6267\u884C\uFF0C\u4E5F\u53EF\u80FD\u5728\u7B49\u7528\u6237\u56DE\u7B54\u3002`
    };
  }
  if (hasEvents && findNoticeIndex(parent, message.id) < 0) {
    return { ok: false, result: "\u524D\u53F0\u4F1A\u8BDD\u6CA1\u6709\u6536\u5230\u8FD9\u6761\u8BF7\u6C42\uFF08\u6392\u961F\u7684\u6D88\u606F\u88AB\u6E05\u7A7A\uFF0C\u53EF\u80FD\u88AB\u7528\u6237\u505C\u6B62\uFF09\u3002" };
  }
  const outcome = hasEvents ? firstAssistantTextAfter(parent, message.id) : lastAssistantText2(parent);
  return { ok: true, result: outcome };
}
function resolveCallerId(ctx, sessionId, fallbackParentId) {
  try {
    const registry = ctx?.get?.("codeAgentRegistry");
    const rows = registry?.list?.() ?? [];
    const owner = rows.find((row) => row?.sessionId === sessionId)?.callerId;
    if (typeof owner === "string" && owner !== "") return owner;
  } catch {
  }
  return fallbackParentId;
}
function createComputerUseBridgeTool(options) {
  const {
    defineTool: defineTool2,
    createUserMessage: createUserMessage2,
    boundContextSummary: boundContextSummary2,
    agent,
    ctx,
    parentId,
    maxHandoffs = 20
  } = options;
  if (typeof defineTool2 !== "function") throw new TypeError("createComputerUseBridgeTool: defineTool is required");
  const state = { handoffs: 0 };
  return defineTool2({
    name: COMPUTER_USE_TOOL,
    description: "Ask the Computer Use session that started this background job to perform ONE visible desktop GUI step. You cannot see the screen. Call this when the task needs a desktop app: open or switch an application window, click a button, type into another app, pick a file in a native dialog, read a dialog or an on-screen value, or confirm what the screen currently shows. Give one concrete step and state exactly what to bring back (window title, visible text, chosen path, click result). The foreground Computer Use session sees the screen, performs the step, and returns a short report. Use this early instead of guessing, retrying shell commands, or scripting SendKeys/UI Automation. Do not use it for file, shell, web, or reasoning work your own tools can do; do not use it to ask the user a question; do not repeat a step that already returned a result. The call waits until that session finishes the step, so call it only when you truly need the screen.",
    parameters: {
      task: {
        type: "string",
        required: true,
        description: 'One concrete GUI step plus what to bring back, e.g. "\u5728\u5FAE\u4FE1\u91CC\u6253\u5F00\u6587\u4EF6\u4F20\u8F93\u52A9\u624B\uFF0C\u622A\u56FE\u544A\u8BC9\u6211\u7A97\u53E3\u6807\u9898\u548C\u6700\u540E\u4E00\u6761\u6D88\u606F". Required.'
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          result: { type: "string", required: true }
        }
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? resultText(value.result) : failureText(value.result) }
      ]
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: "generic",
      title: "Computer Use",
      kind: "execute",
      rawInput: { task: args.task }
    }),
    async execute(args, exec) {
      const task = String(args?.task ?? "").trim();
      if (task === "") throw new Error("computer_use task must include non-whitespace text");
      const caller = exec?.agent ?? agent;
      if (caller === void 0) return { ok: false, result: "computer_use requires a calling session" };
      state.handoffs += 1;
      if (state.handoffs > maxHandoffs) {
        return {
          ok: false,
          result: `\u672C\u4F1A\u8BDD\u5DF2\u7ECF\u8FDE\u7EED\u8BF7\u6C42 GUI ${maxHandoffs} \u6B21\uFF0C\u5148\u505C\u4E0B\uFF1A\u628A\u5269\u4F59\u9700\u8981\u684C\u9762\u7684\u6B65\u9AA4\u6574\u7406\u7ED9\u7528\u6237\u3002`
        };
      }
      const serviceCtx = typeof caller.ctx?.get === "function" ? caller.ctx : ctx;
      const targetId = resolveCallerId(serviceCtx, caller.id, parentId);
      if (typeof targetId !== "string" || targetId === "") {
        return { ok: false, result: "\u627E\u4E0D\u5230\u542F\u52A8\u8FD9\u4E2A\u540E\u53F0\u4EFB\u52A1\u7684 Computer Use \u4F1A\u8BDD\u3002" };
      }
      if (targetId === caller.id) {
        return { ok: false, result: "\u4E0D\u80FD\u628A GUI \u8BF7\u6C42\u4EA4\u7ED9\u8C03\u7528\u8005\u81EA\u5DF1\u3002" };
      }
      const agents = serviceCtx?.get?.("agents");
      const parent = agents?.get?.(targetId);
      if (parent === void 0) {
        return { ok: false, result: `Computer Use \u4F1A\u8BDD ${targetId} \u5DF2\u4E0D\u5728\u8FD0\u884C\uFF08\u53EF\u80FD\u88AB\u5173\u95ED\uFF09\u3002` };
      }
      try {
        return await withParentLock(
          targetId,
          () => handoffToComputerUse(parent, task, {
            createUserMessage: createUserMessage2,
            boundContextSummary: boundContextSummary2 ?? ((summary) => summary),
            signal: exec?.signal,
            timeoutMs: options.timeoutMs,
            startWaitMs: options.startWaitMs
          })
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return { ok: false, result: String(error?.message ?? error) };
      }
    }
  });
}

// src/cu-bridge.mjs
var registered = /* @__PURE__ */ new WeakSet();
function registerComputerUseBridge(options) {
  const { agent, ctx, parentId, logger } = options;
  const scope = agent?.ctx;
  if (scope === void 0) return false;
  if (registered.has(agent)) return false;
  let tools;
  try {
    tools = scope.tools;
  } catch {
    return false;
  }
  if (tools === void 0) {
    try {
      logger?.warn?.(`[dsh-assistant] \u540E\u53F0\u4F1A\u8BDD ${agent.id} \u6CA1\u6709 tools \u4F5C\u7528\u57DF\uFF0C\u8DF3\u8FC7 ${COMPUTER_USE_TOOL} \u6CE8\u518C`);
    } catch {
    }
    return false;
  }
  registered.add(agent);
  try {
    const definition = createComputerUseBridgeTool({
      defineTool,
      createUserMessage,
      boundContextSummary,
      agent,
      ctx,
      parentId
    });
    tools.register(definition);
    try {
      logger?.debug?.(`[dsh-assistant] ${COMPUTER_USE_TOOL} \u5DF2\u88C5\u5230\u540E\u53F0\u4F1A\u8BDD ${agent.id}`);
    } catch {
    }
    return true;
  } catch (error) {
    registered.delete(agent);
    try {
      logger?.warn?.(`[dsh-assistant] \u5B89\u88C5 ${COMPUTER_USE_TOOL} \u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    } catch {
    }
    return false;
  }
}

// vendor/computer-use/code-agent.js
var UNATTENDED_CUSTOM_ANSWER = "Stop. Return the short result you already have. Do not expand the task.";
function autoAnswerQuestions(questions) {
  return { answers: questions.map((question) => {
    if (question.intent?.kind === "plan-review") return {
      id: question.id,
      selected: [question.intent.approve]
    };
    const options = question.options ?? [];
    const recommended = options.find((option) => option.label.includes("(Recommended)"));
    if (recommended !== void 0) return {
      id: question.id,
      selected: [recommended.label]
    };
    if (options[0] !== void 0) return {
      id: question.id,
      selected: question.multiSelect === true ? options.map((option) => option.label) : [options[0].label]
    };
    return {
      id: question.id,
      selected: [],
      custom: UNATTENDED_CUSTOM_ANSWER
    };
  }) };
}
function attachUnattendedCodeAgent(code, attached) {
  if (attached.has(code)) return;
  attached.add(code);
  try {
    code.ctx.effect(() => {
      const offApproval = code.ctx.on("approval/request", () => Promise.resolve("allowed-once"), { prepend: true });
      const offQuestions = code.ctx.on("user-questions/request", (request) => Promise.resolve(autoAnswerQuestions(request.questions)), { prepend: true });
      return () => {
        offApproval();
        offQuestions();
        attached.delete(code);
      };
    });
  } catch {
    attached.delete(code);
  }
}
var QUEUE = Symbol.for("dsh-orb.select-model.queue");
function enqueue(task) {
  const holder = globalThis;
  const run = (holder[QUEUE] ?? Promise.resolve()).then(task, task);
  holder[QUEUE] = run.catch(() => void 0);
  return run;
}
function selectModelKeepDefault(ctx, request) {
  return enqueue(() => selectAndRestore(ctx, request));
}
async function selectAndRestore(ctx, request) {
  const defaults = ctx.agentDefaultModel;
  const previous = defaults?.currentSelection();
  const chosen = {
    provider: request.provider,
    model: request.model,
    ...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
  };
  await ctx.sessionController.selectModel({
    sessionId: request.sessionId,
    ...chosen
  });
  if (defaults === void 0) {
    console.error("dsh-orb: agentDefaultModel is missing; a session model may replace the global default");
    return;
  }
  if (previous === void 0 || sameSelection(previous, chosen)) return;
  await defaults.saveSelection(previous);
  console.error("dsh-orb: restored the global default model after a session-only selection");
}
function sameSelection(left, right) {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
var name = "tool-code-agent";
var inject = [
  "tools",
  "sessionController",
  "agentDefaultModel"
];
var TOOL_NAME = "code_agent";
var STATUS_TOOL_NAME = "code_agent_status";
var STOP_TOOL_NAME = "code_agent_stop";
var DESCRIPTION = "Delegate one stretch of file search or file production to a standard-mode Code agent that appears in the desktop sidebar like a user-created session. Do the stretch in this chat when it is visible GUI or when one search or one command will answer or feed the next click. A second search that you expect will hit the point stays here. Do not call this tool for visible GUI work such as opening WeChat or clicking a button in Pages \u2014 use the GUI tools instead. A background Code agent can call computer_use to hand one GUI step back to this chat when it needs the screen; when that notice arrives, perform the step here and reply with the concrete result. Do not call this tool for a short lookup such as today's weather or current headlines \u2014 use web_search or web_fetch in this chat. Call this tool when you are still digging through files, searches, or commands, or when the user asked for a file, document, spreadsheet, or site. The last step being a click does not keep the investigation here. Omit session_id to create a new blank standard session: write a Word document, make a gobang game, write an HTML research report, or any task that is not a follow-up to a previous code_agent result. Pass session_id with the id returned by an earlier code_agent result when continuing the same artifact, for example making that Word document's font green, or another stretch of the same investigation. Do not pass a previous id when the new work is unrelated. session_id must be a session this Computer Use agent started. task is the stretch to enqueue. The call returns after the standard session accepts the message; it does not wait for that session to finish. Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session. A plugin notice arrives later when that session is idle and this session is idle; then decide again: do remaining GUI, or call code_agent with that session_id for another stretch, and tell the user the short conclusion. Do not recite a long report. Pass cwd when the user named a path or said this folder and <frontmost_folder> is present. Omit cwd to create a new subdirectory under this session's workspace. session_id cannot target this Computer Use session, a subagent child, or a non-standard session.";
var BACKGROUND_ROLE = "You are the background worker for a Computer Use session. You do not see the screen and you do not talk to the user. If a step needs a visible desktop app \u2014 opening or switching an app window, clicking a button, typing into another app, choosing a file in a native dialog, reading a dialog or what is currently on screen \u2014 call computer_use with that one GUI step and state what to bring back; do that instead of guessing, retrying shell commands, or scripting SendKeys/UI Automation. The foreground Computer Use session sees the screen, performs the step, and returns the result; continue here with it. Do not spawn a subagent for GUI work: computer_use is the only path to the screen. If this task asks for a file, document, spreadsheet, or site, produce it, reply with its path, and stop. Otherwise search or run commands only until you can answer, including a second search when the first missed the point. Reply in a few sentences with the paths or results that matter, then stop. Do not write a report or create extra files.";
var RUNNING_RESULT = "Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn.";
function queuedTaskText(task) {
  return `${task}

${BACKGROUND_ROLE}`;
}
var STATUS_DESCRIPTION = "List background Code agent sessions this Computer Use agent started. Returns the count plus each task name, working directory, and running or idle status. Does not include sessions from other Computer Use chats or the main window. Stopped and finished sessions stay listed as idle so they can be continued.";
var STOP_DESCRIPTION = "Stop a background Code agent this Computer Use agent started. Cancels the current turn and drops queued follow-ups. The session stays idle so a later code_agent call with the same session_id can continue. Does not delete files. session_id is required and must be a session this Computer Use agent started.";
function requireAgent(exec) {
  if (exec.agent === void 0) throw new Error("code_agent requires a calling Computer Use session");
  return exec.agent;
}
function slugFromTask(task) {
  const slug = task.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
}
function uniqueDirectory(parent, slug) {
  const base = join2(parent, slug);
  if (!existsSync(base)) return base;
  for (let index = 2; index < 1e3; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}
async function workspaceIdForDirectory(ctx, directory) {
  if (directory === void 0 || directory === "") return void 0;
  const registry = ctx.get("workspaceRegistry");
  if (registry === void 0 || typeof registry.resolveByPath !== "function") return void 0;
  try {
    const id = (await registry.resolveByPath(directory))?.id;
    return id === void 0 ? void 0 : brandString(id);
  } catch {
    return;
  }
}
async function locationForCreate(ctx, directory) {
  const workspaceId = await workspaceIdForDirectory(ctx, directory);
  if (workspaceId !== void 0) return { workspaceId };
  if (directory === void 0) return {};
  return { cwd: directory };
}
function ownedBySubagent(ctx, header) {
  const parentId = header.parentSession;
  if (parentId === void 0) return false;
  const agents = ctx.get("agents");
  if (agents === void 0) return false;
  const live = agents.get(header.id);
  const parent = agents.get(parentId);
  return live !== void 0 && parent !== void 0 && agents.isOwnedBy(live.id, parent);
}
function callerDelegations(byCaller, callerId) {
  const existing = byCaller.get(callerId);
  if (existing !== void 0) return existing;
  const created = /* @__PURE__ */ new Map();
  byCaller.set(callerId, created);
  return created;
}
function rememberCaller(liveCaller, callerId, byCaller, remembered, registry) {
  if (remembered.has(liveCaller)) return;
  remembered.add(liveCaller);
  try {
    liveCaller.ctx.effect(() => {
      return () => {
        byCaller.delete(callerId);
        registry.dropCaller(callerId);
        remembered.delete(liveCaller);
      };
    });
  } catch {
    remembered.delete(liveCaller);
    byCaller.delete(callerId);
  }
}
function recordDelegation(delegations, sessionId, task, cwd, watch) {
  const existing = delegations.get(sessionId);
  if (existing === void 0) {
    delegations.set(sessionId, {
      task,
      cwd,
      watches: watch === void 0 ? [] : [watch]
    });
    return;
  }
  existing.task = task;
  existing.cwd = cwd;
  if (watch !== void 0) existing.watches.push(watch);
}
function apply(ctx) {
  const byCaller = /* @__PURE__ */ new Map();
  const rememberedCallers = /* @__PURE__ */ new WeakSet();
  const unattended = /* @__PURE__ */ new WeakSet();
  const registry = sharedCodeAgentRegistry();
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      task: {
        type: "string",
        required: true,
        description: "User message to enqueue on a standard session. Required."
      },
      session_id: {
        type: "string",
        description: "Existing standard session this Computer Use agent started. Omit to create a blank session. Required when following up on the same artifact; forbidden when starting unrelated work."
      },
      cwd: {
        type: "string",
        description: "Workspace directory for a newly created session. Pass a named path or <frontmost_folder>. Omit to create a new subdirectory under this Computer Use session's cwd."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accepted: {
            type: "boolean",
            required: true
          },
          created: {
            type: "boolean",
            required: true
          },
          session_id: {
            type: "string",
            required: true
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.created ? `Started a new standard session ${value.session_id}. ${RUNNING_RESULT} Pass this session_id to continue the same artifact.` : `Queued on standard session ${value.session_id}. ${RUNNING_RESULT}`
      }]
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: "generic",
      title: "Code agent",
      kind: "execute",
      rawInput: {
        task: args.task,
        ...args.session_id === void 0 ? {} : { session_id: args.session_id },
        ...args.cwd === void 0 ? {} : { cwd: args.cwd }
      }
    }),
    async execute(args, exec) {
      const caller = requireAgent(exec);
      const task = args.task.trim();
      if (task === "") throw new Error("code_agent task must include non-whitespace text");
      if (args.session_id !== void 0 && args.session_id.trim() === "") throw new Error("code_agent session_id must be omitted or a non-empty id");
      const delegations = callerDelegations(byCaller, caller.id);
      let sessionId;
      let created = false;
      let cwd;
      if (args.session_id === void 0) {
        const directory = args.cwd !== void 0 ? args.cwd : caller.session.header.cwd === void 0 ? void 0 : uniqueDirectory(caller.session.header.cwd, slugFromTask(task));
        const location = args.cwd === void 0 && directory !== void 0 ? { cwd: directory } : await locationForCreate(ctx, directory);
        sessionId = (await ctx.sessionController.create({
          agentPreset: "standard",
          ...location
        })).sessionId;
        created = true;
        cwd = directory ?? caller.session.header.cwd ?? "";
        const pref = ctx.get("orbCodeAgentModel")?.currentSelection();
        if (pref !== void 0) await selectModelKeepDefault({
          sessionController: ctx.sessionController,
          agentDefaultModel: ctx.get("agentDefaultModel")
        }, {
          sessionId,
          provider: pref.provider,
          model: pref.model,
          ...pref.reasoningEffort === void 0 ? {} : { reasoningEffort: pref.reasoningEffort }
        });
      } else {
        sessionId = brandString(args.session_id);
        if (sessionId === caller.id) throw new Error("code_agent cannot target this Computer Use session");
        const known = delegations.get(sessionId);
        if (known === void 0) throw new Error(`code_agent can continue only a session this Computer Use agent started, not "${sessionId}"`);
        const header = (await ctx.sessionController.inspect(sessionId)).meta;
        if (header.origin === "subagent" || ownedBySubagent(ctx, header)) throw new Error(`code_agent cannot continue subagent session "${sessionId}"`);
        if (header.agentPreset !== "standard") throw new Error(`code_agent can continue only a standard session, not "${header.agentPreset ?? "unknown"}"`);
        if (args.cwd !== void 0 && header.cwd !== void 0 && args.cwd !== header.cwd) throw new Error(`code_agent cwd "${args.cwd}" does not match session "${sessionId}" cwd "${header.cwd}"`);
        cwd = header.cwd ?? known.cwd;
      }
      const agentsBeforePrompt = ctx.get("agents");
      const codeBeforePrompt = agentsBeforePrompt?.get(sessionId);
      if (codeBeforePrompt !== void 0) registerComputerUseBridge({
        agent: codeBeforePrompt,
        ctx,
        parentId: caller.id,
        logger: ctx.logger
      });
      const requestId = brandString(`code-agent-${randomUUID()}`);
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: "queue",
        content: [{
          type: "text",
          text: queuedTaskText(task)
        }]
      }, exec.signal);
      const agents = ctx.get("agents");
      const liveCaller = agents?.get(caller.id);
      const code = agents?.get(sessionId);
      if (liveCaller !== void 0) rememberCaller(liveCaller, caller.id, byCaller, rememberedCallers, registry);
      if (code !== void 0) attachUnattendedCodeAgent(code, unattended);
      if (code !== void 0) registerComputerUseBridge({
        agent: code,
        ctx,
        parentId: caller.id,
        logger: ctx.logger
      });
      let watch;
      if (agents !== void 0 && liveCaller !== void 0 && code !== void 0) watch = watchCodeAgentCompletion({
        caller: liveCaller,
        code,
        agents,
        task,
        sessionId,
        requestId
      });
      recordDelegation(delegations, sessionId, task, cwd, watch);
      registry.record({
        sessionId,
        callerId: caller.id,
        task,
        cwd,
        requestId,
        ...watch === void 0 ? {} : { watch },
        ...code === void 0 ? {} : { agent: code }
      });
      return {
        accepted: true,
        created,
        session_id: sessionId
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: STATUS_TOOL_NAME,
    description: STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: {
            type: "integer",
            required: true
          },
          tasks: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                session_id: {
                  type: "string",
                  required: true
                },
                task: {
                  type: "string",
                  required: true
                },
                cwd: {
                  type: "string",
                  required: true
                },
                status: {
                  type: "string",
                  required: true
                }
              }
            }
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.count === 0 ? "No background Code agent sessions from this Computer Use chat." : value.tasks.map((entry) => `${entry.session_id}: ${entry.status} \u2014 ${entry.task} (${entry.cwd})`).join("\n")
      }]
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({
      card: "generic",
      title: "Code agent status",
      kind: "read"
    }),
    async execute(_args, exec) {
      const caller = requireAgent(exec);
      const agents = ctx.get("agents");
      const tasks = [...byCaller.get(caller.id) ?? []].map(([sessionId, entry]) => ({
        session_id: sessionId,
        task: entry.task,
        cwd: entry.cwd,
        status: agents?.get(sessionId)?.status === "running" ? "running" : "idle"
      }));
      return {
        count: tasks.length,
        tasks
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: STOP_TOOL_NAME,
    description: STOP_DESCRIPTION,
    parameters: { session_id: {
      type: "string",
      required: true,
      description: "Background Code agent session this Computer Use agent started. Required."
    } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accepted: {
            type: "boolean",
            required: true
          },
          session_id: {
            type: "string",
            required: true
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `Stopped background Code agent session ${value.session_id}. The session is idle. Pass this session_id to code_agent to continue the same artifact.`
      }]
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: "generic",
      title: "Stop Code agent",
      kind: "execute",
      rawInput: { session_id: args.session_id }
    }),
    async execute(args, exec) {
      const caller = requireAgent(exec);
      const sessionIdText = args.session_id.trim();
      if (sessionIdText === "") throw new Error("code_agent_stop session_id must be a non-empty id");
      const sessionId = brandString(sessionIdText);
      const known = byCaller.get(caller.id)?.get(sessionId);
      if (known === void 0) throw new Error(`code_agent_stop can stop only a session this Computer Use agent started, not "${sessionId}"`);
      for (const watch of known.watches.splice(0)) watch.abort();
      registry.markStopped(sessionId);
      ctx.get("agents")?.get(sessionId)?.cancel({ kind: "user" });
      return {
        accepted: true,
        session_id: sessionId
      };
    }
  }));
}
export {
  BACKGROUND_ROLE,
  STATUS_TOOL_NAME,
  STOP_TOOL_NAME,
  TOOL_NAME,
  apply,
  inject,
  name,
  queuedTaskText,
  slugFromTask,
  uniqueDirectory
};
