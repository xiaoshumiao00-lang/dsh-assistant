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
function holdsPrompt(code, requestId) {
  return messageHasRpc(code.inbox.nextTurn, requestId) || messageHasRpc(code.inbox.nextStep, requestId);
}
function messageHasRpc(messages, requestId) {
  return messages.some((message) => message.source.kind === "user" && "rpcId" in message.source && message.source.rpcId === requestId);
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
var CODE_AGENT_REGISTRY = "codeAgentRegistry";
var name = "computer-use-code-agent-registry";
var BOOKMARK_OUTCOME_MAX_CHARS = 200;
var shared;
function sharedCodeAgentRegistry() {
  shared ??= createCodeAgentRegistry();
  return shared;
}
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
export {
  BOOKMARK_OUTCOME_MAX_CHARS,
  CODE_AGENT_REGISTRY,
  apply,
  createCodeAgentRegistry,
  name,
  sharedCodeAgentRegistry
};
