// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync as readdirSync2, realpathSync as realpathSync2 } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname as dirname2, resolve as pathResolve, sep as sep3 } from "node:path";
import { createRequire } from "node:module";

// src/web-routes.ts
function manageWebRoutes(server) {
  const disposers = [];
  const register = (route) => {
    let dispose;
    try {
      dispose = server.register(route);
    } catch (err) {
      const duplicate = /duplicate\s+(?:exact|prefix)\s+route/i.test(String(err?.message ?? err));
      const table = route?.kind === "exact" ? server?.exact : server?.prefixes;
      if (!duplicate || !table || typeof table.has !== "function" || typeof table.delete !== "function" || !table.has(route?.path)) {
        throw err;
      }
      table.delete(route.path);
      dispose = server.register(route);
    }
    if (typeof dispose === "function") disposers.push(dispose);
    return typeof dispose === "function" ? dispose : () => void 0;
  };
  const webServer = new Proxy(server, {
    get(target, property) {
      if (property === "register") return register;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return {
    webServer,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
        }
      }
    }
  };
}

// src/path-guard.ts
import { homedir as homedir4, tmpdir } from "node:os";
import { existsSync as existsSync4, realpathSync, statSync as statSync4 } from "node:fs";
import { dirname, resolve as resolvePath4 } from "node:path";

// src/assistant-home.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync3, renameSync as renameSync2, rmdirSync, statSync as statSync3, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3, resolve as resolvePath3, sep } from "node:path";

