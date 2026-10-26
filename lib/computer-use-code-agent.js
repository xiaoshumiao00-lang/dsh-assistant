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
var DESCRIPTION = "Delegate one stretch of file search or file production to a standard-mode Code agent that appears in the desktop sidebar like a user-created session. Do the stretch in this chat when it is visible GUI or when one search or one command will answer or feed the next click. A second search that you expect will hit the point stays here. Do not call this tool for visible GUI work such as opening WeChat or clicking a button in Pages \u2014 use the GUI tools instead. Do not call this tool for a short lookup such as today's weather or current headlines \u2014 use web_search or web_fetch in this chat. Call this tool when you are still digging through files, searches, or commands, or when the user asked for a file, document, spreadsheet, or site. The last step being a click does not keep the investigation here. Omit session_id to create a new blank standard session: write a Word document, make a gobang game, write an HTML research report, or any task that is not a follow-up to a previous code_agent result. Pass session_id with the id returned by an earlier code_agent result when continuing the same artifact, for example making that Word document's font green, or another stretch of the same investigation. Do not pass a previous id when the new work is unrelated. session_id must be a session this Computer Use agent started. task is the stretch to enqueue. The call returns after the standard session accepts the message; it does not wait for that session to finish. Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session. A plugin notice arrives later when that session is idle and this session is idle; then decide again: do remaining GUI, or call code_agent with that session_id for another stretch, and tell the user the short conclusion. Do not recite a long report. Pass cwd when the user named a path or said this folder and <frontmost_folder> is present. Omit cwd to create a new subdirectory under this session's workspace. session_id cannot target this Computer Use session, a subagent child, or a non-standard session.";
var BACKGROUND_ROLE = "You are the background worker for a Computer Use session. You do not see the screen and you do not talk to the user. If this task asks for a file, document, spreadsheet, or site, produce it, reply with its path, and stop. Otherwise search or run commands only until you can answer, including a second search when the first missed the point. Reply in a few sentences with the paths or results that matter, then stop. Do not write a report or create extra files.";
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