// src/assistant-config.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
var EMPTY = {
  newProjectParent: null,
  skillRoot: null,
  asrTerms: [],
  allowedRoots: [],
  allowAllLocalPaths: false,
  persona: null,
  termEnvAllow: [],
  sourceFile: "",
  loadError: ""
};
function assistantConfigCandidates() {
  const out = [];
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? "").trim();
  if (env) out.push(resolvePath(env.replace(/^~(?=$|[\\/])/, homedir())));
  out.push(join(assistantHomeDir(), "config.json"));
  const home = dshHome();
  out.push(join(home, "dsh-assistant-config.json"));
  out.push(join(home, "assistant", "dsh-assistant-config.json"));
  return out;
}
function dshHome() {
  const env = process.env.DSH_HOME;
  const value = env !== void 0 && env.trim().length > 0 ? env : join(homedir(), ".dsh");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolvePath(homedir(), value.slice(2));
  return resolvePath(value);
}
function platformDesktopDir() {
  const names = ["Desktop", "\u684C\u9762"];
  for (const name3 of names) {
    for (const base of [homedir(), process.env.USERPROFILE ?? "", process.env.OneDrive ?? ""]) {
      if (!base) continue;
      const candidate = join(base, name3);
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return resolvePath(candidate);
      } catch {
      }
    }
  }
  return null;
}
function resolveNewProjectParent(cfg = loadAssistantConfig()) {
  const configured = String(cfg.newProjectParent ?? "").trim();
  if (configured) return { parent: resolvePath(configured.replace(/^~(?=$|[\\/])/, homedir())), from: "config" };
  const desktop = platformDesktopDir();
  if (desktop) return { parent: desktop, from: "desktop" };
  return { parent: join(assistantHomeDir(), "projects"), from: "assistant" };
}
function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      const pattern2 = String(item[0] ?? "");
      const replace2 = String(item[1] ?? "");
      if (pattern2 && replace2) out.push({ pattern: pattern2, replace: replace2 });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item;
    const pattern = String(record.pattern ?? "");
    const replace = String(record.replace ?? "");
    if (!pattern || !replace) continue;
    const flags = typeof record.flags === "string" ? record.flags : void 0;
    out.push(flags ? { pattern, replace, flags } : { pattern, replace });
  }
  return out;
}
function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    out.push(resolvePath(text.replace(/^~(?=$|[\\/])/, homedir())));
  }
  return out;
}
function normalizePersona(raw) {
  if (typeof raw === "string") {
    const lines2 = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines2.length ? { lines: lines2 } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw;
  const lines = Array.isArray(record.lines) ? record.lines.map((line) => String(line ?? "")).filter((line) => line.trim() !== "") : [];
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!lines.length && !title) return null;
  return { ...title ? { title } : {}, ...lines.length ? { lines } : {} };
}
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
var cache = null;
function loadAssistantConfig(force = false) {
  const candidates = assistantConfigCandidates();
  const file = candidates.find((path) => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }) ?? "";
  if (!file) {
    cache = null;
    return { ...EMPTY };
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
  }
  if (!force && cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.value;
  let value = { ...EMPTY, sourceFile: file };
  try {
    const raw = JSON.parse(stripBom(readFileSync(file, "utf8")));
    const parsed = raw && typeof raw === "object" ? raw : {};
    const newProjectParent = typeof parsed.newProjectParent === "string" ? parsed.newProjectParent.trim() : "";
    const skillRoot = typeof parsed.skillRoot === "string" ? parsed.skillRoot.trim() : "";
    value = {
      newProjectParent: newProjectParent || null,
      skillRoot: skillRoot || null,
      asrTerms: normalizeRules(parsed.asrTerms),
      allowedRoots: normalizeRoots(parsed.allowedRoots ?? parsed.extraRoots),
      allowAllLocalPaths: parsed.allowAllLocalPaths === true,
      persona: normalizePersona(parsed.persona ?? parsed.personaLines),
      termEnvAllow: Array.isArray(parsed.termEnvAllow) ? parsed.termEnvAllow.map((name3) => String(name3 ?? "").trim()).filter(Boolean) : [],
      sourceFile: file,
      loadError: ""
    };
  } catch (err) {
    value = { ...EMPTY, sourceFile: file, loadError: String(err?.message ?? err) };
  }
  cache = { file, mtimeMs, value };
  return value;
}
function resetAssistantConfigCacheForTests() {
  cache = null;
}
function assistantConfigClientView() {
  const cfg = loadAssistantConfig();
  const resolved = resolveNewProjectParent(cfg);
  const persona = cfg.persona;
  return {
    ok: true,
    newProjectParent: resolved.parent,
    newProjectParentSource: resolved.from,
    skillRoot: cfg.skillRoot || join(dshHome(), "skills"),
    assistantHome: assistantHomeDir(),
    asrTerms: cfg.asrTerms,
    persona: persona ? { title: persona.title ?? "\u672C\u673A\u4EBA\u8BBE", lines: persona.lines ?? [] } : null,
    configError: cfg.loadError || void 0
  };
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  } catch {
  }
}
function registerAssistantConfigRoutes(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  routes.webServer.register({
    kind: "exact",
    path: "/api/assistant/config",
    handler: (req, res) => {
      try {
        sendJson(res, 200, assistantConfigClientView());
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }
  });
  return routes.dispose;
}
var assistantConfigTestSurface = {
  assistantConfigCandidates,
  loadAssistantConfig,
  resolveNewProjectParent,
  assistantConfigClientView,
  resetAssistantConfigCacheForTests,
  platformDesktopDir,
  dshHome
};

// src/assistant-memory.ts
import { copyFileSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, statSync as statSync2, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2, resolve as resolvePath2 } from "node:path";
var MEMORY_ENTRY_SEPARATOR = "\xA7";
function runtimeMemoryDir() {
  const override = String(process.env.MNEMON_DATA_DIR ?? "").trim();
  if (override !== "") return override.replace(/^~(?=$|[\\/])/, homedir2());
  return join2(homedir2(), ".mnemon", "runtime");
}
function readText(path, limit = 400 * 1024) {
  try {
    if (!existsSync2(path) || !statSync2(path).isFile()) return "";
    if (statSync2(path).size > limit) return "";
    return readFileSync2(path, "utf8");
  } catch {
    return "";
  }
}
function backupPath(path, stamp) {
  return `${path}.dsh-assistant-backup-${stamp}`;
}
function splitEntries(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let current = [];
  const flush = () => {
    const content = current.join("\n").replace(/^[ \t]*\r?\n+/, "").replace(/\s+$/, "");
    if (content.trim()) out.push({ content, index: out.length });
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === MEMORY_ENTRY_SEPARATOR) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}
function joinEntries(entries) {
  return entries.map((entry) => entry.content).join(`
${MEMORY_ENTRY_SEPARATOR}
`);
}
function writeAtomic(path, text) {
  try {
    mkdirSync(resolvePath2(path, ".."), { recursive: true });
  } catch {
  }
  const tmp = `${path}.dsh-assistant-tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
function targetOf(item) {
  return String(item?.target ?? "memory");
}
function contentOf(item) {
  return String(item?.content ?? "");
}
function readStore(dir) {
  const path = join2(dir, "memories.json");
  const raw = readText(path);
  if (!raw) return { data: null, path };
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return { data: null, path };
    return { data: parsed, path };
  } catch {
    return { data: null, path };
  }
}
function targetView(target, dir, storeEntries) {
  const projection = join2(dir, target === "user" ? "USER.md" : "MEMORY.md");
  const text = readText(projection);
  const entries = splitEntries(text);
  for (const entry of entries) {
    const record = storeEntries.find((item) => contentOf(item).trim() === entry.content.trim());
    if (!record) continue;
    if (typeof record.importance === "string") entry.importance = record.importance;
    if (typeof record.created_at === "string") entry.created_at = record.created_at;
    if (typeof record.updated_at === "string") entry.updated_at = record.updated_at;
    if (Array.isArray(record.branches)) entry.branches = record.branches.map((name3) => String(name3));
  }
  let bytes = 0;
  try {
    bytes = existsSync2(projection) ? statSync2(projection).size : 0;
  } catch {
  }
  return { target, projection, text, entries, bytes };
}
function readRuntimeMemory() {
  const dir = runtimeMemoryDir();
  const store = readStore(dir);
  const entries = store.data ? store.data.entries : [];
  return {
    ok: true,
    dir,
    store: store.path,
    writable: !!store.data,
    totalEntries: entries.length,
    targets: ["user", "memory"].map((target) => targetView(target, dir, entries)),
    note: store.data ? "" : "\u8BFB\u4E0D\u5230 memories.json\uFF08\u6CA1\u88C5 dsh-mnemon\uFF0C\u6216\u5B83\u7528\u4E86\u522B\u7684\u5B58\u50A8\u5E03\u5C40\uFF09\uFF1A\u5220\u9664\u529F\u80FD\u4E0D\u53EF\u7528\uFF0C\u53EA\u80FD\u67E5\u770B\u4E0E\u5BFC\u51FA\u3002"
  };
}
function deleteRuntimeMemoryEntry(target, content, mode = "exact") {
  const wanted = String(content ?? "").trim();
  if (!wanted) return { ok: false, error: "empty-content" };
  const dir = runtimeMemoryDir();
  const store = readStore(dir);
  if (!store.data) return { ok: false, error: "store-unavailable" };
  const entries = store.data.entries;
  const matches = entries.filter((item) => {
    if (targetOf(item) !== target) return false;
    const text = contentOf(item);
    return mode === "exact" ? text.trim() === wanted : text.includes(wanted);
  });
  if (matches.length === 0) return { ok: false, error: "no-match" };
  const matched = new Set(matches.map((item) => contentOf(item).trim()));
  const stamp = Date.now();
  const backups = [];
  try {
    copyFileSync(store.path, backupPath(store.path, stamp));
    backups.push(backupPath(store.path, stamp));
    writeAtomic(
      store.path,
      JSON.stringify({ ...store.data, entries: entries.filter((item) => !matched.has(contentOf(item).trim())) }, null, 2)
    );
  } catch (err) {
    return { ok: false, error: `write-failed: ${String(err?.message ?? err)}` };
  }
  let projectionRemoved = 0;
  try {
    const view = targetView(target, dir, []);
    if (view.text) {
      const keep = view.entries.filter((entry) => !(mode === "exact" ? matched.has(entry.content.trim()) : entry.content.includes(wanted)));
      if (keep.length !== view.entries.length) {
        copyFileSync(view.projection, backupPath(view.projection, stamp));
        backups.push(backupPath(view.projection, stamp));
        writeAtomic(view.projection, keep.length ? joinEntries(keep) + "\n" : "");
        projectionRemoved = view.entries.length - keep.length;
      }
    }
  } catch (err) {
    return { ok: false, error: `projection-write-failed: ${String(err?.message ?? err)}` };
  }
  return { ok: true, storeRemoved: matches.length, projectionRemoved, backups, restartRequired: true };
}
var assistantMemoryTestSurface = {
  runtimeMemoryDir,
  splitEntries,
  joinEntries,
  readRuntimeMemory,
  deleteRuntimeMemoryEntry,
  clearRuntimeMemory,
  MEMORY_ENTRY_SEPARATOR
};
function clearRuntimeMemory(target) {
  const dir = runtimeMemoryDir();
  const store = readStore(dir);
  if (!store.data) return { ok: false, error: "store-unavailable" };
  const entries = store.data.entries;
  const removed = entries.filter((item) => targetOf(item) === target);
  if (removed.length === 0) return { ok: false, error: "no-match" };
  const stamp = Date.now();
  const backups = [];
  try {
    copyFileSync(store.path, backupPath(store.path, stamp));
    backups.push(backupPath(store.path, stamp));
    writeAtomic(store.path, JSON.stringify({ ...store.data, entries: entries.filter((item) => targetOf(item) !== target) }, null, 2));
  } catch {
    return { ok: false, error: "backup-or-write-failed" };
  }
  let projectionRemoved = 0;
  try {
    const view = targetView(target, dir, []);
    if (existsSync2(view.projection)) {
      copyFileSync(view.projection, backupPath(view.projection, stamp));
      backups.push(backupPath(view.projection, stamp));
      writeAtomic(view.projection, "");
      projectionRemoved = view.entries.length;
    }
  } catch {
  }
  return { ok: true, storeRemoved: removed.length, projectionRemoved, backups, restartRequired: true };
}

// src/assistant-home.ts
var AGENTS_MARKER = "<!-- dsh-assistant:assistant-home v1 -->";
var HOME_RULES_MARKER = "<!-- dsh-assistant:home-rules v2 -->";
var PERSONA_BEGIN = "<!-- dsh-assistant:persona v1 begin -->";
var PERSONA_END = "<!-- dsh-assistant:persona v1 end -->";
var OUTPUTS_RETENTION_DAYS = 14;
var JOURNAL_ARCHIVE_AFTER_DAYS = 90;
var JOURNAL_MAX_FILES = 180;
var NOTE_TOTAL_BYTES_LIMIT = 8 * 1024 * 1024;
var ARCHIVE_SOFT_BYTES_LIMIT = 32 * 1024 * 1024;
var TIDY_INTERVAL_MS = 6 * 60 * 60 * 1e3;
var HOME_RULES_MD = `${HOME_RULES_MARKER}
## \u5BB6\u76EE\u5F55\u89C4\u77E9\uFF08\u4EA7\u7269\u522B\u5806\u5728\u8FD9\u91CC\uFF09
\u8FD9\u91CC\u662F\u300C\u4F4F\u7684\u5730\u65B9\u300D\uFF0C\u4E0D\u662F\u300C\u5E72\u6D3B\u7684\u684C\u5B50\u300D\uFF1A
- \u957F\u671F\u6587\u4EF6\u53EA\u653E\u4E09\u6837\uFF1A\`AGENTS.md\`\u3001\`journal/\`\uFF08\u6309\u5929\u65E5\u5FD7\uFF09\u3001\`notes/\`\uFF08\u957F\u671F\u6863\u6848\uFF09\u3002
- \u4E34\u65F6\u4EA7\u7269\uFF08\u811A\u672C\u3001\u622A\u56FE\u3001\u5BFC\u51FA\u3001\u4E2D\u95F4\u7ED3\u679C\uFF09\u4E00\u5F8B\u5199\u5230 \`outputs/YYYY-MM-DD/\`\uFF0C\u6216\u76F4\u63A5\u5199\u7CFB\u7EDF\u4E34\u65F6\u76EE\u5F55\uFF1B
  \`outputs/\` \u91CC\u8D85\u8FC7 ${OUTPUTS_RETENTION_DAYS} \u5929\u7684\u4E1C\u897F\u4F1A\u88AB\u63D2\u4EF6\u81EA\u52A8\u6E05\u6389\uFF0C\u522B\u628A\u8981\u7559\u7684\u4E1C\u897F\u653E\u8FD9\u3002
- \u8981\u957F\u671F\u4FDD\u7559\u3001\u8981\u4EA4\u4ED8\u3001\u8981\u591A\u8F6E\u8FED\u4EE3\u7684\u4EA7\u7269 \u2192 \u5EFA\u9879\u76EE\u5361\u7247\uFF0C\u4EA7\u7269\u843D\u5728\u90A3\u4E2A\u9879\u76EE\u7684\u6587\u4EF6\u5939\u91CC\u3002
- \u5199\u6587\u4EF6\u524D\u5148\u95EE\u81EA\u5DF1\u4E00\u53E5\uFF1A\u8FD9\u6587\u4EF6\u4E09\u5929\u540E\u8FD8\u6709\u7528\u5417\uFF1F\u6CA1\u7528 \u2192 outputs\uFF1B\u6709\u7528 \u2192 \u5EFA\u5361\u3002
`;
var ARCHIVE_RULES_MARKER = "<!-- dsh-assistant:home-rules v3 -->";
var ARCHIVE_RULES_MD = `${ARCHIVE_RULES_MARKER}
## \u5F52\u6863\u89C4\u77E9\uFF08journal / notes \u6709\u5BB9\u91CF\u4E0A\u9650\uFF09
- \`journal/\` \u53EA\u7559\u6700\u8FD1 ${JOURNAL_ARCHIVE_AFTER_DAYS} \u5929\u7684\u65E5\u5FD7\uFF1B\u66F4\u65E9\u7684\u6309\u5E74\u6574\u4EFD\u642C\u8FDB \`archive/journal/<\u5E74>/\`\u3002
- \`notes/\` \u603B\u4F53\u79EF\u4E0A\u9650 ${Math.round(NOTE_TOTAL_BYTES_LIMIT / 1024 / 1024)}MB\uFF1B\u8D85\u4E86\u5C31\u6309\u6700\u65E7\u7684\u6574\u4EFD\u642C\u8FDB \`archive/notes/\`\u3002
- \u642C\u8D70\u7684\u4E1C\u897F\u63D2\u4EF6**\u4E0D\u4F1A\u5220**\uFF0C\u90FD\u5728 \`archive/\` \u91CC\u770B\u5F97\u89C1\uFF1B\u8981\u771F\u7684\u5220\u5F97\u81EA\u5DF1\u5728\u9762\u677F\u4E0A\u52A8\u624B\u3002
- \`outputs/\` \u624D\u4F1A\u88AB\u81EA\u52A8\u5220\uFF08\u8D85\u8FC7 ${OUTPUTS_RETENTION_DAYS} \u5929\uFF09\u3002
`;
var AGENTS_MD = `${AGENTS_MARKER}
# \u79C1\u4EBA\u52A9\u624B

\u4F60\u662F\u8FD9\u4E2A\u52A9\u624B\u76EE\u5F55\u4E3B\u4EBA\u7684\u79C1\u4EBA\u52A9\u624B\uFF1A\u4E0D\u662F\u4EFB\u52A1\u542F\u52A8\u5668\uFF0C\u4E5F\u4E0D\u662F\u901A\u7528\u5BA2\u670D\u3002\u4F60\u4F4F\u5728\u8FD9\u4E2A\u76EE\u5F55\u91CC\uFF0C
\u957F\u671F\u8BB0\u5F97\u4E3B\u4EBA\u505A\u8FC7\u4EC0\u4E48\u3001\u600E\u4E48\u505A\u4E8B\u3001\u8981\u4EC0\u4E48\u6807\u51C6\u3002

## \u5F00\u53E3\u524D\u5148\u770B\u8BB0\u5FC6
1. \u70ED\u8BB0\u5FC6\u6BCF\u8F6E\u5DF2\u7ECF\u6CE8\u5165\uFF1A\`USER.md\` = \u4ED6\u662F\u8C01\u3001\u504F\u597D\u3001\u96F7\u533A\uFF1B\`MEMORY.md\` = \u9879\u76EE\u4E0E\u73AF\u5883\u7684\u786C\u4E8B\u5B9E\u3002
   \u6309\u5B83\u4EEC\u529E\u4E8B\uFF0C\u5DF2\u7ECF\u8BB0\u4E0B\u7684\u4E0D\u8981\u91CD\u590D\u95EE\u3002
2. \u9700\u8981\u66F4\u65E9\u7684\u7EC6\u8282\uFF1A\u7528 \`mnemon_recall\` \u67E5\u8BB0\u5FC6\u3001\`mnemon_document_search\` \u67E5\u9879\u76EE\u6863\u6848\u3002
   \u8981\u7FFB\u67D0\u6B21\u65E7\u4F1A\u8BDD\u7684\u539F\u6587\uFF0C\u5C31\u95EE\u4ED6\u8981\u6216\u8BA9\u4ED6\u6253\u5F00\u90A3\u6761\u4F1A\u8BDD\u2014\u2014\u4E0D\u8981\u51ED\u7A7A\u731C\u3002
3. \u4E0D\u786E\u5B9A\u7684\u4E8B\u5B9E\u4E0D\u8981\u7F16\u3002\u4E0D\u786E\u5B9A\u65F6\u53EA\u95EE\u4E00\u4E2A\u95EE\u9898\uFF0C\u4E0D\u8981\u8FDE\u95EE\u4E00\u4E32\u3002

## \u76F4\u63A5\u505A\uFF0C\u8FD8\u662F\u5EFA\u9879\u76EE\u5361\u7247
\u9ED8\u8BA4**\u76F4\u63A5\u505A**\uFF1A\u4E00\u53E5\u8BDD\u80FD\u7B54\u3001\u4E00\u6B21\u5DE5\u5177\u8C03\u7528\u80FD\u5B8C\u6210\u3001\u4E0D\u9700\u8981\u591A\u8F6E\u4EA7\u51FA\u7269\u3001\u4E0D\u8DE8\u5929\u7684\u4E8B\u3002
\u5EFA\u8BAE**\u5EFA\u5361**\u7684\u60C5\u5F62\uFF1A\u8981\u4EA7\u51FA\u6587\u4EF6/\u4EE3\u7801/\u8BBA\u6587\u7EA7\u4EA4\u4ED8\u7269\u3001\u8981\u591A\u8F6E\u8FED\u4EE3\u3001\u8981\u540E\u53F0\u8DD1\u5F88\u4E45\u3001\u8981\u5E76\u884C\u63A8\u8FDB\u3001
\u8981\u7ED9\u522B\u4EBA\u770B\u8FDB\u5EA6\u3002
- \u5EFA\u5361\u65F6\u8BF4\u660E\u7406\u7531\uFF0C\u5E76\u7ED9\u51FA\u9879\u76EE\u540D + \u76EE\u5F55\u5EFA\u8BAE\uFF0C\u7B49\u4ED6\u5728\u63A7\u5236\u5BA4\u70B9\u300C\u6DFB\u52A0\u9879\u76EE\u300D\u518D\u5F00\u5DE5
  \uFF08\u7B2C\u4E8C\u6B65\u4F1A\u505A\u6210\u4F60\u76F4\u63A5\u5EFA\u5361\uFF0C\u73B0\u5728\u5148\u522B\u81EA\u5DF1\u7CCA\u4E00\u4E2A\u76EE\u5F55\uFF09\u3002
- \u5224\u65AD\u4E0D\u4E86\u5C31\u95EE\u4E00\u53E5\uFF0C\u4E0D\u8981\u9ED8\u9ED8\u628A\u5C0F\u4E8B\u505A\u6210\u5927\u5DE5\u7A0B\uFF0C\u4E5F\u4E0D\u8981\u628A\u5927\u6D3B\u786C\u585E\u8FDB\u4E00\u53E5\u8BDD\u7684\u5BF9\u8BDD\u91CC\u3002

## \u8BB0\u5FC6\u600E\u4E48\u5199\uFF08\u8FD9\u662F\u300C\u8D8A\u7528\u8D8A\u61C2\u4ED6\u300D\u7684\u5168\u90E8\uFF09
- **\u6536\u5DE5**\uFF08\u4ED6\u8BF4\u300C\u6536\u5DE5 / \u4ECA\u5929\u5230\u8FD9 / \u603B\u7ED3\u4E00\u4E0B\u300D\uFF09\uFF1A\u628A\u8FD9\u4E00\u8F6E\u505A\u4E86\u4EC0\u4E48\u3001\u7ED3\u8BBA\u3001\u5F85\u529E\uFF0C
  \u4E00\u884C\u4E00\u6761\u8FFD\u52A0\u5230 \`journal/YYYY-MM-DD.md\`\uFF1B\u65B0\u51FA\u73B0\u7684\u7A33\u5B9A\u4E8B\u5B9E\u5199\u8FDB \`MEMORY.md\`
  \uFF08\u540C\u4E00\u4EF6\u4E8B\u7528 replace \u8986\u76D6\u65E7\u6761\u76EE\uFF0C\u4E0D\u8981\u65B0\u65E7\u5E76\u5B58\u3001\u4E0D\u8981\u5806\u91CD\u590D\uFF09\u3002
- **\u4ED6\u7EA0\u6B63\u4F60**\uFF08\u300C\u4E0D\u5BF9 / \u4E0D\u662F\u8FD9\u6837 / \u8BB0\u4F4F\u300D\uFF09\uFF1A\u7ACB\u523B\u6539\u8BB0\u5FC6\uFF0C\u5E76\u56DE\u4E00\u53E5\u300C\u5DF2\u6539\uFF1A\u4ECE X \u6539\u6210 Y\u300D\u3002
  \u65E7\u7ED3\u8BBA\u8981\u5220\u6389\u6216\u6807\u5E9F\u5F03\u3002
- \u53EA\u8BB0\u80FD\u957F\u671F\u590D\u7528\u7684\u4E8B\u5B9E\u3001\u504F\u597D\u3001\u51B3\u7B56\u3001\u7ED3\u8BBA\u3002\u4E0D\u8BB0\u5BD2\u6684\u3001\u4E34\u65F6\u8FDB\u5EA6\u3001\u4E00\u6B21\u6027\u7684\u4E2D\u95F4\u7ED3\u679C\u3002
- \u4ED6\u95EE\u300C\u4F60\u8BB0\u5F97\u6211\u4EC0\u4E48\u300D\uFF1A\u5206\u6761\u5217\u51FA \`USER.md\` \u4E0E \`MEMORY.md\` \u7684\u8981\u70B9\uFF0C\u5E76\u6807\u51FA\u6700\u8FD1\u6539\u52A8\u7684\u51E0\u6761\u3002

## \u8BED\u6C14
- \u4E2D\u6587\uFF0C\u76F4\u63A5\u7B80\u6D01\uFF1B\u9996\u53E5\u5E26\u72B6\u6001\u56FE\u6807\uFF1A\u2705 \u5B8C\u6210 / \u26A0\uFE0F \u6CE8\u610F / \u2757 \u98CE\u9669 / \u{1F6A7} \u8FDB\u884C\u4E2D / \u{1F4A1} \u5EFA\u8BAE\u3002
- \u975E\u5FC5\u8981\u5C11\u8D34\u4EE3\u7801\u5757\u3001\u957F\u8DEF\u5F84\u3001\u5927\u6BB5\u62A5\u544A\uFF1B\u8981\u5B8C\u6574\u8868\u683C\u4E0E\u89C4\u683C\u65F6\uFF08\u8BBA\u6587\u3001\u56FE\u8868\u3001Word/Excel\uFF09\u6309\u5B66\u672F\u4EA4\u4ED8\u505A\u3002
- \u62A5\u9519\u5148\u67E5\u6839\u56E0\u518D\u7ED9\u65B9\u6848\uFF1B\u5F02\u5E38\u5148\u5B9A\u4F4D\u518D\u52A8\u624B\u3002

## \u8FB9\u754C
- \u5220\u9664\u3001\u8986\u76D6\u3001\u5BF9\u5916\u53D1\u9001\u3001\u82B1\u94B1\u3001\u63D0\u4EA4\u5230\u8FDC\u7AEF\u4E4B\u524D\u5148\u95EE\u4ED6\u3002
- \u4E0D\u628A\u79C1\u4EBA\u4FE1\u606F\u5199\u8FDB\u5BF9\u5916\u6587\u6863\uFF1B\u4E0D\u5728\u4ED6\u6CA1\u8981\u6C42\u65F6\u64C5\u81EA\u6539\u9879\u76EE\u91CC\u7684\u6587\u4EF6\u3002
- \u6743\u9650\u6309\u9700\uFF1A\u65E5\u5E38\u8BFB\u5199\u8DB3\u591F\uFF0C\u4E0D\u8981\u968F\u624B\u5F00\u6700\u9AD8\u6743\u9650\u3002
`;
function assistantHomeDir() {
  const override = String(process.env.DSH_ASSISTANT_HOME ?? "").trim();
  return override !== "" ? override : join3(homedir3(), ".dsh", "assistant");
}
function personaBlockFromConfig() {
  let persona = null;
  try {
    persona = loadAssistantConfig().persona;
  } catch {
    return "";
  }
  const title = String(persona?.title ?? "").trim();
  const lines = (persona?.lines ?? []).map((line) => String(line ?? "").trim()).filter(Boolean);
  if (!title && lines.length === 0) return "";
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- \uFF08\u914D\u7F6E\u6587\u4EF6\u91CC persona.lines \u4E3A\u7A7A\uFF09";
  return [
    "",
    PERSONA_BEGIN,
    "## \u672C\u673A\u4EBA\u8BBE\uFF08\u6765\u81EA ~/.dsh/assistant/config.json\uFF0C\u63D2\u4EF6\u6258\u7BA1\u8FD9\u6BB5\uFF09",
    title,
    body,
    "\uFF08USER.md / MEMORY.md \u662F\u6BCF\u8F6E\u81EA\u52A8\u6CE8\u5165\u7684\u70ED\u8BB0\u5FC6\uFF1B\u8FD9\u6BB5\u53EA\u7ED9 AGENTS.md \u4E00\u4E2A\u56FA\u5B9A\u7684\u81EA\u6211\u4ECB\u7ECD\u3002\uFF09",
    PERSONA_END,
    ""
  ].filter((line) => line !== "").join("\n");
}
function ensureAssistantHome() {
  const dir = assistantHomeDir();
  const journal = join3(dir, "journal");
  const notes = join3(dir, "notes");
  const outputs = join3(dir, "outputs");
  const archive = join3(dir, "archive");
  const agentsFile = join3(dir, "AGENTS.md");
  for (const path of [dir, journal, notes, outputs, archive]) {
    try {
      mkdirSync2(path, { recursive: true });
    } catch {
    }
  }
  try {
    const persona = personaBlockFromConfig();
    if (!existsSync3(agentsFile)) {
      writeFileSync2(agentsFile, AGENTS_MD + HOME_RULES_MD + ARCHIVE_RULES_MD + persona, "utf8");
    } else {
      let current = readFileSync3(agentsFile, "utf8");
      let changed = false;
      if (current.includes(AGENTS_MARKER) && !current.includes(HOME_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + HOME_RULES_MD;
        changed = true;
      }
      if (current.includes(AGENTS_MARKER) && !current.includes(ARCHIVE_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + ARCHIVE_RULES_MD;
        changed = true;
      }
      if (persona && !current.includes(PERSONA_BEGIN) && current.includes("\u4F60\u662F\u8FD9\u4E2A\u52A9\u624B\u76EE\u5F55\u4E3B\u4EBA\u7684\u79C1\u4EBA\u52A9\u624B")) {
        current = current.replace(/\s*$/, "\n\n") + persona;
        changed = true;
      }
      if (changed) writeFileSync2(agentsFile, current, "utf8");
    }
  } catch {
  }
  return { dir, journal, notes, agentsFile, outputs, archive };
}
function dirUsage(root) {
  let bytes = 0;
  let files = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join3(root, entry.name);
      if (entry.isDirectory()) {
        const nested = dirUsage(path);
        bytes += nested.bytes;
        files += nested.files;
      } else if (entry.isFile()) {
        try {
          bytes += statSync3(path).size;
          files += 1;
        } catch {
        }
      }
    }
  } catch {
  }
  return { bytes, files };
}
function assistantHomeUsage() {
  const dir = assistantHomeDir();
  const journal = dirUsage(join3(dir, "journal"));
  const notes = dirUsage(join3(dir, "notes"));
  const outputs = dirUsage(join3(dir, "outputs"));
  const archive = dirUsage(join3(dir, "archive"));
  let agents = 0;
  try {
    agents = statSync3(join3(dir, "AGENTS.md")).size;
  } catch {
  }
  return {
    totalBytes: agents + journal.bytes + notes.bytes + outputs.bytes + archive.bytes,
    totalFiles: journal.files + notes.files + outputs.files + archive.files,
    journalBytes: journal.bytes,
    notesBytes: notes.bytes,
    outputsBytes: outputs.bytes,
    journalFiles: journal.files,
    notesFiles: notes.files,
    outputsFiles: outputs.files,
    archiveFiles: archive.files,
    archiveBytes: archive.bytes,
    limits: {
      outputsRetentionDays: OUTPUTS_RETENTION_DAYS,
      journalArchiveAfterDays: JOURNAL_ARCHIVE_AFTER_DAYS,
      journalMaxFiles: JOURNAL_MAX_FILES,
      noteTotalBytesLimit: NOTE_TOTAL_BYTES_LIMIT,
      archiveSoftBytesLimit: ARCHIVE_SOFT_BYTES_LIMIT
    },
    capsReached: {
      journalOverMax: journal.files > JOURNAL_MAX_FILES,
      notesOverBytes: notes.bytes > NOTE_TOTAL_BYTES_LIMIT,
      archiveOverSoft: archive.bytes > ARCHIVE_SOFT_BYTES_LIMIT
    }
  };
}
function tidyAssistantHome(now = Date.now(), retentionDays = OUTPUTS_RETENTION_DAYS) {
  const root = resolvePath3(join3(assistantHomeDir(), "outputs"));
  const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1e3;
  let removed = 0;
  let freedBytes = 0;
  const sweep = (dir) => {
    let empty = true;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join3(dir, entry.name);
      const real = resolvePath3(path);
      if (real !== root && !real.startsWith(root + sep)) continue;
      if (entry.isDirectory()) {
        const childEmpty = sweep(real);
        if (childEmpty) {
          try {
            rmdirSync(real);
          } catch {
            empty = false;
          }
        } else empty = false;
        continue;
      }
      if (!entry.isFile()) continue;
      empty = false;
      try {
        const info = statSync3(real);
        if (info.mtimeMs >= cutoff) continue;
        unlinkSync(real);
        removed += 1;
        freedBytes += info.size;
      } catch {
      }
    }
    return empty;
  };
  try {
    if (!statSync3(root).isDirectory()) return { removed: 0, freedBytes: 0, outputsBytes: 0 };
  } catch {
    return { removed: 0, freedBytes: 0, outputsBytes: 0 };
  }
  sweep(root);
  return { removed, freedBytes, outputsBytes: dirUsage(root).bytes };
}
function listFiles(dir, depth = 4) {
  const out = [];
  const walk = (current, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join3(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = statSync3(path);
        out.push({ name: entry.name, path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
      }
    }
  };
  walk(dir, 1);
  return out;
}
function moveToArchive(file, archiveRoot, homeRoot, sub) {
  const real = resolvePath3(file.path);
  if (!real.startsWith(homeRoot + sep)) return false;
  const targetDir = join3(archiveRoot, ...sub);
  try {
    mkdirSync2(targetDir, { recursive: true });
  } catch {
    return false;
  }
  const target = join3(targetDir, file.name);
  if (existsSync3(target)) return false;
  try {
    renameSync2(real, target);
    return true;
  } catch {
  }
  try {
    copyFileSync2(real, target);
    unlinkSync(real);
    return true;
  } catch {
    return false;
  }
}
function rotateAssistantHome(now = Date.now()) {
  const dir = assistantHomeDir();
  const journalDir = join3(dir, "journal");
  const notesDir = join3(dir, "notes");
  const archiveDir = join3(dir, "archive");
  const report = {
    journalArchived: 0,
    notesArchived: 0,
    movedBytes: 0,
    archiveSoftLimitReached: false,
    archiveBytes: 0
  };
  const dayMs = 24 * 60 * 60 * 1e3;
  const journalFiles = listFiles(journalDir);
  const dated = journalFiles.map((file) => ({ file, date: file.name.match(/^(\d{4})-(\d{2})-(\d{2})/)?.[0] ?? "" })).filter((item) => item.date !== "");
  const cutoff = now - JOURNAL_ARCHIVE_AFTER_DAYS * dayMs;
  for (const item of dated) {
    const stamp = Date.parse(`${item.date}T23:59:59`);
    if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
    const year = item.date.slice(0, 4);
    if (moveToArchive(item.file, archiveDir, dir, ["journal", year])) {
      report.journalArchived += 1;
      report.movedBytes += item.file.size;
    }
  }
  const remaining = listFiles(journalDir);
  if (remaining.length > JOURNAL_MAX_FILES) {
    const overflow = remaining.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, remaining.length - JOURNAL_MAX_FILES);
    for (const file of overflow) {
      if (moveToArchive(file, archiveDir, dir, ["journal", "overflow"])) {
        report.journalArchived += 1;
        report.movedBytes += file.size;
      }
    }
  }
  let notesBytes = listFiles(notesDir).reduce((sum, file) => sum + file.size, 0);
  if (notesBytes > NOTE_TOTAL_BYTES_LIMIT) {
    const oldest = listFiles(notesDir).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of oldest) {
      if (notesBytes <= NOTE_TOTAL_BYTES_LIMIT) break;
      if (moveToArchive(file, archiveDir, dir, ["notes"])) {
        report.notesArchived += 1;
        report.movedBytes += file.size;
        notesBytes -= file.size;
      }
    }
  }
  const archive = dirUsage(archiveDir);
  report.archiveBytes = archive.bytes;
  report.archiveSoftLimitReached = archive.bytes > ARCHIVE_SOFT_BYTES_LIMIT;
  return report;
}
function assistantHomeFiles(limitPerArea = 200) {
  const dir = assistantHomeDir();
  const out = {};
  for (const area of ["journal", "notes", "outputs", "archive"]) {
    const files = listFiles(join3(dir, area)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limitPerArea).map((file) => ({ name: file.name, path: file.path, bytes: file.size, mtimeMs: file.mtimeMs, area }));
    out[area] = files;
  }
  return out;
}
function readTextIfExists(path, limit = 200 * 1024) {
  try {
    if (!existsSync3(path)) return "";
    if (statSync3(path).size > limit) return "";
    return readFileSync3(path, "utf8");
  } catch {
    return "";
  }
}
function sendJson2(res, status, body) {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  } catch {
  }
}
function readJsonBody(req, limitBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > limitBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) raw += String(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return resolve({ __tooLarge: true });
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
function registerAssistantHome(ctx) {
  const home = ensureAssistantHome();
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  webServer.register({
    kind: "exact",
    path: "/api/assistant/home",
    handler: (_req, res) => {
      const current = ensureAssistantHome();
      sendJson2(res, 200, {
        ok: true,
        dir: current.dir,
        journal: current.journal,
        notes: current.notes,
        outputs: current.outputs,
        archive: current.archive,
        hasAgents: existsSync3(current.agentsFile),
        marker: AGENTS_MARKER,
        usage: assistantHomeUsage(),
        files: assistantHomeFiles(),
        retentionDays: OUTPUTS_RETENTION_DAYS
      });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/memory",
    handler: (_req, res) => {
      const view = readRuntimeMemory();
      const runtime = view.dir;
      const dshHome3 = process.env.DSH_HOME || join3(homedir3(), ".dsh");
      const pick = (name3) => (
        // 老版本 / 没装 mnemon：退回 $DSH_HOME 里的那份投影
        readTextIfExists(join3(runtime, name3)) || readTextIfExists(join3(dshHome3, name3))
      );
      const user = view.targets.find((target) => target.target === "user");
      const memory = view.targets.find((target) => target.target === "memory");
      sendJson2(res, 200, {
        ...view,
        dir: home.dir,
        memoryDir: runtime,
        user: user?.text ?? pick("USER.md"),
        memory: memory?.text ?? pick("MEMORY.md"),
        agents: readTextIfExists(join3(home.dir, "AGENTS.md"))
      });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/memory-entry-delete",
    handler: (req, res) => {
      if (String(req.method ?? "GET").toUpperCase() !== "POST") {
        sendJson2(res, 405, { ok: false, error: "method" });
        return;
      }
      void readJsonBody(req, 128 * 1024).then((body) => {
        if (body?.__tooLarge) {
          sendJson2(res, 413, { ok: false, error: "body-too-large" });
          return;
        }
        const target = body?.target === "user" || body?.target === "memory" ? body.target : null;
        const content = String(body?.content ?? "");
        if (!target) {
          sendJson2(res, 400, { ok: false, error: "need-target" });
          return;
        }
        if (!content.trim()) {
          sendJson2(res, 400, { ok: false, error: "need-content" });
          return;
        }
        const mode = body?.mode === "contains" ? "contains" : "exact";
        const result = deleteRuntimeMemoryEntry(target, content, mode);
        sendJson2(res, result.ok ? 200 : 409, { ...result, restartRequired: true });
      });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/memory-clear",
    handler: (req, res) => {
      if (String(req.method ?? "GET").toUpperCase() !== "POST") {
        sendJson2(res, 405, { ok: false, error: "method" });
        return;
      }
      void readJsonBody(req, 128 * 1024).then((body) => {
        if (body?.__tooLarge) {
          sendJson2(res, 413, { ok: false, error: "body-too-large" });
          return;
        }
        const target = body?.target === "user" || body?.target === "memory" ? body.target : null;
        if (!target) {
          sendJson2(res, 400, { ok: false, error: "need-target" });
          return;
        }
        if (String(body?.confirm ?? "") !== "DELETE-ALL") {
          sendJson2(res, 400, { ok: false, error: "need-confirmation" });
          return;
        }
        const result = clearRuntimeMemory(target);
        sendJson2(res, result.ok ? 200 : 409, { ...result, restartRequired: true });
      });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/tidy",
    handler: (req, res) => {
      const method = String(req.method ?? "GET").toUpperCase();
      if (method !== "POST") {
        sendJson2(res, 200, { ok: true, usage: assistantHomeUsage(), retentionDays: OUTPUTS_RETENTION_DAYS });
        return;
      }
      const report = tidyAssistantHome();
      const rotation = rotateAssistantHome();
      sendJson2(res, 200, {
        ok: true,
        removed: report.removed,
        freedBytes: report.freedBytes,
        rotation,
        usage: assistantHomeUsage(),
        retentionDays: OUTPUTS_RETENTION_DAYS
      });
    }
  });
  let timer = null;
  let firstRun = null;
  try {
    const runTidy = () => {
      try {
        const report = tidyAssistantHome();
        const rotation = rotateAssistantHome();
        if (report.removed > 0) {
          try {
            ctx?.logger?.("dsh-assistant")?.info?.(`assistant outputs tidied: ${report.removed} files, ${report.freedBytes} bytes`);
          } catch {
          }
        }
        if (rotation.journalArchived + rotation.notesArchived > 0) {
          try {
            ctx?.logger?.("dsh-assistant")?.info?.(`assistant journal/notes archived: ${rotation.journalArchived} + ${rotation.notesArchived} files, ${rotation.movedBytes} bytes`);
          } catch {
          }
        }
        if (rotation.archiveSoftLimitReached) {
          try {
            ctx?.logger?.("dsh-assistant")?.warn?.(`assistant archive \u8D85\u8FC7 ${ARCHIVE_SOFT_BYTES_LIMIT} \u5B57\u8282\u8F6F\u4E0A\u9650\uFF1A\u63D2\u4EF6\u4E0D\u518D\u81EA\u52A8\u642C\uFF0C\u8BF7\u81EA\u5DF1\u6E05 archive/`);
          } catch {
          }
        }
      } catch {
      }
    };
    firstRun = setTimeout(runTidy, 3e4);
    firstRun.unref?.();
    timer = setInterval(runTidy, TIDY_INTERVAL_MS);
    timer.unref?.();
  } catch {
  }
  return () => {
    try {
      if (firstRun) clearTimeout(firstRun);
    } catch {
    }
    try {
      if (timer) clearInterval(timer);
    } catch {
    }
    try {
      routes.dispose();
    } catch {
    }
  };
}

// src/path-guard.ts
function expandHome(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value === "~") return homedir4();
  if (value === "~\\" || value === "~/") return homedir4();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolvePath4(homedir4(), value.slice(2));
  return value;
}
function comparable(raw) {
  let value = String(raw).replace(/[\\/]+/g, "/");
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (process.platform === "win32") value = value.toLowerCase();
  return value;
}
function realCandidates(abs) {
  const out = [abs];
  try {
    const real = realpathSync(abs);
    if (real && real !== abs) out.push(real);
  } catch {
  }
  return out;
}
function defaultAllowedRoots(config = loadAssistantConfig()) {
  const roots = [];
  const push = (raw) => {
    const value = String(raw ?? "").trim();
    if (!value) return;
    roots.push(resolvePath4(expandHome(value)));
  };
  push(assistantHomeDir());
  push(dirname(assistantHomeDir()));
  push(dshHome());
  push(platformDesktopDir());
  push(resolveNewProjectParent(config).parent);
  push(config.skillRoot);
  push(tmpdir());
  push(process.cwd());
  push(homedir4());
  for (const extra of config.allowedRoots) push(extra);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const root of roots) {
    const key = comparable(root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}
function createPathGuard(config = loadAssistantConfig(true)) {
  const open = config.allowAllLocalPaths === true;
  const roots = defaultAllowedRoots(config);
  return {
    roots,
    open,
    check(rawPath) {
      const raw = String(rawPath ?? "").trim();
      if (!raw) return { ok: false, reason: "empty-path", target: "" };
      const abs = resolvePath4(expandHome(raw));
      if (open) return { ok: true, reason: "allow-all", target: abs };
      const candidates = realCandidates(abs);
      for (const candidate of candidates) {
        const value = comparable(candidate);
        for (const root of roots) {
          const base = comparable(root);
          if (!base) continue;
          if (value === base || value.startsWith(base + "/")) return { ok: true, reason: "", target: abs };
        }
      }
      return { ok: false, reason: `outside-allowlist: ${abs}`, target: abs };
    }
  };
}
function isDirectory(target) {
  try {
    return existsSync4(target) && statSync4(target).isDirectory();
  } catch {
    return false;
  }
}
var TERM_ENV_ALLOW = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "NODE_VERSION",
  "COLUMNS",
  "PYTHONPATH"
];
function minimalTermEnv(config = loadAssistantConfig(), extraNames = []) {
  const allow = new Set([...TERM_ENV_ALLOW, ...config.termEnvAllow, ...extraNames].map((name3) => String(name3).trim().toUpperCase()).filter(Boolean));
  const out = {};
  for (const name3 of allow) {
    const value = process.env[name3];
    if (typeof value === "string" && value.length > 0) out[name3] = value;
  }
  return out;
}

// src/index.ts
import { homedir as homedir5 } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// template/dshell.css
var dshell_default = `/* dsh-worktable \u539F\u751F\u76AE\u80A4 \xB7 DSH \u8BBE\u8BA1\u7CFB\u7EDF\u7EC4\u4EF6\u5E93
   \u7528\u6CD5\uFF1A<link rel="stylesheet" href="/api/worktable/template/dshell.css">
   \u6240\u6709\u989C\u8272\u8D70 DSH \u4E3B\u9898\u53D8\u91CF\uFF08--dsw-alias-*\uFF09\uFF0C\u81EA\u52A8\u9002\u914D\u660E\u6697\u4E3B\u9898\u3002 */
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--dsw-alias-bg-base, #0b0e14);
  color: var(--dsw-alias-label-primary, #e6e8eb);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.6;
}
.dshell { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; min-height: 100%; }
/* \u6587\u5B57\u5C42\u7EA7 */
.dshell-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-muted { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11.5px; }
/* \u5361\u7247 */
.dshell-card { border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); padding: 12px 14px; }
.dshell-card + .dshell-card { margin-top: 10px; }
/* \u6309\u94AE\uFF08\u7EFF\u8272\u4E3B\u6309\u94AE / \u5E7D\u7075\u6309\u94AE / \u5371\u9669\uFF09 */
.dshell-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 999px; border: 1px solid transparent; background: #3fb950; color: #0b0e14; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.dshell-btn:hover { filter: brightness(1.08); }
.dshell-btnGhost { background: transparent; border-color: var(--dsw-alias-border-l1, #262b36); color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-btnGhost:hover { color: var(--dsw-alias-label-primary, #e6e8eb); border-color: var(--dsw-alias-border-l2, #3a4150); }
.dshell-btnDanger { background: transparent; border-color: #f85149; color: #f85149; }
/* \u72B6\u6001\u5FBD\u6807\uFF08\u5706\u70B9 + \u6587\u5B57\uFF1B\u7EFF=\u5DF2\u5B8C\u6210 \u9EC4=\u5F85\u529E/\u5F85\u53D1\u5E03 \u7070=\u672A\u5F00\u59CB\uFF09 */
.dshell-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #262b36); font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); }
.dshell-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-badgeDone { color: #3fb950; border-color: rgba(63,185,80,.4); }
.dshell-badgeDone::before { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-badgeWait { color: #d29922; border-color: rgba(210,153,34,.4); }
.dshell-badgeWait::before { background: #d29922; box-shadow: 0 0 5px #d29922; }
.dshell-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-dotDone { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-dotWait { background: #d29922; box-shadow: 0 0 5px #d29922; }
/* \u6807\u7B7E\u9875 */
.dshell-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-tab { padding: 7px 12px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); cursor: pointer; border: none; background: none; font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dshell-tabOn { color: var(--dsw-alias-label-primary, #e6e8eb); border-bottom-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u5217\u8868 */
.dshell-list { display: flex; flex-direction: column; gap: 6px; }
.dshell-listItem { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); cursor: pointer; }
.dshell-listItem:hover { border-color: var(--dsw-alias-border-l2, #3a4150); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.05)); }
.dshell-listItemTitle { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e8eb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshell-listItemMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* \u7F51\u683C / \u7EDF\u8BA1 */
.dshell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.dshell-stat { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); }
.dshell-statLabel { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-statValue { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-statDelta { font-size: 11px; color: #3fb950; }
/* \u8FDB\u5EA6\u6761 */
.dshell-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.06)); overflow: hidden; }
.dshell-progressBar { height: 100%; border-radius: 3px; background: #3fb950; }
/* \u8F93\u5165 */
.dshell-input, .dshell-textarea { width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); color: var(--dsw-alias-label-primary, #e6e8eb); font: inherit; font-size: 12.5px; outline: none; }
.dshell-input:focus, .dshell-textarea:focus { border-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u8868\u683C */
.dshell-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshell-table th, .dshell-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-table th { color: var(--dsw-alias-label-secondary, #9aa4b2); font-weight: 500; }
/* \u952E\u503C\u5BF9 */
.dshell-kv { display: flex; flex-direction: column; gap: 6px; }
.dshell-kvRow { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.dshell-kvKey { color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-kvValue { color: var(--dsw-alias-label-primary, #e6e8eb); text-align: right; }
/* \u5206\u5272\u7EBF */
.dshell-divider { height: 1px; background: var(--dsw-alias-border-l1, #262b36); margin: 6px 0; }
/* \u6EDA\u52A8\u6761 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }
`;

// template/dshell.html
var dshell_default2 = '<!doctype html>\n<!-- dsh-worktable \u539F\u751F\u76AE\u80A4\u6A21\u677F\uFF1A\u65B0\u9875\u9762\u4EE5\u6B64\u4E3A\u57FA\u7840\uFF0C\u66FF\u6362\u4E0B\u9762\u793A\u4F8B\u5185\u5BB9\u5373\u53EF\u3002\n     \u6837\u5F0F\u8868\u7531\u63D2\u4EF6\u63D0\u4F9B\uFF08\u968F\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF09\uFF0C\u4E0D\u8981\u590D\u5236\u6216\u6539\u5199\u5B83\u3002 -->\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>\u6211\u7684\u7A97\u53E3</title>\n  <link rel="stylesheet" href="/api/worktable/template/dshell.css" />\n</head>\n<body>\n  <div class="dshell">\n    <!-- \u6807\u9898\u533A -->\n    <h1 class="dshell-title">\u7A97\u53E3\u6807\u9898</h1>\n    <p class="dshell-sub">\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u7A97\u53E3\u505A\u4EC0\u4E48\u3002</p>\n\n    <!-- \u72B6\u6001\u5FBD\u6807\uFF1A\u5DF2\u5B8C\u6210 dshell-badgeDone / \u8FDB\u884C\u4E2D dshell-badgeWait / \u9ED8\u8BA4 -->\n    <div>\n      <span class="dshell-badge dshell-badgeDone">\u5DF2\u5B8C\u6210</span>\n      <span class="dshell-badge dshell-badgeWait">\u8FDB\u884C\u4E2D</span>\n      <span class="dshell-badge">\u672A\u5F00\u59CB</span>\n    </div>\n\n    <!-- \u6807\u7B7E\u9875 -->\n    <div class="dshell-tabs">\n      <button class="dshell-tab dshell-tabOn">\u6982\u89C8</button>\n      <button class="dshell-tab">\u8BE6\u60C5</button>\n      <button class="dshell-tab">\u8BBE\u7F6E</button>\n    </div>\n\n    <!-- \u7EDF\u8BA1\u5361\u7247\u7F51\u683C -->\n    <div class="dshell-grid">\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u603B\u6570</div>\n        <div class="dshell-statValue">128</div>\n        <div class="dshell-statDelta">+12.4%</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u8FDB\u884C\u4E2D</div>\n        <div class="dshell-statValue">7</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u5DF2\u5B8C\u6210</div>\n        <div class="dshell-statValue">121</div>\n      </div>\n    </div>\n\n    <!-- \u5217\u8868 -->\n    <div class="dshell-list">\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E00\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-listItemMeta">\u6628\u5929</span>\n      </div>\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E8C\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-badge dshell-badgeDone">\u5DF2\u53D1\u5E03</span>\n      </div>\n    </div>\n\n    <!-- \u5361\u7247 + \u952E\u503C\u5BF9 -->\n    <div class="dshell-card">\n      <h2 class="dshell-sub" style="margin:0 0 8px">\u8BE6\u60C5</h2>\n      <div class="dshell-kv">\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 A</span><span class="dshell-kvValue">\u503C A</span></div>\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 B</span><span class="dshell-kvValue">\u503C B</span></div>\n      </div>\n      <div class="dshell-divider"></div>\n      <div class="dshell-progress"><div class="dshell-progressBar" style="width:72%"></div></div>\n    </div>\n\n    <!-- \u64CD\u4F5C\u533A -->\n    <div style="display:flex;gap:8px">\n      <button class="dshell-btn">\u4E3B\u8981\u64CD\u4F5C</button>\n      <button class="dshell-btn dshell-btnGhost">\u6B21\u8981\u64CD\u4F5C</button>\n    </div>\n  </div>\n</body>\n</html>\n';

// src/index.ts
function baseDshHome() {
  const env = process.env.DSH_HOME;
  const value = env !== void 0 && env.trim().length > 0 ? env : pathResolve(homedir5(), ".dsh");
  if (value === "~") return homedir5();
  if (value.startsWith("~/") || value.startsWith("~\\")) return pathResolve(homedir5(), value.slice(2));
  return pathResolve(value);
}
var cachedDshHome = null;
var dshHomeSource = "fallback";
function resolveDshHomeSafe() {
  if (cachedDshHome) return cachedDshHome;
  try {
    const pkg = loadPkg("@deepseek-ai/dsh-home-paths");
    if (pkg && typeof pkg.resolveDshHome === "function") {
      const home = pkg.resolveDshHome(void 0, process.env);
      if (typeof home === "string" && home.trim() !== "") {
        dshHomeSource = "official";
        cachedDshHome = home;
        return cachedDshHome;
      }
    }
  } catch {
  }
  dshHomeSource = "fallback";
  cachedDshHome = baseDshHome();
  return cachedDshHome;
}
var PLUGIN_VERSION = false ? "dev" : "0.2.11";
var name = "dsh-assistant";
var PLUGIN_SELF = "dsh-assistant/worktable";
var HEALTH_PATH = "/api/worktable/health";
var MAX_ENTRIES = 500;
var FILE_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm"
};
var SITE_PREFIX = "/api/worktable/site";
var TEMPLATE_PREFIX = "/api/worktable/template";
var loadProbeAttempts = 0;
function loadPkg(pkg) {
  const starts = /* @__PURE__ */ new Set();
  try {
    starts.add(dirname2(fileURLToPath(import.meta.url)));
  } catch {
  }
  try {
    starts.add(realpathSync2(dirname2(fileURLToPath(import.meta.url))));
  } catch {
  }
  for (const start of starts) {
    let dir = start;
    while (dir && dir !== pathResolve(dir, "..")) {
      loadProbeAttempts++;
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
      dir = pathResolve(dir, "..");
    }
  }
  try {
    const profilesDir = pathResolve(baseDshHome(), "profiles");
    for (const profile of readdirSync2(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue;
      const nm = pathResolve(profilesDir, profile.name, "node_modules");
      loadProbeAttempts++;
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
    }
  } catch {
  }
  return null;
}
function serverCwd(ctx, sessionId, clientCwd) {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
      if (typeof headerCwd === "string" && headerCwd) return headerCwd;
    } catch {
    }
  }
  if (typeof clientCwd === "string" && clientCwd) return clientCwd;
  return process.cwd();
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJsonBody2(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
async function listDirectory(path) {
  const abs = pathResolve(path);
  const dirents = await readdir(abs, { withFileTypes: true });
  const sorted = [...dirents].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  const truncated = sorted.length > MAX_ENTRIES;
  const visible = truncated ? sorted.slice(0, MAX_ENTRIES) : sorted;
  const entries = await Promise.all(visible.map(async (d) => {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(abs + sep3 + d.name)).mtimeMs;
    } catch {
    }
    return { name: d.name, path: abs + sep3 + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith("."), mtimeMs };
  }));
  return { path: abs, entries, truncated };
}
function gitExec(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout);
    });
  });
}
async function gitStatus(cwd) {
  try {
    const branchRaw = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const porcelain = await gitExec(["status", "--porcelain=v1", "-z"], cwd);
    const entries = porcelain.split("\0").filter((s) => s.length > 2).map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }));
    return { isRepo: true, branch: branchRaw.trim() || "HEAD", entries };
  } catch {
    return { isRepo: false, branch: void 0, entries: [] };
  }
}
function setupTerminal(webServer, ctx, guard) {
  if (typeof webServer.registerUpgrade !== "function") return;
  const wsMod = loadPkg("ws");
  const ptyMod = loadPkg("node-pty");
  ctx.logger?.info?.(`[${PLUGIN_SELF}] term deps: ws=${wsMod ? "ok" : "MISSING"} node-pty=${ptyMod ? "ok" : "MISSING"}`);
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn(`[${PLUGIN_SELF}] \u7EC8\u7AEF\u8DEF\u7531\u672A\u6CE8\u518C\uFF1Aws/node-pty \u4E0D\u53EF\u7528`);
    return;
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer;
  if (!WebSocketServer) return;
  const pty = ptyMod.default ?? ptyMod;
  const wss = new WebSocketServer({ noServer: true });
  const spawnShell = () => process.platform === "win32" ? { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile"] } : { cmd: process.env.SHELL || "/bin/bash", args: [] };
  const clampDim = (v, fallback) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback));
  ctx.effect(() => webServer.registerUpgrade({
    path: "/api/worktable/term",
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const u = new URL(req.url ?? "/", "http://dsh.internal");
        const cwd = serverCwd(ctx, u.searchParams.get("sessionId") || void 0, u.searchParams.get("cwd") || void 0);
        const cwdCheck = guard.check(cwd);
        if (!cwdCheck.ok) {
          try {
            ws.send("\r\n[worktable] \u7EC8\u7AEF\u62D2\u7EDD\uFF1A" + cwdCheck.reason + "\uFF08\u4E0D\u5728\u76EE\u5F55 allowlist \u5185\uFF09");
          } catch {
          }
          try {
            ws.close();
          } catch {
          }
          ctx.logger?.warn?.(`[${PLUGIN_SELF}] term \u8D8A\u754C\u62D2\u7EDD\uFF1A${cwdCheck.reason}`);
          return;
        }
        const cols = clampDim(Number(u.searchParams.get("cols")), 80);
        const rows = clampDim(Number(u.searchParams.get("rows")), 24);
        let term = null;
        try {
          const shell = spawnShell();
          term = pty.spawn(shell.cmd, shell.args, { name: "xterm-256color", cols, rows, cwd, env: minimalTermEnv() });
        } catch (err) {
          try {
            ws.send("\r\n[worktable] \u7EC8\u7AEF\u542F\u52A8\u5931\u8D25\uFF1A" + String(err));
          } catch {
          }
          try {
            ws.close();
          } catch {
          }
          return;
        }
        term.onData((d) => {
          try {
            ws.send(d);
          } catch {
          }
        });
        term.onExit(() => {
          try {
            ws.close();
          } catch {
          }
        });
        ws.on("message", (raw) => {
          const text = String(raw);
          try {
            const msg = JSON.parse(text);
            if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows));
              return;
            }
          } catch {
          }
          try {
            term.write(text);
          } catch {
          }
        });
        ws.on("close", () => {
          try {
            term.kill();
          } catch {
          }
        });
      });
    }
  }), `${PLUGIN_SELF}: terminal upgrade`);
}
async function readSkillMeta(file) {
  try {
    const raw = await readFile(file, "utf8");
    const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
    if (!text.startsWith("---")) return null;
    const body = text.indexOf("\n");
    if (body < 0) return null;
    const end = text.indexOf("\n---", body);
    if (end < 0) return null;
    const lines = text.slice(body + 1, end).split(/\r?\n/);
    let name3 = "";
    let description = "";
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key !== "name" && key !== "description") continue;
      let val = m[2].trim();
      if (/^[>|][-+]?$/.test(val)) {
        const parts = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (!/^\s+\S/.test(lines[j])) break;
          parts.push(lines[j].trim());
        }
        val = parts.join(" ");
      } else if (val.startsWith('"') && val.endsWith('"') && val.length > 1 || val.startsWith("'") && val.endsWith("'") && val.length > 1) {
        val = val.slice(1, -1);
      }
      if (key === "name") name3 = val;
      else description = val;
    }
    if (!name3 && !description) return null;
    return { name: name3, description };
  } catch {
    return null;
  }
}
var SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
async function scanSkillDirs(cwd) {
  const roots = [
    { path: pathResolve(cwd, ".dsh", "skills"), source: "project-dsh" },
    { path: pathResolve(cwd, ".agents", "skills"), source: "project-agents" },
    { path: pathResolve(resolveDshHomeSafe(), "skills"), source: "user-dsh" },
    { path: pathResolve(homedir5(), ".agents", "skills"), source: "user-agents" }
  ];
  const seen = /* @__PURE__ */ new Map();
  const skipped = [];
  for (const root of roots) {
    let dirents;
    try {
      dirents = await readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const dirName = String(d.name ?? "");
      if (!dirName || dirName.startsWith(".")) continue;
      if (/\.retired-/i.test(dirName)) continue;
      const isDir = typeof d.isDirectory === "function" ? d.isDirectory() : false;
      const isFile = typeof d.isFile === "function" ? d.isFile() : false;
      let meta = null;
      if (isDir) {
        meta = await readSkillMeta(pathResolve(root.path, dirName, "SKILL.md"));
      } else if (isFile && dirName.toLowerCase().endsWith(".md")) {
        meta = await readSkillMeta(pathResolve(root.path, dirName));
      } else {
        continue;
      }
      if (!meta || !meta.name) {
        skipped.push(dirName + "\uFF08\u65E0 frontmatter name\uFF09");
        continue;
      }
      if (!SKILL_NAME_RE.test(meta.name)) {
        skipped.push(dirName + "\uFF08name \u975E kebab-case\uFF1A" + meta.name + "\uFF09");
        continue;
      }
      if (seen.has(meta.name)) continue;
      seen.set(meta.name, { name: meta.name, description: meta.description, source: root.source });
    }
  }
  return { skills: [...seen.values()], skipped };
}
async function listSkills(ctx, cwd) {
  let fromService = [];
  try {
    let svc = null;
    try {
      svc = typeof ctx?.get === "function" ? ctx.get("skills") ?? null : null;
    } catch {
    }
    if (svc && typeof svc.list === "function") {
      const list = await svc.list({ cwd });
      if (Array.isArray(list)) {
        fromService = list.filter((s) => s && typeof s.name === "string" && s.name.trim() !== "").map((s) => ({
          name: String(s.name),
          description: typeof s.description === "string" ? s.description : "",
          source: typeof s.source === "string" ? s.source : ""
        }));
      }
    }
  } catch (err) {
    ctx?.logger?.warn?.(`[${PLUGIN_SELF}] ctx.skills \u4E0D\u53EF\u7528\uFF0C\u56DE\u9000\u626B\u63CF\u6280\u80FD\u76EE\u5F55\uFF1A` + String(err));
  }
  if (fromService.length > 0) return { skills: fromService, source: "service", skipped: [] };
  const scanned = await scanSkillDirs(cwd);
  return { skills: scanned.skills, source: "scan", skipped: scanned.skipped };
}
function apply(ctx) {
  const server = ctx.webServer;
  if (!server) {
    ctx.logger?.warn(`[${PLUGIN_SELF}] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531`);
    return;
  }
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const guard = createPathGuard();
  ctx.logger?.info?.(`[${PLUGIN_SELF}] \u76EE\u5F55 allowlist: ${guard.open ? "\u5168\u653E\u884C\uFF08allowAllLocalPaths\uFF09" : guard.roots.join(" | ")}`);
  const denyOutside = (res, rawPath, routeName) => {
    const check = guard.check(rawPath);
    if (check.ok) return false;
    ctx.logger?.warn?.(`[${PLUGIN_SELF}] ${routeName} \u8D8A\u754C\u62D2\u7EDD\uFF1A${check.reason}`);
    json(res, 403, {
      ok: false,
      error: "outside-allowlist",
      path: check.target,
      hint: "\u5728 ~/.dsh/assistant/config.json \u7684 allowedRoots \u91CC\u52A0\u4E0A\u8FD9\u4E2A\u76EE\u5F55\uFF08\u6216\u628A\u5B83\u672C\u8EAB\u653E\u8FDB\u5DF2\u5141\u8BB8\u6839\uFF09\uFF0C\u518D\u91CD\u542F DSH"
    });
    return true;
  };
  try {
    webServer.register({
      kind: "exact",
      path: HEALTH_PATH,
      handler: (_req, res) => {
        json(res, 200, { plugin: name, half: PLUGIN_SELF, version: PLUGIN_VERSION, ok: true });
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/file",
      handler: async (req, res) => {
        try {
          const u = new URL(req.url ?? "/", "http://dsh.internal");
          const p = u.searchParams.get("path") || "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          if (denyOutside(res, p, "file")) return;
          const abs = pathResolve(p);
          const stat2 = await import("node:fs/promises").then((m) => m.stat(abs));
          if (stat2.size > 20 * 1024 * 1024) {
            json(res, 413, { error: "file too large" });
            return;
          }
          const data = await readFile(abs);
          const ext = (abs.split(".").pop() || "").toLowerCase();
          const types = {
            html: "text/html; charset=utf-8",
            htm: "text/html; charset=utf-8",
            css: "text/css; charset=utf-8",
            js: "text/javascript; charset=utf-8",
            mjs: "text/javascript; charset=utf-8",
            json: "application/json; charset=utf-8",
            md: "text/markdown; charset=utf-8",
            markdown: "text/markdown; charset=utf-8",
            txt: "text/plain; charset=utf-8",
            log: "text/plain; charset=utf-8",
            pdf: "application/pdf",
            svg: "image/svg+xml",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            ico: "image/x-icon"
          };
          res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
          res.end(data);
        } catch (err) {
          json(res, 404, { error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "prefix",
      path: TEMPLATE_PREFIX,
      handler: (req, res) => {
        try {
          if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
          }
          const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const rel = pathname.slice(TEMPLATE_PREFIX.length);
          if (rel === "/dshell.css") {
            res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
            res.end(dshell_default);
          } else {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(dshell_default2);
          }
        } catch (err) {
          res.writeHead(404);
          res.end(String(err));
        }
      }
    });
    webServer.register({
      kind: "prefix",
      path: SITE_PREFIX,
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
          }
          const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const segs = pathname.slice(SITE_PREFIX.length).split("/").filter(Boolean);
          const rootToken = decodeURIComponent(segs.shift() ?? "");
          const rel = segs.map((s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          }).join("/");
          if (!rootToken) {
            json(res, 400, { error: "missing root" });
            return;
          }
          if (denyOutside(res, rootToken, "site")) return;
          const root = pathResolve(rootToken);
          let abs = pathResolve(root, rel);
          if (abs !== root && !abs.startsWith(root + sep3)) {
            json(res, 403, { error: "outside root" });
            return;
          }
          const statMod = await import("node:fs/promises");
          let info = await statMod.stat(abs).catch(() => null);
          if (info && info.isDirectory()) {
            abs = pathResolve(abs, "index.html");
            info = await statMod.stat(abs).catch(() => null);
          }
          if (!info || !info.isFile()) {
            json(res, 404, { error: "not found" });
            return;
          }
          if (info.size > 40 * 1024 * 1024) {
            json(res, 413, { error: "file too large" });
            return;
          }
          const data = await readFile(abs);
          const ext = (abs.split(".").pop() || "").toLowerCase();
          res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
          res.end(data);
        } catch (err) {
          json(res, 404, { error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/fs",
      handler: async (req, res) => {
        try {
          const body = await readJsonBody2(req);
          const path = typeof body.path === "string" && body.path ? body.path : serverCwd(ctx, body.sessionId, body.cwd);
          if (denyOutside(res, path, "fs")) return;
          json(res, 200, await listDirectory(path));
        } catch (err) {
          json(res, 500, { path: "", entries: [], truncated: false, error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/skills",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
          }
          const u = new URL(req.url ?? "/", "http://dsh.internal");
          const cwd = serverCwd(ctx, u.searchParams.get("sessionId") || void 0, u.searchParams.get("cwd") || void 0);
          if (denyOutside(res, cwd, "skills")) return;
          const { skills, source, skipped } = await listSkills(ctx, cwd);
          if (skipped.length > 0) {
            ctx?.logger?.info?.(`[${PLUGIN_SELF}] \u6280\u80FD\u76EE\u5F55\u4E2D\u4EE5\u4E0B\u6761\u76EE\u56E0\u6280\u80FD\u540D\u975E\u6CD5\u4E0D\u53EF\u7528\uFF08\u4E0D\u5F71\u54CD\u5176\u5B83\u6280\u80FD\uFF09\uFF1A` + skipped.join("\uFF1B"));
          }
          skills.sort((a, b) => a.name.localeCompare(b.name));
          json(res, 200, { ok: true, source, cwd, count: skills.length, skipped, skills });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err), count: 0, skills: [] });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/workspaces",
      handler: async (_req, res) => {
        try {
          let registry = null;
          try {
            registry = ctx.workspaceRegistry ?? null;
          } catch {
          }
          if (!registry) {
            try {
              registry = ctx.get?.("workspaceRegistry") ?? null;
            } catch {
            }
          }
          if (registry && typeof registry.list === "function") {
            const list = registry.list() ?? [];
            const workspaceIds = [];
            const tables = {};
            for (const ws of list) {
              const id = String(ws?.id ?? "");
              if (!id) continue;
              workspaceIds.push(id);
              tables[id] = {
                title: typeof ws?.title === "string" ? ws.title : void 0,
                sessionIds: Array.isArray(ws?.sessionIds) ? ws.sessionIds.map(String) : []
              };
            }
            let archived = [];
            try {
              archived = (registry.archivedSessionIds ?? []).map(String);
            } catch {
            }
            json(res, 200, {
              unit: { name: "workspace", version: 2 },
              global: { initialized: true, workspaceIds, archivedSessionIds: archived },
              tables: { workspaces: tables }
            });
            return;
          }
          const file = pathResolve(resolveDshHomeSafe(), "storages", "workspace.json");
          const raw = await readFile(file, "utf8");
          json(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
        } catch (err) {
          json(res, 404, { error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/write",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          const body = await readJsonBody2(req);
          const p = typeof body.path === "string" ? body.path : "";
          const content = typeof body.content === "string" ? body.content : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          if (denyOutside(res, p, "write")) return;
          if (content.length > 20 * 1024 * 1024) {
            json(res, 413, { error: "content too large" });
            return;
          }
          const abs = pathResolve(p);
          await import("node:fs/promises").then((m) => m.writeFile(abs, content, "utf8"));
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/mkdir",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          const body = await readJsonBody2(req);
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          if (denyOutside(res, p, "mkdir")) return;
          const abs = pathResolve(p);
          const fsx = await import("node:fs/promises");
          const parent = dirname2(abs);
          try {
            await fsx.access(parent);
          } catch {
            json(res, 400, { error: "parent not found" });
            return;
          }
          await fsx.mkdir(abs);
          json(res, 200, { ok: true, path: abs });
        } catch (err) {
          json(res, err?.code === "EEXIST" ? 200 : 500, err?.code === "EEXIST" ? { ok: true, exists: true } : { error: String(err) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/git",
      handler: async (req, res) => {
        const body = await readJsonBody2(req);
        const cwd = serverCwd(ctx, body.sessionId, body.cwd);
        if (denyOutside(res, cwd, "git")) return;
        json(res, 200, await gitStatus(cwd));
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/worktable/open-folder",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          const body = await readJsonBody2(req);
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          if (denyOutside(res, p, "open-folder")) return;
          const abs = pathResolve(p);
          const fsx = await import("node:fs/promises");
          try {
            const st = await fsx.stat(abs);
            if (!st.isDirectory()) {
              json(res, 400, { error: "not a directory" });
              return;
            }
          } catch {
            json(res, 404, { error: "directory not found" });
            return;
          }
          const opener = process.platform === "win32" ? { cmd: "explorer.exe", args: [abs] } : process.platform === "darwin" ? { cmd: "open", args: [abs] } : { cmd: "xdg-open", args: [abs] };
          const cp = await import("node:child_process");
          const child = cp.spawn(opener.cmd, opener.args, { detached: true, stdio: "ignore", windowsHide: true });
          child.unref();
          json(res, 200, { ok: true, path: abs });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      }
    });
    setupTerminal(webServer, ctx, guard);
    return routes.dispose;
  } catch (err) {
    routes.dispose();
    throw err;
  }
}

// src/tuoguan-host.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
var PREFIX = "/.dsh-tuoguan";
var STATE_ROUTE = `${PREFIX}/state`;
var STATE_FILENAME = "dsh-tuoguan-state.json";
var MAX_BODY_BYTES = 64 * 1024;
var MAX_SESSION_ID_LENGTH = 256;
function optionalService(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function profileDirectory(ctx) {
  const profile = optionalService(ctx, "profileContext");
  if (profile && typeof profile.dir === "string" && profile.dir !== "") return profile.dir;
  const homePaths = optionalService(ctx, "homePaths");
  if (homePaths && typeof homePaths.home === "string" && homePaths.home !== "") return homePaths.home;
  return process.cwd();
}
function normalizeState(raw) {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const offSource = typeof record.off === "object" && record.off !== null && !Array.isArray(record.off) ? record.off : {};
  const off = {};
  for (const [key, value] of Object.entries(offSource)) {
    if (typeof key === "string" && key !== "" && key.length <= MAX_SESSION_ID_LENGTH && value === true) {
      off[key] = true;
    }
  }
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision >= 0 ? Math.floor(record.revision) : 0;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  const onSource = typeof record.on === "object" && record.on !== null && !Array.isArray(record.on) ? record.on : {};
  const on = {};
  for (const [key, value] of Object.entries(onSource)) {
    if (typeof key === "string" && key !== "" && key.length <= MAX_SESSION_ID_LENGTH && value === true) {
      on[key] = true;
    }
  }
  const defaultOn = typeof record.defaultOn === "boolean" ? record.defaultOn : true;
  for (const key of Object.keys(off)) delete on[key];
  return { off, on, defaultOn, revision, updatedAt };
}
function readStateSync(file) {
  try {
    return normalizeState(JSON.parse(readFileSync4(file, "utf8")));
  } catch {
    return { off: {}, on: {}, defaultOn: true, revision: 0, updatedAt: "" };
  }
}
function writeStateSync(file, state) {
  const payload = `${JSON.stringify(state, void 0, 2)}
`;
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync3(dirname3(file), { recursive: true });
  writeFileSync3(temporary, payload, "utf8");
  renameSync3(temporary, file);
}
var TuoguanStore = class {
  file;
  chain = Promise.resolve();
  constructor(file) {
    this.file = file;
  }
  /** 串行执行一个（同步）任务，返回它的结果；前面的任务失败也继续跑。 */
  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => void 0, () => void 0);
    return run;
  }
  read() {
    return this.enqueue(() => readStateSync(this.file));
  }
  /** 某会话的当前有效状态：显式记录优先，否则用默认值。 */
  effective(state, sessionId) {
    if (state.off[sessionId] === true) return false;
    if (state.on[sessionId] === true) return true;
    return state.defaultOn;
  }
  /**
   * 切换某个会话的托管开关。
   * 值没变时不写盘、不涨 revision —— 避免两端反复轮询/重放同一状态造成写放大。
   * 只把「与默认状态不同」的会话记成显式状态，状态文件不会随会话数无限膨胀。
   */
  setSession(sessionId, on) {
    return this.enqueue(() => {
      const current = readStateSync(this.file);
      if (this.effective(current, sessionId) === on) return current;
      const off = { ...current.off };
      const onMap = { ...current.on };
      delete off[sessionId];
      delete onMap[sessionId];
      if (on !== current.defaultOn) {
        if (on) onMap[sessionId] = true;
        else off[sessionId] = true;
      }
      const next = {
        off,
        on: onMap,
        defaultOn: current.defaultOn,
        revision: current.revision + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      writeStateSync(this.file, next);
      return next;
    });
  }
  /** 改「新会话默认托管状态」；值没变就不写盘。 */
  setDefault(defaultOn) {
    return this.enqueue(() => {
      const current = readStateSync(this.file);
      if (current.defaultOn === defaultOn) return current;
      const next = {
        ...current,
        defaultOn,
        revision: current.revision + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      writeStateSync(this.file, next);
      return next;
    });
  }
};
function sendJson3(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limit) {
        reject(Object.assign(new Error("too-large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
async function readJsonBody3(req) {
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (bytes.length === 0) return {};
  const parsed = JSON.parse(bytes.toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}
function rejectionStatus(ctx, req) {
  const connection = optionalService(ctx, "connection");
  if (connection === void 0 || connection === null) return void 0;
  try {
    if (typeof connection.admit === "function") {
      const admitted = connection.admit(req);
      if (admitted && typeof admitted === "object" && typeof admitted.rejection === "number") {
        return admitted.rejection;
      }
      return void 0;
    }
    if (typeof connection.isAuthenticated === "function") {
      return connection.isAuthenticated(req) ? void 0 : 401;
    }
  } catch {
  }
  return void 0;
}
async function handleRequest(ctx, store, req, res) {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const rejection = rejectionStatus(ctx, req);
  if (rejection !== void 0) {
    res.writeHead(rejection);
    res.end();
    return;
  }
  const method = req.method ?? "GET";
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, { allow: "GET, POST, OPTIONS" });
      res.end();
      return;
    }
    if (path === STATE_ROUTE && method === "GET") {
      sendJson3(res, 200, await store.read());
      return;
    }
    if (path === STATE_ROUTE && method === "POST") {
      const body = await readJsonBody3(req);
      if (typeof body.defaultOn === "boolean") {
        sendJson3(res, 200, await store.setDefault(body.defaultOn));
        return;
      }
      const sessionId = body.sessionId;
      const on = body.on;
      if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH) {
        sendJson3(res, 400, { error: "invalid-session" });
        return;
      }
      if (typeof on !== "boolean") {
        sendJson3(res, 400, { error: "invalid-on" });
        return;
      }
      sendJson3(res, 200, await store.setSession(sessionId, on));
      return;
    }
    if (path === STATE_ROUTE) {
      res.writeHead(405, { allow: "GET, POST, OPTIONS" });
      res.end();
      return;
    }
    sendJson3(res, 404, { error: "not-found" });
  } catch (error) {
    const status = error?.status;
    if (status === 413) {
      sendJson3(res, 413, { error: "too-large" });
      return;
    }
    if (!res.headersSent) sendJson3(res, 500, { error: "internal", message: String(error?.message ?? error) });
    else res.end();
  }
}
function registerTuoguanRoutes(ctx, store) {
  let webServer = optionalService(ctx, "webServer");
  if (webServer === void 0) {
    try {
      webServer = ctx?.webServer;
    } catch {
      webServer = void 0;
    }
  }
  if (!webServer || typeof webServer.register !== "function") {
    console.error("dsh-assistant: \u5BBF\u4E3B webServer \u4E0D\u53EF\u7528\uFF0C\u6258\u7BA1\u72B6\u6001\u65E0\u6CD5\u8DE8\u7AEF\u540C\u6B65\uFF08\u4EC5\u672C\u673A localStorage \u751F\u6548\uFF09");
    return () => void 0;
  }
  const dispose = webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => handleRequest(ctx, store, req, res)
  });
  return typeof dispose === "function" ? dispose : () => void 0;
}
function apply2(ctx) {
  const directory = profileDirectory(ctx);
  const store = new TuoguanStore(join5(directory, STATE_FILENAME));
  console.error(`dsh-assistant: \u6258\u7BA1\u72B6\u6001\u6587\u4EF6 ${store.file}`);
  const effect = typeof ctx?.effect === "function" ? ctx.effect : void 0;
  if (effect === void 0) {
    registerTuoguanRoutes(ctx, store);
    return;
  }
  effect(() => {
    const detach = registerTuoguanRoutes(ctx, store);
    console.error(`dsh-assistant: \u5DF2\u6302\u8F7D\u6258\u7BA1\u8DEF\u7531 GET/POST ${STATE_ROUTE}`);
    return () => {
      detach();
    };
  });
}

// src/assistant-store.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { dirname as dirname4, join as join6 } from "node:path";
var STATE_ROUTE2 = "/api/assistant/state";
var STATE_FILENAME2 = "dsh-assistant-state.json";
var MAX_BODY_BYTES2 = 4 * 1024 * 1024;
function profileDir(ctx) {
  try {
    const p = ctx?.get?.("profileContext");
    if (p && typeof p.dir === "string" && p.dir) return p.dir;
  } catch {
  }
  try {
    const h = ctx?.get?.("homePaths");
    if (h && typeof h.home === "string" && h.home) return h.home;
  } catch {
  }
  return process.env.DSH_HOME || process.cwd();
}
function sendJson4(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
async function readJsonBody4(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > MAX_BODY_BYTES2) throw Object.assign(new Error("too-large"), { status: 413 });
    chunks.push(b);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.projects || typeof raw.projects !== "object") return null;
  return {
    projects: raw.projects,
    view: raw.view && typeof raw.view === "object" ? raw.view : null,
    revision: Number.isFinite(raw.revision) ? Math.max(0, Math.floor(raw.revision)) : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : ""
  };
}
function registerAssistantState(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const file = join6(profileDir(ctx), STATE_FILENAME2);
  let cached2 = null;
  let loaded = false;
  let chain = Promise.resolve();
  const readState = async () => {
    if (loaded) return cached2;
    try {
      cached2 = normalize(JSON.parse(await readFile2(file, "utf8")));
    } catch {
      cached2 = null;
    }
    loaded = true;
    return cached2;
  };
  const writeState = (projects, view, baseRevision) => {
    const task = async () => {
      const prev = await readState();
      if (prev && baseRevision != null && Number.isFinite(baseRevision) && prev.revision > baseRevision) {
        return { conflict: prev };
      }
      const next = {
        projects,
        view,
        revision: (prev?.revision ?? 0) + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const payload = JSON.stringify(next);
      await mkdir(dirname4(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
      cached2 = next;
      loaded = true;
      return next;
    };
    const run = chain.then(task, task);
    chain = run.then(() => void 0, () => void 0);
    return run;
  };
  webServer.register({
    kind: "prefix",
    path: STATE_ROUTE2,
    handler: async (req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path !== STATE_ROUTE2) {
        sendJson4(res, 404, { error: "not-found" });
        return;
      }
      try {
        if (req.method === "GET" || req.method === "HEAD") {
          const state = await readState();
          const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
          const rawSince = params.get("sinceRevision");
          const since = rawSince === null ? Number.NaN : Number(rawSince);
          if (state && Number.isFinite(since) && state.revision === since) {
            res.writeHead(204, { "cache-control": "no-store" });
            res.end();
            return;
          }
          sendJson4(res, 200, { ok: true, state });
          return;
        }
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody4(req);
          if (!body.projects || typeof body.projects !== "object" || Array.isArray(body.projects)) {
            sendJson4(res, 400, { error: "invalid-projects" });
            return;
          }
          const base = typeof body.baseRevision === "number" ? body.baseRevision : null;
          const out = await writeState(body.projects, body.view ?? null, base);
          if (out && typeof out === "object" && "conflict" in out) {
            sendJson4(res, 409, { ok: false, conflict: true, state: out.conflict });
            return;
          }
          sendJson4(res, 200, { ok: true, state: out });
          return;
        }
        res.writeHead(405, { allow: "GET, PUT, POST" });
        res.end();
      } catch (err) {
        if (err?.status === 413) {
          sendJson4(res, 413, { error: "too-large" });
          return;
        }
        sendJson4(res, 500, { error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  return routes.dispose;
}

// src/coordinate-mode.ts
import { mkdir as mkdir2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync5 } from "node:fs";
import { dirname as dirname5, join as join7 } from "node:path";
var COORDINATE_MODE_ROUTE = "/api/assistant/coordinate-mode";
var SETTINGS_FILE = "millifraction-coordinates.json";
function profileDir2(ctx) {
  try {
    const p = ctx?.get?.("profileContext");
    if (p && typeof p.dir === "string" && p.dir) return p.dir;
  } catch {
  }
  try {
    const h = ctx?.get?.("homePaths");
    if (h && typeof h.home === "string" && h.home) return h.home;
  } catch {
  }
  return process.env.DSH_HOME || process.cwd();
}
function defaultMillifraction() {
  return process.platform === "win32";
}
function readMillifraction(file) {
  try {
    const parsed = JSON.parse(readFileSync5(file, "utf8"));
    if (parsed && typeof parsed.enabled === "boolean") return parsed.enabled;
  } catch {
  }
  return defaultMillifraction();
}
function sendJson5(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
async function readBody2(req, limit = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function registerCoordinateMode(ctx) {
  const file = join7(profileDir2(ctx), SETTINGS_FILE);
  let enabled = readMillifraction(file);
  const currentMode = () => enabled ? "millifraction" : "pixel";
  const setEnabled = async (next) => {
    const previous = enabled;
    enabled = next;
    try {
      await mkdir2(dirname5(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile2(tmp, JSON.stringify({ enabled: next }, null, 2) + "\n", "utf8");
      await rename2(tmp, file);
    } catch (err) {
      enabled = previous;
      try {
        ctx.logger?.("dsh-assistant")?.error?.("save coordinate mode failed: %s", String(err));
      } catch {
      }
      throw err;
    }
  };
  const service = {
    currentMode,
    millifractionEnabled: () => enabled,
    setMillifractionEnabled: setEnabled
  };
  const disposers = [];
  const routes = manageWebRoutes(ctx.webServer);
  disposers.push(routes.dispose);
  try {
    if (ctx?.get?.("assistantCoordinateMode") === void 0 && typeof ctx?.provide === "function") {
      const dispose = ctx.provide("assistantCoordinateMode", service);
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("provide assistantCoordinateMode failed: %s", String(err));
    } catch {
    }
  }
  try {
    routes.webServer.register({
      kind: "exact",
      path: COORDINATE_MODE_ROUTE,
      handler: async (req, res) => {
        const method = String(req?.method ?? "GET").toUpperCase();
        try {
          if (method === "GET" || method === "HEAD") {
            sendJson5(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction()
            });
            return;
          }
          if (method === "POST" || method === "PUT") {
            const body = await readBody2(req);
            if (!body || typeof body.enabled !== "boolean") {
              sendJson5(res, 400, { ok: false, error: "invalid-enabled" });
              return;
            }
            await setEnabled(body.enabled);
            sendJson5(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction()
            });
            return;
          }
          res.writeHead(405, { allow: "GET, HEAD, POST, PUT" });
          res.end();
        } catch (err) {
          sendJson5(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
        }
      }
    });
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("register coordinate mode route failed: %s", String(err));
    } catch {
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}

// src/consoleAsset.ts
import { readFile as readFile3 } from "node:fs/promises";
var CONSOLE_SEA01_ROUTE = "/api/assistant/assets/console-sea01.jpg";
var assetUrl = new URL("./console-sea01.jpg", import.meta.url);
var assetPromise = null;
function loadAsset() {
  if (!assetPromise) {
    assetPromise = readFile3(assetUrl).catch((error) => {
      assetPromise = null;
      throw error;
    });
  }
  return assetPromise;
}
async function serveConsoleSea01(req, res) {
  const method = String(req?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  try {
    const body = await loadAsset();
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": String(body.length),
      "cache-control": "public, max-age=86400"
    });
    res.end(method === "HEAD" ? void 0 : body);
  } catch {
    if (!res.headersSent) res.writeHead(404, { "cache-control": "no-store" });
    res.end();
  }
}

// src/desktop-ball.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync4, openSync, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join8 } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

// src/desktop-focus.ts
import { spawn } from "node:child_process";
import { basename, dirname as dirname6 } from "node:path";
import koffi from "koffi";
var lastWakeAt = 0;
var wakePending = false;
function desktopAppExecutable() {
  if (process.platform !== "win32") return "";
  if (!process.versions.electron) return "";
  if (process.defaultApp === true) return "";
  const exe = process.execPath;
  if (!exe || basename(exe).toLowerCase() === "electron.exe") return "";
  return exe;
}
function wakeDesktopApp() {
  const exe = desktopAppExecutable();
  if (!exe) return false;
  const now = Date.now();
  if (wakePending || now - lastWakeAt < 1500) return true;
  lastWakeAt = now;
  wakePending = true;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RUN_AS_NODE_OPTIONS;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(exe, [], {
      cwd: dirname6(exe),
      windowsHide: true,
      stdio: "ignore",
      detached: false,
      env
    });
    const release = () => {
      wakePending = false;
    };
    child.once("error", release);
    child.once("exit", release);
    const timer = setTimeout(release, 3e3);
    timer.unref?.();
    return true;
  } catch {
    wakePending = false;
    return false;
  }
}
var cached = null;
function user32() {
  if (cached) return cached;
  const lib = koffi.load("user32.dll");
  cached = {
    FindWindowExW: lib.func("void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *className, const char16_t *title)"),
    GetWindowThreadProcessId: lib.func("uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)"),
    GetWindowTextLengthW: lib.func("int __stdcall GetWindowTextLengthW(void *hwnd)"),
    GetWindowTextW: lib.func("int __stdcall GetWindowTextW(void *hwnd, uint16_t *buffer, int count)"),
    IsIconic: lib.func("int __stdcall IsIconic(void *hwnd)"),
    IsWindowVisible: lib.func("int __stdcall IsWindowVisible(void *hwnd)"),
    ShowWindow: lib.func("int __stdcall ShowWindow(void *hwnd, int command)"),
    SwitchToThisWindow: lib.func("void __stdcall SwitchToThisWindow(void *hwnd, bool altTab)"),
    GetForegroundWindow: lib.func("void * __stdcall GetForegroundWindow()")
  };
  return cached;
}
function titleOf(api, hwnd) {
  const length = api.GetWindowTextLengthW(hwnd);
  if (length <= 0) return "";
  const buffer = Buffer.alloc((length + 1) * 2);
  api.GetWindowTextW(hwnd, buffer, length + 1);
  return buffer.toString("utf16le", 0, length * 2);
}
function focusDesktopMainWindow() {
  if (process.platform !== "win32" || !process.ppid) return false;
  try {
    const api = user32();
    let hwnd = null;
    let fallback = null;
    while (hwnd = api.FindWindowExW(null, hwnd, null, null)) {
      const pid = [0];
      api.GetWindowThreadProcessId(hwnd, pid);
      if (pid[0] !== process.ppid) continue;
      const title = titleOf(api, hwnd);
      if (!title.includes("DeepSeek Harness")) continue;
      if (api.IsWindowVisible(hwnd)) {
        fallback = hwnd;
        break;
      }
      fallback ??= hwnd;
    }
    if (!fallback) return false;
    if (!api.IsWindowVisible(fallback)) return wakeDesktopApp();
    if (api.IsIconic(fallback)) api.ShowWindow(fallback, 9);
    api.SwitchToThisWindow(fallback, true);
    const foreground = api.GetForegroundWindow();
    return typeof foreground === "bigint" && typeof fallback === "bigint" ? foreground === fallback : Number(foreground) === Number(fallback);
  } catch {
    return false;
  }
}

// src/desktop-ball.ts
var DESKTOP_BALL_SINGLETON = "__dshAssistantDesktopBallSingleton";
function desktopBallSingleton() {
  const root = globalThis;
  if (!root[DESKTOP_BALL_SINGLETON]) root[DESKTOP_BALL_SINGLETON] = { generation: 0, handle: null };
  return root[DESKTOP_BALL_SINGLETON];
}
function dshHome2() {
  return process.env.DSH_HOME || join8(homedir6(), ".dsh");
}
function profileDir3(ctx) {
  try {
    const p = ctx?.get?.("profileContext");
    if (p && typeof p.dir === "string" && p.dir) return p.dir;
  } catch {
  }
  try {
    const h = ctx?.get?.("homePaths");
    if (h && typeof h.home === "string" && h.home) return h.home;
  } catch {
  }
  return dshHome2();
}
function ballProfileDir(ctx) {
  return join8(profileDir3(ctx), "dsh-assistant-ball");
}
function findElectron() {
  const candidates = [
    join8(dshHome2(), "dsh-orb", "electron-runtime", "electron.exe"),
    join8(dshHome2(), "dsh-assistant", "electron", "electron.exe"),
    process.env.DSH_ASSISTANT_ELECTRON || ""
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync5(p)) return p;
    } catch {
    }
  }
  return null;
}
var BALL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none}
#b{position:absolute;left:6px;top:6px;width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;
background:radial-gradient(circle at 32% 28%,#fff 0%,#eef2ff 24%,#c7d2fe 55%,#8b5cf6 100%);
box-shadow:0 6px 20px rgba(76,29,149,.45),0 2px 6px rgba(0,0,0,.25),inset 0 2px 6px rgba(255,255,255,.9);
cursor:grab;transition:transform .12s ease}
#b:active{cursor:grabbing;transform:scale(.92)}
</style></head><body><div id="b">\u{1F52E}</div><script>
const { ipcRenderer } = require('electron')
const b = document.getElementById('b')
let down = false, sx = 0, sy = 0, moved = 0, lpTimer = null, lpFired = false
const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null } }
b.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  down = true; moved = 0; sx = e.screenX; sy = e.screenY; lpFired = false
  ipcRenderer.send('ball-down', { x: sx, y: sy })
  // \u957F\u6309 600ms = \u79C1\u4EBA\u52A9\u624B\uFF1B\u79FB\u52A8\u8D85\u8FC7\u9608\u503C\u5373\u53D6\u6D88\uFF08\u62D6\u52A8\u4F18\u5148\uFF09\u3002
  clearLp()
  lpTimer = setTimeout(() => { lpTimer = null; if (moved >= 6) return; lpFired = true; ipcRenderer.send('ball-long-press') }, 600)
})
window.addEventListener('mousemove', (e) => {
  if (!down) return
  moved = Math.max(moved, Math.hypot(e.screenX - sx, e.screenY - sy))
  if (moved >= 6) clearLp()
  ipcRenderer.send('ball-move', { x: e.screenX, y: e.screenY })
})
window.addEventListener('mouseup', () => {
  if (!down) return
  down = false; clearLp()
  if (lpFired) { lpFired = false; return }
  ipcRenderer.send('ball-up', { moved })
})
</script></body></html>`;
var HELPER_MAIN = `const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron')
const net = require('net')
const fs = require('fs')
const path = require('path')
const dir = __dirname
const args = process.argv.slice(2)
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const port = Number(arg('port', '0'))
const token = arg('token', '')
let win = null
let sock = null
let startCursor = null
let startPos = null

function connect() {
  try {
    sock = net.connect(port, '127.0.0.1', () => { try { sock.write(token + '\\n') } catch {} })
    sock.on('error', () => {})
    sock.on('close', () => { try { app.quit() } catch {} })
  } catch { setTimeout(connect, 1500) }
}
function send(msg) { try { sock && sock.write(msg + '\\n') } catch {} }

app.whenReady().then(() => {
  let x = 80, y = 160
  try {
    const area = screen.getPrimaryDisplay().workAreaSize
    x = Math.max(0, area.width - 96)
    y = Math.max(0, area.height - 300)
  } catch {}
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'pos.json'), 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) { x = p.x; y = p.y }
  } catch {}
  win = new BrowserWindow({
    width: 72, height: 72, x, y, frame: false, transparent: true, resizable: false,
    // \u4E0D\u80FD\u805A\u7126\uFF1A\u5426\u5219 Windows \u4F1A\u5728\u7B2C\u4E00\u6B21\u70B9\u51FB\u65F6\u5148\u6FC0\u6D3B\u5C0F\u7403\uFF0CChromium \u4E0D\u6D3E\u53D1 mousedown\uFF0C
    // \u8868\u73B0\u4E3A\u201C\u70B9\u4E00\u4E0B\u6CA1\u53CD\u5E94/\u53EA\u505C\u5728\u4F1A\u8BDD\u8BE6\u60C5\u201D\uFF0C\u7B2C\u4E8C\u4E0B\u624D\u6253\u5F00\u63A7\u5236\u5BA4\u3002
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, devTools: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(dir, 'index.html'))
  win.once('ready-to-show', () => { try { win.showInactive() } catch { try { win.show() } catch {} } })
  const persist = () => { try { const p = win.getPosition(); fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify({ x: p[0], y: p[1] })) } catch {} }
  win.on('moved', persist)
  win.on('closed', () => { try { app.quit() } catch {} })
  ipcMain.on('ball-down', (_e, p) => { startCursor = { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }; try { startPos = win.getPosition() } catch {} })
  ipcMain.on('ball-move', (_e, p) => {
    if (!startCursor || !startPos) return
    const dx = (Number(p && p.x) || 0) - startCursor.x
    const dy = (Number(p && p.y) || 0) - startCursor.y
    try { win.setPosition(Math.round(startPos[0] + dx), Math.round(startPos[1] + dy)) } catch {}
  })
  ipcMain.on('ball-up', (_e, p) => {
    const moved = Number(p && p.moved) || 0
    if (moved < 5) send('click')
  })
  // \u957F\u6309\u7403 = \u79C1\u4EBA\u52A9\u624B\uFF1A\u548C\u8F7B\u70B9\uFF08\u63A7\u5236\u5BA4\uFF09\u8D70\u4E0D\u540C\u7684\u610F\u56FE\u3002
  ipcMain.on('ball-long-press', () => { send('assistant') })
  // \u684C\u9762\u5168\u5C40\u70ED\u952E\uFF1A\u7A97\u53E3\u4E0D\u5728\u524D\u53F0\u4E5F\u80FD\u5524\u8D77\u52A9\u624B\u3002
  try {
    globalShortcut.register('Control+Alt+A', () => { send('assistant') })
  } catch {}
  connect()
})
app.on('window-all-closed', () => { try { app.quit() } catch {} })
app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch {} })
`;
async function startDesktopBall(ctx, opts = {}) {
  if (process.platform !== "win32") return null;
  const exe = findElectron();
  if (!exe) {
    try {
      console.error("[dsh-assistant] \u684C\u9762\u60AC\u6D6E\u7403\uFF1A\u672A\u627E\u5230 Electron \u8FD0\u884C\u65F6\uFF08\u8DF3\u8FC7\uFF09");
    } catch {
    }
    return null;
  }
  const singleton = desktopBallSingleton();
  const generation = ++singleton.generation;
  try {
    singleton.handle?.dispose();
  } catch {
  }
  singleton.handle = null;
  try {
    console.error("[dsh-assistant] \u684C\u9762\u60AC\u6D6E\u7403\uFF1A\u4F7F\u7528", exe);
  } catch {
  }
  const dir = join8(profileDir3(ctx), "dsh-assistant-ball");
  try {
    mkdirSync4(dir, { recursive: true });
    writeFileSync4(join8(dir, "package.json"), JSON.stringify({ name: "dsh-assistant-ball", version: "1.0.0", main: "main.js" }), "utf8");
    writeFileSync4(join8(dir, "main.js"), HELPER_MAIN, "utf8");
    const avatar = String(opts.avatar ?? "").trim();
    const safeAvatar = avatar.startsWith("data:image/") ? avatar.replace(/"/g, "&quot;") : "";
    const avatarScript = safeAvatar ? `<script>document.getElementById('b').innerHTML=${JSON.stringify(`<img src="${safeAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none" alt="">`)}</script>` : "";
    writeFileSync4(join8(dir, "index.html"), BALL_HTML.replace("</body>", `${avatarScript}</body>`), "utf8");
  } catch (err) {
    try {
      console.error("[dsh-assistant] \u5199\u60AC\u6D6E\u7403 helper \u5931\u8D25\uFF1A", err);
    } catch {
    }
    return null;
  }
  const token = randomBytes(16).toString("hex");
  let pendingIntent = null;
  const clickListeners = /* @__PURE__ */ new Set();
  let child = null;
  const authSockets = /* @__PURE__ */ new Set();
  const server = createServer((sock) => {
    let authed = false;
    let buf = "";
    authSockets.add(sock);
    sock.setTimeout(4e3);
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        if (!authed) {
          if (text === token) {
            authed = true;
            try {
              sock.write("ok\n");
            } catch {
            }
          } else {
            try {
              sock.destroy();
            } catch {
            }
          }
          continue;
        }
        if (text === "click" || text === "assistant") {
          const intent = text === "assistant" ? "assistant" : "console";
          pendingIntent = intent;
          for (const listener of [...clickListeners]) {
            try {
              listener(intent);
            } catch {
            }
          }
          setImmediate(() => {
            try {
              focusDesktopMainWindow();
            } catch {
            }
          });
        }
      }
    });
    sock.on("timeout", () => {
      if (!authed) {
        try {
          sock.destroy();
        } catch {
        }
      }
    });
    sock.on("error", () => {
    });
    sock.on("close", () => {
      authSockets.delete(sock);
    });
  });
  let port = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", (e) => reject(e));
      server.listen(0, "127.0.0.1");
    });
    port = Number(server.address()?.port) || 0;
  } catch {
    try {
      server.close();
    } catch {
    }
    return null;
  }
  if (!port) {
    try {
      server.close();
    } catch {
    }
    return null;
  }
  if (generation !== singleton.generation) {
    try {
      server.close();
    } catch {
    }
    return null;
  }
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RUN_AS_NODE_OPTIONS;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    let logFd = "ignore";
    try {
      logFd = openSync(join8(dir, "helper.log"), "a");
    } catch {
    }
    child = spawn2(exe, [dir, "--port", String(port), "--token", token], {
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      detached: false,
      env
    });
    try {
      console.error("[dsh-assistant] \u684C\u9762\u60AC\u6D6E\u7403 helper pid =", child.pid, "port =", port);
    } catch {
    }
    child.on("error", (e) => {
      try {
        console.error("[dsh-assistant] \u60AC\u6D6E\u7403 helper error\uFF1A", e?.message ?? e);
      } catch {
      }
    });
    child.on("exit", (code) => {
      try {
        console.error("[dsh-assistant] \u60AC\u6D6E\u7403 helper \u9000\u51FA\uFF0Ccode =", code);
      } catch {
      }
    });
  } catch (err) {
    try {
      console.error("[dsh-assistant] \u542F\u52A8 Electron \u60AC\u6D6E\u7403\u5931\u8D25\uFF1A", err);
    } catch {
    }
    try {
      server.close();
    } catch {
    }
    return null;
  }
  let disposed = false;
  let handle;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pendingIntent = null;
    clickListeners.clear();
    for (const s of authSockets) {
      try {
        s.destroy();
      } catch {
      }
    }
    try {
      server.close();
    } catch {
    }
    try {
      child?.kill();
    } catch {
    }
    child = null;
    if (singleton.handle === handle) singleton.handle = null;
  };
  handle = {
    dispose,
    takeClick: () => {
      const v = pendingIntent;
      pendingIntent = null;
      return v;
    },
    onClick: (listener) => {
      clickListeners.add(listener);
      return () => {
        clickListeners.delete(listener);
      };
    }
  };
  singleton.handle = handle;
  return handle;
}

// src/assistant-diagnostics.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, statSync as statSync5, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir7, tmpdir as tmpdir2 } from "node:os";
import { join as join9 } from "node:path";
import { createRequire as createRequire2 } from "node:module";
var MASK = "\xAB\u5DF2\u8131\u654F\xBB";
function knownRoots() {
  const home = homedir7();
  const dsHome = dshHome();
  const out = [];
  const push = (marker, path) => {
    const clean = String(path ?? "").trim();
    if (!clean) return;
    if (out.some((item) => item.path.toLowerCase() === clean.toLowerCase())) return;
    out.push({ marker, path: clean });
  };
  push("<PROFILE>", join9(dsHome, "profiles", "desktop"));
  push("<DSH>", dsHome);
  push("<ASSISTANT>", assistantHomeDir());
  push("<DESKTOP>", platformDesktopDir());
  push("<HOME>", home);
  push("<TMP>", tmpdir2());
  try {
    const config = loadAssistantConfig();
    push("<SKILLS>", config.skillRoot ? resolveNewProjectParent(config).parent : "");
    push("<SKILLROOT>", config.skillRoot ?? "");
    for (const root of config.allowedRoots) push("<ROOT>", root);
  } catch {
  }
  return out.sort((a, b) => b.path.length - a.path.length);
}
var SECRET_PATTERNS = [
  // key=value / "key": value 形态的秘密字段
  /(["']?(?:pin|token|cookie|authorization|secret|password|apikey|api_key|accessKey|accessToken|tunnelToken)["']?\s*[:=]\s*)["']?[^\s,"'&}]{1,200}/gi,
  // 「pin 12345678」「密码 12345678」这种空格形态（日志里最常见的写法）
  /\b(pin|passcode|密码|口令)\s+[A-Za-z0-9]{4,}/gi,
  // Bearer 与裸 32+ 位十六进制
  /\bBearer\s+[A-Za-z0-9._\-+/=]{6,}/gi,
  /\b[0-9a-f]{32,}\b/gi
];
function redactText(input, roots = knownRoots()) {
  let text = String(input ?? "");
  let replaced = 0;
  for (const root of roots) {
    const escaped = root.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped + `(?=[\\\\/]|$|[\\s"'\uFF0C\u3002\uFF1A])`, "gi");
    text = text.replace(pattern, () => {
      replaced += 1;
      return root.marker;
    });
  }
  text = text.replace(/(?:[A-Za-z]:[\\/])[^\s"',，。；;)}\]]{1,200}/g, () => {
    replaced += 1;
    return "<PATH>";
  });
  text = text.replace(/(?:\/Users|\/home)\/[^\s"',，。；;)}\]]{1,200}/g, () => {
    replaced += 1;
    return "<PATH>";
  });
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      replaced += 1;
      const keepShape = /^["']?[A-Za-z_]+["']?\s*[:=]\s*/.exec(match);
      return keepShape ? keepShape[0] + MASK : MASK;
    });
  }
  text = text.replace(/"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
    if (!/\b\d{6,8}\b/.test(inner)) return match;
    replaced += 1;
    return '"' + inner.replace(/\b\d{6,8}\b/g, MASK) + '"';
  });
  return { text, replaced };
}
function tailLines(path, maxLines = 120, maxBytes = 256 * 1024) {
  if (!existsSync6(path)) return { path, exists: false, lines: [], truncated: false };
  let raw = "";
  try {
    const size = statSync5(path).size;
    raw = readFileSync6(path, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    const truncated = size > maxBytes || lines.length > maxLines;
    return { path, exists: true, lines: lines.slice(-maxLines), truncated };
  } catch {
    return { path, exists: true, lines: [], truncated: true };
  }
}
function jsonSummary(path) {
  if (!existsSync6(path)) return { path, exists: false, summary: {} };
  try {
    const parsed = JSON.parse(readFileSync6(path, "utf8"));
    const record = parsed && typeof parsed === "object" ? parsed : {};
    const summary = {};
    for (const key of ["revision", "updatedAt", "savedAt", "version"]) {
      if (record[key] !== void 0) summary[key] = record[key];
    }
    for (const key of ["projects", "layouts", "folders", "bindings", "removed", "flows", "on", "off"]) {
      const value = record[key];
      if (Array.isArray(value)) summary[`${key}Count`] = value.length;
      else if (value && typeof value === "object") summary[`${key}Count`] = Object.keys(value).length;
    }
    return { path, exists: true, summary };
  } catch (err) {
    return { path, exists: true, summary: { parseError: String(err) } };
  }
}
function pocketDiagSummary(path, maxKeep = 12) {
  const empty = { path, exists: false, total: 0, byKind: {}, recent: [] };
  if (!existsSync6(path)) return empty;
  try {
    const lines = readFileSync6(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
    const byKind = {};
    for (const line of lines) {
      let kind = "unknown";
      try {
        kind = String(JSON.parse(line)?.kind ?? JSON.parse(line)?.event ?? "unknown");
      } catch {
      }
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const recent = lines.slice(-maxKeep).map((line) => {
      try {
        const entry = JSON.parse(line);
        const keep = {};
        for (const key of ["kind", "event", "at", "ts", "code", "status", "msg"]) {
          if (entry[key] !== void 0) keep[key] = typeof entry[key] === "string" ? String(entry[key]).slice(0, 160) : entry[key];
        }
        return keep;
      } catch {
        return { unparsed: true };
      }
    });
    return { path, exists: true, total: lines.length, byKind, recent };
  } catch {
    return { ...empty, exists: true };
  }
}
function versions() {
  const out = {};
  try {
    const require2 = createRequire2(import.meta.url);
    const pkg = require2("../package.json");
    out.package = `${pkg.name}@${pkg.version}`;
  } catch {
    out.package = "unknown";
  }
  try {
    const manifest = JSON.parse(readFileSync6(join9(process.cwd(), "dsh.plugin.json"), "utf8"));
    out.manifest = `${manifest?.name}@${manifest?.version}`;
  } catch {
    out.manifest = "unknown";
  }
  out.node = process.version;
  out.platform = `${process.platform} ${process.release?.lskVersion ?? ""}`.trim();
  try {
    out.dshVersion = process.env.DSH_VERSION ?? process.env.DSH_CLIENT_VERSION ?? "unknown";
  } catch {
    out.dshVersion = "unknown";
  }
  return out;
}
function collectDiagnostics(ctx) {
  const home = ensureAssistantHome();
  const dsHome = dshHome();
  const profileDir4 = (() => {
    try {
      const p = ctx?.get?.("profileContext");
      if (p && typeof p.dir === "string" && p.dir) return p.dir;
    } catch {
    }
    return join9(dsHome, "profiles", "desktop");
  })();
  const config = loadAssistantConfig();
  const bundle = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    versions: versions(),
    assistantHome: { dir: home.dir, usage: assistantHomeUsage() },
    focusLog: tailLines(join9(dsHome, "dsh-assistant-focus.log")),
    ballHelperLog: tailLines(join9(profileDir4, "dsh-assistant-ball", "helper.log")),
    pocketDiagnostic: pocketDiagSummary(join9(dsHome, "dsh-pocket", "diagnostic.jsonl")),
    stateFiles: {
      assistant: jsonSummary(join9(profileDir4, "dsh-assistant-state.json")),
      tuoguan: jsonSummary(join9(profileDir4, "dsh-tuoguan-state.json"))
    },
    localConfig: {
      sourceFile: config.sourceFile ? "<CONFIG>" : "",
      hasPersona: !!config.persona,
      asrTermCount: config.asrTerms.length,
      allowedRoots: defaultAllowedRoots(config),
      allowAllLocalPaths: config.allowAllLocalPaths === true,
      loadError: config.loadError || ""
    },
    // 不导出的东西列在这里：让看的人知道「这里故意不给」
    notCollected: ["dsh-pocket/settings.json\uFF08PIN / \u96A7\u9053 Token / cloudflared \u8DEF\u5F84\uFF09", "\u4F1A\u8BDD\u5185\u5BB9\u4E0E\u65E5\u5FD7\u672C\u4F53", "config.json \u91CC\u7684\u4E2A\u4EBA\u76EE\u5F55\u4E0E\u8BCD\u8868\u539F\u6587"],
    pidOfBall: (() => {
      try {
        return statSync5(join9(profileDir4, "dsh-assistant-ball", "helper.pid")).size;
      } catch {
        return 0;
      }
    })()
  };
  return bundle;
}
function renderDiagnosticsBundle(ctx) {
  const raw = JSON.stringify(collectDiagnostics(ctx), null, 2);
  const withConfigMasked = raw.replace(/"sourceFile":\s*"[^"]*"/g, `"sourceFile": "<CONFIG>"`);
  const redacted = redactText(withConfigMasked);
  return { text: redacted.text.replace(/<ASSISTANT>/g, "<ASSISTANT>"), replaced: redacted.replaced };
}
function writeDiagnosticsBundle(ctx) {
  const home = ensureAssistantHome();
  const { text, replaced } = renderDiagnosticsBundle(ctx);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const savedPath = join9(home.outputs, `diagnostics-${stamp}.json`);
  try {
    writeFileSync5(savedPath, text + "\n", { mode: 384 });
  } catch {
    writeFileSync5(savedPath, text + "\n", "utf8");
  }
  return { savedPath, bytes: Buffer.byteLength(text, "utf8"), replaced, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function registerAssistantDiagnostics(ctx) {
  const routes = manageWebRoutes(ctx.webServer);
  const webServer = routes.webServer;
  const sendJson6 = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  webServer.register({
    kind: "exact",
    path: "/api/assistant/diagnostics",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const { text, replaced } = renderDiagnosticsBundle(ctx);
        sendJson6(res, 200, { ok: true, redactedReplacements: replaced, bundle: JSON.parse(text) });
      } catch (err) {
        sendJson6(res, 500, { ok: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/diagnostics/export",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const result = writeDiagnosticsBundle(ctx);
        sendJson6(res, 200, { ok: true, ...result, outputsDir: ensureAssistantHome().outputs });
        try {
          ctx.logger?.info?.(`[dsh-assistant] \u8BCA\u65AD\u5305\u5DF2\u5BFC\u51FA\uFF1A${result.savedPath}\uFF08\u8131\u654F\u66FF\u6362 ${result.replaced} \u5904\uFF09`);
        } catch {
        }
      } catch (err) {
        sendJson6(res, 500, { ok: false, error: String(err) });
      }
    }
  });
  return routes.dispose;
}
var assistantDiagnosticsTestSurface = {
  redactText,
  collectDiagnostics,
  renderDiagnosticsBundle,
  writeDiagnosticsBundle,
  registerAssistantDiagnostics,
  maskConstant: MASK,
  secretPatterns: SECRET_PATTERNS.length
};

// src/assistant-archive.ts
import { createHash } from "node:crypto";
import { copyFileSync as copyFileSync3, existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync7, readdirSync as readdirSync3, statSync as statSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join10, dirname as dirname7, relative, isAbsolute } from "node:path";
var ARCHIVE_FORMAT = "dsh-assistant-archive";
var ARCHIVE_Areas = ["agents", "journal", "notes", "archive", "config", "memory", "state"];
var MAX_ITEM_BYTES = 4 * 1024 * 1024;
var MAX_BUNDLE_BYTES = 48 * 1024 * 1024;
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function stampNow() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
function collectArchive() {
  const home = ensureAssistantHome();
  const items = [];
  const push = (area, absPath, relPath) => {
    if (!existsSync7(absPath)) return;
    let content = "";
    try {
      if (statSync6(absPath).size > MAX_ITEM_BYTES) return;
      content = readFileSync7(absPath, "utf8");
    } catch {
      return;
    }
    items.push({ area, relPath, content, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) });
  };
  push("agents", join10(home.dir, "AGENTS.md"), "AGENTS.md");
  push("config", join10(home.dir, "config.json"), "config.json");
  for (const area of ["journal", "notes"]) {
    const dir = area === "journal" ? home.journal : home.notes;
    for (const rel of listFilesRecursively(dir)) push(area, join10(dir, rel), rel);
  }
  for (const rel of listFilesRecursively(home.archive)) push("archive", join10(home.archive, rel), rel);
  const memoryDir = runtimeMemoryDir();
  for (const name3 of ["USER.md", "MEMORY.md", "memories.json"]) push("memory", join10(memoryDir, name3), name3);
  const dsHome = dshHome();
  for (const name3 of ["dsh-assistant-state.json", "dsh-tuoguan-state.json"]) {
    for (const dir of [join10(dsHome, "profiles", "desktop"), dsHome]) {
      const abs = join10(dir, name3);
      if (existsSync7(abs)) {
        push("state", abs, name3);
        break;
      }
    }
  }
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const body = {
    format: ARCHIVE_FORMAT,
    version: readVersion(),
    generatedAt,
    areas: items.map((item) => item.area),
    items,
    totals: {
      items: items.length,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      journal: items.filter((item) => item.area === "journal").length,
      notes: items.filter((item) => item.area === "notes").length,
      archive: items.filter((item) => item.area === "archive").length
    }
  };
  const bundle = JSON.stringify({ ...body, checksum: sha256(items.map((item) => `${item.area}\0${item.relPath}\0${item.sha256}`).join("\n")) }, null, 2);
  return { bundle, items, totals: body.totals, generatedAt };
}
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync7(join10(process.cwd(), "package.json"), "utf8"));
    return String(pkg?.version ?? "unknown");
  } catch {
    return "unknown";
  }
}
function listFilesRecursively(root, base = "") {
  if (!existsSync7(root)) return [];
  const out = [];
  let names = [];
  try {
    names = readdirSync3(root);
  } catch {
    return [];
  }
  for (const name3 of names) {
    if (name3 === "node_modules" || name3.startsWith(".")) continue;
    const abs = join10(root, name3);
    const rel = base ? `${base}/${name3}` : name3;
    try {
      if (statSync6(abs).isDirectory()) out.push(...listFilesRecursively(abs, rel));
      else out.push(rel);
    } catch {
    }
  }
  return out;
}
function writeArchiveBundle() {
  const home = ensureAssistantHome();
  const exportsDir = join10(home.dir, "exports");
  mkdirSync6(exportsDir, { recursive: true });
  const { bundle, items, totals } = collectArchive();
  const savedPath = join10(exportsDir, `archive-${stampNow()}.json`);
  if (Buffer.byteLength(bundle, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`\u6863\u6848\u5305\u592A\u5927\uFF08${totals.bytes} \u5B57\u8282 > ${MAX_BUNDLE_BYTES}\uFF09\uFF0C\u5148\u6E05 archive/ \u6216\u6311\u7740\u5BFC`);
  }
  try {
    writeFileSync6(savedPath, bundle + "\n", { mode: 384 });
  } catch {
    writeFileSync6(savedPath, bundle + "\n", "utf8");
  }
  return { savedPath, bytes: Buffer.byteLength(bundle, "utf8"), items: items.length };
}
function importArchiveBundle(raw, knownPresets = [], dryRun = false) {
  const report = { ok: false, written: [], skipped: [], keptBoth: [], tombstonesIgnored: 0, missingPresets: [], totals: { items: 0, bytes: 0 } };
  const bundle = typeof raw === "string" ? safeParse(raw) : raw;
  if (!bundle || typeof bundle !== "object") {
    report.error = "bad-bundle";
    return report;
  }
  const body = bundle;
  if (body.format !== ARCHIVE_FORMAT) {
    report.error = `format \u4E0D\u662F ${ARCHIVE_FORMAT}`;
    return report;
  }
  if (!Array.isArray(body.items)) {
    report.error = "\u5305\u91CC\u6CA1\u6709 items \u5217\u8868";
    return report;
  }
  const checksum = sha256(body.items.map((item) => `${item.area}\0${item.relPath}\0${item.sha256}`).join("\n"));
  if (typeof body.checksum === "string" && body.checksum !== checksum) {
    report.error = "\u6821\u9A8C\u548C\u4E0D\u5BF9\uFF08\u5305\u88AB\u6539\u8FC7\u6216\u534A\u622A\uFF09\uFF0C\u62D2\u7EDD\u5BFC\u5165";
    return report;
  }
  const home = ensureAssistantHome();
  const stamp = stampNow();
  const backupDir = join10(home.archive, `import-backup-${stamp}`);
  if (!dryRun) mkdirSync6(backupDir, { recursive: true });
  const areaDir = (area) => {
    if (area === "journal") return home.journal;
    if (area === "notes") return home.notes;
    if (area === "archive") return home.archive;
    return home.dir;
  };
  for (const itemRaw of body.items) {
    const item = itemRaw;
    if (!item || typeof item.relPath !== "string" || typeof item.content !== "string") {
      report.skipped.push({ area: String(item?.area ?? "?"), relPath: String(item?.relPath ?? "?"), why: "\u6761\u76EE\u4E0D\u5B8C\u6574" });
      continue;
    }
    const area = String(item.area ?? "notes");
    if (!ARCHIVE_Areas.includes(area) || area === "state" || area === "config") {
      report.skipped.push({ area, relPath: item.relPath, why: area === "state" ? "\u72B6\u6001\u6587\u4EF6\u91CC\u7684\u5220\u9664\u5893\u7891\u4E0D\u5199\u56DE\uFF08\u5C0A\u91CD\u672C\u673A\u5220\u8FC7\u7684\u5361\u7247\uFF09" : "\u8FD9\u4E2A\u533A\u57DF\u4E0D\u63A5\u53D7\u5BFC\u5165" });
      if (area === "state") report.tombstonesIgnored += 1;
      continue;
    }
    const targetDir = areaDir(area);
    const target = join10(targetDir, item.relPath);
    const relCheck = relative(targetDir, target);
    if (!relCheck || relCheck.startsWith("..") || isAbsolute(item.relPath)) {
      report.skipped.push({ area, relPath: item.relPath, why: "\u8DEF\u5F84\u8D8A\u754C\uFF08\u4E0D\u8BB8\u8DF3\u51FA\u52A9\u624B\u5BB6\u76EE\u5F55\uFF09" });
      continue;
    }
    const incomingHash = sha256(item.content);
    if (existsSync7(target)) {
      let existing = "";
      try {
        existing = readFileSync7(target, "utf8");
      } catch {
        existing = "";
      }
      if (sha256(existing) === incomingHash) {
        report.skipped.push({ area, relPath: item.relPath, why: "\u5DF2\u7ECF\u6709\u4E00\u6A21\u4E00\u6837\u7684\u8FD9\u4EFD\uFF08\u5224\u91CD\u8DF3\u8FC7\uFF09" });
        continue;
      }
      const lastDot = item.relPath.lastIndexOf(".");
      const extension = lastDot > 0 ? item.relPath.slice(lastDot) : ".txt";
      const stem = lastDot > 0 ? item.relPath.slice(0, lastDot) : item.relPath;
      const altRel = `${stem}.imported-${stamp}${extension}`;
      const alt = join10(targetDir, altRel);
      if (!dryRun) {
        mkdirSync6(dirname7(alt), { recursive: true });
        writeFileSync6(alt, item.content, "utf8");
      }
      report.keptBoth.push({ area, relPath: item.relPath, wroteAs: altRel });
      report.totals.items += 1;
      report.totals.bytes += Buffer.byteLength(item.content, "utf8");
      continue;
    }
    if (!dryRun) {
      mkdirSync6(targetDir, { recursive: true });
      writeFileSync6(target, item.content, "utf8");
    }
    report.written.push({ area, relPath: item.relPath, as: item.relPath });
    report.totals.items += 1;
    report.totals.bytes += Buffer.byteLength(item.content, "utf8");
  }
  if (!dryRun) {
    try {
      for (const { label, dir } of [{ label: "journal", dir: home.journal }, { label: "notes", dir: home.notes }]) {
        for (const rel of listFilesRecursively(dir)) {
          const abs = join10(dir, rel);
          if (existsSync7(abs)) copyFileSync3(abs, join10(backupDir, `${label}_${rel.replace(/[\\/]/g, "_")}`));
        }
      }
      const agents = join10(home.dir, "AGENTS.md");
      if (existsSync7(agents)) copyFileSync3(agents, join10(backupDir, "AGENTS.md"));
    } catch {
    }
  }
  report.backupDir = dryRun ? void 0 : backupDir;
  const usedPresets = collectPresetIds(body);
  const known = new Set(knownPresets.map(String));
  report.missingPresets = usedPresets.filter((id) => !known.has(id));
  report.ok = true;
  report.dryRun = dryRun;
  return report;
}
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function collectPresetIds(body) {
  const found = /* @__PURE__ */ new Set();
  const visit = (value, depth = 0) => {
    if (depth > 8 || value === null || value === void 0) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed !== null) visit(parsed, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") return;
    const record = value;
    for (const key of ["preset", "presetId", "templateId"]) {
      const raw = record[key];
      if (typeof raw === "string" && raw.trim()) found.add(raw.trim());
    }
    for (const key of Object.keys(record)) visit(record[key], depth + 1);
  };
  visit(body, 0);
  return Array.from(found).sort();
}
function registerAssistantArchive(ctx) {
  const routes = manageWebRoutes(ctx.webServer);
  const webServer = routes.webServer;
  const sendJson6 = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  const readBody3 = async (req, limitBytes = MAX_BUNDLE_BYTES) => {
    if (!req || typeof req[Symbol.asyncIterator] !== "function") return {};
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limitBytes) {
        const sentinel = {};
        sentinel.__tooLarge = true;
        return sentinel;
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { __badJson: true };
    }
  };
  webServer.register({
    kind: "exact",
    path: "/api/assistant/archive",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const { bundle, items, totals } = collectArchive();
        sendJson6(res, 200, { ok: true, totals, count: items.length, bundle: JSON.parse(bundle) });
      } catch (err) {
        sendJson6(res, 500, { ok: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/archive/export",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const result = writeArchiveBundle();
        sendJson6(res, 200, { ok: true, ...result });
        try {
          ctx.logger?.info?.(`[dsh-assistant] \u52A9\u624B\u6863\u6848\u5DF2\u5BFC\u51FA\uFF1A${result.savedPath}\uFF08${result.items} \u9879\uFF09`);
        } catch {
        }
      } catch (err) {
        sendJson6(res, 500, { ok: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/assistant/archive/import",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = await readBody3(req);
      if (body?.__tooLarge) {
        sendJson6(res, 413, { ok: false, error: "\u5305\u592A\u5927\uFF08\u4E0A\u9650 48MB\uFF09" });
        return;
      }
      if (body?.__badJson) {
        sendJson6(res, 400, { ok: false, error: "body \u4E0D\u662F\u5408\u6CD5 JSON" });
        return;
      }
      const bundle = body?.bundle ?? body;
      const known = Array.isArray(body?.knownPresets) ? body.knownPresets.map(String) : [];
      const report = importArchiveBundle(bundle, known, body?.dryRun === true);
      sendJson6(res, report.ok ? 200 : 400, { ok: report.ok, ...report, restartRequired: report.ok && !report.dryRun ? true : false });
    }
  });
  return routes.dispose;
}
var assistantArchiveTestSurface = {
  ARCHIVE_FORMAT,
  ARCHIVE_Areas,
  collectArchive,
  writeArchiveBundle,
  importArchiveBundle,
  registerAssistantArchive,
  checksumOf: (items) => sha256(items.map((item) => `${item.area}\0${item.relPath}\0${item.sha256}`).join("\n"))
};

// src/assistant.ts
import { appendFileSync, mkdirSync as mkdirSync7, readFileSync as readFileSync8, rmSync, statSync as statSync7, writeFileSync as writeFileSync7 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as joinPathNode } from "node:path";
var FOCUS_DIAG_LOG = joinPathNode(homedir8(), ".dsh", "dsh-assistant-focus.log");
function appendFocusDiag(raw) {
  const text = String(raw ?? "").slice(0, 8e3);
  if (!text) return;
  try {
    if (statSync7(FOCUS_DIAG_LOG).size > 512 * 1024) writeFileSync7(FOCUS_DIAG_LOG, "");
  } catch {
  }
  appendFileSync(FOCUS_DIAG_LOG, text.replace(/\s+/g, " ") + "\n", "utf8");
}
var name2 = "dsh-assistant";
var inject = ["webServer", "sessions"];
function apply3(ctx, config = {}) {
  const disposers = [];
  const routes = manageWebRoutes(ctx.webServer);
  const webServer = routes.webServer;
  disposers.push(routes.dispose);
  try {
    const dispose = apply?.(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("worktable half failed: %s", String(err));
    } catch {
    }
    throw err;
  }
  try {
    const dispose = apply2?.(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("tuoguan half failed: %s", String(err));
    } catch {
    }
  }
  try {
    const dispose = registerAssistantState(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("state store failed: %s", String(err));
    } catch {
    }
  }
  try {
    const dispose = registerCoordinateMode(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("coordinate mode failed: %s", String(err));
    } catch {
    }
  }
  let nativeBall = false;
  let ballHandle = null;
  const ballDir = (() => {
    try {
      return ballProfileDir(ctx);
    } catch {
      return "";
    }
  })();
  const ballStateFile = ballDir ? joinPathNode(ballDir, "state.json") : "";
  const ballAvatarFile = ballDir ? joinPathNode(ballDir, "avatar.txt") : "";
  let pendingOpen = null;
  const clickWaiters = /* @__PURE__ */ new Set();
  const sendClick = (res, intent) => {
    if (res?.destroyed || res?.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ open: intent !== null, intent: intent ?? "console", longPoll: true }));
  };
  const finishClickWaiter = (waiter, intent, respond = true) => {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    clickWaiters.delete(waiter);
    if (respond) {
      try {
        sendClick(waiter.res, intent);
      } catch {
      }
    }
  };
  const takeOpenClick = () => {
    const native = ballHandle ? ballHandle.takeClick() : null;
    if (pendingOpen !== null) {
      const intent = pendingOpen;
      pendingOpen = null;
      return intent;
    }
    return native === "assistant" ? "assistant" : native === "console" ? "console" : null;
  };
  const wakeClickWaiters = () => {
    if (clickWaiters.size === 0) return;
    const intent = takeOpenClick();
    if (intent === null) return;
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, intent);
  };
  disposers.push(() => {
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, null);
  });
  const readBallState = () => {
    let enabled = true;
    let avatar = "";
    try {
      const parsed = JSON.parse(readFileSync8(ballStateFile, "utf8"));
      if (parsed && typeof parsed.enabled === "boolean") enabled = parsed.enabled;
    } catch {
    }
    try {
      avatar = readFileSync8(ballAvatarFile, "utf8");
    } catch {
    }
    return { enabled, avatar };
  };
  const ballState = readBallState();
  const saveBallState = () => {
    try {
      if (ballStateFile) {
        mkdirSync7(ballDir, { recursive: true });
        writeFileSync7(ballStateFile, JSON.stringify({ enabled: ballState.enabled }), "utf8");
      }
      if (ballAvatarFile) {
        if (ballState.avatar) writeFileSync7(ballAvatarFile, ballState.avatar, "utf8");
        else rmSync(ballAvatarFile, { force: true });
      }
    } catch (err) {
      try {
        ctx.logger?.("dsh-assistant")?.error?.("save ball state failed: %s", String(err));
      } catch {
      }
    }
  };
  const applyBall = async () => {
    if (ballHandle) {
      try {
        ballHandle.dispose();
      } catch {
      }
      ballHandle = null;
      nativeBall = false;
    }
    if (!ballState.enabled) return;
    try {
      const handle = await startDesktopBall(ctx, { avatar: ballState.avatar });
      if (!handle) return;
      ballHandle = handle;
      nativeBall = true;
      const offClick = handle.onClick?.(wakeClickWaiters);
      disposers.push(() => {
        try {
          offClick?.();
          handle.dispose();
        } catch {
        }
      });
      try {
        ctx.logger?.("dsh-assistant")?.info?.("desktop ball started");
      } catch {
      }
    } catch (err) {
      try {
        ctx.logger?.("dsh-assistant")?.error?.("desktop ball failed: %s", String(err));
      } catch {
      }
    }
  };
  const readSmallJson = (req, limit = 2 * 1024 * 1024) => new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      if (raw.length < limit) raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
  try {
    webServer.register({
      kind: "exact",
      path: "/api/assistant/ball",
      handler: (req, res) => {
        const method = String(req.method ?? "GET").toUpperCase();
        if (method === "POST") {
          void readSmallJson(req).then((body) => {
            if (typeof body?.enabled === "boolean") ballState.enabled = body.enabled;
            saveBallState();
            void applyBall();
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: true, native: nativeBall, enabled: ballState.enabled }));
          });
          return;
        }
        const payload = JSON.stringify({ native: nativeBall, enabled: ballState.enabled, hasAvatar: !!ballState.avatar });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(payload);
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/ball-avatar",
      handler: (req, res) => {
        const method = String(req.method ?? "GET").toUpperCase();
        if (method === "GET") {
          const payload = JSON.stringify({ avatar: ballState.avatar });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(payload);
          return;
        }
        if (method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        void readSmallJson(req).then((body) => {
          const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
          if (dataUrl && !dataUrl.startsWith("data:image/")) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "invalid-image" }));
            return;
          }
          ballState.avatar = dataUrl.slice(0, 15e5);
          saveBallState();
          void applyBall();
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, hasAvatar: !!ballState.avatar }));
        });
      }
    });
    webServer.register({
      kind: "exact",
      path: CONSOLE_SEA01_ROUTE,
      handler: (req, res) => {
        void serveConsoleSea01(req, res);
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/models",
      handler: (_req, res) => {
        void (async () => {
          try {
            const controller = ctx.get?.("sessionController") ?? ctx.sessionController;
            const catalog = await controller?.modelCatalog?.();
            if (!catalog) throw new Error("model catalog unavailable");
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: true, catalog }));
          } catch (err) {
            try {
              res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
            } catch {
            }
          }
        })();
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/open-console",
      handler: (_req, res) => {
        pendingOpen = "console";
        wakeClickWaiters();
        const payload = JSON.stringify({ ok: true, opened: true });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(payload);
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/open-assistant",
      handler: (_req, res) => {
        pendingOpen = "assistant";
        wakeClickWaiters();
        const payload = JSON.stringify({ ok: true, opened: true, intent: "assistant" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(payload);
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/focus-diag",
      handler: (req, res) => {
        let raw = "";
        try {
          req.on("data", (chunk) => {
            if (raw.length < 8e3) raw += String(chunk);
          });
          req.on("end", () => {
            try {
              appendFocusDiag(raw);
            } catch {
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: true }));
          });
          req.on("error", () => {
            try {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false }));
            } catch {
            }
          });
        } catch {
          try {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false }));
          } catch {
          }
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/api/assistant/ball-click",
      handler: (req, res) => {
        const pending = takeOpenClick();
        if (pending !== null) {
          sendClick(res, pending);
          return;
        }
        const wantsWait = /[?&]wait=1(?:&|$)/.test(String(req.url ?? ""));
        if (!wantsWait) {
          sendClick(res, null);
          return;
        }
        const waiter = { res, timer: null, done: false };
        waiter.timer = setTimeout(() => finishClickWaiter(waiter, null), 15e3);
        clickWaiters.add(waiter);
        req.on("close", () => finishClickWaiter(waiter, null, false));
      }
    });
    disposers.push(registerAssistantHome(ctx));
    disposers.push(registerAssistantConfigRoutes(ctx));
    disposers.push(registerAssistantDiagnostics(ctx));
    disposers.push(registerAssistantArchive(ctx));
  } catch {
  }
  void applyBall();
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}
export {
  ARCHIVE_FORMAT,
  apply3 as apply,
  assistantArchiveTestSurface,
  assistantConfigTestSurface,
  assistantDiagnosticsTestSurface,
  assistantMemoryTestSurface,
  collectArchive,
  createPathGuard,
  defaultAllowedRoots,
  expandHome,
  importArchiveBundle,
  inject,
  isDirectory,
  minimalTermEnv,
  name2 as name,
  redactText,
  registerAssistantArchive,
  registerAssistantDiagnostics,
  registerAssistantHome,
  renderDiagnosticsBundle,
  writeArchiveBundle,
  writeDiagnosticsBundle
};
