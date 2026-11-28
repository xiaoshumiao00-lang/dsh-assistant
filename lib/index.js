// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync as readdirSync2, realpathSync as realpathSync2 } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname as dirname4, resolve as pathResolve, sep as sep2 } from "node:path";
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
import { existsSync as existsSync5, realpathSync, statSync as statSync4 } from "node:fs";
import { dirname as dirname3, resolve as resolvePath4 } from "node:path";

// src/assistant-home.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, readdirSync, readFileSync as readFileSync4, renameSync as renameSync4, rmdirSync, statSync as statSync3, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4, resolve as resolvePath3, sep } from "node:path";

// src/assistant-config.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2, isAbsolute, join as join2, resolve as resolvePath } from "node:path";

// src/assistant-escape-hatch.ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
var ESCAPE_HATCH_FILENAME = "escape-hatch.json";
function escapeHatchFile() {
  return join(assistantHomeDir(), ESCAPE_HATCH_FILENAME);
}
function createEscapeHatchToken() {
  return randomBytes(18).toString("base64url");
}
function parseRecord(raw) {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.token !== "string" || parsed.token.length < 16) return null;
    return { token: parsed.token, createdAt: String(parsed.createdAt ?? ""), rotatedAt: String(parsed.rotatedAt ?? "") };
  } catch {
    return null;
  }
}
function writeRecord(record) {
  const file = escapeHatchFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 384 });
    if (process.platform !== "win32") {
      try {
        chmodSync(tmp, 384);
      } catch {
      }
    }
    renameSync(tmp, file);
    return { ok: true, record };
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
    }
    return { ok: false, error: "hatch-write-failed: " + String(err?.message ?? err) };
  }
}
function rotateEscapeHatch() {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return writeRecord({ token: createEscapeHatchToken(), createdAt: now, rotatedAt: now });
}
function ensureEscapeHatch() {
  const file = escapeHatchFile();
  let text = "";
  try {
    if (existsSync(file)) text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: "hatch-unreadable: " + String(err?.message ?? err) };
  }
  if (text) {
    const record = parseRecord(text);
    if (record) return { ok: true, record };
  }
  return rotateEscapeHatch();
}
function verifyEscapeHatchConfirm(value) {
  if (typeof value !== "string") return false;
  const candidate = Buffer.from(value, "utf8");
  if (candidate.length === 0 || candidate.length > 256) return false;
  const result = ensureEscapeHatch();
  if (!result.ok) return false;
  const expected = Buffer.from(result.record.token, "utf8");
  if (expected.length === 0) return false;
  if (candidate.length !== expected.length) {
    const pad = Buffer.alloc(expected.length);
    timingSafeEqual(pad, expected);
    return false;
  }
  try {
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
function rotateEscapeHatchAfterUse() {
  return rotateEscapeHatch();
}
function escapeHatchStatus() {
  const file = escapeHatchFile();
  let exists = false;
  try {
    exists = existsSync(file);
  } catch {
  }
  const record = exists ? parseRecordSafe(file) : null;
  return { file, exists: Boolean(record), tokenLength: record?.token.length ?? 0 };
}
function parseRecordSafe(file) {
  try {
    return parseRecord(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
var escapeHatchTestSurface = {
  escapeHatchFile,
  escapeHatchStatus,
  ensureEscapeHatch,
  rotateEscapeHatch,
  createEscapeHatchToken,
  verifyEscapeHatchConfirm
};

// src/assistant-config.ts
var WRITABLE_CONFIG_FIELDS = [
  "newProjectParent",
  "skillRoot",
  "asrTerms",
  "allowedRoots",
  "allowAllLocalPaths",
  "persona",
  "termEnvAllow",
  "updateSource",
  "updateCheckEnabled"
];
var LOOPBACK_ONLY_CONFIG_FIELDS = ["allowAllLocalPaths", "allowedRoots"];
var LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
var POCKET_SOURCE_MARKER = "x-dsh-pocket-source";
function hostNameOf(value) {
  let name3 = String(value ?? "").trim().toLowerCase();
  if (name3.startsWith("[")) {
    const end = name3.indexOf("]");
    if (end >= 0) name3 = name3.slice(1, end);
  } else {
    name3 = name3.replace(/:\d+$/, "");
  }
  return name3;
}
function headerOf(req, name3) {
  const raw = req?.headers?.[name3];
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  return String(raw ?? "");
}
function requestLoopback(req) {
  const marker = headerOf(req, POCKET_SOURCE_MARKER).trim().toLowerCase();
  if (marker === "lan" || marker === "public") return { loopback: false, reason: `pocket-proxy:${marker}` };
  if (headerOf(req, "cf-connecting-ip").trim()) return { loopback: false, reason: "cf-connecting-ip" };
  if (marker === "loopback") return { loopback: true, reason: "pocket-proxy:loopback" };
  const host = hostNameOf(headerOf(req, "host"));
  if (!host) {
    const addr = String(req?.socket?.remoteAddress ?? "").trim().toLowerCase();
    if (addr && (LOOPBACK_HOSTNAMES.has(addr) || addr === "0.0.0.0" || /^127\./.test(addr))) return { loopback: true, reason: "socket-loopback" };
    return { loopback: false, reason: "no-host-header" };
  }
  if (LOOPBACK_HOSTNAMES.has(host) || host === "0.0.0.0" || /^127\./.test(host)) return { loopback: true, reason: "host-loopback" };
  return { loopback: false, reason: `host:${host}` };
}
var EMPTY = {
  newProjectParent: null,
  skillRoot: null,
  asrTerms: [],
  allowedRoots: [],
  allowAllLocalPaths: false,
  persona: null,
  termEnvAllow: [],
  updateSource: "",
  updateCheckEnabled: false,
  sourceFile: "",
  loadError: ""
};
var MAX_BODY_BYTES = 256 * 1024;
var MAX_PATH_CHARS = 4096;
var MAX_ASR_TERMS = 500;
var MAX_ROOTS = 200;
var MAX_TERM_ENV = 100;
var MAX_PERSONA_LINES = 200;
var MAX_LINE_CHARS = 2e3;
function assistantConfigCandidates() {
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? "").trim();
  if (env) return [resolvePath(env.replace(/^~(?=$|[\\/])/, homedir()))];
  const out = [];
  out.push(join2(assistantHomeDir(), "config.json"));
  const home = dshHome();
  out.push(join2(home, "dsh-assistant-config.json"));
  out.push(join2(home, "assistant", "dsh-assistant-config.json"));
  return out;
}
function dshHome() {
  const env = process.env.DSH_HOME;
  const value = env !== void 0 && env.trim().length > 0 ? env : join2(homedir(), ".dsh");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolvePath(homedir(), value.slice(2));
  return resolvePath(value);
}
function platformDesktopDir() {
  const names = ["Desktop", "\u684C\u9762"];
  for (const name3 of names) {
    for (const base of [homedir(), process.env.USERPROFILE ?? "", process.env.OneDrive ?? ""]) {
      if (!base) continue;
      const candidate = join2(base, name3);
      try {
        if (existsSync2(candidate) && statSync(candidate).isDirectory()) return resolvePath(candidate);
      } catch {
      }
    }
  }
  return null;
}
function resolveSkillRoot(cfg = loadAssistantConfig()) {
  const configured = String(cfg.skillRoot ?? "").trim();
  if (configured) return { root: resolvePath(configured.replace(/^~(?=$|[\\/])/, homedir())), from: "config" };
  return { root: join2(dshHome(), "skills"), from: "dshHome" };
}
function resolveNewProjectParent(cfg = loadAssistantConfig()) {
  const configured = String(cfg.newProjectParent ?? "").trim();
  if (configured) return { parent: resolvePath(configured.replace(/^~(?=$|[\\/])/, homedir())), from: "config" };
  const desktop = platformDesktopDir();
  if (desktop) return { parent: desktop, from: "desktop" };
  return { parent: join2(assistantHomeDir(), "projects"), from: "assistant" };
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
      return existsSync2(path) && statSync(path).isFile();
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
    const raw = JSON.parse(stripBom(readFileSync2(file, "utf8")));
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
      updateSource: typeof parsed.updateSource === "string" ? parsed.updateSource.trim() : "",
      updateCheckEnabled: parsed.updateCheckEnabled === true,
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
  const skill = resolveSkillRoot(cfg);
  const persona = cfg.persona;
  return {
    ok: true,
    newProjectParent: resolved.parent,
    newProjectParentSource: resolved.from,
    skillRoot: skill.root,
    skillRootSource: skill.from,
    assistantHome: assistantHomeDir(),
    asrTerms: cfg.asrTerms,
    persona: persona ? { title: persona.title ?? "\u672C\u673A\u4EBA\u8BBE", lines: persona.lines ?? [] } : null,
    allowedRoots: cfg.allowedRoots,
    allowAllLocalPaths: cfg.allowAllLocalPaths,
    termEnvAllow: cfg.termEnvAllow,
    updateSource: cfg.updateSource,
    updateCheckEnabled: cfg.updateCheckEnabled,
    configSource: cfg.sourceFile,
    configError: cfg.loadError || void 0
  };
}
function bad(field, error) {
  return { ok: false, field, error };
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizePathField(value) {
  if (typeof value !== "string") return void 0;
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_PATH_CHARS) return void 0;
  if (/[\u0000-\u001f]/.test(text)) return void 0;
  const expanded = text.replace(/^~(?=$|[\\/])/, homedir());
  return isAbsolute(expanded) ? text : void 0;
}
function validateAssistantConfigPatch(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: "expected-object" };
  const target = isPlainObject(raw.config) ? raw.config : raw;
  const patch = {};
  for (const key of Object.keys(target)) {
    if (key === "config" || key === "confirm") continue;
    if (!WRITABLE_CONFIG_FIELDS.includes(key)) return bad(key, "unknown-field");
  }
  if ("newProjectParent" in target) {
    const value = normalizePathField(target.newProjectParent);
    if (value === void 0) return bad("newProjectParent", "expected-absolute-path");
    patch.newProjectParent = value;
  }
  if ("skillRoot" in target) {
    const value = normalizePathField(target.skillRoot);
    if (value === void 0) return bad("skillRoot", "expected-absolute-path");
    patch.skillRoot = value;
  }
  if ("asrTerms" in target) {
    const raw_ = target.asrTerms;
    if (!Array.isArray(raw_)) return bad("asrTerms", "expected-array");
    if (raw_.length > MAX_ASR_TERMS) return bad("asrTerms", "too-many");
    const terms = [];
    for (let i = 0; i < raw_.length; i++) {
      const item = raw_[i];
      if (!isPlainObject(item)) return bad("asrTerms", `item-${i}-expected-object`);
      const pattern = item.pattern;
      const replace = item.replace;
      if (typeof pattern !== "string" || pattern === "" || pattern.length > 500) return bad("asrTerms", `item-${i}-bad-pattern`);
      if (typeof replace !== "string" || replace === "" || replace.length > 500) return bad("asrTerms", `item-${i}-bad-replace`);
      const flags = item.flags;
      if (flags !== void 0 && (typeof flags !== "string" || !/^[a-z]*$/.test(flags))) return bad("asrTerms", `item-${i}-bad-flags`);
      terms.push(flags ? { pattern, replace, flags } : { pattern, replace });
    }
    patch.asrTerms = terms;
  }
  if ("allowedRoots" in target) {
    const raw_ = target.allowedRoots;
    if (!Array.isArray(raw_)) return bad("allowedRoots", "expected-array");
    if (raw_.length > MAX_ROOTS) return bad("allowedRoots", "too-many");
    const roots = [];
    for (let i = 0; i < raw_.length; i++) {
      const value = normalizePathField(raw_[i]);
      if (value === void 0 || value === null) return bad("allowedRoots", `item-${i}-expected-absolute-path`);
      roots.push(value);
    }
    patch.allowedRoots = roots;
  }
  if ("allowAllLocalPaths" in target) {
    if (typeof target.allowAllLocalPaths !== "boolean") return bad("allowAllLocalPaths", "expected-boolean");
    patch.allowAllLocalPaths = target.allowAllLocalPaths;
  }
  if ("persona" in target) {
    const raw_ = target.persona;
    if (raw_ === null) patch.persona = null;
    else {
      const persona = normalizePersonaForWrite(raw_);
      if (persona === void 0) return bad("persona", "bad-persona");
      patch.persona = persona;
    }
  }
  if ("termEnvAllow" in target) {
    const raw_ = target.termEnvAllow;
    if (!Array.isArray(raw_)) return bad("termEnvAllow", "expected-array");
    if (raw_.length > MAX_TERM_ENV) return bad("termEnvAllow", "too-many");
    const names = [];
    for (let i = 0; i < raw_.length; i++) {
      const value = raw_[i];
      if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())) return bad("termEnvAllow", `item-${i}-bad-name`);
      const name3 = value.trim().toUpperCase();
      if (!names.includes(name3)) names.push(name3);
    }
    patch.termEnvAllow = names;
  }
  if ("updateSource" in target) {
    const raw_ = target.updateSource;
    if (typeof raw_ !== "string") return bad("updateSource", "expected-string");
    const value = raw_.trim();
    if (value !== "" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return bad("updateSource", "expected-owner-repo");
    patch.updateSource = value;
  }
  if ("updateCheckEnabled" in target) {
    if (typeof target.updateCheckEnabled !== "boolean") return bad("updateCheckEnabled", "expected-boolean");
    patch.updateCheckEnabled = target.updateCheckEnabled;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "nothing-to-change" };
  return { ok: true, patch };
}
function normalizePersonaForWrite(raw) {
  if (typeof raw === "string") {
    const lines2 = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines2.length > MAX_PERSONA_LINES) return void 0;
    if (lines2.some((line) => line.length > MAX_LINE_CHARS)) return void 0;
    return lines2.length ? { lines: lines2 } : null;
  }
  if (!isPlainObject(raw)) return void 0;
  const title = raw.title === void 0 ? "" : raw.title;
  if (typeof title !== "string" || title.length > 200) return void 0;
  const linesRaw = raw.lines === void 0 ? [] : raw.lines;
  if (!Array.isArray(linesRaw)) return void 0;
  if (linesRaw.length > MAX_PERSONA_LINES) return void 0;
  const lines = [];
  for (const line of linesRaw) {
    if (typeof line !== "string" || line.length > MAX_LINE_CHARS) return void 0;
    const text = line.trim();
    if (text) lines.push(text);
  }
  if (!lines.length && !title.trim()) return null;
  return { ...title.trim() ? { title: title.trim() } : {}, ...lines.length ? { lines } : {} };
}
function configWriteTarget(cfg = loadAssistantConfig()) {
  if (cfg.sourceFile) return cfg.sourceFile;
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? "").trim();
  if (env) return resolvePath(env.replace(/^~(?=$|[\\/])/, homedir()));
  return join2(assistantHomeDir(), "config.json");
}
function writeAssistantConfig(patch) {
  if (!patch || Object.keys(patch).length === 0) return { ok: false, error: "nothing-to-change" };
  const before = loadAssistantConfig();
  const file = configWriteTarget(before);
  let base = {};
  try {
    if (existsSync2(file)) {
      const parsed = JSON.parse(stripBom(readFileSync2(file, "utf8")));
      if (!isPlainObject(parsed)) return { ok: false, error: "config-not-object" };
      base = parsed;
    }
  } catch (err) {
    return { ok: false, error: "config-unreadable: " + String(err?.message ?? err) };
  }
  const next = { ...base };
  for (const key of WRITABLE_CONFIG_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === void 0) delete next[key];
    else next[key] = value;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync2(dirname2(file), { recursive: true });
    writeFileSync2(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 384 });
    renameSync2(tmp, file);
  } catch (err) {
    try {
      if (existsSync2(tmp)) unlinkSync2(tmp);
    } catch {
    }
    try {
      cache = null;
    } catch {
    }
    return { ok: false, error: "write-failed: " + String(err?.message ?? err) };
  }
  cache = null;
  return { ok: true, file, config: loadAssistantConfig(true) };
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  } catch {
  }
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return { ok: false, error: "too-large", status: 413 };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "read-failed", status: 400 };
  }
  if (size === 0) return { ok: false, error: "empty-body", status: 400 };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "invalid-json", status: 400 };
  }
}
function applyConfigSideEffects(ctx) {
  try {
    const guard = ctx?.get?.("assistantPathGuard");
    if (guard && typeof guard.refresh === "function") guard.refresh();
  } catch {
  }
  try {
    if (typeof syncPersonaSection === "function") syncPersonaSection();
  } catch (err) {
    try {
      ctx?.logger?.("dsh-assistant")?.warn?.("persona sync failed: %s", String(err));
    } catch {
    }
  }
}
function registerAssistantConfigRoutes(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  routes.webServer.register({
    kind: "exact",
    path: "/api/assistant/config",
    handler: async (req, res) => {
      const method = String(req?.method ?? "GET").toUpperCase();
      try {
        if (method === "GET" || method === "HEAD") {
          sendJson(res, 200, assistantConfigClientView());
          return;
        }
        if (method === "POST" || method === "PUT") {
          const read = await readJsonBody(req);
          if (!read.ok) {
            sendJson(res, read.status, { ok: false, error: read.error });
            return;
          }
          const validated = validateAssistantConfigPatch(read.body);
          if (!validated.ok) {
            sendJson(res, 400, { ok: false, error: validated.error, ...validated.field ? { field: validated.field } : {} });
            return;
          }
          const dangerous = LOOPBACK_ONLY_CONFIG_FIELDS.filter((field) => field in validated.patch);
          if (dangerous.length > 0) {
            const source = requestLoopback(req);
            if (!source.loopback) {
              sendJson(res, 403, {
                ok: false,
                error: "loopback-only",
                field: dangerous.join(","),
                hint: `${dangerous.join(" / ")} \u53EA\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\u6539\uFF08\u6765\u6E90\u5224\u5B9A\uFF1A${source.reason}\uFF09`
              });
              return;
            }
          }
          const body = read.body;
          if (validated.patch.allowAllLocalPaths === true && !verifyEscapeHatchConfirm(body?.confirm)) {
            const hatch = escapeHatchStatus();
            sendJson(res, 400, {
              ok: false,
              error: "confirm-required",
              field: "allowAllLocalPaths",
              hint: `allowAllLocalPaths \u9700\u8981\u672C\u673A\u4E00\u6B21\u6027\u53E3\u4EE4\uFF08\u53E3\u4EE4\u957F ${hatch.tokenLength} \u4F4D\uFF0C\u53EA\u5728\u8FD9\u53F0\u7535\u8111\u7684\u8BBE\u7F6E\u9875\u663E\u793A\uFF0C\u4E0D\u5728\u6E90\u7801/\u4ED3\u5E93/\u6784\u5EFA\u4EA7\u7269\u91CC\uFF09`
            });
            return;
          }
          const result = writeAssistantConfig(validated.patch);
          if (!result.ok) {
            sendJson(res, 500, { ok: false, error: result.error });
            return;
          }
          applyConfigSideEffects(ctx);
          if (validated.patch.allowAllLocalPaths === true) {
            try {
              rotateEscapeHatchAfterUse();
            } catch {
            }
          }
          sendJson(res, 200, { ...assistantConfigClientView(), saved: Object.keys(validated.patch), file: result.file });
          return;
        }
        res.writeHead(405, { allow: "GET, HEAD, POST, PUT" });
        res.end();
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }
  });
  routes.webServer.register({
    kind: "exact",
    path: "/api/assistant/escape-hatch",
    handler: async (req, res) => {
      const method = String(req?.method ?? "GET").toUpperCase();
      try {
        const source = requestLoopback(req);
        if (!source.loopback) {
          sendJson(res, 403, {
            ok: false,
            error: "loopback-only",
            hint: `\u9003\u751F\u53E3\u4EE4\u53EA\u5728\u8FD9\u53F0\u7535\u8111\u7684\u8BBE\u7F6E\u9875\u663E\u793A\uFF08\u6765\u6E90\u5224\u5B9A\uFF1A${source.reason}\uFF09`
          });
          return;
        }
        if (method !== "GET" && method !== "HEAD" && method !== "POST") {
          res.writeHead(405, { allow: "GET, HEAD, POST" });
          res.end();
          return;
        }
        const hatch = method === "GET" || method === "HEAD" ? ensureEscapeHatch() : rotateEscapeHatchAfterUse();
        if (!hatch.ok) {
          sendJson(res, 500, { ok: false, error: hatch.error });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          token: hatch.record.token,
          createdAt: hatch.record.createdAt,
          rotatedAt: hatch.record.rotatedAt,
          file: escapeHatchStatus().file,
          loopback: true
        });
        return;
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
  resolveSkillRoot,
  assistantConfigClientView,
  resetAssistantConfigCacheForTests,
  platformDesktopDir,
  dshHome,
  configWriteTarget,
  validateAssistantConfigPatch,
  writeAssistantConfig,
  registerAssistantConfigRoutes,
  requestLoopback,
  LOOPBACK_ONLY_CONFIG_FIELDS,
  WRITABLE_CONFIG_FIELDS
};

// src/assistant-memory.ts
import { copyFileSync, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync3, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, resolve as resolvePath2 } from "node:path";
var MEMORY_ENTRY_SEPARATOR = "\xA7";
function runtimeMemoryDir() {
  const override = String(process.env.MNEMON_DATA_DIR ?? "").trim();
  if (override !== "") return override.replace(/^~(?=$|[\\/])/, homedir2());
  return join3(homedir2(), ".mnemon", "runtime");
}
function readText(path, limit = 400 * 1024) {
  try {
    if (!existsSync3(path) || !statSync2(path).isFile()) return "";
    if (statSync2(path).size > limit) return "";
    return readFileSync3(path, "utf8");
  } catch {
    return "";
  }
}
function backupPath(path, stamp2) {
  return `${path}.dsh-assistant-backup-${stamp2}`;
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
    mkdirSync3(resolvePath2(path, ".."), { recursive: true });
  } catch {
  }
  const tmp = `${path}.dsh-assistant-tmp`;
  writeFileSync3(tmp, text, "utf8");
  renameSync3(tmp, path);
}
function targetOf(item) {
  return String(item?.target ?? "memory");
}
function contentOf(item) {
  return String(item?.content ?? "");
}
function readStore(dir) {
  const path = join3(dir, "memories.json");
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
  const projection = join3(dir, target === "user" ? "USER.md" : "MEMORY.md");
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
    bytes = existsSync3(projection) ? statSync2(projection).size : 0;
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
  const stamp2 = Date.now();
  const backups = [];
  try {
    copyFileSync(store.path, backupPath(store.path, stamp2));
    backups.push(backupPath(store.path, stamp2));
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
        copyFileSync(view.projection, backupPath(view.projection, stamp2));
        backups.push(backupPath(view.projection, stamp2));
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
  const stamp2 = Date.now();
  const backups = [];
  try {
    copyFileSync(store.path, backupPath(store.path, stamp2));
    backups.push(backupPath(store.path, stamp2));
    writeAtomic(store.path, JSON.stringify({ ...store.data, entries: entries.filter((item) => targetOf(item) !== target) }, null, 2));
  } catch {
    return { ok: false, error: "backup-or-write-failed" };
  }
  let projectionRemoved = 0;
  try {
    const view = targetView(target, dir, []);
    if (existsSync3(view.projection)) {
      copyFileSync(view.projection, backupPath(view.projection, stamp2));
      backups.push(backupPath(view.projection, stamp2));
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
  return override !== "" ? override : join4(homedir3(), ".dsh", "assistant");
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
function applyPersonaSection(text, block) {
  const start = text.indexOf(PERSONA_BEGIN);
  const end = text.indexOf(PERSONA_END);
  if (start >= 0 && end > start) {
    const before = text.slice(0, start).replace(/\s*$/, "\n\n");
    const after = text.slice(end + PERSONA_END.length).replace(/^\s*\n/, "");
    if (block === "") return (before + after).replace(/\n{3,}/g, "\n\n");
    return before + block + "\n\n" + after.replace(/^\n+/, "");
  }
  if (block === "") return text;
  if (text.includes("\u4F60\u662F\u8FD9\u4E2A\u52A9\u624B\u76EE\u5F55\u4E3B\u4EBA\u7684\u79C1\u4EBA\u52A9\u624B")) return text.replace(/\s*$/, "\n\n") + block;
  return text;
}
function ensureAssistantHome() {
  const dir = assistantHomeDir();
  const journal = join4(dir, "journal");
  const notes = join4(dir, "notes");
  const outputs = join4(dir, "outputs");
  const archive = join4(dir, "archive");
  const agentsFile = join4(dir, "AGENTS.md");
  for (const path of [dir, journal, notes, outputs, archive]) {
    try {
      mkdirSync4(path, { recursive: true });
    } catch {
    }
  }
  try {
    const persona = personaBlockFromConfig();
    if (!existsSync4(agentsFile)) {
      writeFileSync4(agentsFile, AGENTS_MD + HOME_RULES_MD + ARCHIVE_RULES_MD + persona, "utf8");
    } else {
      let current = readFileSync4(agentsFile, "utf8");
      let changed = false;
      if (current.includes(AGENTS_MARKER) && !current.includes(HOME_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + HOME_RULES_MD;
        changed = true;
      }
      if (current.includes(AGENTS_MARKER) && !current.includes(ARCHIVE_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + ARCHIVE_RULES_MD;
        changed = true;
      }
      const withPersona = applyPersonaSection(current, persona);
      if (withPersona !== current) {
        current = withPersona;
        changed = true;
      }
      if (changed) writeFileSync4(agentsFile, current, "utf8");
    }
  } catch {
  }
  return { dir, journal, notes, agentsFile, outputs, archive };
}
function syncPersonaSection() {
  const dir = assistantHomeDir();
  const file = join4(dir, "AGENTS.md");
  let before = "";
  try {
    before = existsSync4(file) ? readFileSync4(file, "utf8") : "";
  } catch {
  }
  const home = ensureAssistantHome();
  let after = "";
  try {
    after = readFileSync4(home.agentsFile, "utf8");
  } catch {
  }
  return { changed: before !== after, file: home.agentsFile };
}
function dirUsage(root) {
  let bytes = 0;
  let files = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join4(root, entry.name);
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
  const journal = dirUsage(join4(dir, "journal"));
  const notes = dirUsage(join4(dir, "notes"));
  const outputs = dirUsage(join4(dir, "outputs"));
  const archive = dirUsage(join4(dir, "archive"));
  let agents = 0;
  try {
    agents = statSync3(join4(dir, "AGENTS.md")).size;
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
  const root = resolvePath3(join4(assistantHomeDir(), "outputs"));
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
      const path = join4(dir, entry.name);
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
        unlinkSync3(real);
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
      const path = join4(current, entry.name);
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
  const targetDir = join4(archiveRoot, ...sub);
  try {
    mkdirSync4(targetDir, { recursive: true });
  } catch {
    return false;
  }
  const target = join4(targetDir, file.name);
  if (existsSync4(target)) return false;
  try {
    renameSync4(real, target);
    return true;
  } catch {
  }
  try {
    copyFileSync2(real, target);
    unlinkSync3(real);
    return true;
  } catch {
    return false;
  }
}
function rotateAssistantHome(now = Date.now()) {
  const dir = assistantHomeDir();
  const journalDir = join4(dir, "journal");
  const notesDir = join4(dir, "notes");
  const archiveDir = join4(dir, "archive");
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
    const stamp2 = Date.parse(`${item.date}T23:59:59`);
    if (!Number.isFinite(stamp2) || stamp2 >= cutoff) continue;
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
    const files = listFiles(join4(dir, area)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limitPerArea).map((file) => ({ name: file.name, path: file.path, bytes: file.size, mtimeMs: file.mtimeMs, area }));
    out[area] = files;
  }
  return out;
}
function readTextIfExists(path, limit = 200 * 1024) {
  try {
    if (!existsSync4(path)) return "";
    if (statSync3(path).size > limit) return "";
    return readFileSync4(path, "utf8");
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
function readJsonBody2(req, limitBytes) {
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
        hasAgents: existsSync4(current.agentsFile),
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
      const dshHome3 = process.env.DSH_HOME || join4(homedir3(), ".dsh");
      const pick2 = (name3) => (
        // 老版本 / 没装 mnemon：退回 $DSH_HOME 里的那份投影
        readTextIfExists(join4(runtime, name3)) || readTextIfExists(join4(dshHome3, name3))
      );
      const user = view.targets.find((target) => target.target === "user");
      const memory = view.targets.find((target) => target.target === "memory");
      sendJson2(res, 200, {
        ...view,
        dir: home.dir,
        memoryDir: runtime,
        user: user?.text ?? pick2("USER.md"),
        memory: memory?.text ?? pick2("MEMORY.md"),
        agents: readTextIfExists(join4(home.dir, "AGENTS.md"))
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
      void readJsonBody2(req, 128 * 1024).then((body) => {
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
      void readJsonBody2(req, 128 * 1024).then((body) => {
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
  push(dirname3(assistantHomeDir()));
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
function createPathGuard(config) {
  const pinned = config !== void 0;
  let state = config ?? loadAssistantConfig(true);
  const sync = (force) => {
    if (pinned && !force) return;
    try {
      state = loadAssistantConfig(force);
    } catch {
    }
  };
  return {
    get roots() {
      return defaultAllowedRoots(state);
    },
    get open() {
      return state.allowAllLocalPaths === true;
    },
    refresh() {
      sync(true);
    },
    check(rawPath) {
      sync(false);
      const raw = String(rawPath ?? "").trim();
      if (!raw) return { ok: false, reason: "empty-path", target: "" };
      const abs = resolvePath4(expandHome(raw));
      if (state.allowAllLocalPaths === true) return { ok: true, reason: "allow-all", target: abs };
      const roots = defaultAllowedRoots(state);
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
    return existsSync5(target) && statSync4(target).isDirectory();
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

// src/file-disposition.ts
import { basename, extname } from "node:path";
var INLINE_FILE_EXTENSIONS = [
  "txt",
  "log",
  "md",
  "markdown",
  "json",
  "csv",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "pdf",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "mp3",
  "mp4",
  "webm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "wasm"
];
var INLINE_FILE_EXTENSION_SET = new Set(INLINE_FILE_EXTENSIONS);
function fileExtensionOf(nameOrPath) {
  const value = String(nameOrPath ?? "").trim();
  if (value === "") return "";
  const ext = extname(value);
  return ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
}
function fileDispositionType(ext, forceAttachment) {
  if (forceAttachment === true) return "attachment";
  return INLINE_FILE_EXTENSION_SET.has(String(ext ?? "").trim().toLowerCase()) ? "inline" : "attachment";
}
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}
function contentDispositionValue(nameOrPath, ext, opts) {
  const full = String(nameOrPath ?? "").trim();
  const name3 = basename(full) === "" ? "file" : basename(full);
  const type = fileDispositionType(ext ?? fileExtensionOf(name3), opts?.forceAttachment);
  const ascii = name3.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name3)}`;
}
function contentDispositionHeaderFor(absPath, opts) {
  return contentDispositionValue(absPath, fileExtensionOf(absPath), opts);
}
var fileDispositionTestSurface = {
  INLINE_FILE_EXTENSIONS,
  fileExtensionOf,
  fileDispositionType,
  contentDispositionValue,
  contentDispositionHeaderFor
};

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
var PLUGIN_VERSION = false ? "dev" : "0.2.42";
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
  webm: "video/webm",
  // 2026-11-27「所有附件都走下载」：apk 必须回对 MIME——DownloadManager 与安卓端下载完成后的
  // 安装分流都靠它认安装包（缺了会落成 application/octet-stream，安装界面拉不起来）。
  apk: "application/vnd.android.package-archive"
};
var SITE_PREFIX = "/api/worktable/site";
var TEMPLATE_PREFIX = "/api/worktable/template";
var loadProbeAttempts = 0;
function loadPkg(pkg) {
  const starts = /* @__PURE__ */ new Set();
  try {
    starts.add(dirname4(fileURLToPath(import.meta.url)));
  } catch {
  }
  try {
    starts.add(realpathSync2(dirname4(fileURLToPath(import.meta.url))));
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
async function readJsonBody3(req) {
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
      mtimeMs = (await stat(abs + sep2 + d.name)).mtimeMs;
    } catch {
    }
    return { name: d.name, path: abs + sep2 + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith("."), mtimeMs };
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
var LOCAL_FILE_MAX_BYTES = 100 * 1024 * 1024;
function createLocalFileHandler(deps) {
  const { denyOutside, logger } = deps;
  return async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://dsh.internal");
      const p = u.searchParams.get("path") || "";
      if (!p) {
        json(res, 400, { error: "missing path" });
        return;
      }
      if (denyOutside(res, p, "file")) return;
      const abs = pathResolve(p);
      const fsp = await import("node:fs/promises");
      const stat2 = await fsp.stat(abs);
      if (!stat2.isFile()) {
        json(res, 404, { error: "not a file" });
        return;
      }
      if (stat2.size > LOCAL_FILE_MAX_BYTES) {
        logger?.warn?.(`[${PLUGIN_SELF}] file \u8D85\u4E0A\u9650\u62D2\u7EDD\uFF1A${stat2.size} \u5B57\u8282 > ${LOCAL_FILE_MAX_BYTES}\uFF08${abs}\uFF09`);
        json(res, 413, { error: "file too large", maxBytes: LOCAL_FILE_MAX_BYTES });
        return;
      }
      const ext = (abs.split(".").pop() || "").toLowerCase();
      const forceAttachment = u.searchParams.get("download") === "1";
      const headers = {
        "content-type": FILE_TYPES[ext] ?? "application/octet-stream",
        "content-length": String(stat2.size),
        "content-disposition": contentDispositionHeaderFor(abs, { forceAttachment }),
        "cache-control": "no-store"
      };
      if (String(req.method ?? "GET").toUpperCase() === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      if (stat2.size === 0) {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      const handle = await fsp.open(abs, "r");
      const body = handle.createReadStream({ start: 0, end: stat2.size - 1, autoClose: true });
      body.on("error", () => {
        try {
          res.destroy();
        } catch {
        }
      });
      res.on("close", () => {
        if (!body.destroyed) body.destroy();
      });
      try {
        res.writeHead(200, headers);
      } catch (err) {
        body.destroy();
        throw err;
      }
      body.pipe(res);
    } catch (err) {
      try {
        json(res, 404, { error: String(err) });
      } catch {
        try {
          res.destroy();
        } catch {
        }
      }
    }
  };
}
function apply(ctx) {
  const server = ctx.webServer;
  if (!server) {
    ctx.logger?.warn(`[${PLUGIN_SELF}] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531`);
    return;
  }
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const extraDisposers = [];
  const guard = createPathGuard();
  try {
    if (typeof ctx?.provide === "function" && typeof ctx?.get === "function" && ctx.get("assistantPathGuard") === void 0) {
      const off = ctx.provide("assistantPathGuard", {
        refresh: () => guard.refresh(),
        get roots() {
          return guard.roots;
        },
        get open() {
          return guard.open;
        }
      });
      if (typeof off === "function") extraDisposers.push(off);
    }
  } catch {
  }
  ctx.logger?.info?.(`[${PLUGIN_SELF}] \u76EE\u5F55 allowlist: ${guard.open ? "\u5168\u653E\u884C\uFF08allowAllLocalPaths\uFF09" : guard.roots.join(" | ")}`);
  const denyOutside = (res, rawPath, routeName) => {
    const check = guard.check(rawPath);
    if (check.ok) return false;
    ctx.logger?.warn?.(`[${PLUGIN_SELF}] ${routeName} \u8D8A\u754C\u62D2\u7EDD\uFF1A${check.reason}`);
    json(res, 403, {
      ok: false,
      error: "outside-allowlist",
      path: check.target,
      hint: "\u5728\u300C\u8BBE\u7F6E \u2192 \u4E2A\u4EBA\u52A9\u624B \u2192 \u672C\u673A\u914D\u7F6E \u2192 \u76EE\u5F55\u8FB9\u754C\u300D\u91CC\u52A0\u4E0A\u8FD9\u4E2A\u76EE\u5F55\uFF08\u6216\u628A\u5B83\u672C\u8EAB\u653E\u8FDB\u5DF2\u5141\u8BB8\u6839\uFF09\uFF0C\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548"
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
      handler: createLocalFileHandler({ denyOutside, logger: ctx.logger })
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
          if (abs !== root && !abs.startsWith(root + sep2)) {
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
          const body = await readJsonBody3(req);
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
          const body = await readJsonBody3(req);
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
          const body = await readJsonBody3(req);
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          if (denyOutside(res, p, "mkdir")) return;
          const abs = pathResolve(p);
          const fsx = await import("node:fs/promises");
          const parent = dirname4(abs);
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
        const body = await readJsonBody3(req);
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
          const body = await readJsonBody3(req);
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
    return () => {
      for (const dispose of [...extraDisposers].reverse()) {
        try {
          dispose();
        } catch {
        }
      }
      routes.dispose();
    };
  } catch (err) {
    routes.dispose();
    throw err;
  }
}
var localFileRouteTestSurface = { LOCAL_FILE_MAX_BYTES, createLocalFileHandler };

// src/tuoguan-host.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync5, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname5, join as join6 } from "node:path";

// src/tuoguan-autocontinue.ts
import { randomUUID } from "node:crypto";
var CONTINUE_TEXT = "\u7EE7\u7EED";
var DEFAULT_MAX_CONSECUTIVE = 8;
var DEFAULT_FRESHNESS_MS = 9e4;
function tuoguanStateIsOn(state, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  if (hasTrue(state?.off, sessionId)) return false;
  if (hasTrue(state?.on, sessionId)) return true;
  return state?.defaultOn !== false;
}
function hasTrue(map, key) {
  if (typeof map !== "object" || map === null) return false;
  return map[key] === true;
}
function isSubagentSession(session) {
  const header = session?.header;
  if (typeof header !== "object" || header === null) return false;
  if (header.origin === "subagent") return true;
  const depth = header.delegationDepth;
  return typeof depth === "number" && depth > 0;
}
function createContinueMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" }
  });
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function waitIdleWithin(agent, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, Math.max(1e3, timeoutMs));
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
    if (typeof agent.whenIdle !== "function") {
      finish(agent.status === "idle");
      return;
    }
    try {
      Promise.resolve(agent.whenIdle()).then(() => {
        finish(true);
      }, () => {
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}
function renderThrown(error) {
  return error instanceof Error ? error.message : String(error);
}
function createAutoContinue(deps) {
  const maxConsecutive = normalizeLimit(deps.maxConsecutive, DEFAULT_MAX_CONSECUTIVE);
  const freshnessMs = typeof deps.freshnessMs === "number" && deps.freshnessMs > 0 ? deps.freshnessMs : DEFAULT_FRESHNESS_MS;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {
  };
  const create = typeof deps.createMessage === "function" ? deps.createMessage : createContinueMessage;
  const waitIdle = typeof deps.waitIdle === "function" ? deps.waitIdle : waitIdleWithin;
  const streaks = /* @__PURE__ */ new Map();
  const handled = /* @__PURE__ */ new Map();
  const autoIds = /* @__PURE__ */ new Set();
  const inflight = /* @__PURE__ */ new Set();
  function track(run) {
    const task = run.then(() => void 0, () => void 0).finally(() => {
      inflight.delete(task);
    });
    inflight.add(task);
  }
  function schedule(sessionId, turn, truncatedAt) {
    track((async () => {
      if (!await readOn(sessionId)) return;
      const agent = deps.agentOf(sessionId);
      if (agent === null || agent === void 0 || typeof agent.followup !== "function") return;
      if (!await waitIdle(agent, freshnessMs)) return;
      if (deps.agentOf(sessionId) !== agent) return;
      if (now() - truncatedAt > freshnessMs) return;
      if (agent.status !== "idle") return;
      if (pendingTurns(agent) > 0) return;
      if ((streaks.get(sessionId) ?? 0) >= maxConsecutive) return;
      if (!await readOn(sessionId)) return;
      if (pendingTurns(agent) > 0) return;
      const message = create(CONTINUE_TEXT);
      agent.followup(message);
      const id = message?.id;
      if (typeof id === "string" && id !== "") {
        autoIds.add(id);
        if (autoIds.size > 64) {
          const oldest = autoIds.values().next().value;
          if (typeof oldest === "string") autoIds.delete(oldest);
        }
      }
      const count = (streaks.get(sessionId) ?? 0) + 1;
      streaks.set(sessionId, count);
      log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\uFF1A${sessionId} \u7B2C ${count}/${maxConsecutive} \u6B21\u8865\u53D1\u300C${CONTINUE_TEXT}\u300D\uFF08turn ${turn} \u8F93\u51FA\u88AB\u622A\u65AD\uFF09`);
    })().catch((error) => {
      log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u5931\u8D25\uFF08${sessionId}\uFF09\uFF1A${renderThrown(error)}`);
    }));
  }
  async function readOn(sessionId) {
    try {
      const state = await deps.readState();
      return tuoguanStateIsOn(state, sessionId);
    } catch (error) {
      log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u8BFB\u4E0D\u5230\u6258\u7BA1\u72B6\u6001\uFF08\u6309\u4E0D\u7EED\u5199\u5904\u7406\uFF09\uFF1A${renderThrown(error)}`);
      return false;
    }
  }
  function pendingTurns(agent) {
    const list = agent.inbox?.nextTurn;
    return Array.isArray(list) ? list.length : 0;
  }
  return {
    maxConsecutive,
    handleSessionEvent(session, event) {
      try {
        const sessionId = typeof session?.id === "string" ? session.id : String(session?.id ?? "");
        if (sessionId === "") return;
        const type = event?.type;
        if (type === "user/message") {
          const id = event?.data?.id;
          if (typeof id === "string" && autoIds.has(id)) return;
          streaks.delete(sessionId);
          return;
        }
        if (type !== "turn/end") return;
        const data = event?.data;
        const reason = data?.reason?.kind;
        if (reason !== "max-tokens") {
          streaks.delete(sessionId);
          return;
        }
        const turn = typeof data?.turn === "number" && Number.isFinite(data.turn) ? data.turn : -1;
        if (handled.get(sessionId) === turn) return;
        handled.set(sessionId, turn);
        if (isSubagentSession(session)) return;
        if ((streaks.get(sessionId) ?? 0) >= maxConsecutive) {
          log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\uFF1A${sessionId} \u8FDE\u7EED ${maxConsecutive} \u6B21\u8F93\u51FA\u622A\u65AD\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u8865\u53D1\uFF08\u7B49\u4F60\u786E\u8BA4\uFF09`);
          return;
        }
        schedule(sessionId, turn, now());
      } catch (error) {
        log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u5904\u7406\u4E8B\u4EF6\u5931\u8D25\uFF1A${renderThrown(error)}`);
      }
    },
    handleSessionDisposed(session) {
      const sessionId = typeof session?.id === "string" ? session.id : String(session?.id ?? "");
      if (sessionId === "") return;
      streaks.delete(sessionId);
      handled.delete(sessionId);
    },
    streakOf(sessionId) {
      return streaks.get(sessionId) ?? 0;
    },
    handledTurnOf(sessionId) {
      return handled.get(sessionId);
    },
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    }
  };
}
function normalizeLimit(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const limit = Math.floor(value);
  return limit >= 1 ? limit : fallback;
}
function installAutoContinue(ctx, options) {
  const scope = ctx;
  const log = typeof options.log === "function" ? options.log : (message) => {
    console.warn(`[dsh-assistant] ${message}`);
  };
  const disposers = [];
  if (scope === null || scope === void 0 || typeof scope.on !== "function") {
    log("\u5BBF\u4E3B\u6CA1\u6709\u4E8B\u4EF6\u603B\u7EBF\uFF0C\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u672A\u542F\u7528");
    return () => void 0;
  }
  const controller = createAutoContinue({
    readState: options.readState,
    maxConsecutive: options.maxConsecutive,
    freshnessMs: options.freshnessMs,
    log,
    agentOf: (sessionId) => {
      try {
        const agents = typeof scope.get === "function" ? scope.get("agents") : void 0;
        return agents?.get?.(sessionId) ?? null;
      } catch {
        return null;
      }
    }
  });
  let wired = false;
  try {
    const off = scope.on("session/event", (session, event) => {
      controller.handleSessionEvent(session, event);
    });
    if (typeof off === "function") {
      disposers.push(off);
      wired = true;
    }
  } catch (error) {
    log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u6302\u4E0D\u4E0A session/event\uFF1A${renderThrown(error)}`);
  }
  try {
    const off = scope.on("session/disposed", (session) => {
      controller.handleSessionDisposed(session);
    });
    if (typeof off === "function") disposers.push(off);
  } catch {
  }
  if (wired) log(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u5DF2\u542F\u7528\uFF1A\u8F93\u51FA\u88AB\u622A\u65AD\uFF08max-tokens\uFF09\u65F6\u81EA\u52A8\u8865\u53D1\u300C${CONTINUE_TEXT}\u300D\uFF0C\u8FDE\u7EED\u4E0A\u9650 ${controller.maxConsecutive} \u6B21`);
  else log("\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u672A\u542F\u7528\uFF1Asession/event \u6CA1\u6302\u4E0A");
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}

// src/tuoguan-autoanswer.ts
var FREE_TEXT_DEFAULT = "auto-hosting\uFF1A\u672A\u63D0\u4F9B\u4EBA\u5DE5\u8F93\u5165\uFF0C\u8BF7\u6309\u9ED8\u8BA4\u5047\u8BBE\u7EE7\u7EED\u3002";
var APPROVAL_OUTCOME = "allowed-once";
function hasTrue2(map, key) {
  if (typeof map !== "object" || map === null) return false;
  return map[key] === true;
}
function tuoguanOnForChain(state, chain) {
  for (const sessionId of chain) {
    if (typeof sessionId !== "string" || sessionId === "") continue;
    if (hasTrue2(state?.off, sessionId)) return false;
    if (hasTrue2(state?.on, sessionId)) return true;
  }
  return state?.defaultOn !== false;
}
function sessionAncestry(sessionId, agentOf) {
  const chain = [sessionId];
  let current = sessionId;
  for (let depth = 0; depth < 16; depth += 1) {
    const header = safeHeader(agentOf, current);
    if (header === null) break;
    const delegated = header.origin === "subagent" || typeof header.delegationDepth === "number" && header.delegationDepth > 0;
    if (!delegated) break;
    const parent = header.parentSession;
    if (typeof parent !== "string" || parent === "" || parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}
function safeHeader(agentOf, sessionId) {
  try {
    const header = agentOf(sessionId)?.session?.header;
    return typeof header === "object" && header !== null ? header : null;
  } catch {
    return null;
  }
}
function sessionIdOf(request) {
  const id = request?.agent?.session?.id;
  return typeof id === "string" ? id : "";
}
function defaultAnswerLabel(question) {
  const intent = question?.intent;
  if (intent?.kind === "plan-review" && typeof intent.approve === "string" && intent.approve !== "") {
    return intent.approve;
  }
  const first = question?.options?.[0];
  const label = first?.label;
  return typeof label === "string" && label !== "" ? label : FREE_TEXT_DEFAULT;
}
function defaultAnswerBatch(questions) {
  return {
    answers: questions.map((question) => {
      const id = typeof question?.id === "string" ? question.id : String(question?.id ?? "");
      const label = defaultAnswerLabel(question);
      const options = question?.options;
      if (!Array.isArray(options) || options.length === 0) return { id, selected: [], custom: label };
      return { id, selected: [label] };
    })
  };
}
function createAutoAnswer(deps) {
  const log = typeof deps.log === "function" ? deps.log : () => {
  };
  const ancestryOf = typeof deps.ancestryOf === "function" ? deps.ancestryOf : (sessionId) => [sessionId];
  const gated = createTuoguanGate({ readState: deps.readState, ancestryOf, log });
  async function isOnFor(sessionId) {
    return gated(sessionId);
  }
  return {
    isOnFor,
    async answerApproval(request, next) {
      const sessionId = sessionIdOf(request);
      if (sessionId === "") return next();
      if (!await isOnFor(sessionId)) return next();
      const toolName = typeof request?.toolName === "string" && request.toolName !== "" ? request.toolName : "unknown";
      log(`\u6258\u7BA1\u81EA\u52A8\u5E94\u7B54\uFF1A${sessionId} \u5BA1\u6279 ${toolName} \u2192 ${APPROVAL_OUTCOME}`);
      return APPROVAL_OUTCOME;
    },
    async answerQuestion(request, next) {
      const sessionId = sessionIdOf(request);
      if (sessionId === "") return next();
      const questions = Array.isArray(request?.questions) ? request.questions : [];
      if (questions.length === 0) return next();
      if (questions.some((question) => typeof question?.id !== "string" || question.id === "")) return next();
      if (!await isOnFor(sessionId)) return next();
      const batch = defaultAnswerBatch(questions);
      const labels = batch.answers.map((answer) => answer.custom ?? answer.selected[0] ?? "").join(" / ");
      log(`\u6258\u7BA1\u81EA\u52A8\u5E94\u7B54\uFF1A${sessionId} \u63D0\u95EE ${questions.length} \u9898 \u2192 ${labels}`);
      return batch;
    }
  };
}
function createTuoguanGate(deps) {
  const log = typeof deps.log === "function" ? deps.log : () => {
  };
  const ancestryOf = typeof deps.ancestryOf === "function" ? deps.ancestryOf : (sessionId) => [sessionId];
  const chainOf = (sessionId) => {
    try {
      const chain = ancestryOf(sessionId);
      return Array.isArray(chain) && chain.length > 0 ? chain : [sessionId];
    } catch {
      return [sessionId];
    }
  };
  return async function isOnFor(sessionId, parentSessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    try {
      const state = await deps.readState();
      const chain = chainOf(sessionId);
      if (typeof parentSessionId === "string" && parentSessionId !== "" && !chain.includes(parentSessionId)) {
        for (const id of chainOf(parentSessionId)) if (!chain.includes(id)) chain.push(id);
      }
      return tuoguanOnForChain(state, chain);
    } catch (error) {
      log(`\u6258\u7BA1\u95E8\u63A7\u8BFB\u4E0D\u5230\u6258\u7BA1\u72B6\u6001\uFF08\u6309\u4E0D\u6258\u7BA1\u5904\u7406\uFF09\uFF1A${renderThrown2(error)}`);
      return false;
    }
  };
}
function renderThrown2(error) {
  return error instanceof Error ? error.message : String(error);
}
function installAutoAnswer(ctx, options) {
  const scope = ctx;
  const log = typeof options.log === "function" ? options.log : (message) => {
    console.warn(`[dsh-assistant] ${message}`);
  };
  const disposers = [];
  if (scope === null || scope === void 0 || typeof scope.on !== "function") {
    log("\u5BBF\u4E3B\u6CA1\u6709\u4E8B\u4EF6\u603B\u7EBF\uFF0C\u6258\u7BA1\u51B3\u7B56\u81EA\u52A8\u5E94\u7B54\u672A\u542F\u7528");
    return () => void 0;
  }
  const agentOf = typeof options.agentOf === "function" ? options.agentOf : (sessionId) => {
    try {
      const agents = typeof scope.get === "function" ? scope.get("agents") : void 0;
      return agents?.get?.(sessionId) ?? null;
    } catch {
      return null;
    }
  };
  const controller = createAutoAnswer({
    readState: options.readState,
    log,
    ancestryOf: (sessionId) => sessionAncestry(sessionId, agentOf)
  });
  const wire = (event, handler) => {
    try {
      const off = scope.on(event, function(request, next) {
        return handler(request, next);
      }, { prepend: true });
      if (typeof off === "function") disposers.push(off);
      else log(`\u6258\u7BA1\u51B3\u7B56\u81EA\u52A8\u5E94\u7B54\u6302\u4E0D\u4E0A ${event}\uFF08\u5BBF\u4E3B\u6CA1\u7ED9\u5378\u8F7D\u51FD\u6570\uFF09`);
    } catch (error) {
      log(`\u6258\u7BA1\u51B3\u7B56\u81EA\u52A8\u5E94\u7B54\u6302\u4E0D\u4E0A ${event}\uFF1A${renderThrown2(error)}`);
    }
  };
  wire("approval/request", (request, next) => controller.answerApproval(request, next));
  wire("user-questions/request", (request, next) => controller.answerQuestion(request, next));
  if (disposers.length > 0) {
    log("\u6258\u7BA1\u51B3\u7B56\u81EA\u52A8\u5E94\u7B54\u5DF2\u542F\u7528\uFF1A\u5BA1\u6279 \u2192 allowed-once\uFF0C\u63D0\u95EE / plan-review \u2192 \u9ED8\u8BA4\u9879\uFF08\u5BBF\u4E3B\u76F4\u63A5\u4F5C\u7B54\uFF0C\u4E0D\u9700\u8981\u6253\u5F00\u90A3\u4E2A\u4F1A\u8BDD\uFF09");
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}

// src/tuoguan-gate.ts
var TUOGUAN_GATE_KEY = Symbol.for("dsh-assistant.tuoguan-gate");
function installTuoguanGate(isOnFor) {
  if (typeof isOnFor !== "function") return () => {
  };
  const holder = globalThis;
  const previous = holder[TUOGUAN_GATE_KEY];
  holder[TUOGUAN_GATE_KEY] = isOnFor;
  return () => {
    if (holder[TUOGUAN_GATE_KEY] !== isOnFor) return;
    if (previous === void 0) delete holder[TUOGUAN_GATE_KEY];
    else holder[TUOGUAN_GATE_KEY] = previous;
  };
}

// src/tuoguan-host.ts
var PREFIX = "/.dsh-tuoguan";
var STATE_ROUTE = `${PREFIX}/state`;
var STATE_FILENAME = "dsh-tuoguan-state.json";
var MAX_BODY_BYTES2 = 64 * 1024;
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
    return normalizeState(JSON.parse(readFileSync5(file, "utf8")));
  } catch {
    return { off: {}, on: {}, defaultOn: true, revision: 0, updatedAt: "" };
  }
}
function writeStateSync(file, state) {
  const payload = `${JSON.stringify(state, void 0, 2)}
`;
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync5(dirname5(file), { recursive: true });
  writeFileSync5(temporary, payload, "utf8");
  renameSync5(temporary, file);
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
  /** 某会话的当前有效状态：显式记录优先，否则用默认值（与自动续写共用同一套判定）。 */
  effective(state, sessionId) {
    return tuoguanStateIsOn(state, sessionId);
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
async function readJsonBody4(req) {
  const bytes = await readBody(req, MAX_BODY_BYTES2);
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
      const body = await readJsonBody4(req);
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
function hostLog(message) {
  try {
    console.error(`dsh-assistant: ${message}`);
  } catch {
  }
}
function installAutoContinueFor(ctx, store) {
  try {
    return installAutoContinue(ctx, {
      readState: () => store.read(),
      log: hostLog
    });
  } catch (error) {
    hostLog(`\u6258\u7BA1\u81EA\u52A8\u7EED\u5199\u542F\u7528\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    return () => void 0;
  }
}
function installAutoAnswerFor(ctx, store) {
  try {
    return installAutoAnswer(ctx, {
      readState: () => store.read(),
      log: hostLog
    });
  } catch (error) {
    hostLog(`\u6258\u7BA1\u51B3\u7B56\u81EA\u52A8\u5E94\u7B54\u542F\u7528\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    return () => void 0;
  }
}
function installTuoguanGateForSignals(ctx, readState) {
  const agentOf = (sessionId) => {
    try {
      const agents = optionalService(ctx, "agents");
      return agents?.get?.(sessionId) ?? null;
    } catch {
      return null;
    }
  };
  try {
    const gate = createTuoguanGate({
      readState,
      log: hostLog,
      ancestryOf: (sessionId) => sessionAncestry(sessionId, agentOf)
    });
    return installTuoguanGate(gate);
  } catch (error) {
    hostLog(`\u6258\u7BA1\u95E8\u63A7\u542F\u7528\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    return () => void 0;
  }
}
function apply2(ctx) {
  const directory = profileDirectory(ctx);
  const store = new TuoguanStore(join6(directory, STATE_FILENAME));
  hostLog(`\u6258\u7BA1\u72B6\u6001\u6587\u4EF6 ${store.file}`);
  const effect = typeof ctx?.effect === "function" ? ctx.effect : void 0;
  if (effect === void 0) {
    registerTuoguanRoutes(ctx, store);
    installAutoContinueFor(ctx, store);
    installAutoAnswerFor(ctx, store);
    installTuoguanGateForSignals(ctx, () => store.read());
    return;
  }
  effect(() => {
    const detach = registerTuoguanRoutes(ctx, store);
    const detachAutoContinue = installAutoContinueFor(ctx, store);
    const detachAutoAnswer = installAutoAnswerFor(ctx, store);
    const detachGate = installTuoguanGateForSignals(ctx, () => store.read());
    hostLog(`\u5DF2\u6302\u8F7D\u6258\u7BA1\u8DEF\u7531 GET/POST ${STATE_ROUTE}`);
    return () => {
      detachGate();
      detachAutoAnswer();
      detachAutoContinue();
      detach();
    };
  });
}

// src/turn-guard.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { appendFileSync, mkdirSync as mkdirSync6, readFileSync as readFileSync6, renameSync as renameSync6, statSync as statSync5, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname6, join as join7 } from "node:path";
var VERSION = "1.1.0";
var MARK = "[turn-guard]";
var PREFIX2 = "/.dsh-assistant/turn-guard";
var STATE_FILENAME2 = "dsh-assistant-turn-guard.json";
var LOG_FILENAME = "dsh-assistant-turn-guard.log";
var MAX_BODY_BYTES3 = 64 * 1024;
var MAX_PRESET_LENGTH = 64;
var MAX_PRESETS = 16;
var MAX_LOG_BYTES = 200 * 1024;
var LOG_ARCHIVE_SUFFIX = ".1";
var MAX_LOG_LINE_CHARS = 240;
var LOCAL_PATH_PATTERNS = [
  /\b[A-Za-z]:[\\/][^\s,;)'"`（）：。，、]*/g,
  /[\\/]{2}[A-Za-z0-9._$-]+[\\/][^\s,;)'"`（）：。，、]*/g,
  /[\\/](?:Users|Documents and Settings|Profiles|home)[\\/][^\s,;)'"`（）：。，、]*/gi
];
var LEAK = /<tool_call>|<\/tool_call>|<parameter|<function|<\/function>|<input_text>/i;
var LEAK_AT_LINE_START = /^(<tool_call>|<\/tool_call>|<function[=\s]|<\/function>|<parameter[=\s>]|<input_text>)/i;
var MESSAGE_ROLES = /* @__PURE__ */ new Set(["system", "developer", "user", "assistant", "tool"]);
function looksLikeCall(text) {
  const bare = String(text ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return bare.split("\n").some((line) => LEAK_AT_LINE_START.test(line.trim()));
}
function buildUserMessage(text, options = {}) {
  return {
    id: randomUUID2(),
    role: "user",
    content: [{ type: "text", text: String(text ?? "") }],
    source: { kind: options.kind ?? "user", ...options.form === void 0 ? {} : { form: options.form } }
  };
}
function assertIdentifiedMessage(message, subject = "message") {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError(`${subject} is not a message object`);
  }
  const { id, role, source, content } = message;
  if (typeof id !== "string" || id === "") throw new TypeError(`${subject} lacks an identified message: missing id`);
  if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) throw new TypeError(`${subject} has an invalid role`);
  if (source === null || typeof source !== "object" || typeof source.kind !== "string" || source.kind === "") {
    throw new TypeError(`${subject} lacks a source kind`);
  }
  if (!Array.isArray(content)) throw new TypeError(`${subject} content must be an array`);
  return true;
}
function repairIdentifiedMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return void 0;
  const sourceOk = message.source !== null && typeof message.source === "object" && typeof message.source.kind === "string" && message.source.kind !== "";
  if (!Array.isArray(message.content)) return void 0;
  const patched = Object.isExtensible(message) ? message : { ...message };
  if (typeof patched.id !== "string" || patched.id === "") patched.id = randomUUID2();
  if (patched.role !== "user") patched.role = "user";
  if (!sourceOk) patched.source = { kind: "user" };
  return patched;
}
function guardMessagesForHistory(messages, log = () => {
}) {
  const out = [];
  for (const message of messages ?? []) {
    if (typeof message?.id === "string" && message.id !== "") {
      out.push(message);
      continue;
    }
    const repaired = repairIdentifiedMessage(message);
    if (repaired === void 0) {
      log(`dropped invalid message (no usable content) role=${String(message?.role ?? "?")}`);
      continue;
    }
    log(`stamped missing id (role=${String(repaired.role)}, source=${String(repaired.source?.kind)})`);
    out.push(repaired);
  }
  return out;
}
function installHistoryGuard(ctx, log, isEnabled) {
  if (typeof ctx?.on !== "function") return () => void 0;
  const off = ctx.on("agent/pre-step", async (_payload, next) => {
    const decision = await next();
    if (!isEnabled()) return decision;
    if (decision?.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    const guarded = guardMessagesForHistory(decision.messages, (line) => log(`pre-step: ${line}`));
    if (guarded.length === decision.messages.length) return decision;
    return { ...decision, messages: guarded };
  }, { prepend: true });
  return typeof off === "function" ? off : () => void 0;
}
function eventsOf(session) {
  return typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
}
function lastAssistantEvent(session) {
  const events = eventsOf(session);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "assistant/message") return events[i];
  }
  return void 0;
}
function eventTimeMs(event) {
  const raw = typeof event?.time === "number" ? event.time : typeof event?.data?.time === "number" ? event.data.time : void 0;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}
function dayKeyOf(event) {
  const ms = eventTimeMs(event);
  if (ms === 0) return "";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function isGuardInjectionEvent(event) {
  if (event?.type !== "user/message") return false;
  const content = event?.data?.content ?? [];
  return content.some((b) => b?.type === "text" && String(b?.text ?? "").startsWith(MARK));
}
function countGuardInjections(events) {
  const byTurn = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  let unscoped = 0;
  let total = 0;
  let currentTurn;
  let currentDay;
  for (const event of events ?? []) {
    if (event?.type === "turn/start") {
      const turn = event?.data?.turn;
      if (typeof turn === "number" && Number.isFinite(turn)) currentTurn = turn;
      currentDay = dayKeyOf(event) || currentDay;
      continue;
    }
    if (event?.type === "assistant/message") {
      const turn = event?.data?.turn;
      if (currentTurn === void 0 && typeof turn === "number" && Number.isFinite(turn)) currentTurn = turn;
      const day2 = dayKeyOf(event);
      if (day2) currentDay = day2;
      continue;
    }
    if (!isGuardInjectionEvent(event)) continue;
    total += 1;
    if (currentTurn === void 0) unscoped += 1;
    else byTurn.set(currentTurn, (byTurn.get(currentTurn) ?? 0) + 1);
    const day = dayKeyOf(event) || currentDay;
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return { byTurn, byDay, unscoped, total };
}
function judge(session, config = {}, turn) {
  const maxPerTurn = Number.isFinite(config.maxPerTurn) ? Math.max(0, Math.floor(config.maxPerTurn)) : 3;
  const steerEmptyText = config.steerEmptyText !== false;
  const events = eventsOf(session);
  const last = lastAssistantEvent(session);
  if (last === void 0) {
    return { steer: false, branch: "no-assistant", injected: 0, injectedMax: maxPerTurn, dayInjected: 0, turn };
  }
  const blocks = last.data?.message?.content ?? [];
  const hasToolCall = blocks.some((b) => b?.type === "tool-call");
  const text = blocks.filter((b) => b?.type === "text").map((b) => b?.text ?? "").join("\n").trim();
  const hasReasoning = blocks.some((b) => b?.type === "reasoning");
  const counts = countGuardInjections(events);
  const perTurn = typeof turn === "number" && counts.byTurn.size > 0;
  const injected = perTurn ? counts.byTurn.get(turn) ?? 0 : counts.total;
  const injectedMax = maxPerTurn;
  const dayInjected = counts.byDay.get(dayKeyOf(last)) ?? 0;
  const tail = { hasToolCall, text, injected, injectedMax, dayInjected, turn };
  if (injected >= maxPerTurn) return { steer: false, branch: "cap", ...tail };
  if (hasToolCall) return { steer: false, branch: "toolcall", hasToolCall: true, ...tail };
  if (text !== "" && !LEAK.test(text)) return { steer: false, branch: "text-ok", ...tail };
  if (looksLikeCall(text)) return { steer: true, reason: "leak", branch: "leak", ...tail };
  if (steerEmptyText && text === "" && hasReasoning) return { steer: true, reason: "empty", branch: "empty", ...tail };
  return { steer: false, branch: "fallthrough", ...tail };
}
function correctiveText(reason, detail = "") {
  const tail = detail ? `

\u4E0A\u4E00\u6B65\u5DE5\u5177\u8FD4\u56DE\u7684\u9519\u8BEF\uFF1A${detail}` : "";
  if (reason === "leak") {
    return `${MARK} \u4F60\u4E0A\u4E00\u6761\u6D88\u606F\u628A\u5DE5\u5177\u8C03\u7528\u5199\u6210\u4E86\u6B63\u6587\uFF08\u53EA\u8F93\u51FA\u4E86 <tool_call>/</function> \u4E4B\u7C7B\u7684\u7247\u6BB5\uFF09\uFF0C\u6CA1\u6709\u5F62\u6210\u53EF\u6267\u884C\u7684\u5DE5\u5177\u8C03\u7528\uFF0C\u8FD9\u4E00\u6B65\u7B49\u4E8E\u7A7A\u8F6C\u3002
\u8BF7\u7ACB\u523B\u91CD\u65B0\u53D1\u51FA\u771F\u6B63\u7684\u5DE5\u5177\u8C03\u7528\u7EE7\u7EED\u4E0A\u4E00\u6B65\u64CD\u4F5C\uFF1A\u53EA\u7ED9\u5DE5\u5177\u540D\u548C\u5B8C\u6574\u53C2\u6570\uFF0C\u4E0D\u8981\u7528\u6587\u5B57\u63CF\u8FF0\u3001\u4E0D\u8981\u7559\u7A7A\u7684 <tool_call>\u3001\u4E0D\u8981\u7701\u7565\u5FC5\u9700\u5B57\u6BB5\uFF08click/scroll/input_text \u9700\u8981 screen_index\uFF1Bclick/drag/scroll \u9700\u8981 position\uFF09\u3002${tail}`;
  }
  return `${MARK} \u4F60\u4E0A\u4E00\u6761\u6D88\u606F\u53EA\u6709\u601D\u8003\uFF0C\u6CA1\u6709\u6B63\u6587\u4E5F\u6CA1\u6709\u5DE5\u5177\u8C03\u7528\uFF0C\u8FD9\u4E00\u6B65\u7B49\u4E8E\u7A7A\u8F6C\u3002
\u8BF7\u7ACB\u523B\u7528\u771F\u6B63\u7684\u5DE5\u5177\u8C03\u7528\u7EE7\u7EED\u4EFB\u52A1\uFF08\u53EA\u7ED9\u5DE5\u5177\u540D\u548C\u5B8C\u6574\u53C2\u6570\uFF09\uFF1B\u5982\u679C\u4EFB\u52A1\u786E\u5B9E\u5DF2\u7ECF\u5B8C\u6210\uFF0C\u518D\u7ED9\u4E00\u53E5\u7ED3\u8BBA\u3002${tail}`;
}
function lastToolError(session) {
  const events = eventsOf(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "tool/result") continue;
    const error = event?.data?.error;
    const text = (event?.data?.message?.content ?? []).find((b) => b?.type === "text")?.text ?? "";
    if (error || /^Error:/.test(String(text))) return `${error?.code ?? ""} ${String(text).slice(0, 200)}`.trim();
    return "";
  }
  return "";
}
function sessionIdOf2(session, payload) {
  const raw = session?.id ?? session?.header?.id ?? payload?.sessionId ?? payload?.address?.sessionId;
  const text = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return text === "" ? "?" : text.slice(0, 64);
}
function presetOf(ctx, session) {
  try {
    const projections = ctx?.get?.("sessionProjections") ?? ctx?.sessionProjections;
    const live = projections?.stateOf?.(session, "agentPreset");
    if (typeof live === "string" && live !== "") return live;
  } catch {
  }
  const header = session?.header?.agentPreset;
  return typeof header === "string" && header !== "" ? header : void 0;
}
function defaultState() {
  return { enabled: true, presets: ["*"], maxPerTurn: 3, steerEmptyText: true, revision: 0, updatedAt: "" };
}
function normalizeState2(raw) {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const fallback = defaultState();
  const presets = [];
  if (Array.isArray(record.presets)) {
    for (const item of record.presets) {
      const text = String(item ?? "").trim();
      if (text && text.length <= MAX_PRESET_LENGTH && !presets.includes(text) && presets.length < MAX_PRESETS) presets.push(text);
    }
  }
  const maxPerTurnRaw = record.maxPerTurn;
  const maxPerTurn = typeof maxPerTurnRaw === "number" && Number.isFinite(maxPerTurnRaw) ? Math.min(20, Math.max(0, Math.floor(maxPerTurnRaw))) : fallback.maxPerTurn;
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision >= 0 ? Math.floor(record.revision) : 0;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    presets: presets.length > 0 ? presets : fallback.presets,
    maxPerTurn,
    steerEmptyText: typeof record.steerEmptyText === "boolean" ? record.steerEmptyText : fallback.steerEmptyText,
    revision,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
  };
}
function stripBom2(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function readStateSync2(file) {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync5(file).mtimeMs;
  } catch {
  }
  if (cache2 !== null && cache2.file === file && cache2.mtimeMs === mtimeMs) return cache2.state;
  let state;
  try {
    state = normalizeState2(JSON.parse(stripBom2(readFileSync6(file, "utf8"))));
  } catch {
    state = defaultState();
  }
  cache2 = { file, mtimeMs, state };
  return state;
}
var cache2 = null;
function writeStateSync2(file, state) {
  const payload = `${JSON.stringify(state, void 0, 2)}
`;
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync6(dirname6(file), { recursive: true });
  writeFileSync6(temporary, payload, "utf8");
  renameSync6(temporary, file);
}
var TurnGuardStore = class {
  file;
  chain = Promise.resolve();
  constructor(file) {
    this.file = file;
  }
  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => void 0, () => void 0);
    return run;
  }
  /** 同步读：turn 收尾时要立刻拿到开关，不能等 Promise。 */
  readSync() {
    return readStateSync2(this.file);
  }
  read() {
    return this.enqueue(() => readStateSync2(this.file));
  }
  /** 改开关 / 参数；值没变时不写盘、不涨 revision。 */
  patch(change) {
    return this.enqueue(() => {
      const current = readStateSync2(this.file);
      const next = {
        enabled: typeof change.enabled === "boolean" ? change.enabled : current.enabled,
        presets: Array.isArray(change.presets) ? change.presets.slice(0, MAX_PRESETS).map((item) => String(item).slice(0, MAX_PRESET_LENGTH)).filter(Boolean) : current.presets,
        maxPerTurn: typeof change.maxPerTurn === "number" && Number.isFinite(change.maxPerTurn) ? Math.min(20, Math.max(0, Math.floor(change.maxPerTurn))) : current.maxPerTurn,
        steerEmptyText: typeof change.steerEmptyText === "boolean" ? change.steerEmptyText : current.steerEmptyText,
        revision: current.revision + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const same = next.enabled === current.enabled && next.maxPerTurn === current.maxPerTurn && next.steerEmptyText === current.steerEmptyText && next.presets.join("\0") === current.presets.join("\0");
      if (same) return current;
      writeStateSync2(this.file, next);
      return next;
    });
  }
};
function optionalService2(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function profileDirectory2(ctx) {
  const profile = optionalService2(ctx, "profileContext");
  if (profile && typeof profile.dir === "string" && profile.dir !== "") return profile.dir;
  const homePaths = optionalService2(ctx, "homePaths");
  if (homePaths && typeof homePaths.home === "string" && homePaths.home !== "") return homePaths.home;
  return process.cwd();
}
function sendJson4(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody2(req, limit) {
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
async function readJsonBody5(req) {
  const bytes = await readBody2(req, MAX_BODY_BYTES3);
  if (bytes.length === 0) return {};
  const parsed = JSON.parse(bytes.toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}
async function handleRequest2(store, req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== PREFIX2) {
    sendJson4(res, 404, { error: "not-found" });
    return;
  }
  const method = req.method ?? "GET";
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, { allow: "GET, POST, OPTIONS" });
      res.end();
      return;
    }
    if (method === "GET") {
      sendJson4(res, 200, { ok: true, ...await store.read(), logFile: LOG_FILENAME, version: VERSION });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody5(req);
      const change = {};
      if (typeof body.enabled === "boolean") change.enabled = body.enabled;
      if (typeof body.maxPerTurn === "number") change.maxPerTurn = body.maxPerTurn;
      if (typeof body.steerEmptyText === "boolean") change.steerEmptyText = body.steerEmptyText;
      if (Array.isArray(body.presets)) change.presets = body.presets.map((item) => String(item ?? ""));
      if (Object.keys(change).length === 0) {
        sendJson4(res, 400, { error: "nothing-to-change" });
        return;
      }
      const next = await store.patch(change);
      sendJson4(res, 200, { ok: true, ...next, logFile: LOG_FILENAME, version: VERSION });
      return;
    }
    res.writeHead(405, { allow: "GET, POST, OPTIONS" });
    res.end();
  } catch (error) {
    const status = error?.status;
    if (status === 413) {
      sendJson4(res, 413, { error: "too-large" });
      return;
    }
    if (!res.headersSent) sendJson4(res, 500, { error: "internal", message: String(error?.message ?? error) });
    else res.end();
  }
}
function sanitizeTurnGuardLine(line) {
  let text = String(line ?? "").replace(/\s+/g, " ").trim();
  for (const pattern of LOCAL_PATH_PATTERNS) text = text.replace(pattern, "<path>");
  if (text.length > MAX_LOG_LINE_CHARS) text = `${text.slice(0, MAX_LOG_LINE_CHARS)}...`;
  return text;
}
function rotateTurnGuardLog(logFile) {
  try {
    const size = statSync5(logFile).size;
    if (size <= MAX_LOG_BYTES) return false;
    renameSync6(logFile, `${logFile}${LOG_ARCHIVE_SUFFIX}`);
    return true;
  } catch {
    return false;
  }
}
function formatTurnGuardLine(line) {
  return `${(/* @__PURE__ */ new Date()).toISOString()} [pid ${process.pid}] ${line}
`;
}
function appendTurnGuardLog(logFile, line) {
  try {
    rotateTurnGuardLog(logFile);
    appendFileSync(logFile, formatTurnGuardLine(sanitizeTurnGuardLine(line)), "utf8");
    return true;
  } catch {
    return false;
  }
}
function installTurnGuard(ctx, options) {
  const disposers = [];
  if (typeof ctx?.on !== "function") {
    options.log("\u5BBF\u4E3B\u6CA1\u6709\u4E8B\u4EF6\u603B\u7EBF\uFF08ctx.on \u4E0D\u53EF\u7528\uFF09\uFF0Cturn-guard \u672A\u542F\u7528");
    return () => void 0;
  }
  const isEnabled = () => options.readState().enabled === true;
  const offHistory = installHistoryGuard(ctx, options.log, isEnabled);
  disposers.push(offHistory);
  try {
    const off = ctx.on("agent/turn-stopping", (payload) => {
      try {
        const state = options.readState();
        const turnLabel = typeof payload?.turn === "number" ? String(payload.turn) : "?";
        const sessionTag = `session=${sessionIdOf2(payload?.agent?.session, payload)}`;
        const quota = `maxPerTurn=${state.maxPerTurn}`;
        if (state.enabled !== true) {
          options.log(`verdict turn=${turnLabel} ${sessionTag} steer=false branch=disabled injected=0/${state.maxPerTurn} ${quota}`);
          return;
        }
        const agent = payload?.agent;
        const session = agent?.session;
        if (agent === void 0 || session === void 0) {
          options.log(`verdict turn=${turnLabel} ${sessionTag} steer=false branch=no-agent ${quota}`);
          return;
        }
        const anyPreset = state.presets.includes("*");
        if (!anyPreset) {
          const preset = presetOf(ctx, session);
          if (preset === void 0 || !state.presets.includes(preset)) {
            options.log(`verdict turn=${turnLabel} ${sessionTag} steer=false branch=preset-skip preset=${String(preset ?? "?")} allowed=[${state.presets.join(",")}] ${quota}`);
            return;
          }
        }
        const turn = typeof payload?.turn === "number" ? payload.turn : void 0;
        const verdict = judge(session, state, turn);
        const injected = verdict.injected ?? 0;
        const injectedMax = verdict.injectedMax ?? state.maxPerTurn;
        const textChars = String(verdict.text ?? "").length;
        options.log(`verdict turn=${turnLabel} ${sessionTag} steer=${verdict.steer ? "true" : "false"} branch=${verdict.branch} injected=${injected}/${injectedMax} dayInjected=${verdict.dayInjected ?? 0} scoped=${turn === void 0 ? "session" : "turn"} ${quota} textChars=${textChars} toolCall=${verdict.hasToolCall ? "yes" : "no"}`);
        if (!verdict.steer) return;
        const message = buildUserMessage(correctiveText(verdict.reason, lastToolError(session)), {
          kind: "user",
          form: "turn-guard"
        });
        assertIdentifiedMessage(message, "turn-guard corrective message");
        agent.send(message, "next-step", false);
        options.log(`steer turn=${turnLabel} ${sessionTag} reason=${verdict.reason} branch=${verdict.branch} injected=${injected + 1}/${injectedMax} textChars=${textChars}`);
      } catch (error) {
        options.log(`steer failed kind=${String(error?.name ?? "unknown")} message=${String(error?.message ?? "")}`);
      }
    });
    if (typeof off === "function") disposers.push(off);
    options.log("\u5DF2\u6302\u4E0A agent/turn-stopping \u5224\u5B9A\uFF08pre-step \u5386\u53F2\u95F8\u540C\u6302\uFF1B\u5F00\u5173\u6309\u72B6\u6001\u6587\u4EF6\u5B9E\u65F6\u5224\u65AD\uFF09");
  } catch (error) {
    options.log(`turn-stopping \u6302\u4E0D\u4E0A\uFF1A${String(error?.message ?? error)}`);
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}
function apply3(ctx) {
  const directory = profileDirectory2(ctx);
  const store = new TurnGuardStore(join7(directory, STATE_FILENAME2));
  const logFile = join7(dshHome(), LOG_FILENAME);
  const rotatedExisting = rotateTurnGuardLog(logFile);
  const log = (line) => {
    const text = sanitizeTurnGuardLine(line);
    try {
      console.warn(`dsh-assistant: ${text}`);
    } catch {
    }
    appendTurnGuardLog(logFile, text);
  };
  if (rotatedExisting) {
    let archivedBytes = 0;
    try {
      archivedBytes = statSync5(`${logFile}${LOG_ARCHIVE_SUFFIX}`).size;
    } catch {
    }
    log(`log rotate: \u73B0\u5B58\u91CF ${archivedBytes} \u5B57\u8282\u5DF2\u5F52\u6863\u5230 ${LOG_FILENAME}${LOG_ARCHIVE_SUFFIX}`);
  }
  const initial = store.readSync();
  log(`load: v${VERSION} enabled=${initial.enabled} presets=[${initial.presets.join(", ")}] maxPerTurn=${initial.maxPerTurn} steerEmptyText=${initial.steerEmptyText}`);
  const disposers = [];
  try {
    const routes = manageWebRoutes(ctx.webServer);
    routes.webServer.register({
      kind: "exact",
      path: PREFIX2,
      handler: (req, res) => {
        void handleRequest2(store, req, res);
      }
    });
    disposers.push(routes.dispose);
    log(`\u5DF2\u6302\u8F7D turn-guard \u8DEF\u7531 GET/POST ${PREFIX2}\uFF08\u72B6\u6001\u6587\u4EF6 ${STATE_FILENAME2}\uFF09`);
  } catch (error) {
    log(`turn-guard \u8DEF\u7531\u6302\u8F7D\u5931\u8D25\uFF08\u5F00\u5173\u4ECD\u6309\u72B6\u6001\u6587\u4EF6\u751F\u6548\uFF09\uFF1A${String(error?.message ?? error)}`);
  }
  disposers.push(installTurnGuard(ctx, { readState: () => store.readSync(), log }));
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  };
}
var turnGuardTestSurface = {
  looksLikeCall,
  judge,
  countGuardInjections,
  correctiveText,
  lastToolError,
  buildUserMessage,
  guardMessagesForHistory,
  normalizeState: normalizeState2,
  defaultState,
  sessionIdOf: sessionIdOf2,
  sanitizeTurnGuardLine,
  rotateTurnGuardLog,
  appendTurnGuardLog,
  Mark: MARK,
  Version: VERSION,
  MaxLogBytes: MAX_LOG_BYTES,
  LogFilename: LOG_FILENAME,
  LogArchiveSuffix: LOG_ARCHIVE_SUFFIX
};

// src/assistant-store.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { dirname as dirname7, join as join8 } from "node:path";
var STATE_ROUTE2 = "/api/assistant/state";
var STATE_FILENAME3 = "dsh-assistant-state.json";
var MAX_BODY_BYTES4 = 4 * 1024 * 1024;
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
function sendJson5(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
async function readJsonBody6(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > MAX_BODY_BYTES4) throw Object.assign(new Error("too-large"), { status: 413 });
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
  const file = join8(profileDir(ctx), STATE_FILENAME3);
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
      await mkdir(dirname7(file), { recursive: true });
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
        sendJson5(res, 404, { error: "not-found" });
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
          sendJson5(res, 200, { ok: true, state });
          return;
        }
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody6(req);
          if (!body.projects || typeof body.projects !== "object" || Array.isArray(body.projects)) {
            sendJson5(res, 400, { error: "invalid-projects" });
            return;
          }
          const base = typeof body.baseRevision === "number" ? body.baseRevision : null;
          const out = await writeState(body.projects, body.view ?? null, base);
          if (out && typeof out === "object" && "conflict" in out) {
            sendJson5(res, 409, { ok: false, conflict: true, state: out.conflict });
            return;
          }
          sendJson5(res, 200, { ok: true, state: out });
          return;
        }
        res.writeHead(405, { allow: "GET, PUT, POST" });
        res.end();
      } catch (err) {
        if (err?.status === 413) {
          sendJson5(res, 413, { error: "too-large" });
          return;
        }
        sendJson5(res, 500, { error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  return routes.dispose;
}

// src/coordinate-mode.ts
import { mkdir as mkdir2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync7 } from "node:fs";
import { dirname as dirname8, join as join9 } from "node:path";
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
  return false;
}
function readMillifraction(file) {
  try {
    const parsed = JSON.parse(readFileSync7(file, "utf8"));
    if (parsed && typeof parsed.enabled === "boolean") return parsed.enabled;
  } catch {
  }
  return defaultMillifraction();
}
function sendJson6(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
async function readBody3(req, limit = 8 * 1024) {
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
  const file = join9(profileDir2(ctx), SETTINGS_FILE);
  let enabled = readMillifraction(file);
  const currentMode = () => enabled ? "millifraction" : "pixel";
  const setEnabled = async (next) => {
    const previous = enabled;
    enabled = next;
    try {
      await mkdir2(dirname8(file), { recursive: true });
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
            sendJson6(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction()
            });
            return;
          }
          if (method === "POST" || method === "PUT") {
            const body = await readBody3(req);
            if (!body || typeof body.enabled !== "boolean") {
              sendJson6(res, 400, { ok: false, error: "invalid-enabled" });
              return;
            }
            await setEnabled(body.enabled);
            sendJson6(res, 200, {
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
          sendJson6(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
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
import { existsSync as existsSync6, mkdirSync as mkdirSync7, openSync, writeFileSync as writeFileSync7 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join10 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
import { createServer } from "node:net";

// src/desktop-focus.ts
import { createRequire as createRequire2 } from "node:module";
import { spawn } from "node:child_process";
import { basename as basename2, dirname as dirname9 } from "node:path";
var lastWakeAt = 0;
var wakePending = false;
var koffiModule;
function loadKoffi() {
  if (koffiModule !== void 0) return koffiModule;
  try {
    const req = createRequire2(import.meta.url);
    koffiModule = req("koffi");
  } catch {
    koffiModule = null;
  }
  return koffiModule;
}
function nativeFocusAvailability() {
  if (process.platform !== "win32") return { available: false, reason: "not-windows" };
  const koffi = loadKoffi();
  if (!koffi) return { available: false, reason: "koffi-unavailable" };
  try {
    user32(koffi);
    return { available: true, reason: "" };
  } catch {
    return { available: false, reason: "user32-load-failed" };
  }
}
function desktopAppExecutable() {
  if (process.platform !== "win32") return "";
  if (!process.versions.electron) return "";
  if (process.defaultApp === true) return "";
  const exe = process.execPath;
  if (!exe || basename2(exe).toLowerCase() === "electron.exe") return "";
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
      cwd: dirname9(exe),
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
function user32(koffi) {
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
    const koffi = loadKoffi();
    if (!koffi) return false;
    const api = user32(koffi);
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
var BALL_GESTURE_INTENT = {
  "short-press": "assistant",
  "long-press": "console",
  hotkey: "assistant"
};
function ballIntentFor(gesture) {
  return BALL_GESTURE_INTENT[gesture];
}
function socketBallIntent(text) {
  const value = String(text ?? "").trim();
  if (value === "console" || value === "click") return "console";
  if (value === "assistant") return "assistant";
  return null;
}
function desktopBallSingleton() {
  const root = globalThis;
  if (!root[DESKTOP_BALL_SINGLETON]) root[DESKTOP_BALL_SINGLETON] = { generation: 0, handle: null };
  return root[DESKTOP_BALL_SINGLETON];
}
function dshHome2() {
  return process.env.DSH_HOME || join10(homedir6(), ".dsh");
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
  return join10(profileDir3(ctx), "dsh-assistant-ball");
}
function findElectron() {
  const candidates = [
    join10(dshHome2(), "dsh-orb", "electron-runtime", "electron.exe"),
    join10(dshHome2(), "dsh-assistant", "electron", "electron.exe"),
    process.env.DSH_ASSISTANT_ELECTRON || ""
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync6(p)) return p;
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
  // \u957F\u6309 600ms = \u63A7\u5236\u5BA4\uFF08\u5355\u51FB\u677E\u624B = \u4E2A\u4EBA\u79D8\u4E66\uFF0C\u6620\u5C04\u5728\u5BBF\u4E3B HELPER_MAIN \u91CC\uFF09\uFF1B\u79FB\u52A8\u8D85\u8FC7\u9608\u503C\u5373\u53D6\u6D88\uFF08\u62D6\u52A8\u4F18\u5148\uFF09\u3002
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
  // \u5355\u51FB\uFF08\u77ED\u6309\u677E\u624B\u3001\u672A\u62D6\u52A8\uFF09= \u4E2A\u4EBA\u79D8\u4E66\u56FA\u5B9A\u4F1A\u8BDD\uFF082026-11-21 \u5BF9\u8C03\uFF1B\u539F\u6765\u8FD9\u91CC\u662F\u63A7\u5236\u5BA4\uFF09\u3002
  ipcMain.on('ball-up', (_e, p) => {
    const moved = Number(p && p.moved) || 0
    if (moved < 5) send('assistant')
  })
  // \u957F\u6309 600ms = \u63A7\u5236\u5BA4\uFF08\u539F\u6765\u7684\u5355\u51FB\u884C\u4E3A\uFF09\uFF1B\u62D6\u52A8\u8D85\u8FC7\u9608\u503C\u65F6\u7403\u4F53\u811A\u672C\u6839\u672C\u4E0D\u4F1A\u53D1\u8FD9\u6761\u3002
  ipcMain.on('ball-long-press', () => { send('console') })
  // \u684C\u9762\u5168\u5C40\u70ED\u952E\uFF1A\u7A97\u53E3\u4E0D\u5728\u524D\u53F0\u4E5F\u80FD\u5524\u8D77\u4E2A\u4EBA\u79D8\u4E66\uFF08\u4E0E\u5355\u51FB\u540C\u5411\uFF09\u3002
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
  const dir = join10(profileDir3(ctx), "dsh-assistant-ball");
  try {
    mkdirSync7(dir, { recursive: true });
    writeFileSync7(join10(dir, "package.json"), JSON.stringify({ name: "dsh-assistant-ball", version: "1.0.0", main: "main.js" }), "utf8");
    writeFileSync7(join10(dir, "main.js"), HELPER_MAIN, "utf8");
    const avatar = String(opts.avatar ?? "").trim();
    const safeAvatar = avatar.startsWith("data:image/") ? avatar.replace(/"/g, "&quot;") : "";
    const avatarScript = safeAvatar ? `<script>document.getElementById('b').innerHTML=${JSON.stringify(`<img src="${safeAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none" alt="">`)}</script>` : "";
    writeFileSync7(join10(dir, "index.html"), BALL_HTML.replace("</body>", `${avatarScript}</body>`), "utf8");
  } catch (err) {
    try {
      console.error("[dsh-assistant] \u5199\u60AC\u6D6E\u7403 helper \u5931\u8D25\uFF1A", err);
    } catch {
    }
    return null;
  }
  const token = randomBytes2(16).toString("hex");
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
        const intent = socketBallIntent(text);
        if (intent !== null) {
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
      logFd = openSync(join10(dir, "helper.log"), "a");
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
var desktopBallTestSurface = {
  BALL_GESTURE_INTENT,
  ballIntentFor,
  socketBallIntent,
  helperMain: () => HELPER_MAIN,
  ballHtml: () => BALL_HTML
};

// src/assistant-diagnostics.ts
import { existsSync as existsSync7, readFileSync as readFileSync8, statSync as statSync6, writeFileSync as writeFileSync8 } from "node:fs";
import { homedir as homedir7, tmpdir as tmpdir2 } from "node:os";
import { join as join11 } from "node:path";
import { createRequire as createRequire3 } from "node:module";
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
  push("<PROFILE>", join11(dsHome, "profiles", "desktop"));
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
  if (!existsSync7(path)) return { path, exists: false, lines: [], truncated: false };
  let raw = "";
  try {
    const size = statSync6(path).size;
    raw = readFileSync8(path, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    const truncated = size > maxBytes || lines.length > maxLines;
    return { path, exists: true, lines: lines.slice(-maxLines), truncated };
  } catch {
    return { path, exists: true, lines: [], truncated: true };
  }
}
function jsonSummary(path) {
  if (!existsSync7(path)) return { path, exists: false, summary: {} };
  try {
    const parsed = JSON.parse(readFileSync8(path, "utf8"));
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
  if (!existsSync7(path)) return empty;
  try {
    const lines = readFileSync8(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
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
    const require2 = createRequire3(import.meta.url);
    const pkg = require2("../package.json");
    out.package = `${pkg.name}@${pkg.version}`;
  } catch {
    out.package = "unknown";
  }
  try {
    const manifest = JSON.parse(readFileSync8(join11(process.cwd(), "dsh.plugin.json"), "utf8"));
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
  const profileDir6 = (() => {
    try {
      const p = ctx?.get?.("profileContext");
      if (p && typeof p.dir === "string" && p.dir) return p.dir;
    } catch {
    }
    return join11(dsHome, "profiles", "desktop");
  })();
  const config = loadAssistantConfig();
  const bundle = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    versions: versions(),
    assistantHome: { dir: home.dir, usage: assistantHomeUsage() },
    focusLog: tailLines(join11(dsHome, "dsh-assistant-focus.log")),
    ballHelperLog: tailLines(join11(profileDir6, "dsh-assistant-ball", "helper.log")),
    pocketDiagnostic: pocketDiagSummary(join11(dsHome, "dsh-pocket", "diagnostic.jsonl")),
    stateFiles: {
      assistant: jsonSummary(join11(profileDir6, "dsh-assistant-state.json")),
      tuoguan: jsonSummary(join11(profileDir6, "dsh-tuoguan-state.json"))
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
        return statSync6(join11(profileDir6, "dsh-assistant-ball", "helper.pid")).size;
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
  const stamp2 = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const savedPath = join11(home.outputs, `diagnostics-${stamp2}.json`);
  try {
    writeFileSync8(savedPath, text + "\n", { mode: 384 });
  } catch {
    writeFileSync8(savedPath, text + "\n", "utf8");
  }
  return { savedPath, bytes: Buffer.byteLength(text, "utf8"), replaced, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function registerAssistantDiagnostics(ctx) {
  const routes = manageWebRoutes(ctx.webServer);
  const webServer = routes.webServer;
  const sendJson13 = (res, status, body) => {
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
        sendJson13(res, 200, { ok: true, redactedReplacements: replaced, bundle: JSON.parse(text) });
      } catch (err) {
        sendJson13(res, 500, { ok: false, error: String(err) });
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
        sendJson13(res, 200, { ok: true, ...result, outputsDir: ensureAssistantHome().outputs });
        try {
          ctx.logger?.info?.(`[dsh-assistant] \u8BCA\u65AD\u5305\u5DF2\u5BFC\u51FA\uFF1A${result.savedPath}\uFF08\u8131\u654F\u66FF\u6362 ${result.replaced} \u5904\uFF09`);
        } catch {
        }
      } catch (err) {
        sendJson13(res, 500, { ok: false, error: String(err) });
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
import { copyFileSync as copyFileSync3, existsSync as existsSync8, mkdirSync as mkdirSync9, readFileSync as readFileSync9, readdirSync as readdirSync3, statSync as statSync7, writeFileSync as writeFileSync9 } from "node:fs";
import { join as join12, dirname as dirname10, relative, isAbsolute as isAbsolute2 } from "node:path";
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
    if (!existsSync8(absPath)) return;
    let content = "";
    try {
      if (statSync7(absPath).size > MAX_ITEM_BYTES) return;
      content = readFileSync9(absPath, "utf8");
    } catch {
      return;
    }
    items.push({ area, relPath, content, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) });
  };
  push("agents", join12(home.dir, "AGENTS.md"), "AGENTS.md");
  push("config", join12(home.dir, "config.json"), "config.json");
  for (const area of ["journal", "notes"]) {
    const dir = area === "journal" ? home.journal : home.notes;
    for (const rel of listFilesRecursively(dir)) push(area, join12(dir, rel), rel);
  }
  for (const rel of listFilesRecursively(home.archive)) push("archive", join12(home.archive, rel), rel);
  const memoryDir = runtimeMemoryDir();
  for (const name3 of ["USER.md", "MEMORY.md", "memories.json"]) push("memory", join12(memoryDir, name3), name3);
  const dsHome = dshHome();
  for (const name3 of ["dsh-assistant-state.json", "dsh-tuoguan-state.json"]) {
    for (const dir of [join12(dsHome, "profiles", "desktop"), dsHome]) {
      const abs = join12(dir, name3);
      if (existsSync8(abs)) {
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
    const pkg = JSON.parse(readFileSync9(join12(process.cwd(), "package.json"), "utf8"));
    return String(pkg?.version ?? "unknown");
  } catch {
    return "unknown";
  }
}
function listFilesRecursively(root, base = "") {
  if (!existsSync8(root)) return [];
  const out = [];
  let names = [];
  try {
    names = readdirSync3(root);
  } catch {
    return [];
  }
  for (const name3 of names) {
    if (name3 === "node_modules" || name3.startsWith(".")) continue;
    const abs = join12(root, name3);
    const rel = base ? `${base}/${name3}` : name3;
    try {
      if (statSync7(abs).isDirectory()) out.push(...listFilesRecursively(abs, rel));
      else out.push(rel);
    } catch {
    }
  }
  return out;
}
function writeArchiveBundle() {
  const home = ensureAssistantHome();
  const exportsDir = join12(home.dir, "exports");
  mkdirSync9(exportsDir, { recursive: true });
  const { bundle, items, totals } = collectArchive();
  const savedPath = join12(exportsDir, `archive-${stampNow()}.json`);
  if (Buffer.byteLength(bundle, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`\u6863\u6848\u5305\u592A\u5927\uFF08${totals.bytes} \u5B57\u8282 > ${MAX_BUNDLE_BYTES}\uFF09\uFF0C\u5148\u6E05 archive/ \u6216\u6311\u7740\u5BFC`);
  }
  try {
    writeFileSync9(savedPath, bundle + "\n", { mode: 384 });
  } catch {
    writeFileSync9(savedPath, bundle + "\n", "utf8");
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
  const stamp2 = stampNow();
  const backupDir = join12(home.archive, `import-backup-${stamp2}`);
  if (!dryRun) mkdirSync9(backupDir, { recursive: true });
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
    const target = join12(targetDir, item.relPath);
    const relCheck = relative(targetDir, target);
    if (!relCheck || relCheck.startsWith("..") || isAbsolute2(item.relPath)) {
      report.skipped.push({ area, relPath: item.relPath, why: "\u8DEF\u5F84\u8D8A\u754C\uFF08\u4E0D\u8BB8\u8DF3\u51FA\u52A9\u624B\u5BB6\u76EE\u5F55\uFF09" });
      continue;
    }
    const incomingHash = sha256(item.content);
    if (existsSync8(target)) {
      let existing = "";
      try {
        existing = readFileSync9(target, "utf8");
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
      const altRel = `${stem}.imported-${stamp2}${extension}`;
      const alt = join12(targetDir, altRel);
      if (!dryRun) {
        mkdirSync9(dirname10(alt), { recursive: true });
        writeFileSync9(alt, item.content, "utf8");
      }
      report.keptBoth.push({ area, relPath: item.relPath, wroteAs: altRel });
      report.totals.items += 1;
      report.totals.bytes += Buffer.byteLength(item.content, "utf8");
      continue;
    }
    if (!dryRun) {
      mkdirSync9(targetDir, { recursive: true });
      writeFileSync9(target, item.content, "utf8");
    }
    report.written.push({ area, relPath: item.relPath, as: item.relPath });
    report.totals.items += 1;
    report.totals.bytes += Buffer.byteLength(item.content, "utf8");
  }
  if (!dryRun) {
    try {
      for (const { label, dir } of [{ label: "journal", dir: home.journal }, { label: "notes", dir: home.notes }]) {
        for (const rel of listFilesRecursively(dir)) {
          const abs = join12(dir, rel);
          if (existsSync8(abs)) copyFileSync3(abs, join12(backupDir, `${label}_${rel.replace(/[\\/]/g, "_")}`));
        }
      }
      const agents = join12(home.dir, "AGENTS.md");
      if (existsSync8(agents)) copyFileSync3(agents, join12(backupDir, "AGENTS.md"));
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
  const sendJson13 = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  const readBody4 = async (req, limitBytes = MAX_BUNDLE_BYTES) => {
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
        sendJson13(res, 200, { ok: true, totals, count: items.length, bundle: JSON.parse(bundle) });
      } catch (err) {
        sendJson13(res, 500, { ok: false, error: String(err) });
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
        sendJson13(res, 200, { ok: true, ...result });
        try {
          ctx.logger?.info?.(`[dsh-assistant] \u52A9\u624B\u6863\u6848\u5DF2\u5BFC\u51FA\uFF1A${result.savedPath}\uFF08${result.items} \u9879\uFF09`);
        } catch {
        }
      } catch (err) {
        sendJson13(res, 500, { ok: false, error: String(err) });
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
      const body = await readBody4(req);
      if (body?.__tooLarge) {
        sendJson13(res, 413, { ok: false, error: "\u5305\u592A\u5927\uFF08\u4E0A\u9650 48MB\uFF09" });
        return;
      }
      if (body?.__badJson) {
        sendJson13(res, 400, { ok: false, error: "body \u4E0D\u662F\u5408\u6CD5 JSON" });
        return;
      }
      const bundle = body?.bundle ?? body;
      const known = Array.isArray(body?.knownPresets) ? body.knownPresets.map(String) : [];
      const report = importArchiveBundle(bundle, known, body?.dryRun === true);
      sendJson13(res, report.ok ? 200 : 400, { ok: report.ok, ...report, restartRequired: report.ok && !report.dryRun ? true : false });
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

// src/assistant-secretary.ts
import { existsSync as existsSync9, mkdirSync as mkdirSync10, readFileSync as readFileSync11, renameSync as renameSync7, rmSync, writeFileSync as writeFileSync11 } from "node:fs";
import { dirname as dirname11, join as join14 } from "node:path";
import zlib from "node:zlib";

// src/assistant-open-diag.ts
import { appendFileSync as appendFileSync2, readFileSync as readFileSync10, statSync as statSync8, writeFileSync as writeFileSync10 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join13 } from "node:path";
var OPEN_DIAG_LOG = (() => {
  const override = String(globalThis.process?.env?.DSH_ASSISTANT_OPEN_DIAG_LOG ?? "").trim();
  return override !== "" ? override : join13(homedir8(), ".dsh", "dsh-assistant-open.log");
})();
var SIZE_LIMIT = 512 * 1024;
function appendOpenDiag(entry) {
  try {
    const text = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry }).replace(/\s+/g, " ").slice(0, 2e3);
    try {
      if (statSync8(OPEN_DIAG_LOG).size > SIZE_LIMIT) writeFileSync10(OPEN_DIAG_LOG, "", "utf8");
    } catch {
    }
    appendFileSync2(OPEN_DIAG_LOG, text + "\n", "utf8");
  } catch {
  }
}
function readOpenDiagTail(lines = 40) {
  try {
    const raw = readFileSync10(OPEN_DIAG_LOG, "utf8").split("\n").filter((line) => line.trim() !== "");
    return raw.slice(-lines);
  } catch {
    return [];
  }
}
var OPEN_DIAG_PATH = "/api/assistant/open-diag";
var MAX_BODY_BYTES5 = 8192;
function readJsonBody7(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req?.on?.("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES5 + 1024) chunks.push(Buffer.from(chunk));
    });
    req?.on?.("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? parsed : { raw: String(parsed ?? "").slice(0, 500) });
      } catch {
        resolve({ raw: text.slice(0, 500) });
      }
    });
    req?.on?.("error", () => resolve({}));
  });
}
function sendJson7(res, status, payload) {
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  } catch {
  }
  res.end(JSON.stringify(payload));
}
async function handleOpenDiag(req, res) {
  const method = String(req?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    sendJson7(res, 200, { ok: true, lines: readOpenDiagTail() });
    return;
  }
  if (method !== "POST") {
    res.writeHead(405, { allow: "GET, HEAD, POST" });
    res.end();
    return;
  }
  await readJsonBody7(req).then((body) => {
    const entry = body && typeof body === "object" ? body : { raw: String(body ?? "") };
    try {
      appendOpenDiag({ ...entry, from: "client" });
    } catch {
    }
    sendJson7(res, 200, { ok: true });
  });
}
function registerAssistantOpenDiagRoute(server) {
  if (!server || typeof server.register !== "function") return () => void 0;
  const unregister = server.register({ kind: "exact", path: OPEN_DIAG_PATH, handler: handleOpenDiag });
  return () => {
    try {
      if (typeof unregister === "function") unregister();
    } catch {
    }
  };
}

// src/assistant-secretary.ts
var ASSISTANT_SECRETARY_ROUTE = "/api/assistant/secretary";
var SECRETARY_DISPATCH_POLICY = "default-computer-use-v2";
var STATE_FILENAME4 = "dsh-assistant-secretary.json";
var MAX_BODY_BYTES6 = 4096;
var SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
var ASSISTANT_SECRETARY_SESSIONS_ROUTE = "/api/assistant/secretary/sessions";
var SECRETARY_SESSIONS_DEFAULT_LIMIT = 200;
var SECRETARY_SESSIONS_MAX_LIMIT = 600;
var SECRETARY_SESSIONS_QUERY_MAX = 80;
var TITLE_MAX_CHARS = 160;
var CWD_MAX_CHARS = 300;
var EXISTENCE_TTL_MS = 3e4;
var existenceCache = null;
function parseSecretaryRequestQuery(rawUrl) {
  const url = String(rawUrl ?? "");
  const queryIndex = url.indexOf("?");
  const query = queryIndex === -1 ? "" : url.slice(queryIndex + 1);
  const wantsVerify = /(?:^|&)verify=1(?:&|$)/.test(query);
  const match = query.match(/(?:^|&)session(?:Id)?=([^&]*)/);
  const raw = match === null ? "" : decodeURIComponent(match[1]);
  const trimmed = raw.trim();
  return { wantsVerify, requestedId: SESSION_ID_RE.test(trimmed) ? trimmed : "" };
}
async function secretarySessionExistsOnHost(ctx, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (id === "") return false;
  const now = Date.now();
  if (existenceCache && existenceCache.id === id && now - existenceCache.at < EXISTENCE_TTL_MS) return existenceCache.value;
  let asked = false;
  try {
    const live = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : null;
    if (live !== null) {
      asked = true;
      if (live.some((session) => String(session?.header?.id ?? session?.id ?? "") === id)) {
        existenceCache = { id, value: true, at: Date.now() };
        return true;
      }
    }
  } catch {
  }
  try {
    const query = ctx?.get?.("sessionQuery");
    if (query && typeof query.listSessions === "function") {
      const list = await query.listSessions(void 0);
      asked = true;
      const found = Array.isArray(list) ? list.some((record) => String(record?.header?.id ?? record?.sessionId ?? "") === id) : false;
      existenceCache = { id, value: found, at: Date.now() };
      return found;
    }
  } catch {
  }
  if (!asked) return null;
  existenceCache = { id, value: false, at: Date.now() };
  return false;
}
function normalizeBindableSessionRow(raw) {
  const record = raw;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const header = typeof record.header === "object" && record.header !== null ? record.header : record;
  const id = String(header?.id ?? record?.sessionId ?? "").trim();
  if (!SESSION_ID_RE.test(id)) return null;
  const titleRaw = typeof header.title === "string" ? header.title : "";
  const displayTitle = typeof header.displayTitle === "string" ? header.displayTitle : "";
  const title = (displayTitle || titleRaw || id).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
  const cwdRaw = typeof header.cwd === "string" ? header.cwd : "";
  const stamp2 = Number(header.updatedAt ?? header.createdAt ?? 0);
  const updatedAt = Number.isFinite(stamp2) && stamp2 > 0 ? stamp2 : 0;
  const row = { sessionId: id, title, updatedAt, cwd: cwdRaw.slice(0, CWD_MAX_CHARS) };
  if (header.archived === true) row.archived = true;
  if (header.live === true) row.live = true;
  if (header.bound === true) row.bound = true;
  return row;
}
function parseSecretarySessionsQuery(rawUrl) {
  const url = String(rawUrl ?? "");
  const index = url.indexOf("?");
  const query = index === -1 ? "" : url.slice(index + 1);
  const qMatch = query.match(/(?:^|&)q=([^&]*)/);
  const lMatch = query.match(/(?:^|&)limit=(\d{1,4})/);
  const keyword = qMatch === null ? "" : decodeURIComponent(qMatch[1]).replace(/\s+/g, " ").trim().slice(0, SECRETARY_SESSIONS_QUERY_MAX);
  const parsed = lMatch === null ? 0 : Number(lMatch[1]);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, SECRETARY_SESSIONS_MAX_LIMIT) : SECRETARY_SESSIONS_DEFAULT_LIMIT;
  return { query: keyword, limit };
}
function sessionRowMatchesKeyword(row, keyword) {
  if (keyword === "") return true;
  const needle = keyword.toLowerCase();
  return row.title.toLowerCase().includes(needle) || row.sessionId.toLowerCase().includes(needle) || row.cwd.toLowerCase().includes(needle);
}
function pickBindableSessions(rows, opts = {}) {
  const currentId = String(opts.currentId ?? "").trim();
  const keyword = String(opts.query ?? "").trim();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SECRETARY_SESSIONS_DEFAULT_LIMIT;
  const merged = /* @__PURE__ */ new Map();
  for (const row of Array.from(rows ?? [])) {
    const normalized = normalizeBindableSessionRow(row);
    if (normalized === null) continue;
    if (normalized.archived === true) continue;
    const previous = merged.get(normalized.sessionId);
    if (previous === void 0) {
      merged.set(normalized.sessionId, normalized);
      continue;
    }
    if (normalized.updatedAt > previous.updatedAt) {
      previous.updatedAt = normalized.updatedAt;
      if (normalized.title !== normalized.sessionId) previous.title = normalized.title;
      if (normalized.cwd !== "") previous.cwd = normalized.cwd;
    }
    if (normalized.live === true) previous.live = true;
  }
  const current = currentId !== "" ? merged.get(currentId) : void 0;
  if (current !== void 0) current.bound = true;
  const filtered = Array.from(merged.values()).filter((row) => sessionRowMatchesKeyword(row, keyword));
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  if (filtered.length <= limit) return filtered;
  const trimmed = filtered.slice(0, limit);
  if (current !== void 0 && !trimmed.includes(current)) trimmed.unshift(current);
  return trimmed;
}
function markBoundSessions(rows, currentId) {
  const id = String(currentId ?? "").trim();
  return Array.from(rows ?? []).map((row) => row.sessionId === id ? { ...row, bound: true } : row);
}
function secretaryStateMatchesWrite(expected, readBack) {
  return readBack !== null && readBack.sessionId === expected;
}
var secretarySessionRef = { id: "" };
function profileDir4(ctx) {
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
function normalizeSecretaryState(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return {
    sessionId,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
  };
}
var SECRETARY_DELEGATION_TOOLS = /* @__PURE__ */ new Set([
  "secretary_dispatch"
]);
var SECRETARY_READONLY_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "glob",
  "grep",
  "read_image"
]);
var SECRETARY_GOAL_TOOLS = /* @__PURE__ */ new Set([
  "create_goal",
  "update_goal",
  "get_goal"
]);
var NOTICE_MESSAGE_IDS = /* @__PURE__ */ new Set();
var NOTICE_ID_LIMIT = 400;
function registerNoticeMessageId(id) {
  const value = String(id ?? "").trim();
  if (value === "") return;
  NOTICE_MESSAGE_IDS.add(value);
  if (NOTICE_MESSAGE_IDS.size > NOTICE_ID_LIMIT) {
    const oldest = NOTICE_MESSAGE_IDS.values().next().value;
    if (typeof oldest === "string") NOTICE_MESSAGE_IDS.delete(oldest);
  }
}
function isNoticeMessageId(id) {
  const value = typeof id === "string" ? id.trim() : "";
  return value !== "" && NOTICE_MESSAGE_IDS.has(value);
}
function clearNoticeMessageIds() {
  NOTICE_MESSAGE_IDS.clear();
}
var SECRETARY_ALLOWED_TOOLS = /* @__PURE__ */ new Set([
  "ask_user_question",
  "present",
  "skill",
  "todo_write",
  "list_agents",
  "job_list",
  "job_output",
  "proactive_card",
  "web_search",
  "web_fetch",
  // 日程四件套只作用于本会话自己的提醒表（不落本机文件/不动屏幕/不跑终端），2026-11-22 用户要求放行。
  "schedule_list",
  "schedule_create",
  "schedule_update",
  "schedule_delete"
]);
function secretaryToolDenied(toolName) {
  const name3 = String(toolName ?? "").trim().toLowerCase();
  if (name3 === "") return false;
  if (SECRETARY_DELEGATION_TOOLS.has(name3)) return false;
  if (SECRETARY_READONLY_TOOLS.has(name3)) return false;
  if (SECRETARY_GOAL_TOOLS.has(name3)) return true;
  if (SECRETARY_ALLOWED_TOOLS.has(name3)) return false;
  if (name3.startsWith("web_")) return false;
  if (name3.startsWith("session_")) return false;
  if (name3.startsWith("mnemon_")) return false;
  return true;
}
function secretaryNoticeTurnAllowed(toolName) {
  const name3 = String(toolName ?? "").trim().toLowerCase();
  if (name3 === "") return false;
  if (SECRETARY_READONLY_TOOLS.has(name3)) return true;
  return false;
}
function sendJson8(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readJsonBody8(req, maxBytes = MAX_BODY_BYTES6) {
  return new Promise((resolve) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      const text = String(chunk ?? "");
      size += Buffer.byteLength(text);
      if (size <= maxBytes) raw += text;
    });
    req.on("end", () => {
      if (size > maxBytes) {
        resolve({ __tooLarge: true });
        return;
      }
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
function readFileState(file) {
  try {
    return normalizeSecretaryState(JSON.parse(readFileSync11(file, "utf8")));
  } catch {
    return null;
  }
}
var ASSISTANT_SECRETARY_READ_ROUTE = "/api/assistant/secretary-read";
var READ_STATE_FILENAME = "dsh-assistant-secretary-read.json";
var READ_MAX_KEYS = 400;
var READ_CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/;
var ASSISTANT_SECRETARY_QUOTE_ROUTE = "/api/assistant/secretary-quote";
var QUOTE_STATE_FILENAME = "dsh-assistant-secretary-quote.json";
var QUOTE_TTL_MS = 30 * 60 * 1e3;
var QUOTE_PREVIEW_MAX_CHARS = 600;
var QUOTE_MAX_BODY_BYTES = 256 * 1024;
var QUOTE_CARD_KINDS = ["assistant", "user", "notice"];
var SECRETARY_QUOTE_SECTION_ORDER = 1783;
var SECRETARY_QUOTE_ANCHOR_SECTION_ORDER = 1791;
var QUOTE_MESSAGE_BLOCK_OPEN = "\u3010\u5F15\u7528\u5361\uFF5C\u672C\u8F6E\u5FC5\u987B\u56DE\u7B54\u7684\u5361\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09\u3011";
var QUOTE_BODY_MAX_CHARS = 2e4;
var QUOTE_ATTACHMENT_MAX = 12;
var QUOTE_ATTACHMENT_TEXT_MAX = 160;
function normalizeQuoteCardKey(raw) {
  const value = String(raw ?? "").trim();
  return READ_CARD_KEY_RE.test(value) ? value : "";
}
function normalizeQuoteSessionIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (id === "" || id.length > 120 || !SESSION_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}
function normalizeQuoteAttachments(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const source = item;
    const name3 = String(source.name ?? "").trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX);
    if (name3 === "") continue;
    const kind = String(source.kind ?? "").trim() === "image" ? "image" : "file";
    const meta = String(source.meta ?? "").trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX);
    if (out.some((existing) => existing.name === name3 && existing.kind === kind)) continue;
    out.push({ name: name3, kind, meta });
    if (out.length >= QUOTE_ATTACHMENT_MAX) break;
  }
  return out;
}
function normalizeQuoteBody(raw) {
  const text = String(raw ?? "").trim();
  if (text.length <= QUOTE_BODY_MAX_CHARS) return text;
  const cut = text.slice(0, QUOTE_BODY_MAX_CHARS);
  return `${cut}
\uFF08\u5361\u6B63\u6587\u8D85\u8FC7 ${QUOTE_BODY_MAX_CHARS} \u5B57\uFF0C\u5F15\u7528\u94FE\u8DEF\u53EA\u4FDD\u5230\u8FD9\u91CC\uFF1B\u540E\u9762\u8FD8\u6709 ${text.length - QUOTE_BODY_MAX_CHARS} \u5B57\u672A\u6CE8\u5165\uFF09`;
}
function normalizeQuoteRecord(raw, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : null;
  if (source === null) return null;
  const cardKey = normalizeQuoteCardKey(source.cardKey);
  const kind = String(source.kind ?? "").trim();
  if (cardKey === "" || !QUOTE_CARD_KINDS.includes(kind)) return null;
  const previewRaw = String(source.preview ?? "");
  const preview = previewRaw.length > QUOTE_PREVIEW_MAX_CHARS ? `${previewRaw.slice(0, QUOTE_PREVIEW_MAX_CHARS - 1)}\u2026` : previewRaw;
  const updatedAtRaw = Number(source.updatedAt);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : now;
  return {
    cardKey,
    kind,
    turnNo: String(source.turnNo ?? "").trim(),
    preview,
    body: normalizeQuoteBody(source.body),
    attachments: normalizeQuoteAttachments(source.attachments),
    refSessionIds: normalizeQuoteSessionIds(source.refSessionIds),
    updatedAt
  };
}
function quoteAlive(record, now = Date.now(), ttlMs = QUOTE_TTL_MS) {
  if (record === null) return false;
  return now - record.updatedAt <= ttlMs;
}
function normalizeSecretaryQuoteState(raw, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [sessionId, value] of Object.entries(source)) {
    if (!SESSION_ID_RE.test(String(sessionId ?? ""))) continue;
    const record = normalizeQuoteRecord(value, now);
    if (record === null || !quoteAlive(record, now)) continue;
    out[sessionId] = record;
  }
  return out;
}
var QUOTE_KIND_LABELS = {
  notice: "\u7CFB\u7EDF\u901A\u77E5\u5361",
  user: "\u7528\u6237\u6D88\u606F\u5361",
  assistant: "\u79D8\u4E66\u56DE\u590D\u5361"
};
function secretaryQuoteInjectionText(record) {
  if (record === null) return "";
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? "\u5361\u7247";
  const lines = [
    "# \u5361\u7247\u5F15\u7528\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09",
    `\u7528\u6237\u521A\u5728\u4F1A\u8BDD\u9875\u4E0A\u6309\u4E86\u300C\u5F15\u7528\u300D\uFF0C\u5F15\u7528\u7684\u5C31\u662F\u4E0B\u9762\u8FD9\u5F20${kindLabel}\uFF1B\u7528\u6237\u8FD9\u6761\u6D88\u606F\u5C31\u662F\u8981\u63A5\u7740\u5B83\u8BF4\u7684\u5185\u5BB9\u3002`,
    `\u5B9A\u4F4D\uFF1Akind=${record.kind}\uFF5C\u8F6E\u6B21 ${record.turnNo === "" ? "\u672A\u77E5" : record.turnNo}\uFF5CcardKey=${record.cardKey}`,
    `\u5361\u7247\u6B63\u6587\u6458\u5F55\uFF08\u4E0D\u662F\u5B8C\u6574\u6C47\u62A5\uFF0C\u53EA\u7528\u6765\u5B9A\u4F4D\u5F15\u7528\u7684\u662F\u54EA\u6BB5\u8BDD\uFF09\uFF1A${record.preview}`
  ];
  if (record.refSessionIds.length > 0) {
    lines.push(`\u8FD9\u5F20\u5361\u91CC\u5F15\u7528\u7684\u4F1A\u8BDD id\uFF1A${record.refSessionIds.join("\u3001")}\u2014\u2014\u63A5\u7740\u8FD9\u4EF6\u4E8B\u8981\u7EE7\u7EED\uFF0C\u5C31\u7528 secretary_dispatch kind=existing \u843D\u5230\u90A3\u6761\u4F1A\u8BDD\u6240\u5728\u7684\u9879\u76EE\u76EE\u5F55\u3002`);
  }
  lines.push("\u5904\u7406\u8981\u6C42\uFF1A\u628A\u7528\u6237\u8FD9\u6761\u6D88\u606F\u5F53\u4F5C\u5BF9\u8FD9\u5F20\u5361\u7684\u56DE\u5E94\uFF1B\u4E0D\u8BB8\u56E0\u4E3A\u6458\u5F55\u77ED\u5C31\u628A\u7528\u6237\u8FD9\u6761\u6D88\u606F\u91CC\u7684\u8981\u6C42\u541E\u6389\uFF0C\u4E5F\u4E0D\u8BB8\u628A\u8FD9\u5F20\u5361\u7684\u539F\u6709\u5185\u5BB9\u6539\u5199\u6210\u522B\u7684\u8BF4\u6CD5\u3002\u5F15\u7528\u767B\u8BB0\u53EA\u8BF4\u660E\u300C\u63A5\u7740\u54EA\u5F20\u5361\u8BF4\u300D\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u6D3E\u6D3B\u4E0E\u5DE5\u5177\u89C4\u5219\u3002");
  lines.push("\u8FD9\u5F20\u5361\u7684\u6B63\u6587\u5168\u6587\u4E0E\u9644\u4EF6\u4FE1\u606F\u5DF2\u7ECF\u62FC\u8FDB\u672C\u6761\u7528\u6237\u6D88\u606F\u7684\u6B63\u6587\u672B\u5C3E\uFF08\u300C\u5F15\u7528\u5361\u300D\u5F00\u5934\u7684\u90A3\u4E00\u5757\uFF0C\u4E0D\u662F\u7CFB\u7EDF\u63D0\u793A\u91CC\u7684\u4E00\u6BB5\u8BF4\u660E\uFF09\uFF1A\u56DE\u7B54\u53E3\u5F84\u4EE5\u90A3\u6761\u6D88\u606F\u91CC\u7684\u5361\u6B63\u6587\u4E3A\u51C6\uFF0C\u672C\u6BB5\u7684\u6458\u5F55\u53EA\u7528\u6765\u5B9A\u4F4D\u3002");
  return lines.join("\n");
}
function secretaryQuoteAnchorText(record) {
  if (record === null) return "";
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? "\u5361\u7247";
  const lines = [
    "# \u5F15\u7528\u951A\u70B9\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09",
    `\u8FD9\u6761\u7528\u6237\u6D88\u606F\u5F15\u7528\u7684\u5C31\u662F\u8FD9\u5F20${kindLabel}\uFF1AcardKey=${record.cardKey}\uFF5Ckind=${record.kind}\uFF5C\u8F6E\u6B21 ${record.turnNo === "" ? "\u672A\u77E5" : record.turnNo}\u3002`,
    `\u88AB\u5F15\u7528\u5361\u6B63\u6587\uFF1A${record.preview}`,
    "\u5904\u7406\u8981\u6C42\uFF1A\u8FD9\u6761\u6D88\u606F\u91CC\u7684\u6307\u4EE3\uFF08\u8FD9\u4E2A\u3001\u90A3\u5F20\u3001\u5B83\u3001\u8FD9\u6761\u4EFB\u52A1\uFF09\u4E00\u5F8B\u6307\u5411\u8FD9\u5F20\u5361\uFF1B\u5148\u56DE\u7B54\u8FD9\u5F20\u5361\u63A5\u7740\u7684\u90A3\u4EF6\u4E8B\uFF0C\u4E0D\u8BB8\u628A\u8FD9\u6761\u6D88\u606F\u63A5\u5230\u6700\u8FD1\u90A3\u6761\u6D3E\u6D3B\u3001\u6700\u8FD1\u90A3\u6761\u7CFB\u7EDF\u901A\u77E5\u6216\u522B\u7684\u4EFB\u52A1\u4E0A\uFF1B\u4E0D\u8BB8\u56E0\u4E3A\u6458\u5F55\u77ED\u5C31\u541E\u6389\u8FD9\u6761\u6D88\u606F\u91CC\u7684\u8981\u6C42\uFF1B\u4E0D\u8BB8\u5728\u591A\u4E2A\u5019\u9009\u4EFB\u52A1\u91CC\u81EA\u5DF1\u6311\u4E00\u4E2A\u6765\u63A5\u3002\u5F15\u7528\u951A\u70B9\u53EA\u8BF4\u660E\u300C\u63A5\u7740\u54EA\u5F20\u5361\u8BF4\u300D\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u6D3E\u6D3B\u4E0E\u5DE5\u5177\u89C4\u5219\u3002"
  ];
  return lines.join("\n");
}
function secretaryQuoteCardBlockText(record) {
  if (record === null) return "";
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? "\u5361\u7247";
  const body = record.body.trim() === "" ? record.preview : record.body;
  const attachments = record.attachments.length === 0 ? "\uFF08\u8FD9\u5F20\u5361\u6CA1\u6709\u9644\u4EF6\uFF09" : record.attachments.map((item) => `${item.name}\uFF5C${item.kind === "image" ? "\u56FE\u7247" : "\u6587\u4EF6"}${item.meta === "" ? "" : `\uFF5C${item.meta}`}`).join("\uFF1B");
  const lines = [
    QUOTE_MESSAGE_BLOCK_OPEN,
    `\u8FD9\u5F20\u5361\u662F\u7528\u6237\u8FD9\u6761\u6D88\u606F\u6309\u300C\u5F15\u7528\u300D\u9009\u4E2D\u7684${kindLabel}\uFF08\u8F6E\u6B21 ${record.turnNo === "" ? "\u672A\u77E5" : record.turnNo}\uFF5CcardKey=${record.cardKey}\uFF09\uFF1A\u6B63\u6587\u5168\u6587\u5DF2\u7ECF\u62FC\u5728\u4E0B\u9762\uFF0C\u5B83\u662F\u672C\u8F6E\u552F\u4E00\u7684\u56DE\u7B54\u5BF9\u8C61\u3002`,
    "\u2014\u2014 \u5361\u6B63\u6587\u5F00\u59CB \u2014\u2014",
    body,
    "\u2014\u2014 \u5361\u6B63\u6587\u7ED3\u675F \u2014\u2014",
    `\u5361\u91CC\u5E26\u7684\u9644\u4EF6\uFF08\u53EA\u6709\u6587\u4EF6\u4FE1\u606F\uFF0C\u56FE\u7247\u672C\u4F53\u6CA1\u6709\u968F\u5F15\u7528\u9001\u6765\uFF09\uFF1A${attachments}`,
    "\u3010\u786C\u6307\u4EE4\uFF5C\u6309\u4F18\u5148\u7EA7\u6267\u884C\u3011",
    "\u2460 \u8FD9\u5F20\u5F15\u7528\u5361\u7684\u5185\u5BB9\u4F18\u5148\u7EA7\u6700\u9AD8\uFF0C\u672C\u8F6E\u56DE\u7B54\u5FC5\u987B\u9488\u5BF9\u5B83\u3002",
    "\u2461 \u5FFD\u7565\u4E0E\u5F15\u7528\u65E0\u5173\u7684\u6700\u8FD1\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF08\u5305\u62EC\u4E0A\u4E00\u6761\u4EFB\u52A1\u3001\u7CFB\u7EDF\u901A\u77E5\u3001\u5F85\u529E\u63D0\u9192\uFF09\uFF1A\u4E0D\u8BB8\u628A\u672C\u6761\u6D88\u606F\u63A5\u5230\u6700\u8FD1\u90A3\u6761\u6D3E\u6D3B\u4E0A\uFF0C\u4E5F\u4E0D\u8BB8\u63A5\u5230\u6700\u8FD1\u90A3\u6761\u7CFB\u7EDF\u901A\u77E5\u4E0A\uFF0C\u4E5F\u4E0D\u8BB8\u63A5\u5230\u6700\u8FD1\u4E00\u8F6E\u7684\u4EFB\u52A1\u8FDB\u5EA6\u4E0A\u3002",
    "\u2462 \u7981\u6B62\u5728\u591A\u4E2A\u5019\u9009\u4EFB\u52A1\u91CC\u81EA\u5DF1\u6311\u4E00\u4E2A\u6765\u63A5\u3002",
    "\u2463 \u7528\u6237\u8FD9\u53E5\u6A21\u7CCA\u6307\u4EE3\uFF08\u8FD9\u4E2A\u3001\u90A3\u5F20\u3001\u5B83\u3001\u8FD9\u6761\u4EFB\u52A1\u3001\u8FD9\u4E2A\u4EFB\u52A1\uFF09\u4E00\u5F8B\u6307\u5411\u8FD9\u5F20\u5F15\u7528\u5361\u3002",
    "\u3010\u9644\u4EF6\u53E3\u5F84\u3011\u9644\u4EF6\u53EA\u6709\u540D\u5B57\u4E0E\u79CD\u7C7B\uFF1A\u56FE\u91CC\u7684\u5185\u5BB9\u6CA1\u6709\u968F\u5F15\u7528\u6CE8\u5165\uFF0C\u4E0D\u8BB8\u7F16\u9020\u56FE\u91CC\u6CA1\u5199\u7684\u7EC6\u8282\uFF0C\u4E5F\u4E0D\u8BB8\u5047\u88C5\u770B\u8FC7\u8FD9\u5F20\u56FE\u3002",
    "\u5F15\u7528\u5361\u53EA\u8BF4\u660E\u56DE\u7B54\u54EA\u5F20\u5361\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u6D3E\u6D3B\u4E0E\u5DE5\u5177\u89C4\u5219\u3002"
  ];
  return lines.join("\n");
}
function contentWithQuoteBlock(content, block) {
  const blocks = Array.isArray(content) ? content.slice() : [];
  if (blocks.length === 0) return null;
  let lastText = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    const item = blocks[index];
    if (item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string") lastText = index;
  }
  if (lastText >= 0) blocks[lastText] = { ...blocks[lastText], text: `${blocks[lastText].text}

${block}` };
  else blocks.push({ type: "text", text: block });
  return blocks;
}
function spliceQuoteIntoUserMessage(messages, record) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (record === null) return { messages: list, spliced: false };
  const block = secretaryQuoteCardBlockText(record);
  if (block === "") return { messages: list, spliced: false };
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message === null || typeof message !== "object") continue;
    if (message.role !== "user") continue;
    if (String(message.source?.kind ?? "") === "runtime-context") continue;
    if (isNoticeMessageId(message.id)) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) continue;
    const already = content.some((item) => item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string" && item.text.includes(QUOTE_MESSAGE_BLOCK_OPEN));
    if (already) return { messages: list, spliced: false };
    const nextContent = contentWithQuoteBlock(content, block);
    if (nextContent === null) continue;
    list[index] = { ...message, content: nextContent };
    return { messages: list, spliced: true };
  }
  return { messages: list, spliced: false };
}
function normalizeReadCardKey(raw) {
  const value = String(raw ?? "").trim();
  return READ_CARD_KEY_RE.test(value) ? value : "";
}
function normalizeReadCardKeys(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const key = normalizeReadCardKey(item);
    if (key === "" || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > READ_MAX_KEYS ? out.slice(out.length - READ_MAX_KEYS) : out;
}
function normalizeSecretaryReadState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [sessionId, value] of Object.entries(source)) {
    if (!SESSION_ID_RE.test(String(sessionId ?? ""))) continue;
    const keys = normalizeReadCardKeys(value);
    if (keys.length > 0) out[sessionId] = keys;
  }
  return out;
}
function addReadCardKey(state, sessionId, cardKey) {
  const key = normalizeReadCardKey(cardKey);
  if (key === "") return 0;
  const list = Array.isArray(state[sessionId]) ? state[sessionId] : [];
  if (!list.includes(key)) {
    list.push(key);
    while (list.length > READ_MAX_KEYS) list.shift();
  }
  state[sessionId] = list;
  return list.length;
}
var SESSION_SOURCE_NONE = "none";
function titleFromProjectionBlock(block) {
  const values = block?.values;
  if (values === null || typeof values !== "object") return "";
  const raw = values.title;
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}
function resolveHostSessionTitle(ctx, header, live) {
  const sessionId = String(header?.id ?? "").trim();
  let liveSession;
  try {
    if (live === true && sessionId !== "" && typeof ctx?.sessions?.get === "function") liveSession = ctx.sessions.get(sessionId);
  } catch {
  }
  try {
    const projections = ctx?.sessionProjections;
    if (liveSession !== void 0 && liveSession !== null && projections && typeof projections.cachedSnapshot === "function") {
      const title = titleFromProjectionBlock(projections.cachedSnapshot(liveSession));
      if (title !== "") return title;
    }
  } catch {
  }
  try {
    const cache3 = typeof ctx?.get === "function" ? ctx.get("sessionProjectionCache") : void 0;
    if (cache3 && typeof cache3.cachedSnapshot === "function") {
      let title = titleFromProjectionBlock(cache3.cachedSnapshot(header));
      if (title === "" && typeof cache3.cachedPredecessorTitle === "function") {
        title = titleFromProjectionBlock(cache3.cachedPredecessorTitle(header));
      }
      if (title !== "") return title;
    }
  } catch {
  }
  try {
    const titles = typeof ctx?.get === "function" ? ctx.get("sessionTitle") : void 0;
    if (liveSession !== void 0 && liveSession !== null && titles && typeof titles.get === "function") {
      const snapshot = titles.get(liveSession);
      const raw = typeof snapshot === "string" ? snapshot : snapshot?.title;
      const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS) : "";
      if (title !== "") return title;
    }
  } catch {
  }
  return "";
}
async function collectHostSessionRows(ctx) {
  const entries = [];
  let source = SESSION_SOURCE_NONE;
  try {
    const query = ctx?.get?.("sessionQuery");
    if (query && typeof query.listSessions === "function") {
      const list = await query.listSessions(void 0);
      if (Array.isArray(list)) {
        source = "session-query";
        for (const record of list) {
          const header = record?.header ?? record;
          if (header === null || typeof header !== "object") continue;
          entries.push({ header, live: record?.live === true });
        }
      }
    }
  } catch {
  }
  try {
    const live = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : null;
    if (live !== null) {
      if (source === SESSION_SOURCE_NONE) source = "sessions-list";
      for (const session of live) {
        const header = session?.header ?? session;
        if (header === null || typeof header !== "object") continue;
        entries.push({ header, live: true });
      }
    }
  } catch {
  }
  const rows = [];
  for (const entry of entries) {
    const row = normalizeBindableSessionRow(entry.header);
    if (row === null) continue;
    if (entry.live) row.live = true;
    if (row.title === row.sessionId) {
      const title = resolveHostSessionTitle(ctx, entry.header, entry.live);
      if (title !== "") row.title = title;
    }
    rows.push(row);
  }
  return { rows, source };
}
function registerAssistantSecretary(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const file = join14(profileDir4(ctx), STATE_FILENAME4);
  let state = readFileState(file);
  let activeSessionId = state?.sessionId ?? "";
  secretarySessionRef.id = activeSessionId;
  let chain = Promise.resolve();
  const writeState = (sessionId) => {
    const task = async () => {
      const next = { sessionId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      mkdirSync10(dirname11(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync11(tmp, JSON.stringify(next), "utf8");
      renameSync7(tmp, file);
      state = next;
      activeSessionId = next.sessionId;
      secretarySessionRef.id = next.sessionId;
      return next;
    };
    const run = chain.then(task, task);
    chain = run.then(() => void 0, () => void 0);
    return run;
  };
  const clearState = () => {
    const task = async () => {
      try {
        if (existsSync9(file)) rmSync(file, { force: true });
      } catch {
      }
      state = null;
      activeSessionId = "";
      secretarySessionRef.id = "";
    };
    const run = chain.then(task, task);
    chain = run.then(() => void 0, () => void 0);
    return run;
  };
  const restoreSecretaryState = async (previous) => {
    try {
      if (previous === null) {
        await clearState();
        return null;
      }
      const back = await writeState(previous.sessionId);
      return secretaryStateMatchesWrite(previous.sessionId, readFileState(file)) ? back : null;
    } catch {
      return null;
    }
  };
  webServer.register({
    kind: "exact",
    path: ASSISTANT_SECRETARY_ROUTE,
    handler: async (req, res) => {
      const method = String(req.method ?? "GET").toUpperCase();
      const current = state?.sessionId ?? "";
      try {
        if (method === "GET" || method === "HEAD") {
          const query = parseSecretaryRequestQuery(String(req.url ?? ""));
          const askedId = query.requestedId !== "" ? query.requestedId : current;
          const exists = query.wantsVerify ? askedId === "" ? false : await secretarySessionExistsOnHost(ctx, askedId) : void 0;
          if (query.wantsVerify && exists !== true) {
            appendOpenDiag({ step: "host-secretary-verify", sessionId: askedId, exists });
          }
          sendJson8(res, 200, {
            ok: true,
            sessionId: current || null,
            updatedAt: state?.updatedAt ?? "",
            dispatchPolicy: SECRETARY_DISPATCH_POLICY,
            ...query.wantsVerify ? { exists, ...query.requestedId !== "" ? { queried: query.requestedId } : {} } : {}
          });
          return;
        }
        if (method === "POST" || method === "PUT") {
          const body = await readJsonBody8(req);
          if (body?.__tooLarge === true) {
            sendJson8(res, 413, { ok: false, error: "too-large" });
            return;
          }
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
            return;
          }
          if (sessionId === current && state !== null) {
            appendOpenDiag({ step: "host-state-skip-unchanged", sessionId });
            sendJson8(res, 200, { ok: true, sessionId, updatedAt: state.updatedAt, unchanged: true });
            return;
          }
          const next = await writeState(sessionId);
          appendOpenDiag({ step: "host-state-write", sessionId, previous: current });
          sendJson8(res, 200, { ok: true, sessionId: next.sessionId, updatedAt: next.updatedAt });
          return;
        }
        if (method === "DELETE") {
          appendOpenDiag({ step: "host-state-clear", sessionId: current });
          await clearState();
          sendJson8(res, 200, { ok: true, sessionId: null, updatedAt: "" });
          return;
        }
        res.writeHead(405, { allow: "GET, HEAD, POST, PUT, DELETE" });
        res.end();
      } catch (err) {
        sendJson8(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: ASSISTANT_SECRETARY_SESSIONS_ROUTE,
    handler: async (req, res) => {
      const method = String(req.method ?? "GET").toUpperCase();
      const current = state?.sessionId ?? "";
      try {
        if (method === "GET" || method === "HEAD") {
          const parsed = parseSecretarySessionsQuery(String(req.url ?? ""));
          const collected = await collectHostSessionRows(ctx);
          const all = pickBindableSessions(collected.rows, {
            currentId: current,
            query: parsed.query,
            limit: Number.MAX_SAFE_INTEGER
          });
          const items = pickBindableSessions(collected.rows, {
            currentId: current,
            query: parsed.query,
            limit: parsed.limit
          });
          sendJson8(res, 200, {
            ok: true,
            sessionId: current || null,
            updatedAt: state?.updatedAt ?? "",
            query: parsed.query,
            limit: parsed.limit,
            total: all.length,
            returned: items.length,
            truncated: all.length > items.length,
            source: collected.source,
            items
          });
          return;
        }
        if (method === "POST" || method === "PUT") {
          const body = await readJsonBody8(req);
          if (body?.__tooLarge === true) {
            sendJson8(res, 413, { ok: false, error: "too-large" });
            return;
          }
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
            return;
          }
          const previous = state;
          const currentId = previous?.sessionId ?? "";
          if (sessionId === currentId && previous !== null) {
            appendOpenDiag({ step: "host-switch-skip-unchanged", sessionId });
            sendJson8(res, 200, { ok: true, sessionId, updatedAt: previous.updatedAt, unchanged: true });
            return;
          }
          const collected = await collectHostSessionRows(ctx);
          const known = collected.rows.some((row) => row.sessionId === sessionId);
          if (!known) {
            appendOpenDiag({ step: "host-switch-refused", sessionId, reason: collected.source === SESSION_SOURCE_NONE ? "no-session-source" : "session-not-in-host-list" });
            sendJson8(res, 400, {
              ok: false,
              error: collected.source === SESSION_SOURCE_NONE ? "no-session-source" : "session-not-in-host-list",
              sessionId: currentId || null
            });
            return;
          }
          let next = null;
          let writeError = "";
          try {
            next = await writeState(sessionId);
          } catch (err) {
            writeError = String(err?.message ?? err);
          }
          if (next === null) {
            appendOpenDiag({ step: "host-switch-write-failed", sessionId, error: writeError });
            sendJson8(res, 500, { ok: false, error: "state-write-failed", message: writeError, sessionId: currentId || null });
            return;
          }
          if (!secretaryStateMatchesWrite(sessionId, readFileState(file))) {
            const restored = await restoreSecretaryState(previous);
            appendOpenDiag({ step: "host-switch-read-back-mismatch", sessionId, restored: restored?.sessionId ?? "" });
            sendJson8(res, 500, {
              ok: false,
              error: "state-read-back-mismatch",
              sessionId: restored?.sessionId ?? null,
              restored: restored !== null
            });
            return;
          }
          appendOpenDiag({ step: "host-switch-bind", sessionId, previous: currentId });
          sendJson8(res, 200, {
            ok: true,
            sessionId: next.sessionId,
            updatedAt: next.updatedAt,
            previous: currentId || null,
            verified: true,
            readBack: true,
            dispatchPolicy: SECRETARY_DISPATCH_POLICY
          });
          return;
        }
        if (method === "DELETE") {
          sendJson8(res, 405, { ok: false, error: "not-allowed", message: "\u79D8\u4E66\u7ED1\u5B9A\u53EA\u80FD\u7528 POST \u6539\uFF1B\u8981\u91CD\u7F6E\u8BF7\u8D70 DELETE /api/assistant/secretary" });
          return;
        }
        res.writeHead(405, { allow: "GET, HEAD, POST, PUT" });
        res.end();
      } catch (err) {
        sendJson8(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  const readStateFile2 = join14(profileDir4(ctx), READ_STATE_FILENAME);
  const readState = (() => {
    try {
      return normalizeSecretaryReadState(JSON.parse(readFileSync11(readStateFile2, "utf8")));
    } catch {
      return {};
    }
  })();
  let readUpdatedAt = "";
  const persistReadState = () => {
    const task = async () => {
      mkdirSync10(dirname11(readStateFile2), { recursive: true });
      const tmp = `${readStateFile2}.${process.pid}.tmp`;
      const payload = { version: 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), bySession: readState };
      writeFileSync11(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync7(tmp, readStateFile2);
      readUpdatedAt = payload.updatedAt;
    };
    const run = chain.then(task, task);
    chain = run.then(() => void 0, () => void 0);
    return run;
  };
  webServer.register({
    kind: "exact",
    path: ASSISTANT_SECRETARY_READ_ROUTE,
    handler: async (req, res) => {
      const method = String(req.method ?? "GET").toUpperCase();
      try {
        if (method === "POST" || method === "PUT") {
          const body = await readJsonBody8(req);
          if (body?.__tooLarge === true) {
            sendJson8(res, 413, { ok: false, error: "too-large" });
            return;
          }
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          const cardKey = normalizeReadCardKey(body?.cardKey);
          const mark = typeof body?.mark === "string" ? body.mark.trim() : "";
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
            return;
          }
          if (cardKey === "") {
            sendJson8(res, 400, { ok: false, error: "invalid-card-key" });
            return;
          }
          if (mark !== "read") {
            sendJson8(res, 400, { ok: false, error: "invalid-mark" });
            return;
          }
          const already = (readState[sessionId] ?? []).includes(cardKey);
          const count = addReadCardKey(readState, sessionId, cardKey);
          if (!already) await persistReadState();
          sendJson8(res, 200, { ok: true, sessionId, cardKey, read: true, unchanged: already, count, updatedAt: readUpdatedAt });
          return;
        }
        const query = parseSecretaryRequestQuery(String(req.url ?? ""));
        const askedId = query.requestedId !== "" ? query.requestedId : state?.sessionId ?? "";
        if (askedId === "" || !SESSION_ID_RE.test(askedId)) {
          sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
          return;
        }
        if (method === "GET" || method === "HEAD") {
          const cards = readState[askedId] ?? [];
          sendJson8(res, 200, { ok: true, sessionId: askedId, cards, count: cards.length, updatedAt: readUpdatedAt });
          return;
        }
        if (method === "DELETE") {
          const had = Array.isArray(readState[askedId]);
          delete readState[askedId];
          if (had) await persistReadState();
          sendJson8(res, 200, { ok: true, sessionId: askedId, cards: [], count: 0, cleared: had });
          return;
        }
        res.writeHead(405, { allow: "GET, HEAD, POST, PUT, DELETE" });
        res.end();
      } catch (err) {
        sendJson8(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  const quoteFile = join14(profileDir4(ctx), QUOTE_STATE_FILENAME);
  const quoteState = (() => {
    try {
      return normalizeSecretaryQuoteState(JSON.parse(readFileSync11(quoteFile, "utf8")).quoteBySession);
    } catch {
      return {};
    }
  })();
  let quoteUpdatedAt = "";
  let quoteConsumedTurn = false;
  const persistQuoteState = () => {
    const task = async () => {
      mkdirSync10(dirname11(quoteFile), { recursive: true });
      const tmp = `${quoteFile}.${process.pid}.tmp`;
      const payload = { version: 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), quoteBySession: quoteState };
      writeFileSync11(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync7(tmp, quoteFile);
      quoteUpdatedAt = payload.updatedAt;
    };
    const run = chain.then(task, task);
    chain = run.then(() => void 0, () => void 0);
    return run;
  };
  const liveQuote = (sessionId) => {
    const record = quoteState[sessionId];
    if (record === void 0) return null;
    if (!quoteAlive(record)) {
      delete quoteState[sessionId];
      void persistQuoteState().catch(() => void 0);
      return null;
    }
    return record;
  };
  webServer.register({
    kind: "exact",
    path: ASSISTANT_SECRETARY_QUOTE_ROUTE,
    handler: async (req, res) => {
      const method = String(req.method ?? "GET").toUpperCase();
      try {
        if (method === "POST" || method === "PUT") {
          const body = await readJsonBody8(req, QUOTE_MAX_BODY_BYTES);
          if (body?.__tooLarge === true) {
            sendJson8(res, 413, { ok: false, error: "too-large" });
            return;
          }
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
            return;
          }
          const mark = typeof body?.mark === "string" ? body.mark.trim() : "";
          if (mark === "clear") {
            const had = quoteState[sessionId] !== void 0;
            delete quoteState[sessionId];
            quoteConsumedTurn = false;
            if (had) await persistQuoteState();
            sendJson8(res, 200, { ok: true, sessionId, quote: null, cleared: had, updatedAt: quoteUpdatedAt });
            return;
          }
          if (mark !== "quote") {
            sendJson8(res, 400, { ok: false, error: "invalid-mark" });
            return;
          }
          const record = normalizeQuoteRecord({
            cardKey: body?.cardKey,
            kind: body?.kind,
            turnNo: body?.turnNo,
            preview: body?.preview,
            body: body?.body,
            attachments: body?.attachments,
            refSessionIds: body?.refSessionIds,
            updatedAt: typeof body?.updatedAt === "number" ? body.updatedAt : Date.now()
          });
          if (record === null) {
            sendJson8(res, 400, { ok: false, error: "invalid-quote" });
            return;
          }
          const previous = quoteState[sessionId];
          if (previous !== void 0 && previous.cardKey === record.cardKey && previous.updatedAt === record.updatedAt) {
            sendJson8(res, 200, { ok: true, sessionId, quote: record, unchanged: true, updatedAt: quoteUpdatedAt });
            return;
          }
          quoteState[sessionId] = record;
          quoteConsumedTurn = false;
          await persistQuoteState();
          sendJson8(res, 200, { ok: true, sessionId, quote: record, unchanged: false, updatedAt: quoteUpdatedAt });
          return;
        }
        const query = parseSecretaryRequestQuery(String(req.url ?? ""));
        const askedId = query.requestedId !== "" ? query.requestedId : state?.sessionId ?? "";
        if (askedId === "" || !SESSION_ID_RE.test(askedId)) {
          sendJson8(res, 400, { ok: false, error: "invalid-session-id" });
          return;
        }
        if (method === "GET" || method === "HEAD") {
          sendJson8(res, 200, { ok: true, sessionId: askedId, quote: liveQuote(askedId), ttlMs: QUOTE_TTL_MS, updatedAt: quoteUpdatedAt });
          return;
        }
        if (method === "DELETE") {
          const had = quoteState[askedId] !== void 0;
          delete quoteState[askedId];
          if (had) await persistQuoteState();
          sendJson8(res, 200, { ok: true, sessionId: askedId, quote: null, cleared: had });
          return;
        }
        res.writeHead(405, { allow: "GET, HEAD, POST, PUT, DELETE" });
        res.end();
      } catch (err) {
        sendJson8(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  let noticeTurn = false;
  let noticeTurnAt = 0;
  const NOTICE_TURN_TTL_MS = 10 * 60 * 1e3;
  const noticeTurnActive = () => {
    if (!noticeTurn) return false;
    if (Date.now() - noticeTurnAt > NOTICE_TURN_TTL_MS) {
      noticeTurn = false;
      return false;
    }
    return true;
  };
  let offNoticeReset;
  try {
    const off = ctx.on?.("session/event", (session, event) => {
      if (String(session?.id ?? "") !== activeSessionId) return;
      const type = String(event?.type ?? "");
      if (type === "turn/end") {
        noticeTurn = false;
        noticeTurnAt = 0;
        if (quoteConsumedTurn) {
          quoteConsumedTurn = false;
          if (quoteState[activeSessionId] !== void 0) {
            delete quoteState[activeSessionId];
            void persistQuoteState().catch(() => void 0);
          }
        }
      }
    });
    if (typeof off === "function") offNoticeReset = off;
  } catch {
    offNoticeReset = void 0;
  }
  let offToolGate;
  try {
    offToolGate = ctx.on?.("tools/pre-execute", async (exec, next) => {
      if (activeSessionId === "") return next();
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? "");
      if (caller !== activeSessionId) return next();
      const tool = String(exec?.name ?? "");
      if (noticeTurnActive() && !secretaryNoticeTurnAllowed(tool)) {
        return {
          kind: "deny",
          reason: "\u8FD9\u4E00\u8F6E\u662F\u63D2\u4EF6\u81EA\u52A8\u9001\u6765\u7684\u300C\u7535\u8111\u64CD\u4F5C\u4F1A\u8BDD\u5B8C\u6210\uFF0F\u5931\u8D25\u300D\u7CFB\u7EDF\u901A\u77E5\uFF0C\u4E0D\u662F\u7528\u6237\u7684\u8981\u6C42\uFF1A\u52A8\u624B\u7C7B\u5DE5\u5177\u5DF2\u7981\u7528\uFF08\u5199\u6587\u4EF6\u3001\u7F16\u8F91\u3001\u7EC8\u7AEF\u3001\u76F4\u63A5\u64CD\u4F5C\u5C4F\u5E55\u3001\u6D3E\u5B50\u4EE3\u7406\u3001\u518D\u6D3E\u6D3B\u90FD\u4E0D\u884C\uFF09\u3002\u7ACB\u76EE\u6807\u4E5F\u4E00\u6837\u88AB\u62D2\uFF08create_goal/update_goal/get_goal\uFF09\u2014\u2014\u76EE\u6807\u7531 Computer Use \u4F1A\u8BDD\u81EA\u5DF1\u7ACB\u3001\u81EA\u5DF1\u5B8C\u6210\uFF0C\u8FD9\u4E00\u8F6E\u79D8\u4E66\u4E0D\u505A\u76EE\u6807\u7BA1\u7406\uFF1B\u786E\u5B9E\u8FD8\u8981\u52A8\u624B\u5C31\u7528 secretary_dispatch \u6539\u6D3E\u3002\u5B8C\u6210\u5C31\u628A\u90A3\u6761 Computer Use \u4F1A\u8BDD\u7684\u7ED3\u679C\u5B8C\u6574\u6C47\u62A5\u7ED9\u7528\u6237\u2014\u2014\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u81EA\u5DF1\u6574\u7406\u6210\u7B80\u77ED\u7684\u4E2D\u6587\u56DE\u590D\uFF0C\u4FDD\u7559\u6587\u4EF6\u540D\u3001\u5927\u5C0F\u3001\u54C8\u5E0C\u3001\u6570\u5B57\u3001\u63D0\u4EA4\u53F7\u3001\u5224\u636E\u3001\u7ED3\u8BBA\u3001\u5F85\u529E\u7B49\u786C\u4E8B\u5B9E\uFF1B\u4E0D\u8BB8\u6574\u5927\u6BB5\u539F\u5C01\u4E0D\u52A8\u7167\u6284\u3001\u4E0D\u8BB8\u7167\u6284\u8868\u683C\u4E0E\u957F\u8DEF\u5F84\u3001\u4E0D\u8BB8\u91CD\u590D\u901A\u77E5\u539F\u6587\uFF1B\u539F\u6587\u88AB\u88C1\u65F6\u53EF\u4EE5\u7528 read/glob/grep \u6309\u901A\u77E5\u91CC\u7684\u843D\u76D8\u8DEF\u5F84\u628A\u62A5\u544A\u6587\u4EF6\u6574\u6BB5\u8BFB\u56DE\u6765\u518D\u6574\u7406\uFF1B\u5931\u8D25\u8F6E\u5C31\u7167\u5B9E\u8BF4\u662F\u300C\u6D3E\u6D3B\u5931\u8D25\uFF0F\u8FD9\u4E00\u8F6E\u5931\u8D25\u300D\uFF0C\u628A\u9519\u8BEF\u7801\u4E0E\u9519\u8BEF\u539F\u6587\u5B8C\u6574\u6C47\u62A5\u7ED9\u7528\u6237\u5E76\u63D0\u793A\u53EF\u4EE5\u6539\u6D3E\uFF08\u65B0\u5EFA\u4E00\u6761 Computer Use \u4F1A\u8BDD\u6216\u6362\u4E2A\u9879\u76EE\u76EE\u5F55\uFF09\uFF0C\u4E0D\u8BB8\u8BF4\u6210\u5DF2\u6D3E\u6D3B\uFF0F\u5DF2\u5B8C\u6210\u3002"
        };
      }
      if (!secretaryToolDenied(tool)) return next();
      return {
        kind: "deny",
        reason: `\u4E2A\u4EBA\u79D8\u4E66\u53EA\u8BFB\u95F8\u5DF2\u62D2\u7EDD ${tool || "\u672A\u77E5\u5DE5\u5177"}\uFF08\u5199\u6587\u4EF6/\u7F16\u8F91/\u7EC8\u7AEF/\u76F4\u63A5\u64CD\u4F5C\u5C4F\u5E55/\u6D3E\u5B50\u4EE3\u7406\u4E0D\u80FD\u5728\u79D8\u4E66\u4F1A\u8BDD\u6267\u884C\uFF1B\u8BFB\u6587\u4EF6 read/glob/grep \u4E0E\u53EA\u8BFB\u8054\u7F51 web_search/web_fetch \u662F\u653E\u884C\u7684\uFF1Bcreate_goal / update_goal / get_goal \u5DF2\u88AB\u7981\u7528\u2014\u2014\u76EE\u6807\u7531 Computer Use \u4F1A\u8BDD\u81EA\u5DF1\u7ACB\u3001\u81EA\u5DF1\u5B8C\u6210\uFF0C\u79D8\u4E66\u8BF7\u7528 secretary_dispatch \u6D3E\u6D3B\uFF0C\u4E0D\u8981\u81EA\u5DF1\u5EFA\u76EE\u6807\uFF09\u3002\u8FD9\u4E0D\u662F\u6536\u5DE5\u7406\u7531\uFF1A\u5FC5\u987B\u7ACB\u5373\u8C03\u7528 secretary_dispatch\uFF0C\u5DF2\u6709\u9879\u76EE\u7528 kind=existing + cwd\uFF0C\u6CA1\u6709\u9879\u76EE\u7528 kind=new-folder\uFF1B\u6D3E\u6D3B\u6210\u529F\u540E\u7167\u5B9E\u56DE\u62A5\u56DE\u6267\u6587\u6848\u2014\u2014\u300C\u5DF2\u6D3E\u6D3B\uFF08\u2026\u5DF2\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u624D\u662F\u771F\u63A5\u4E0A\u4E86\u8BDD\uFF0C\u300C\u5DF2\u5165\u961F\uFF08\u672A\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u4E0D\u8BB8\u8BF4\u6210\u5DF2\u6D3E\u6D3B\u3002`
      };
    });
  } catch {
    offToolGate = void 0;
  }
  let offStepGate;
  let warnedNoPolicy = false;
  try {
    offStepGate = ctx.on?.("agent/pre-step", async (payload, next) => {
      if (activeSessionId === "") return next();
      const session = payload?.agent?.session ?? payload?.session ?? null;
      const sessionId = String(session?.id ?? "");
      if (sessionId !== activeSessionId) return next();
      const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
      if (claimed.length > 0) {
        const notice = claimed.some((message) => isNoticeMessageId(message?.id));
        noticeTurn = notice;
        noticeTurnAt = notice ? Date.now() : 0;
        if (!notice && quoteState[activeSessionId] !== void 0) quoteConsumedTurn = true;
      }
      let mode = "";
      try {
        const policy = typeof ctx?.get === "function" ? ctx.get("sandboxPolicy") : void 0;
        const resolved = policy && typeof policy.resolve === "function" ? policy.resolve({ session }) : null;
        mode = String(resolved?.mode ?? "");
      } catch {
        mode = "";
      }
      if (mode === "") {
        if (!warnedNoPolicy) {
          warnedNoPolicy = true;
          ctx?.logger?.warn?.("[dsh-assistant] \u8BFB\u4E0D\u5230 sandboxPolicy\uFF1A\u79D8\u4E66\u4F1A\u8BDD\u7684\u53EA\u8BFB\u786E\u8BA4\u8FD9\u4E00\u8F6E\u8DF3\u8FC7\uFF08\u4E0D\u4F1A\u56E0\u6B64\u9501\u6B7B\uFF09");
        }
      } else if (!(mode === "read-only" || mode === "readonly")) {
        return {
          kind: "deny",
          reason: `\u4E2A\u4EBA\u79D8\u4E66\u4F1A\u8BDD\u6CA1\u5728\u53EA\u8BFB\u6863\uFF08\u5F53\u524D ${mode}\uFF09\uFF0C\u8FD9\u6761\u6D88\u606F\u5148\u62E6\u4E0B\u4E86\u3002\u540E\u53F0\u4F1A\u7EE7\u7EED\u628A\u5B83\u5207\u56DE\u300C\u4EC5\u53EF\u67E5\u770B\u300D\uFF0C\u786E\u8BA4\u540E\u518D\u53D1\u5373\u53EF\u3002`
        };
      }
      const decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      const record = quoteState[sessionId];
      if (record === void 0) return decision;
      if (!quoteAlive(record)) {
        delete quoteState[sessionId];
        void persistQuoteState().catch(() => void 0);
        return decision;
      }
      const { messages: splicedMessages, spliced } = spliceQuoteIntoUserMessage(decision.messages, record);
      if (!spliced) return decision;
      return { ...decision, messages: splicedMessages };
    });
  } catch {
    offStepGate = void 0;
  }
  let offSpeechStyle;
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      offSpeechStyle = systemPrompt.section({
        name: "assistant:secretary-speech-style",
        order: 1780,
        // 派活规则段（1790）之前：先定表达，再谈派活
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== activeSessionId) return "";
          return SECRETARY_SPEECH_STYLE_TEXT;
        }
      });
    }
  } catch {
    offSpeechStyle = void 0;
  }
  let offVoiceInput;
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      offVoiceInput = systemPrompt.section({
        name: "assistant:secretary-voice-input",
        order: 1785,
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== activeSessionId) return "";
          return SECRETARY_VOICE_INPUT_TEXT;
        }
      });
    }
  } catch {
    offVoiceInput = void 0;
  }
  let offQuoteSection;
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx?.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      offQuoteSection = systemPrompt.section({
        name: "assistant:secretary-card-quote",
        order: SECRETARY_QUOTE_SECTION_ORDER,
        // 1785（语音输入）与 1790（派活分层）之间，不并入任何既有段落
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== activeSessionId) return "";
          const record = quoteState[sessionId];
          if (record === void 0) return "";
          if (!quoteAlive(record)) {
            delete quoteState[sessionId];
            void persistQuoteState().catch(() => void 0);
            return "";
          }
          return secretaryQuoteInjectionText(record);
        }
      });
    }
  } catch {
    offQuoteSection = void 0;
  }
  let offQuoteAnchorSection;
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx?.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      offQuoteAnchorSection = systemPrompt.section({
        name: "assistant:secretary-card-quote-anchor",
        order: SECRETARY_QUOTE_ANCHOR_SECTION_ORDER,
        // 派活分层(1790)之后，最靠近这条用户消息
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== activeSessionId) return "";
          const record = quoteState[sessionId];
          if (record === void 0) return "";
          if (!quoteAlive(record)) {
            delete quoteState[sessionId];
            void persistQuoteState().catch(() => void 0);
            return "";
          }
          return secretaryQuoteAnchorText(record);
        }
      });
    }
  } catch {
    offQuoteAnchorSection = void 0;
  }
  return () => {
    try {
      offToolGate?.();
    } catch {
    }
    try {
      offNoticeReset?.();
    } catch {
    }
    try {
      offStepGate?.();
    } catch {
    }
    try {
      if (typeof offSpeechStyle === "function") offSpeechStyle();
    } catch {
    }
    try {
      if (typeof offVoiceInput === "function") offVoiceInput();
    } catch {
    }
    try {
      if (typeof offQuoteSection === "function") offQuoteSection();
    } catch {
    }
    try {
      if (typeof offQuoteAnchorSection === "function") offQuoteAnchorSection();
    } catch {
    }
    try {
      routes.dispose();
    } catch {
    }
  };
}
var SECRETARY_VOICE_INPUT_TEXT = [
  "# \u8BED\u97F3\u8F93\u5165\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09",
  "\u4E00\u3001\u672C\u9875\u8F93\u5165\u591A\u662F\u7528\u6237\u8BED\u97F3\u8F6C\u6587\u5B57\uFF1A\u53EF\u80FD\u5E26\u540C\u97F3\u5B57\u6216\u76F8\u8FD1\u97F3\u7684\u9519\u522B\u5B57\u3001\u65AD\u53E5\u4E0D\u5F53\u3001\u7F3A\u6807\u70B9\u3002\u6309\u8BED\u4E49\u7406\u89E3\uFF0C\u540C\u97F3\u7EA0\u6B63\u5728\u4F60\u5185\u90E8\u5B8C\u6210\uFF1B\u4E0D\u8BB8\u6084\u6084\u6539\u5199\u7528\u6237\u539F\u8BDD\uFF0C\u4E0D\u8BB8\u56E0\u4E00\u4E2A\u9519\u522B\u5B57\u5224\u4EFB\u52A1\u5931\u8D25\u6216\u53CD\u95EE\uFF1B\u53EA\u6709\u6B67\u4E49\u786E\u5B9E\u5F71\u54CD\u6267\u884C\u65F6\uFF0C\u624D\u7528\u6700\u77ED\u4E00\u53E5\u786E\u8BA4\u3002",
  "\u4E8C\u3001\u6D3E\u6D3B\u65F6 secretary_dispatch \u7684 task \u5B57\u6BB5\u7167\u6284\u7528\u6237\u539F\u8BDD\uFF0C\u53EF\u5728\u5176\u540E\u52A0\u62EC\u53F7\u6CE8\u660E\u300C\u8BED\u97F3\u8F93\u5165\uFF0C\u53EF\u80FD\u6709\u540C\u97F3\u5B57\u8BEF\u300D\uFF0C\u4F46\u4E0D\u5F97\u66FF\u6362\u5173\u952E\u8BCD\uFF1B\u79D8\u4E66\u9875\u7528\u6237\u5361\uFF08\u51B7\u84DD\u90A3\u5F20\uFF09\u4E0E\u9644\u4EF6\u5185\u5BB9\u4E00\u5F8B\u663E\u793A\u539F\u6587\u3001\u4E0D\u663E\u793A\u7EA0\u6B63\u7248\u672C\uFF0C\u9644\u4EF6\u4E00\u5F8B\u4E0D\u6539\u5199\uFF1B\u82E5\u4F60\u5728\u56DE\u590D\u91CC\u6539\u8BFB\u4E86\u67D0\u4E2A\u8BCD\uFF0C\u5FC5\u987B\u5728\u6B63\u6587\u8BF4\u6E05\u6539\u4E86\u54EA\u4E2A\u8BCD\u3002"
].join("\n");
var SECRETARY_SPEECH_STYLE_TEXT = [
  "# \u8F93\u51FA\u4E0E\u6717\u8BFB\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09",
  "\u4F60\u7684\u6BCF\u6761\u56DE\u590D\u90FD\u4F1A\uFF1A\u2460 \u5728\u4F1A\u8BDD\u9875\u6E32\u67D3\u6210\u4E00\u5F20\u5361\u7247\uFF1B\u2461 \u7531\u5FAE\u8F6F TTS \u81EA\u52A8\u6717\u8BFB\u3002\u8BF7\u4E25\u683C\u9075\u5B88\uFF1A",
  "\u4E00\u3001\u53E3\u8BED\u5316\u77ED\u53E5\uFF0C\u5148\u7ED9\u7ED3\u8BBA\uFF1B\u53EA\u7528\u6B63\u5E38\u4E2D\u6587\u6807\u70B9\uFF1B\u4E0D\u8981\u7528 markdown \u7B26\u53F7\u3001\u8868\u683C\u3001\u5217\u8868\u7B26\u53F7\u3001\u8868\u60C5\u7B26\u53F7\u3001\u4EE3\u7801\u5757\u3002",
  "\u4E8C\u3001\u6570\u5B57\u4E00\u5F8B\u4FDD\u7559\u963F\u62C9\u4F2F\u5199\u6CD5\uFF08\u8FD9\u4E00\u6761 2026-11-24 \u7528\u6237\u660E\u786E\u6279\u51C6\u6539\u53E3\u5F84\uFF09\uFF1A\u5B57\u7B26\u6570\u3001token \u6570\u3001\u5B57\u8282\u6570\u3001\u5C3A\u5BF8\u4E0E\u6BD4\u4F8B\u90FD\u7167\u539F\u6837\u5199\uFF0C\u5982 27458 \u5B57\u7B26\u300149915 token\u30019761427 \u5B57\u8282\u30012617\xD71215\uFF1B\u5E26\u5355\u4F4D\u7684\u4E5F\u7167\u963F\u62C9\u4F2F\u5199\uFF08\u6E29\u5EA6\u5199 8 \u5230 14 \u6444\u6C0F\u5EA6\u3001\u8DDD\u79BB\u5199 3 \u516C\u91CC\u3001\u91CD\u91CF\u5199 2 \u516C\u65A4\u3001\u65F6\u95F4\u5199 8:12\uFF09\uFF1B\u7981\u6B62\u628A\u8FD9\u4E9B\u6570\u8F6C\u5199\u6210\u6C49\u5B57\u6570\u5B57\uFF1B\u82F1\u6587\u7F29\u5199\u5C3D\u91CF\u6362\u6210\u8BFB\u5F97\u51FA\u7684\u4E2D\u6587\u8BF4\u6CD5\uFF0C\u5FC5\u987B\u4FDD\u7559\u65F6\u7167\u539F\u6587\u5199\uFF08\u5982\u8F66\u6B21 G1545\uFF09\u3002",
  "\u4E09\u3001\u5F15\u7528\u67D0\u6761\u4F1A\u8BDD\u65F6\u7528 [[session:\u4F1A\u8BDDid|\u4F1A\u8BDD\u6807\u9898]] \u4E00\u884C\u4E00\u4E2A\uFF08\u4F1A\u8BDD id \u4ECE\u4E0A\u4E0B\u6587\u91CC\u53D6\uFF09\uFF0C\u5361\u7247\u4F1A\u628A\u5B83\u6E32\u67D3\u6210\u53EF\u70B9\u51FB\u7684\u5F15\u7528\u5757\u3002",
  "\u56DB\u3001\u4E0D\u8BB8\u6574\u5927\u6BB5\u539F\u5C01\u4E0D\u52A8\u7167\u6284 Computer Use \u4F1A\u8BDD\u7684\u56DE\u590D\uFF0C\u4E5F\u4E0D\u8BB8\u6574\u6BB5\u8F6C\u8FF0\uFF1A\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u81EA\u5DF1\u6574\u7406\u6210\u7B80\u77ED\u7684\u4E2D\u6587\u56DE\u590D\uFF0C\u53EA\u4FDD\u7559\u5173\u952E\u786C\u4E8B\u5B9E\uFF08\u6587\u4EF6\u540D\u3001\u5927\u5C0F\u3001\u54C8\u5E0C\u3001\u6570\u5B57\u3001\u63D0\u4EA4\u53F7\u3001\u5224\u636E\u3001\u7ED3\u8BBA\u3001\u5F85\u529E\uFF09\uFF1B\u7981\u6B62\u7167\u6284\u8868\u683C\u4E0E\u957F\u8DEF\u5F84\uFF0C\u7981\u6B62\u628A\u56DE\u6267\u91CC\u7684\u65E5\u5FD7\u539F\u6587\u5806\u8FDB\u56DE\u590D\uFF0C\u7981\u6B62\u628A\u901A\u77E5\u539F\u6587\u518D\u6284\u4E00\u904D\u3002\u5FC5\u987B\u5148\u62FF\u5230\u5B8C\u6574\u5185\u5BB9\u518D\u6574\u7406\u2014\u2014\u539F\u6587\u88AB\u88C1\u5C31\u6309\u901A\u77E5\u91CC\u7684\u843D\u76D8\u8DEF\u5F84\u7528 read \u6574\u6BB5\u8BFB\u56DE\uFF0C\u4E0D\u8BB8\u53EA\u4F9D\u636E\u88AB\u88C1\u7684\u6458\u5F55\u4F5C\u7B54\u3002",
  "\u4E94\u3001\u7ED3\u8BBA\u5148\u884C\u662F\u786C\u53E3\u5F84\uFF1A\u5F00\u5934\u7B2C\u4E00\u53E5\u76F4\u63A5\u56DE\u7B54\u7528\u6237\u8FD9\u6761\u6D88\u606F\u95EE\u7684\u90A3\u4EF6\u4E8B\uFF0C\u7B54\u6848\u5148\u843D\u5730\uFF1B\u4E0D\u8BB8\u94FA\u57AB\u3001\u4E0D\u8BB8\u5148\u590D\u8FF0\u7528\u6237\u7684\u95EE\u9898\u518D\u56DE\u7B54\uFF08\u300C\u597D\u7684\u300D\u300C\u5173\u4E8E\u4F60\u8BF4\u7684\u8FD9\u4EF6\u4E8B\u300D\u8FD9\u7C7B\u5F00\u573A\u767D\u4E0D\u7B97\u7B2C\u4E00\u53E5\uFF09\u3002",
  "\u516D\u3001\u957F\u5EA6\u786C\u4E0A\u9650\uFF1A\u9ED8\u8BA4 3 \u5230 5 \u53E5\u8BB2\u5B8C\uFF1B\u786E\u9700\u5C55\u5F00\u65F6\u6700\u591A 5 \u4E2A\u8981\u70B9\uFF0C\u6BCF\u4E2A\u8981\u70B9\u72EC\u5360\u4E00\u884C\uFF0C\u4E0D\u628A\u51E0\u4E2A\u8981\u70B9\u63C9\u8FDB\u4E00\u4E2A\u957F\u6BB5\uFF1B\u4E00\u6B21\u56DE\u590D\u6B63\u6587\u4E0D\u8D85\u8FC7\u7EA6 300 \u5B57\uFF0C\u8D85\u8FC7 300 \u5B57\u5C31\u662F\u6CA1\u6574\u7406\uFF0C\u5FC5\u987B\u538B\u56DE 300 \u5B57\u4EE5\u5185\u518D\u53D1\u3002",
  "\u4E03\u3001\u5BF9\u51C6\u4EFB\u52A1\u518D\u56DE\u7B54\uFF1A\u56DE\u590D\u524D\u5148\u5224\u65AD\u7528\u6237\u8FD9\u6761\u6D88\u606F\u95EE\u7684\u662F\u54EA\u4E2A\u4EFB\u52A1\uFF0C\u53EA\u9488\u5BF9\u90A3\u4EF6\u4E8B\u7ED9\u7ED3\u8BBA\uFF0C\u4E0D\u5806\u65E0\u5173\u7EC6\u8282\uFF0C\u4E0D\u628A\u522B\u7684\u4EFB\u52A1\u7684\u8FDB\u5C55\u585E\u8FDB\u8FD9\u6761\u56DE\u590D\u3002",
  "\u516B\u3001\u4EA4\u4ED8\u6587\u4EF6\u6216\u56FE\u7247\u65F6\uFF08Word\u3001Excel\u3001PPT\u3001PDF\u3001\u56FE\u7247\u3001\u538B\u7F29\u5305\u7B49\uFF09\uFF0C\u5728\u6B63\u6587\u6700\u540E\u5355\u72EC\u4E00\u884C\u5199 [[attach:\u7EDD\u5BF9\u8DEF\u5F84|\u663E\u793A\u540D]]\uFF0C\u4E00\u884C\u4E00\u4E2A\uFF0C\u8DEF\u5F84\u5199\u672C\u673A\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u6B63\u6587\u91CC\u4E0D\u8981\u518D\u8D34\u88F8\u8DEF\u5F84\uFF0C\u5361\u7247\u4F1A\u5728\u6B63\u6587\u4E0B\u65B9\u628A\u5B83\u6E32\u67D3\u6210\u7F29\u7565\u56FE\u6216\u9644\u4EF6\u6761\uFF0C\u70B9\u5F00\u5C31\u662F\u90A3\u4E2A\u6587\u4EF6\u3002\u6CA1\u6709\u4EA4\u4ED8\u7269\u5C31\u4E0D\u5199\u8FD9\u4E00\u884C\u3002"
].join("\n");
var REFERENCE_ARRAY_KEYS = /* @__PURE__ */ new Set(["sourceEventSeqs", "messageSeqs"]);
var REFERENCE_SCALAR_KEYS = /* @__PURE__ */ new Set(["sourceEventSeq", "headerSeq"]);
var ZSTD_MAGIC = Buffer.from([40, 181, 47, 253]);
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function parseLogEventLine(line) {
  const raw = String(line ?? "");
  if (raw.trim() === "") return null;
  try {
    const event = JSON.parse(raw);
    if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
    return event;
  } catch {
    return null;
  }
}
function rewriteEventReferences(event, oldToNew) {
  let staleReferences = 0;
  const seen = /* @__PURE__ */ new WeakSet();
  const rewriteArray = (value, key) => {
    const out = [];
    for (const item of value) {
      if (REFERENCE_ARRAY_KEYS.has(key) && typeof item === "number" && Number.isFinite(item)) {
        const mapped = oldToNew.get(item);
        if (mapped === void 0) {
          staleReferences += 1;
          continue;
        }
        out.push(mapped);
      } else {
        out.push(visit(item, key));
      }
    }
    if (REFERENCE_ARRAY_KEYS.has(key)) {
      const numbers = out.filter((item) => typeof item === "number");
      return Array.from(new Set(numbers)).sort((a, b) => a - b);
    }
    return out;
  };
  const visit = (value, parentKey = "") => {
    if (Array.isArray(value)) return rewriteArray(value, parentKey);
    if (value === null || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    const record = value;
    for (const key of Object.keys(record)) {
      if (REFERENCE_ARRAY_KEYS.has(key) && Array.isArray(record[key])) {
        record[key] = rewriteArray(record[key], key);
      } else if (REFERENCE_SCALAR_KEYS.has(key) && typeof record[key] === "number") {
        const mapped = oldToNew.get(record[key]);
        if (mapped === void 0) staleReferences += 1;
        else record[key] = mapped;
      } else {
        record[key] = visit(record[key], key);
      }
    }
    return record;
  };
  visit(event, "");
  return { staleReferences };
}
function repairSecretaryLogLines(input) {
  const lines = Array.from(input ?? [], (line) => String(line ?? ""));
  const header = lines[0] ?? "";
  const kept = [];
  const droppedOldSeqs = [];
  const oldToNew = /* @__PURE__ */ new Map();
  let staleReferences = 0;
  let openTurn = 0;
  let openStep = 0;
  let nextTurn = 1;
  let nextStep = 1;
  for (const raw of lines.slice(1)) {
    const event = parseLogEventLine(raw);
    if (event === null) {
      const seq = Number(event?.seq);
      if (Number.isFinite(seq)) droppedOldSeqs.push(seq);
      continue;
    }
    const data = event.data ?? {};
    const type = String(event.type ?? "");
    const turn = Number(data.turn);
    const step = Number(data.step);
    let keep = true;
    if (type === "turn/start") {
      if (openTurn !== 0 || !isPositiveNumber(turn) || turn !== nextTurn) keep = false;
      else {
        openTurn = turn;
        openStep = 0;
        nextStep = 1;
      }
    } else if (type === "step/start") {
      if (openTurn === 0 || openStep !== 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== nextStep) keep = false;
      else openStep = step;
    } else if (type === "step/end") {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || openStep !== step) keep = false;
      else {
        openStep = 0;
        nextStep = step + 1;
      }
    } else if (type === "turn/end") {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || openStep !== 0) keep = false;
      else {
        openTurn = 0;
        nextTurn = turn + 1;
        nextStep = 1;
      }
    } else if (type === "assistant/message" || type === "assistant/attempt" || type === "tool/call" || type === "tool/result") {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== openStep) keep = false;
    } else if (isPositiveNumber(turn) && turn !== openTurn) {
      keep = false;
    }
    if (!keep) {
      const oldSeq2 = Number(event.seq);
      if (Number.isFinite(oldSeq2)) droppedOldSeqs.push(oldSeq2);
      continue;
    }
    const oldSeq = Number(event.seq);
    const newSeq = kept.length;
    if (Number.isFinite(oldSeq)) oldToNew.set(oldSeq, newSeq);
    kept.push(event);
  }
  const serialized = kept.map((event, index) => {
    staleReferences += rewriteEventReferences(event, oldToNew).staleReferences;
    event.seq = index;
    return JSON.stringify(event);
  });
  return { lines: [header, ...serialized], droppedOldSeqs, staleReferences };
}
function repairSecretaryLogText(text) {
  const raw = String(text ?? "");
  const result = repairSecretaryLogLines(raw.split(/\r?\n/));
  return `${result.lines.join("\n")}
`;
}
function compressSessionLogText(text) {
  const zlib22 = zlib;
  if (typeof zlib22.zstdCompressSync !== "function") throw new Error("zstdCompressSync not available");
  return Buffer.from(zlib22.zstdCompressSync(Buffer.from(String(text ?? ""), "utf8")));
}
function decompressSessionLogBytes(data) {
  const zlib22 = zlib;
  if (typeof zlib22.zstdDecompressSync !== "function") throw new Error("zstdDecompressSync not available");
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const first = buffer.indexOf(ZSTD_MAGIC);
  if (first === -1) {
    if (buffer.length === 0) return "";
    return Buffer.from(zlib22.zstdDecompressSync(buffer)).toString("utf8");
  }
  const chunks = [];
  for (let cursor = first; cursor < buffer.length; ) {
    const next = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length);
    const end = next === -1 ? buffer.length : next;
    chunks.push(Buffer.from(zlib22.zstdDecompressSync(buffer.subarray(cursor, end))).toString("utf8"));
    cursor = end;
  }
  return chunks.join("");
}
var assistantSecretaryTestSurface = {
  ASSISTANT_SECRETARY_ROUTE,
  ASSISTANT_SECRETARY_READ_ROUTE,
  READ_MAX_KEYS,
  normalizeReadCardKey,
  normalizeReadCardKeys,
  normalizeSecretaryReadState,
  addReadCardKey,
  SECRETARY_DISPATCH_POLICY,
  normalizeSecretaryState,
  secretaryToolDenied,
  secretaryNoticeTurnAllowed,
  registerAssistantSecretary,
  secretarySessionRef,
  registerNoticeMessageId,
  isNoticeMessageId,
  clearNoticeMessageIds,
  SECRETARY_SPEECH_STYLE_TEXT,
  SECRETARY_VOICE_INPUT_TEXT,
  repairSecretaryLogLines,
  repairSecretaryLogText,
  compressSessionLogText,
  decompressSessionLogBytes,
  parseSecretaryRequestQuery,
  // 更换会话（控制室卡片按钮）这一块的离线测试入口
  ASSISTANT_SECRETARY_SESSIONS_ROUTE,
  SECRETARY_SESSIONS_DEFAULT_LIMIT,
  SECRETARY_SESSIONS_MAX_LIMIT,
  normalizeBindableSessionRow,
  titleFromProjectionBlock,
  collectHostSessionRows,
  parseSecretarySessionsQuery,
  pickBindableSessions,
  markBoundSessions,
  secretaryStateMatchesWrite,
  ASSISTANT_SECRETARY_QUOTE_ROUTE,
  SECRETARY_QUOTE_SECTION_ORDER,
  SECRETARY_QUOTE_ANCHOR_SECTION_ORDER,
  QUOTE_MESSAGE_BLOCK_OPEN,
  spliceQuoteIntoUserMessage,
  QUOTE_TTL_MS,
  QUOTE_PREVIEW_MAX_CHARS,
  QUOTE_BODY_MAX_CHARS,
  QUOTE_ATTACHMENT_MAX,
  QUOTE_CARD_KINDS,
  normalizeQuoteCardKey,
  normalizeQuoteSessionIds,
  normalizeQuoteAttachments,
  normalizeQuoteBody,
  normalizeQuoteRecord,
  quoteAlive,
  normalizeSecretaryQuoteState,
  secretaryQuoteInjectionText,
  secretaryQuoteAnchorText,
  secretaryQuoteCardBlockText
};

// src/secretary-card-shared.ts
var CARD_KIND_ASSISTANT = "assistant";
var CARD_KIND_USER = "user";
var CARD_KIND_NOTICE = "notice";
var CARD_WINDOW_DEFAULT = 30;
var CARD_PAGE_SIZE = 30;
var CARD_RENDER_CAP = 120;
var CARD_TITLE_MAX_CHARS = 24;
var HISTORY_PREVIEW_MAX_CHARS = 900;
var EARLIER_HINT_TEXT = "\u66F4\u65E9\u7684\u5185\u5BB9\u8BF7\u5230\u8F68\u8FF9/\u641C\u7D22\u91CC\u770B";
var SCROLL_TOP_THRESHOLD_PX = 240;
var HISTORY_MAX_LIMIT = 60;
var NOTICE_HEAD_LINE_RE = /^\s*[（(【\[]?\s*系统通知/;
var NOTICE_SESSION_REF_LINE_RE = /(^|\n)\s*(最后单独一行原样输出：)?\s*\[\[session:[^\]]*\]\]/;
var SESSION_REF_RE = /\[\[session:([^\]|\s]+)\s*(?:\|\s*([^\]]*))?\]\]/g;
function isSyntheticNoticeUserText(raw) {
  const text = String(raw ?? "");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return false;
  if (NOTICE_HEAD_LINE_RE.test(lines[0])) return true;
  return lines.some((line) => NOTICE_SESSION_REF_LINE_RE.test(`
${line}`));
}
function stripNoticeSyntheticHead(raw) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (text === "") return "";
  const lines = text.split("\n");
  while (lines.length > 0 && NOTICE_HEAD_LINE_RE.test(lines[0])) lines.shift();
  const cleaned = lines.map((line) => line.replace(/^\s*最后单独一行原样输出[：:]\s*/, "").trim());
  return cleaned.filter((line) => line !== "").join("\n");
}
function parseSessionRefs(raw) {
  const text = String(raw ?? "");
  const out = [];
  const pattern = new RegExp(SESSION_REF_RE.source, "g");
  let match = pattern.exec(text);
  while (match !== null) {
    const id = String(match[1] ?? "").trim();
    const title = String(match[2] ?? "").trim();
    if (id !== "") out.push({ id, title });
    const consumed = pattern.lastIndex;
    match = pattern.exec(text);
    if (match !== null && pattern.lastIndex === consumed) pattern.lastIndex += 1;
  }
  return out;
}
function userCardSpeechKey(messageKey, turnNo = "") {
  const key = String(messageKey ?? "").trim();
  if (key !== "") return `user:${key}`;
  const turn = String(turnNo ?? "").trim();
  return turn === "" ? "" : `user:turn:${turn}`;
}
function noticeCardSpeechKey(messageKey, turnNo = "") {
  const key = String(messageKey ?? "").trim();
  if (key !== "") return `notice:${key}`;
  const turn = String(turnNo ?? "").trim();
  return turn === "" ? "" : `notice:turn:${turn}`;
}
function assistantCardSpeechKey(turnNo) {
  const turn = String(turnNo ?? "").trim();
  return turn === "" ? "" : `assistant:turn:${turn}`;
}
function countWords(text) {
  const value = String(text ?? "");
  if (value === "") return 0;
  const latin = value.match(/[A-Za-z0-9\u00C0-\u02BC\u2019'._-]+/g) ?? [];
  const cjk = value.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3001-\u3003\u3008-\u3011\uFF01-\uFF5E]/g) ?? [];
  return latin.length + cjk.length;
}
function truncateCardTitle(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (text === "") return "";
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  const codePoints = Array.from(firstLine);
  if (codePoints.length <= CARD_TITLE_MAX_CHARS) return codePoints.join("");
  return `${codePoints.slice(0, CARD_TITLE_MAX_CHARS).join("")}\u2026`;
}
function truncatePreview(raw, maxChars = HISTORY_PREVIEW_MAX_CHARS) {
  const codePoints = Array.from(String(raw ?? ""));
  const cap = Math.max(1, Math.min(Number(maxChars) || HISTORY_PREVIEW_MAX_CHARS, HISTORY_PREVIEW_MAX_CHARS));
  if (codePoints.length <= cap) return codePoints.join("");
  return `${codePoints.slice(0, cap).join("")}\u2026`;
}
function eventText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content ?? event?.data?.data?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => String(block?.text ?? "")).join("\n").trim();
}
function eventCardKind(event) {
  const type = String(event?.type ?? "");
  if (type === "assistant/message") return CARD_KIND_ASSISTANT;
  if (type === "user/message") return isSyntheticNoticeUserText(eventText(event)) ? CARD_KIND_NOTICE : CARD_KIND_USER;
  return "";
}
function historyItemsFromEvents(events) {
  const ordered = [...events].filter((event) => event !== null && typeof event === "object" && String(event?.type ?? "") !== "").sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0));
  const items = [];
  const assistantByTurn = /* @__PURE__ */ new Map();
  for (const event of ordered) {
    const kind = eventCardKind(event);
    if (kind === "") continue;
    const text = eventText(event);
    if (text === "") continue;
    const seq = Number(event?.seq ?? 0);
    const time = Number(event?.time ?? 0);
    if (kind === CARD_KIND_ASSISTANT) {
      const turn2 = String(event?.data?.turn ?? "").trim();
      if (turn2 === "") continue;
      const cardKey = assistantCardSpeechKey(turn2);
      const existing = assistantByTurn.get(turn2);
      const item = {
        seq,
        cardKey,
        turn: turn2,
        messageKey: "",
        kind,
        time,
        title: truncateCardTitle(text),
        preview: truncatePreview(text),
        refs: parseSessionRefs(text)
      };
      if (existing === void 0) {
        assistantByTurn.set(turn2, item);
        items.push(item);
        continue;
      }
      if (item.preview.length > existing.preview.length) {
        existing.seq = item.seq;
        existing.time = item.time;
        existing.title = item.title;
        existing.preview = item.preview;
        existing.refs = item.refs;
      }
      continue;
    }
    const messageKey = String(event?.data?.id ?? event?.data?.message?.id ?? "").trim();
    const turn = String(event?.data?.turn ?? "").trim();
    const key = kind === CARD_KIND_NOTICE ? noticeCardSpeechKey(messageKey, turn) : userCardSpeechKey(messageKey, turn);
    if (key === "") continue;
    const body = kind === CARD_KIND_NOTICE ? stripNoticeSyntheticHead(text) : text;
    items.push({
      seq,
      cardKey: key,
      turn,
      messageKey,
      kind,
      time,
      title: truncateCardTitle(body),
      preview: truncatePreview(body),
      refs: parseSessionRefs(body)
    });
  }
  return items;
}
function normalizeHistoryLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return CARD_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(value), HISTORY_MAX_LIMIT));
}
function normalizeHistoryCursor(raw) {
  const value = Number(String(raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return void 0;
  return Math.floor(value);
}
function buildHistoryPage(events, options = {}) {
  const all = historyItemsFromEvents(events);
  const totalCards = all.length;
  const totalWords = all.reduce((sum, item) => sum + countWords(item.preview), 0);
  const limit = normalizeHistoryLimit(options.limit);
  const beforeSeq = normalizeHistoryCursor(options.beforeSeq);
  const pool = beforeSeq === void 0 ? all : all.filter((item) => item.seq < beforeSeq);
  const tail = pool.slice(Math.max(0, pool.length - limit));
  const fromSeq = tail.length === 0 ? 0 : tail[0].seq;
  const toSeq = tail.length === 0 ? 0 : tail[tail.length - 1].seq;
  return {
    items: tail,
    hasMore: tail.length > 0 ? pool.length > tail.length : totalCards > 0 && beforeSeq === void 0,
    totalCards,
    fromSeq,
    toSeq,
    nextBefore: fromSeq,
    totalWords
  };
}
function canRenderMore(renderedCount) {
  return Number(renderedCount) < CARD_RENDER_CAP;
}
function windowOfItems(items, limit = CARD_WINDOW_DEFAULT) {
  const size = Math.max(1, Number(limit) || CARD_WINDOW_DEFAULT);
  return items.length <= size ? [...items] : items.slice(items.length - size);
}
function shouldExpandOnScroll(input) {
  if (input.hasMore !== true) return false;
  if (input.capped === true) return false;
  if (input.loading === true) return false;
  if (input.alreadyExpanding === true) return false;
  const threshold = Number(input.threshold ?? SCROLL_TOP_THRESHOLD_PX);
  const top = Number(input.scrollTop);
  if (!Number.isFinite(top) || !Number.isFinite(threshold)) return false;
  return top <= threshold;
}
var CONTEXT_RECENT_ROUNDS = 8;
var CONTEXT_RECENT_WORD_BUDGET = 1200;
var CONTEXT_ROUND_TRIGGER = 12;
var CONTEXT_WORD_TRIGGER = 1e4;
var CONTEXT_SUMMARY_SEGMENT_MAX_CHARS = 260;
var CONTEXT_SUMMARY_MAX_CHARS = 3e3;
var CONTEXT_SUMMARY_TIMEOUT_MS = 4e3;
var CONTEXT_ROUND_LOG_MAX = 60;
var CONTEXT_PROGRESS_LINE_RE = /^\s*(\[?(工具|tool)\]?|正在|已开始|收到执行请求|执行请求已|后台会话|job|pwsh|computer_use|subagent|取证|待办清单|todo_write)/i;
function isProgressLine(line) {
  const value = String(line ?? "").trim();
  if (value === "") return true;
  if (CONTEXT_PROGRESS_LINE_RE.test(value)) return true;
  if (NOTICE_HEAD_LINE_RE.test(value)) return true;
  if (/^\s*最后单独一行原样输出[：:]/.test(value)) return true;
  if (/^\s*\[\[session:[^\]]*\]\]/.test(value)) return true;
  if (/^\s*(§|---|===)/.test(value)) return true;
  return false;
}
function summarizeRoundText(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !isProgressLine(line));
  const todoLine = (line) => /^[-·*]\s*(待办|下一步|还需|接下来|TODO)/i.test(line) || /待办|下一步|还需|接下来/i.test(line);
  const first = lines[0] ?? "";
  const nonTodo = lines.filter((line) => !todoLine(line));
  const last = nonTodo.length > 1 ? nonTodo[nonTodo.length - 1] ?? "" : "";
  const todos = lines.filter((line) => todoLine(line)).slice(0, 4).map((line) => line.replace(/^[-·*]\s*/, "").slice(0, 80));
  const cap = (value) => {
    const codePoints = Array.from(value);
    return codePoints.length <= CONTEXT_SUMMARY_SEGMENT_MAX_CHARS ? value : `${codePoints.slice(0, CONTEXT_SUMMARY_SEGMENT_MAX_CHARS).join("")}\u2026`;
  };
  return { task: cap(first), conclusion: cap(last === first ? "" : last), todos };
}
function selectRecentRounds(rounds, limit = CONTEXT_RECENT_ROUNDS, wordBudget = CONTEXT_RECENT_WORD_BUDGET) {
  const cap = Math.max(1, Math.min(Number(limit) || CONTEXT_RECENT_ROUNDS, CONTEXT_RECENT_ROUNDS));
  const budget = Math.max(1, Number(wordBudget) || CONTEXT_RECENT_WORD_BUDGET);
  const picked = [];
  let words = 0;
  for (const round of [...rounds].reverse()) {
    const nextWords = words + Math.max(1, Number(round?.words) || 0);
    if (picked.length >= cap) break;
    if (picked.length > 0 && nextWords > budget) break;
    picked.unshift(round);
    words = nextWords;
  }
  return picked;
}
function rollingSummaryText(entries) {
  const lines = [];
  for (const entry of entries) {
    const task = String(entry?.task ?? "").trim();
    const conclusion = String(entry?.conclusion ?? "").trim();
    const todos = (entry?.todos ?? []).map((todo) => String(todo ?? "").trim()).filter((todo) => todo !== "");
    if (task === "" && conclusion === "" && todos.length === 0) continue;
    const turn = String(entry?.turn ?? "").trim();
    lines.push(`- ${turn !== "" ? `\u7B2C ${turn} \u8F6E ` : ""}\u5DF2\u5B8C\u6210\uFF1A${task || "\uFF08\u65E0\uFF09"}${conclusion !== "" ? ` \uFF5C\u7ED3\u8BBA\uFF1A${conclusion}` : ""}${todos.length > 0 ? ` \uFF5C\u5F85\u529E\uFF1A${todos.join("\uFF1B")}` : ""}`);
  }
  const joined = lines.join("\n");
  const codePoints = Array.from(joined);
  if (codePoints.length <= CONTEXT_SUMMARY_MAX_CHARS) return joined;
  return `\u2026
${codePoints.slice(codePoints.length - CONTEXT_SUMMARY_MAX_CHARS).join("")}`;
}
var secretCardSharedTestSurface = {
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  CARD_TITLE_MAX_CHARS,
  HISTORY_MAX_LIMIT,
  HISTORY_PREVIEW_MAX_CHARS,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  CONTEXT_RECENT_ROUNDS,
  CONTEXT_RECENT_WORD_BUDGET,
  CONTEXT_ROUND_TRIGGER,
  CONTEXT_WORD_TRIGGER,
  CONTEXT_SUMMARY_TIMEOUT_MS,
  CONTEXT_ROUND_LOG_MAX,
  isSyntheticNoticeUserText,
  stripNoticeSyntheticHead,
  parseSessionRefs,
  countWords,
  truncateCardTitle,
  truncatePreview,
  eventCardKind,
  eventText,
  historyItemsFromEvents,
  buildHistoryPage,
  normalizeHistoryLimit,
  normalizeHistoryCursor,
  canRenderMore,
  shouldExpandOnScroll,
  windowOfItems,
  isProgressLine,
  summarizeRoundText,
  selectRecentRounds,
  rollingSummaryText,
  userCardSpeechKey,
  noticeCardSpeechKey,
  assistantCardSpeechKey
};

// src/assistant-secretary-history.ts
var ASSISTANT_SECRETARY_HISTORY_ROUTE = "/api/assistant/secretary/history";
var SESSION_ID_RE2 = /^[A-Za-z0-9._:-]{1,256}$/;
var PAGE_MESSAGE_WINDOW = 240;
var PAGE_TIMEOUT_MS = 6e3;
function parseHistoryQuery(rawUrl, defaultSessionId) {
  const url = String(rawUrl ?? "");
  const queryIndex = url.indexOf("?");
  const query = queryIndex === -1 ? "" : url.slice(queryIndex + 1);
  const sessionMatch = query.match(/(?:^|&)session(?:Id)?=([^&]*)/);
  const rawSession = sessionMatch === null ? "" : decodeURIComponent(sessionMatch[1] ?? "");
  const trimmed = rawSession.trim();
  const limitMatch = query.match(/(?:^|&)limit=([^&]*)/);
  const beforeMatch = query.match(/(?:^|&(?:before|cursor|beforeSeq))=([^&]*)/);
  return {
    // 没给 sessionId 才兜底用秘书会话；给了但形态不对的原样交出去，让 handler 判 400（坏请求不能当好数据）
    sessionId: trimmed === "" ? String(defaultSessionId ?? "") : trimmed,
    limit: normalizeHistoryLimit(limitMatch?.[1]),
    beforeSeq: normalizeHistoryCursor(beforeMatch?.[1])
  };
}
function unwrapPageRecords(records) {
  const list = Array.isArray(records) ? records : [];
  const out = [];
  for (const record of list) {
    const event = record && typeof record === "object" ? record.event ?? record : record;
    if (event && typeof event === "object" && typeof event.type === "string") out.push(event);
  }
  return out;
}
function optionalService3(ctx, name3) {
  try {
    const direct = ctx?.[name3];
    if (direct !== void 0 && direct !== null) return direct;
    if (typeof ctx?.get === "function") return ctx.get(name3);
  } catch {
  }
  return void 0;
}
async function fetchHistoryEvents(ctx, sessionId, beforeSeq, limit) {
  const controller = optionalService3(ctx, "sessionController");
  if (controller !== void 0 && typeof controller.page === "function") {
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      try {
        abort.abort();
      } catch {
      }
    }, PAGE_TIMEOUT_MS);
    try {
      const page = await controller.page({
        address: { kind: "session", sessionId },
        throughSeq: -1,
        ...beforeSeq === void 0 ? {} : { beforeSeq },
        maxMessages: Math.min(PAGE_MESSAGE_WINDOW, Math.max(limit * 4, CARD_PAGE_SIZE))
      }, abort.signal);
      const records = unwrapPageRecords(page?.records);
      const hasMore = page?.hasMore === true;
      return { events: records, hasMore, source: "controller-page" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOpenDiag({ step: "host-secretary-history-page-failed", sessionId, error: message.slice(0, 200) });
    } finally {
      clearTimeout(timeout);
    }
  }
  let listed = [];
  try {
    listed = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : [];
  } catch {
    listed = [];
  }
  const live = listed.find((session) => String(session?.header?.id ?? session?.id ?? "") === sessionId);
  const snapshot = typeof live?.snapshotEvents === "function" ? live.snapshotEvents() : void 0;
  if (Array.isArray(snapshot)) {
    const filtered = beforeSeq === void 0 ? snapshot : snapshot.filter((event) => Number(event?.seq ?? 0) < beforeSeq);
    const window2 = filtered.slice(Math.max(0, filtered.length - PAGE_MESSAGE_WINDOW));
    return { events: window2, hasMore: filtered.length > window2.length, source: "live-snapshot" };
  }
  return { events: [], hasMore: false, source: "unavailable", error: "no history source on host" };
}
function registerAssistantSecretaryHistory(ctx, deps = {}) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const handle = async (req, res) => {
    const method = String(req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendJson9(res, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    const defaultId = typeof deps.defaultSessionId === "function" ? deps.defaultSessionId() : secretarySessionRef.id;
    const query = parseHistoryQuery(String(req.url ?? ""), defaultId);
    if (!SESSION_ID_RE2.test(query.sessionId) || query.sessionId === "") {
      sendJson9(res, 400, { ok: false, error: "invalid-session-id" });
      return;
    }
    try {
      const fetched = typeof deps.eventsFor === "function" ? { events: await deps.eventsFor(query.sessionId, query.beforeSeq, query.limit), hasMore: true, source: "injected" } : await fetchHistoryEvents(ctx, query.sessionId, query.beforeSeq, query.limit);
      const page = buildHistoryPage(fetched.events, { limit: query.limit, beforeSeq: query.beforeSeq });
      const trimmedMore = page.items.length >= query.limit && fetched.events.length > page.items.length;
      sendJson9(res, 200, {
        ok: true,
        sessionId: query.sessionId,
        source: fetched.source,
        ...fetched.error === void 0 ? {} : { warning: fetched.error },
        page: {
          items: page.items,
          hasMore: page.hasMore || fetched.hasMore || trimmedMore,
          fromSeq: page.fromSeq,
          toSeq: page.toSeq,
          nextBefore: page.nextBefore,
          totalCards: page.totalCards,
          // 事件源只给了「一段」时，totalCards 只代表这一段（客户端不许把它当全量）
          exactTotal: fetched.source === "injected" || fetched.source === "live-snapshot" || fetched.hasMore === false,
          totalWords: page.totalWords,
          fetchedEvents: fetched.events.length
        }
      });
      appendOpenDiag({
        step: "host-secretary-history",
        sessionId: query.sessionId,
        source: fetched.source,
        before: query.beforeSeq ?? null,
        limit: query.limit,
        cards: page.items.length,
        events: fetched.events.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOpenDiag({ step: "host-secretary-history-error", sessionId: query.sessionId, error: message.slice(0, 200) });
      sendJson9(res, 500, { ok: false, error: "history-read-failed" });
    }
  };
  webServer.register({ kind: "exact", path: ASSISTANT_SECRETARY_HISTORY_ROUTE, handler: handle });
  return () => {
    routes.dispose();
  };
}
function sendJson9(res, status, payload) {
  try {
    res.writeHead?.(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end?.(JSON.stringify(payload));
  } catch {
  }
}
var assistantSecretaryHistoryTestSurface = {
  ASSISTANT_SECRETARY_HISTORY_ROUTE,
  parseHistoryQuery,
  unwrapPageRecords,
  fetchHistoryEvents,
  registerAssistantSecretaryHistory
};

// src/assistant-secretary-context.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync11, readFileSync as readFileSync12, renameSync as renameSync8, rmSync as rmSync2, writeFileSync as writeFileSync12 } from "node:fs";
import { dirname as dirname12, join as join15 } from "node:path";
var ASSISTANT_SECRETARY_CONTEXT_ROUTE = "/api/assistant/secretary-context";
var CONTEXT_STATE_FILENAME = "dsh-assistant-secretary-context.json";
var SESSION_ID_RE3 = /^[A-Za-z0-9._:-]{1,256}$/;
var EVICT_MIN_TURNS = 16;
var EVICT_MAX_BUSY_RETRIES = 3;
var EVICT_SOURCE_ID = "assistant-secretary-context-v1";
function emptyContextEviction() {
  return { at: "", count: 0, shadowedTokens: 0, busyRetries: 0, lastError: "" };
}
function emptyContextState(sessionId = "") {
  return {
    version: 1,
    sessionId,
    updatedAt: "",
    summaryAt: "",
    summary: "",
    totalTurns: 0,
    totalWords: 0,
    rounds: [],
    degraded: false,
    degradedReason: "",
    recentRounds: 0,
    degradeCount: 0,
    summaryThroughTurn: 0,
    summaryThroughWords: 0,
    eviction: emptyContextEviction()
  };
}
var TEXT_CAP = 3e3;
function capText(value) {
  const codePoints = Array.from(String(value ?? ""));
  if (codePoints.length <= TEXT_CAP) return codePoints.join("");
  return codePoints.slice(0, TEXT_CAP).join("");
}
function textOfEvent(event) {
  const content = event?.data?.content ?? event?.data?.message?.content ?? event?.data?.data?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => String(block?.text ?? "")).join("\n").trim();
}
function normalizeContextState(raw, sessionId = "") {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const roundsRaw = Array.isArray(source.rounds) ? source.rounds : [];
  const rounds = [];
  for (const item of roundsRaw) {
    const turn = Number(item?.turn);
    if (!Number.isFinite(turn) || turn <= 0) continue;
    rounds.push({
      turn: Math.floor(turn),
      seqFrom: Number(item?.seqFrom) || 0,
      seqTo: Number(item?.seqTo) || 0,
      task: String(item?.task ?? "").slice(0, 400),
      conclusion: String(item?.conclusion ?? "").slice(0, 400),
      todos: (Array.isArray(item?.todos) ? item.todos : []).map((todo) => String(todo ?? "").slice(0, 120)).filter((todo) => todo !== "").slice(0, 6),
      words: Number(item?.words) || 0,
      text: typeof item?.text === "string" ? capText(item.text) : void 0,
      at: Number(item?.at) || 0
    });
  }
  rounds.sort((left, right) => left.turn - right.turn);
  while (rounds.length > CONTEXT_ROUND_LOG_MAX) rounds.shift();
  const totalTurns = Number.isFinite(Number(source.totalTurns)) ? Math.max(0, Math.floor(Number(source.totalTurns))) : rounds.length;
  const persistedWords = Number.isFinite(Number(source.totalWords)) ? Math.max(0, Math.floor(Number(source.totalWords))) : rounds.reduce((sum, round) => sum + round.words, 0);
  const storedSession = String(source.sessionId ?? "").trim();
  return {
    version: 1,
    sessionId: SESSION_ID_RE3.test(storedSession) ? storedSession : String(sessionId ?? ""),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    summaryAt: typeof source.summaryAt === "string" ? source.summaryAt : "",
    summary: typeof source.summary === "string" ? capText(source.summary) : "",
    totalTurns,
    totalWords: persistedWords,
    rounds,
    degraded: source.degraded === true,
    degradedReason: typeof source.degradedReason === "string" ? source.degradedReason.slice(0, 240) : "",
    recentRounds: Number.isFinite(Number(source.recentRounds)) ? Math.max(0, Math.floor(Number(source.recentRounds))) : 0,
    degradeCount: Number.isFinite(Number(source.degradeCount)) ? Math.max(0, Math.floor(Number(source.degradeCount))) : 0,
    summaryThroughTurn: Number.isFinite(Number(source.summaryThroughTurn)) ? Math.max(0, Math.floor(Number(source.summaryThroughTurn))) : 0,
    summaryThroughWords: Number.isFinite(Number(source.summaryThroughWords)) ? Math.max(0, Math.floor(Number(source.summaryThroughWords))) : 0,
    eviction: normalizeContextEviction(source.eviction)
  };
}
function normalizeContextEviction(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    at: typeof source.at === "string" ? source.at : "",
    count: Number.isFinite(Number(source.count)) ? Math.max(0, Math.floor(Number(source.count))) : 0,
    shadowedTokens: Number.isFinite(Number(source.shadowedTokens)) ? Math.max(0, Math.floor(Number(source.shadowedTokens))) : 0,
    busyRetries: Number.isFinite(Number(source.busyRetries)) ? Math.max(0, Math.floor(Number(source.busyRetries))) : 0,
    lastError: typeof source.lastError === "string" ? source.lastError.slice(0, 240) : ""
  };
}
function contextSummaryTriggered(state, options = {}) {
  const turns = Math.max(0, Number(state.totalTurns) || 0);
  const words = Math.max(0, Number(state.totalWords) || 0);
  const baseTurn = Math.max(0, Number(state.summaryThroughTurn) || 0);
  const baseWords = Math.max(0, Number(state.summaryThroughWords) || 0);
  const roundHit = options.skipRoundTrigger !== true && turns - baseTurn >= CONTEXT_ROUND_TRIGGER;
  const wordHit = words - baseWords >= CONTEXT_WORD_TRIGGER;
  const firstSummary = state.summary === "" && turns > 0 && baseTurn === 0;
  return roundHit || wordHit || firstSummary;
}
function roundFromText(turn, texts, seqFrom, seqTo) {
  const kept = texts.map((text) => String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !isProgressLine(line)).join("\n"));
  const joined = kept.filter((text) => text !== "").join("\n").trim();
  const summary = summarizeRoundText(joined);
  return {
    turn,
    seqFrom,
    seqTo,
    task: summary.task,
    conclusion: summary.conclusion,
    todos: summary.todos,
    words: countWords(joined),
    text: capText(joined),
    at: Date.now()
  };
}
function buildSummaryText(rounds) {
  const work = async () => {
    const entries = rounds.slice(-CONTEXT_ROUND_LOG_MAX).map((round) => ({
      turn: round.turn,
      task: round.task,
      conclusion: round.conclusion,
      todos: round.todos
    }));
    const text = rollingSummaryText(entries);
    const meaningful = entries.some((entry) => entry.task !== "" || entry.conclusion !== "" || entry.todos.length > 0);
    if (text === "" || !meaningful) throw new Error("empty summary");
    return text;
  };
  return withTimeout(work(), CONTEXT_SUMMARY_TIMEOUT_MS);
}
function withTimeout(promise, ms) {
  const budget = Math.max(100, Number(ms) || CONTEXT_SUMMARY_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`summary timeout ${String(budget)}ms`)), budget);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function contextSectionText(state) {
  const recent = selectRecentRounds(state.rounds.filter((round) => typeof round.text === "string" && round.text !== ""), CONTEXT_RECENT_ROUNDS);
  const lines = [
    `# \u4E2A\u4EBA\u79D8\u4E66\u4E0A\u4E0B\u6587\uFF08\u63D2\u4EF6\u6EDA\u52A8\u6458\u8981\uFF0C\u6700\u8FD1 ${String(recent.length)} \u8F6E\u539F\u6587 + \u6458\u8981\uFF09`,
    "\u4E0B\u9762\u8FD9\u6BB5\u662F\u672C\u63D2\u4EF6\u6309\u300C\u6700\u8FD1\u539F\u6587\u8F6E\u6570 + \u6EDA\u52A8\u6458\u8981\u300D\u53E3\u5F84\u6CE8\u5165\u7684\uFF0C\u4E0D\u662F\u6A21\u578B\u7684\u81EA\u6211\u627F\u8BFA\u3002"
  ];
  if (state.summary !== "") {
    lines.push("", "\u3010\u5DF2\u538B\u8FDB\u4E0A\u4E0B\u6587\u7684\u5386\u53F2\u6458\u8981\u3011", state.summary);
  } else {
    lines.push("", "\u3010\u5386\u53F2\u6458\u8981\u3011\uFF08\u8FD8\u6CA1\u6709\u6458\u8981\uFF0C\u53EA\u5E26\u6700\u8FD1\u8FD9\u4E9B\u8F6E\u539F\u6587\uFF09");
  }
  if (recent.length > 0) {
    lines.push("", "\u3010\u6700\u8FD1\u8F6E\u6B21\u539F\u6587\u3011");
    for (const round of recent) {
      lines.push(`\u7B2C ${String(round.turn)} \u8F6E\uFF08${String(round.words)} \u8BCD\uFF09\uFF1A`, capText(round.text ?? ""));
    }
  }
  if (state.degraded) {
    lines.push("", `\u3010\u964D\u7EA7\u3011${state.degradedReason || "\u6458\u8981\u751F\u6210\u5931\u8D25"}\uFF1A\u8FD9\u4E00\u8F6E\u53EA\u5E26\u6700\u8FD1 ${String(recent.length)} \u8F6E\u539F\u6587\u7EE7\u7EED\u8DD1\u3002`);
  }
  return `${lines.join("\n")}
`;
}
function contextStateFile(deps = {}) {
  return deps.file ?? join15(deps.homeDir ?? assistantHomeDir(), CONTEXT_STATE_FILENAME);
}
function readStateFile(file, sessionId) {
  try {
    if (!existsSync10(file)) return emptyContextState(sessionId);
    return normalizeContextState(JSON.parse(readFileSync12(file, "utf8")), sessionId);
  } catch {
    return emptyContextState(sessionId);
  }
}
function writeStateFile(file, state) {
  mkdirSync11(dirname12(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync12(tmp, JSON.stringify(state), "utf8");
  renameSync8(tmp, file);
}
async function applyTurnEnd(state, round, file, sessionId) {
  const next = { ...state, sessionId: sessionId || state.sessionId };
  next.totalTurns = Math.max(Number(state.totalTurns) || 0, round.turn);
  next.totalWords = (Number(state.totalWords) || 0) + round.words;
  const rounds = [...state.rounds, round];
  while (rounds.length > CONTEXT_ROUND_LOG_MAX) rounds.shift();
  next.rounds = rounds;
  next.recentRounds = selectRecentRounds(rounds.filter((item) => typeof item.text === "string" && item.text !== ""), CONTEXT_RECENT_ROUNDS).length;
  const triggered = contextSummaryTriggered(next);
  if (!triggered) {
    next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeStateFile(file, next);
    return { state: next, updated: false, summaryUpdated: false };
  }
  let summaryUpdated = false;
  try {
    next.summary = await buildSummaryText(next.rounds);
    next.summaryAt = (/* @__PURE__ */ new Date()).toISOString();
    next.degraded = false;
    next.degradedReason = "";
    next.summaryThroughTurn = next.totalTurns;
    next.summaryThroughWords = next.totalWords;
    summaryUpdated = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    next.degraded = true;
    next.degradedReason = message.slice(0, 240);
    next.degradeCount = (Number(state.degradeCount) || 0) + 1;
    appendOpenDiag({ step: "secretary-context-degraded", sessionId, turn: round.turn, error: message.slice(0, 200), recentRounds: next.recentRounds });
  }
  next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  writeStateFile(file, next);
  return { state: next, updated: true, summaryUpdated };
}
function roundTextsOfEvents(events) {
  const assistant = [];
  const user = [];
  for (const event of events) {
    const type = String(event?.type ?? "");
    const text = textOfEvent(event);
    if (text === "") continue;
    if (type === "assistant/message") {
      assistant.push(text);
    } else if (type === "user/message") {
      if (isSyntheticNoticeUserText(text)) continue;
      if (isProgressLine(text.split("\n")[0] ?? "")) continue;
      user.push(text);
    } else if (type === "developer/message" || type === "system/message") {
      continue;
    }
  }
  return { assistant, user };
}
function registerAssistantSecretaryContext(ctx, deps = {}) {
  const file = contextStateFile(deps);
  let sessionId = secretarySessionRef.id;
  let state = readStateFile(file, sessionId);
  let chain = Promise.resolve();
  const off = [];
  const buckets = /* @__PURE__ */ new Map();
  let secretaryAgent = void 0;
  let pendingEvict = false;
  let evicting = false;
  const compactionService = (agent) => {
    if (deps.compaction && typeof deps.compaction.compactNow === "function") return deps.compaction;
    const candidates = [ctx, agent?.ctx];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const direct = candidate.compaction;
        if (direct && typeof direct.compactNow === "function") return direct;
      } catch {
      }
      try {
        const service = typeof candidate.get === "function" ? candidate.get("compaction") : void 0;
        if (service && typeof service.compactNow === "function") return service;
      } catch {
      }
    }
    return void 0;
  };
  const runEviction = async () => {
    if (evicting || !pendingEvict) return;
    if (sessionId === "" || sessionId !== secretarySessionRef.id) return;
    const compaction = compactionService(secretaryAgent);
    if (compaction === void 0) {
      pendingEvict = false;
      state = { ...state, eviction: { ...state.eviction, lastError: "no compaction service" } };
      try {
        writeStateFile(file, state);
      } catch {
      }
      return;
    }
    if (secretaryAgent === void 0) return;
    evicting = true;
    try {
      const controller = new AbortController();
      const result = await compaction.compactNow(secretaryAgent, controller.signal, EVICT_SOURCE_ID);
      state = {
        ...state,
        eviction: {
          at: (/* @__PURE__ */ new Date()).toISOString(),
          count: state.eviction.count + 1,
          shadowedTokens: Math.max(0, Math.floor(Number(result?.shadowedTokenCount) || 0)),
          busyRetries: 0,
          lastError: ""
        }
      };
      pendingEvict = false;
      try {
        writeStateFile(file, state);
      } catch {
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = error?.name === "ManualCompactionError" && error?.code === "busy";
      const busyRetries = busy ? state.eviction.busyRetries + 1 : state.eviction.busyRetries;
      state = { ...state, eviction: { ...state.eviction, busyRetries, lastError: message.slice(0, 240) } };
      if (!busy || busyRetries >= EVICT_MAX_BUSY_RETRIES) pendingEvict = false;
      appendOpenDiag({ step: "secretary-context-evict-failed", sessionId, error: message.slice(0, 200), busy });
      try {
        writeStateFile(file, state);
      } catch {
      }
    } finally {
      evicting = false;
    }
  };
  const enqueueEviction = () => {
    const task = async () => {
      await runEviction();
    };
    chain = chain.then(task, task);
  };
  try {
    off.push(ctx.on?.("agent/status", (payload) => {
      const agent = payload?.agent;
      const status = String(payload?.status ?? "");
      const agentSessionId = String(agent?.session?.id ?? "");
      if (agentSessionId === "" || agentSessionId !== sessionId) return;
      if (status !== "idle") return;
      secretaryAgent = agent;
      if (pendingEvict && !evicting) enqueueEviction();
    }) ?? (() => void 0));
  } catch {
  }
  const bump = () => {
    const task = async () => {
      try {
        writeStateFile(file, state);
      } catch {
      }
    };
    chain = chain.then(task, task);
  };
  try {
    let currentTurn = 0;
    off.push(ctx.on?.("session/event", async (session, event) => {
      const id = String(session?.id ?? session?.sessionId ?? "");
      if (id !== "" && sessionId !== "" && id !== sessionId) return;
      const type = String(event?.type ?? "");
      const turn = Number(event?.data?.turn ?? event?.turn);
      if (type === "turn/start") {
        if (!Number.isFinite(turn) || turn <= 0) return;
        currentTurn = Math.floor(turn);
        buckets.set(currentTurn, { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) });
        return;
      }
      if (type === "assistant/message" || type === "user/message") {
        const bucketTurn = Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : currentTurn;
        if (bucketTurn <= 0) return;
        const bucket2 = buckets.get(bucketTurn) ?? { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) };
        const text = textOfEvent(event);
        if (text !== "" && !(type === "user/message" && isSyntheticNoticeUserText(text))) bucket2.texts.push(text);
        bucket2.seqTo = Math.max(bucket2.seqTo, Number(event?.seq ?? 0));
        buckets.set(bucketTurn, bucket2);
        return;
      }
      if (type !== "turn/end") return;
      if (!Number.isFinite(turn) || turn <= 0) return;
      const key = Math.floor(turn);
      const bucket = buckets.get(key) ?? { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) };
      buckets.delete(key);
      if (id !== "") sessionId = id;
      const round = roundFromText(key, bucket.texts, bucket.seqFrom, bucket.seqTo);
      const run = async () => {
        const applied = await applyTurnEnd(state, round, file, sessionId);
        state = applied.state;
        if (applied.summaryUpdated && state.totalTurns >= EVICT_MIN_TURNS && sessionId !== "" && sessionId === secretarySessionRef.id) {
          pendingEvict = true;
          enqueueEviction();
        }
      };
      chain = chain.then(run, run);
      void chain.then(() => {
        bump();
      }, () => {
        bump();
      });
    }) ?? (() => void 0));
  } catch {
  }
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      off.push(systemPrompt.section({
        name: "assistant:secretary-context",
        order: 1770,
        text: (context) => {
          const id = String(context?.agent?.session?.id ?? "");
          if (id === "" || sessionId !== "" && id !== sessionId) return "";
          return contextSectionText(state);
        }
      }));
    }
  } catch {
  }
  try {
    const routes = manageWebRoutes(ctx.webServer);
    routes.webServer.register({
      kind: "exact",
      path: ASSISTANT_SECRETARY_CONTEXT_ROUTE,
      handler: async (req, res) => {
        const method = String(req.method ?? "GET").toUpperCase();
        const url = String(req.url ?? "");
        if (method === "DELETE") {
          const run = async () => {
            try {
              if (existsSync10(file)) rmSync2(file, { force: true });
            } catch {
            }
            state = emptyContextState(sessionId);
          };
          chain = chain.then(run, run);
          await chain;
          try {
            res.writeHead?.(200, { "content-type": "application/json; charset=utf-8" });
            res.end?.(JSON.stringify({ ok: true, reset: true, file }));
          } catch {
          }
          return;
        }
        const payload = {
          ok: true,
          file,
          sessionId,
          updatedAt: state.updatedAt,
          summaryAt: state.summaryAt,
          summary: state.summary,
          totalTurns: state.totalTurns,
          totalWords: state.totalWords,
          totalRounds: state.rounds.length,
          rounds: state.rounds.map((round) => ({ turn: round.turn, words: round.words, task: round.task, conclusion: round.conclusion, todos: round.todos })),
          recentRounds: state.recentRounds,
          recentRoundTurns: selectRecentRounds(state.rounds.filter((round) => typeof round.text === "string" && round.text !== ""), CONTEXT_RECENT_ROUNDS).map((round) => round.turn),
          degraded: state.degraded,
          degradedReason: state.degradedReason,
          degradeCount: state.degradeCount,
          summaryThroughTurn: state.summaryThroughTurn,
          summaryThroughWords: state.summaryThroughWords,
          eviction: state.eviction,
          injectedChars: contextSectionText(state).length,
          triggers: { roundTrigger: CONTEXT_ROUND_TRIGGER, wordTrigger: CONTEXT_WORD_TRIGGER, recentRounds: CONTEXT_RECENT_ROUNDS },
          askedSession: (() => {
            const match = url.match(/(?:^|&)session(?:Id)?=([^&]*)/);
            return match === null ? "" : decodeURIComponent(match[1] ?? "");
          })()
        };
        try {
          res.writeHead?.(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end?.(JSON.stringify(payload));
        } catch {
        }
      }
    });
    off.push(() => {
      try {
        routes.dispose();
      } catch {
      }
    });
  } catch {
  }
  return () => {
    for (const dispose of off.splice(0).reverse()) {
      try {
        dispose?.();
      } catch {
      }
    }
  };
}
var assistantSecretaryContextTestSurface = {
  emptyContextState,
  emptyContextEviction,
  normalizeContextEviction,
  normalizeContextState,
  contextSummaryTriggered,
  roundFromText,
  roundTextsOfEvents,
  buildSummaryText,
  withTimeout,
  contextSectionText,
  applyTurnEnd,
  contextStateFile,
  readStateFile: (file, sessionId = "") => readStateFile(file, sessionId),
  writeStateFile,
  CONTEXT_STATE_FILENAME,
  ASSISTANT_SECRETARY_CONTEXT_ROUTE,
  EVICT_MIN_TURNS,
  EVICT_MAX_BUSY_RETRIES,
  EVICT_SOURCE_ID,
  registerAssistantSecretaryContext
};

// src/assistant-dispatch.ts
import { mkdirSync as mkdirSync12, readFileSync as readFileSync13 } from "node:fs";
import { join as join16 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";

// src/client/pathutil.ts
function joinPath(base, rel) {
  const relTrim = rel.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  const sep5 = base.includes("\\") ? "\\" : "/";
  if (base === "/" || base === "\\") return base + relTrim;
  if (/^[A-Za-z]:[\\/]$/.test(base)) return base + relTrim;
  const baseTrim = base.replace(/[\\/]+$/, "");
  if (!baseTrim) return relTrim || sep5;
  return baseTrim + sep5 + relTrim;
}
function basenameOf(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx < 0 ? p : p.slice(idx + 1);
}

// src/client/secretary-dispatch.ts
var TASK_VERBS = [
  "\u5E2E\u6211",
  "\u5E2E\u5FD9",
  "\u8BF7\u5E2E",
  "\u7ED9\u6211",
  "\u66FF\u6211",
  "\u628A",
  "\u5C06",
  "\u505A",
  "\u5199",
  "\u6539",
  "\u4FEE",
  "\u8865",
  "\u5EFA",
  "\u642D",
  "\u8DD1",
  "\u7B97",
  "\u753B",
  "\u67E5",
  "\u627E",
  "\u6574\u7406",
  "\u751F\u6210",
  "\u7FFB\u8BD1",
  "\u4F18\u5316",
  "\u91CD\u6784",
  "\u90E8\u7F72",
  "\u5B89\u88C5",
  "\u914D\u7F6E",
  "\u5BFC\u51FA",
  "\u5BFC\u5165",
  "\u8F6C\u6362",
  "\u5408\u5E76",
  "\u62C6\u5206",
  "\u6D4B\u8BD5",
  "\u6E05\u7406",
  "\u7EDF\u8BA1",
  "\u5BF9\u6BD4",
  "\u4E0B\u8F7D",
  "\u4E0A\u4F20",
  "\u626B\u63CF",
  "\u6821\u5BF9",
  "\u6DA6\u8272",
  "\u6392\u7248",
  "\u5B9E\u73B0",
  "\u5F00\u53D1",
  "\u7F16\u5199",
  "\u505A\u4E2A",
  "\u505A\u4E00\u4E2A",
  "\u6765\u4E00\u4EFD",
  "\u51FA\u4E00\u4EFD",
  "\u5F04\u4E00\u4E2A",
  "\u641E\u4E00\u4E2A",
  "\u5199\u4E2A",
  "\u5EFA\u4E2A",
  "\u52A0\u4E00\u4E2A",
  "increase",
  "add",
  "write",
  "fix",
  "build",
  "run",
  "make",
  "implement",
  "refactor",
  "deploy",
  "create"
];
var CHAT_TAILS = ["\u5417", "\u5462", "\u5427", "\u4E48", "\u600E\u4E48\u6837", "\u4E3A\u4EC0\u4E48", "\u662F\u4EC0\u4E48", "\u6709\u6CA1\u6709", "\u80FD\u4E0D\u80FD", "\u53EF\u4EE5\u5417", "?", "\uFF1F"];
var MULTI_STEP = ["\u7136\u540E", "\u63A5\u7740", "\u518D", "\u6700\u540E", "\u9996\u5148", "\u5176\u6B21", "\u7B2C\u4E00\u6B65", "\u7B2C\u4E8C\u6B65", "\u6B65\u9AA4", "\u2192", "\u5148", "\u4E4B\u540E"];
var CROSS_FILE = [
  "\u6240\u6709\u6587\u4EF6",
  "\u6BCF\u4E2A\u6587\u4EF6",
  "\u5168\u90E8\u6587\u4EF6",
  "\u6279\u91CF",
  "\u9010\u4E2A",
  "\u9010\u9875",
  "\u9010\u6761",
  "\u5168\u6587",
  "\u6574\u4E2A\u76EE\u5F55",
  "\u5404\u7AE0",
  "\u6BCF\u4E00\u7AE0",
  "\u6240\u6709\u7AE0\u8282",
  "\u591A\u4E2A\u6587\u4EF6",
  "\u8DE8\u6587\u4EF6",
  "\u7EDF\u4E00\u6539",
  "\u5168\u90E8\u6539",
  "\u6BCF\u4E2A\u9875\u9762",
  "\u6574\u4E2A\u5DE5\u7A0B",
  "\u6574\u4E2A\u9879\u76EE",
  "\u5168\u7AD9"
];
var BUILD_PROJECT = [
  "\u65B0\u5EFA\u9879\u76EE",
  "\u521B\u5EFA\u9879\u76EE",
  "\u5EFA\u4E2A\u5DE5\u7A0B",
  "\u642D\u4E2A",
  "\u5F00\u53D1\u4E00\u4E2A",
  "\u5B9E\u73B0\u4E00\u4E2A",
  "\u5199\u4E00\u5957",
  "\u505A\u4E00\u4E2A\u7F51\u7AD9",
  "\u5199\u4E2A\u811A\u672C",
  "\u81EA\u52A8\u5316",
  "\u5DE5\u7A0B",
  "\u9879\u76EE",
  "\u5C0F\u7A0B\u5E8F",
  "\u63D2\u4EF6",
  "\u7CFB\u7EDF",
  "pipeline",
  "\u5DE5\u4F5C\u6D41",
  "\u811A\u624B\u67B6",
  "\u4ECE\u96F6"
];
var CONTINUATION = ["\u7EE7\u7EED", "\u63A5\u7740", "\u4E0A\u6B21", "\u4E0A\u4E00\u6B21", "\u521A\u624D", "\u4E4B\u524D\u90A3\u4E2A", "\u4E4B\u524D\u90A3", "\u90A3\u4E2A", "\u518D\u6539", "\u8FD8\u8981", "\u522B\u5FD8\u4E86", "\u63A5\u7740\u8BF4", "\u540E\u6765"];
function norm(value) {
  return String(value ?? "").toLowerCase().replace(/[\s\u3000]+/g, "").replace(/[，。、；：！？"'“”‘’（）()\[\]{}<>《》\-—_/\\|~`@#$%^&*+=.,!?;:]+/g, "");
}
function dispatchSignals(text) {
  const raw = String(text ?? "");
  const hits = [];
  const steps = MULTI_STEP.filter((word) => raw.includes(word));
  if (steps.length >= 2) hits.push("multi-step");
  if (CROSS_FILE.some((word) => raw.includes(word))) hits.push("cross-file");
  if (BUILD_PROJECT.some((word) => raw.includes(word))) hits.push("build-project");
  if (/(^|\n)\s*(?:\d+[.、)]|[①②③④⑤])/m.test(raw)) hits.push("numbered-list");
  return hits;
}
function requiresComputerUse(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return false;
  const lower = raw.toLowerCase();
  if (/(看|查看|识别|读取|操作|点击|截图|截屏).{0,18}(屏幕|页面|窗口|桌面|qq|微信|浏览器|应用|软件)/i.test(raw)) return true;
  if (/(我|你|当前|现在|这个|那个|已|已经).{0,12}(打开|开着|显示|切到).{0,18}(屏幕|页面|窗口|桌面|qq|微信|浏览器|应用|软件)/i.test(raw)) return true;
  if (/(打开|启动|切换|点击|输入|发送|操作).{0,16}(qq|微信|chrome|edge|浏览器|应用|软件|窗口)/i.test(raw)) return true;
  if (/(本机|本地|电脑里|桌面上|磁盘)/i.test(raw) && /(文件|文件夹|目录|文档|截图|图片|word|excel|ppt|pdf|读|看|找|打开)/i.test(raw)) return true;
  if (/(读|打开|查看|查找|检查|修改|整理|分析|总结|转换|导出|上传|下载).{0,18}(文件|文件夹|目录|文档|word|excel|ppt|pdf)/i.test(raw)) return true;
  if (/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:[\w.-]+\/)+[\w.-]+)/.test(raw)) return true;
  if (/(上网|联网|网上|网页|网站|搜索一下|搜一下|在线查|查证|核验|核实|官方来源|最新资料)/i.test(raw)) return true;
  if (/(最新|实时|今天|明天|现在|当前).{0,12}(天气|新闻|汇率|股价|价格|航班|车次|动态)/i.test(raw)) return true;
  if (/\b(computer use|screenshot|screen|desktop)\b/i.test(lower) && /(看|查看|打开|操作|截图|什么|哪)/i.test(raw)) return true;
  return false;
}
function hasTaskIntent(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return false;
  if (requiresComputerUse(raw)) return true;
  const hasVerb = TASK_VERBS.some((word) => raw.toLowerCase().includes(word));
  if (!hasVerb) return false;
  const tailQuestion = CHAT_TAILS.some((word) => raw.endsWith(word));
  if (tailQuestion && !dispatchSignals(raw).length && !/(把|将).{0,20}(改|写|做|建|跑|生成)/.test(raw)) return false;
  return true;
}
function complexityOf(text) {
  const signals = dispatchSignals(text);
  return { level: signals.length > 0 ? "complex" : "simple", signals };
}
function slugFolderName(text, now = /* @__PURE__ */ new Date()) {
  const cleaned = String(text ?? "").replace(/[\\/:*?"<>|\r\n\t\u3000]+/g, "-").replace(/[，。、；：！？“”‘’（）【】《》〈〉·…—～]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const tokens = cleaned.split("-").filter(Boolean).filter((token, index) => index > 0 || !/^(?:帮我|帮忙|请|给我|替我|\d+[.、)]?)$/.test(token));
  const parts = [];
  let length = 0;
  for (const token of tokens) {
    const next = length === 0 ? token.length : length + 1 + token.length;
    if (next > 20) break;
    parts.push(token);
    length = next;
  }
  const head = parts.join("-");
  return head.length >= 2 ? head : stampOf(now);
}
function stampOf(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;
}
function uniqueFolderName(base, existing = []) {
  const taken = new Set(existing.map((name4) => norm(name4)));
  let name3 = base;
  let n = 2;
  while (taken.has(norm(name3))) {
    name3 = `${base}-${n}`;
    n += 1;
  }
  return name3;
}
function absolutePathsIn(text) {
  const out = [];
  const re = /(?:[A-Za-z]:[\\/][^\s"'，。；、）)]*|\\\\[^\s"'，。；、）)]+|\/(?:[\w.-]+\/)+[\w.-]+)/g;
  const matches = String(text ?? "").match(re) ?? [];
  for (const match of matches) {
    const trimmed = match.replace(/[\\/]+$/, "");
    if (trimmed !== "") out.push(trimmed);
    if (out.length >= 4) break;
  }
  return out;
}
function sameOrInside(dir, target) {
  const a = norm(dir);
  const b = norm(target);
  if (a === "" || b === "") return false;
  return b === a || b.startsWith(a);
}
function matchProject(text, projects = []) {
  const raw = String(text ?? "");
  const body = norm(raw);
  if (body === "") return null;
  for (const path of absolutePathsIn(raw)) {
    for (const project of projects) {
      if (project.dir && sameOrInside(project.dir, path)) return { project, signal: "path" };
    }
  }
  let best = null;
  for (const project of projects) {
    const name3 = norm(project.name ?? "");
    if (name3.length >= 2 && body.includes(name3)) {
      best = pick(best, { project, signal: "name", weight: name3.length * 2 });
    }
    const base = norm(basenameOf(project.dir));
    if (base.length >= 2 && base !== name3 && body.includes(base)) {
      best = pick(best, { project, signal: "dir-name", weight: base.length });
    }
  }
  if (best !== null) return { project: best.project, signal: best.signal };
  if (CONTINUATION.some((word) => raw.includes(word))) {
    for (const project of projects) {
      for (const title of project.titles ?? []) {
        const key = norm(title);
        if (key.length >= 4 && body.includes(key)) return { project, signal: "continuation-title" };
      }
    }
  }
  return null;
}
function pick(current, next) {
  return current === null || next.weight > current.weight ? next : current;
}
function decideDispatchTarget(input) {
  const text = String(input.text ?? "").trim();
  const projects = input.projects ?? [];
  const assistantHome = String(input.assistantHome ?? "").trim();
  if (!hasTaskIntent(text)) {
    return { kind: "chat", cwd: "", reason: "\u4E0D\u50CF\u8981\u6D3E\u51FA\u53BB\u7684\u6D3B\uFF0C\u4EA4\u7ED9\u79D8\u4E66\u672C\u4EBA\u56DE\u7B54" };
  }
  const matched = matchProject(text, projects);
  if (matched !== null) {
    return {
      kind: "existing",
      cwd: matched.project.dir,
      projectName: matched.project.name ?? basenameOf(matched.project.dir),
      reason: `\u4E0E\u65E2\u6709\u9879\u76EE\u300C${matched.project.name ?? basenameOf(matched.project.dir)}\u300D\u76F8\u5173\uFF08${matched.signal}\uFF09`
    };
  }
  const complexity = complexityOf(text);
  const fallbackParent = String(input.newFolderParent ?? "").trim();
  const parent = fallbackParent || (assistantHome ? dirnameOf(assistantHome) : "");
  if (parent !== "") {
    const folderName = uniqueFolderName(slugFolderName(text, input.now), input.existingFolders);
    const signals = [...complexity.signals];
    if (requiresComputerUse(text)) signals.push("requires-computer-use");
    return {
      kind: "new-folder",
      cwd: joinPath(parent, folderName),
      folderName,
      signals,
      reason: complexity.level === "complex" ? `\u4E0D\u76F8\u5173\u7684\u65B0\u6D3B\uFF0C\u4E14\u590D\u6742\uFF08${complexity.signals.join("\u3001")}\uFF09\u2192 \u65B0\u5EFA\u4E13\u9879\u6587\u4EF6\u5939 + Computer Use` : "\u6CA1\u6709\u5BF9\u5E94\u9879\u76EE\u6587\u4EF6\u5939\u7684\u52A8\u624B\u4EFB\u52A1 \u2192 \u65B0\u5EFA\u4E13\u9879\u6587\u4EF6\u5939 + Computer Use"
    };
  }
  return { kind: "chat", cwd: "", reason: "\u6CA1\u6709\u53EF\u7528\u7684\u6D3E\u6D3B\u76EE\u5F55\uFF0C\u65E0\u6CD5\u521B\u5EFA Computer Use \u4F1A\u8BDD" };
}
function dirnameOf(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return "";
  if (idx === 0) return p[0];
  if (idx === 2 && /^[A-Za-z]:[\\/]/.test(p)) return p.slice(0, 3);
  return p.slice(0, idx);
}
function projectsFromSessions(rows = [], excludeDirs = []) {
  const excluded = new Set(excludeDirs.map((dir) => norm(dir)).filter(Boolean));
  const byDir = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const dir = String(row?.cwd ?? "").trim();
    if (dir === "") continue;
    const key = norm(dir);
    if (key === "" || excluded.has(key)) continue;
    const title = String(row?.title ?? "").trim();
    const at = Number(row?.updatedAt ?? 0) || 0;
    const current = byDir.get(key);
    if (current === void 0) {
      byDir.set(key, {
        dir,
        name: basenameOf(dir),
        lastUsedAt: at,
        titles: title !== "" ? [title] : []
      });
      continue;
    }
    current.lastUsedAt = Math.max(current.lastUsedAt ?? 0, at);
    if (title !== "" && !(current.titles ?? []).includes(title) && (current.titles ?? []).length < 8) {
      current.titles = [...current.titles ?? [], title];
    }
  }
  return [...byDir.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}

// src/assistant-dispatch.ts
var SECRETARY_DISPATCH_TOOL = "secretary_dispatch";
var CU_AGENT_PRESET = "computer-use";
var DISPATCH_RULES = [
  "A. \u53EA\u6709\u7EAF\u77E5\u8BC6\u3001\u65E0\u9700\u52A8\u624B\u7684\u968F\u53E3\u95EE\u9898\uFF08\u4F8B\u5982\u300C\u4ECA\u5929\u51E0\u53F7\u300D\u300C\u89E3\u91CA\u4E00\u4E2A\u6982\u5FF5\u300D\uFF09\uFF0C\u4EE5\u53CA\u7528\u53EA\u8BFB\u8054\u7F51\u5DE5\u5177 web_search / web_fetch \u4E00\u67E5\u5C31\u80FD\u7B54\u7684\u8F7B\u91CF\u4E8B\u5B9E\uFF08\u5929\u6C14\u3001\u6C14\u6E29\u3001\u65B0\u95FB\u3001\u6C47\u7387\u3001\u8DEF\u7EBF\u65F6\u95F4\u7B49\uFF09\uFF0C\u624D\u76F4\u63A5\u5728\u79D8\u4E66\u4F1A\u8BDD\u91CC\u56DE\u7B54\uFF0C\u4E0D\u8C03\u7528\u672C\u5DE5\u5177\u3001\u4E0D\u5EFA\u4F1A\u8BDD\u3002\u53EA\u8BFB\u9650\u5236\u53EA\u9650\u5236\u5199\u6587\u4EF6\u3001\u8DD1\u7EC8\u7AEF\u3001\u76F4\u63A5\u64CD\u4F5C\u5C4F\u5E55\u548C\u6D3E\u5B50\u4EE3\u7406\uFF1B\u8054\u7F51\u641C\u7D22/\u6293\u53D6\u662F\u53EA\u8BFB\u67E5\u8BE2\uFF0C\u5141\u8BB8\u79D8\u4E66\u81EA\u5DF1\u505A\u3002\u7FFB\u8BD1\u3001\u6DA6\u8272\u3001\u88C1\u56FE\u3001\u6574\u7406\u6587\u4EF6\u4ECD\u7136\u4E0D\u662F A\u3002",
  "B. \u51E1\u9700\u8981\u770B\u5C4F\u5E55\u3001\u770B\u5F53\u524D\u9875\u9762\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u4FDD\u5B58/\u4E0B\u8F7D/\u6574\u7406\u6587\u4EF6\uFF0C\u6216\u9700\u8981\u52A8\u624B\u6267\u884C\uFF08\u8DD1\u547D\u4EE4\u3001\u6539\u6587\u4EF6\u3001\u70B9\u5E94\u7528\uFF09\u7684\u4EFB\u52A1\uFF0C\u82E5\u4E0E\u4E0B\u9762\u67D0\u4E2A\u65E2\u6709\u9879\u76EE\u76F8\u5173\u6216\u662F\u65E7\u4EFB\u52A1\u5EF6\u7EED \u2192 kind \u586B existing\uFF0Ccwd \u586B\u90A3\u4E2A\u9879\u76EE\u7684\u76EE\u5F55\uFF08\u539F\u6837\u7167\u6284\u6E05\u5355\u91CC\u7684\u8DEF\u5F84\uFF09\uFF1B\u5BBF\u4E3B\u7EED\u63A5\u8BE5\u9879\u76EE\u6700\u8FD1\u7684 Computer Use \u4F1A\u8BDD\uFF0C\u6CA1\u6709\u624D\u65B0\u5EFA\u3002",
  "C. \u51E1\u9700\u8981\u770B\u5C4F\u5E55\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u4FDD\u5B58/\u4E0B\u8F7D\u6216\u52A8\u624B\uFF0C\u4F46\u4E0E\u4EFB\u4F55\u65E2\u6709\u9879\u76EE\u90FD\u4E0D\u76F8\u5173 \u2192 kind \u586B new-folder\u3001cwd \u7559\u7A7A\uFF1B\u5BBF\u4E3B\u65B0\u5EFA\u4E13\u9879\u6587\u4EF6\u5939 + Computer Use \u6A21\u5F0F\u4F1A\u8BDD\u3002\u4EFB\u52A1\u7B80\u5355\u4E5F\u7167\u6D3E\uFF0C\u4E0D\u8BB8\u56E0\u300C\u53EA\u662F\u95EE\u4E00\u53E5\u300D\u7559\u5728\u79D8\u4E66\u9875\u3002"
].join("\n");
var DISPATCH_DESCRIPTION = [
  "\u628A\u9700\u8981\u5916\u90E8\u52A8\u624B\u80FD\u529B\u7684\u4EFB\u52A1\u6D3E\u7ED9\u4E00\u6761 Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF08\u4E0D\u662F\u6807\u51C6\u4F1A\u8BDD\u3001\u4E0D\u662F\u5B50\u4EE3\u7406\uFF09\u3002\u9700\u8981\u770B\u5C4F\u5E55\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u4FDD\u5B58/\u4E0B\u8F7D/\u6574\u7406\u6587\u4EF6\u65F6\u5FC5\u987B\u8C03\u7528\u672C\u5DE5\u5177\uFF1B\u7EAF\u77E5\u8BC6\u968F\u53E3\u95EE\u9898\u548C\u53EA\u8BFB\u8054\u7F51\u4E00\u67E5\u5C31\u80FD\u7B54\u7684\u8F7B\u91CF\u4E8B\u5B9E\uFF08\u5982\u300C\u660E\u5929\u5929\u6C14\u300D\uFF09\u4E0D\u8981\u8C03\u7528\uFF0C\u76F4\u63A5\u7528 web_search / web_fetch \u56DE\u7B54\u3002",
  "\u7981\u6B62\u7528\u300C\u6211\u770B\u4E0D\u5230\u300D\u300C\u6CA1\u6709\u622A\u56FE\u80FD\u529B\u300D\u300C\u65E0\u6CD5\u76F4\u63A5\u786E\u8BA4\u300D\u300C\u6211\u505A\u4E0D\u4E86\u300D\u76F4\u63A5\u7EC8\u7B54\u6216\u6536\u5DE5\u3002\u9047\u5230\u81EA\u5DF1\u505A\u4E0D\u5230\u7684\u4E8B\uFF0C\u7B2C\u4E00\u6B65\u5FC5\u987B\u5148\u8C03\u7528\u672C\u5DE5\u5177\uFF1B\u6210\u529F\u540E\u7167\u5B9E\u56DE\u62A5\u56DE\u6267\u6587\u6848\uFF1A\u53EA\u6709\u300C\u5DF2\u6D3E\u6D3B\uFF08\u2026\u5DF2\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u624D\u662F\u90A3\u6761\u4F1A\u8BDD\u771F\u63A5\u4E0A\u4E86\u8BDD\uFF0C\u300C\u5DF2\u5165\u961F\uFF08\u672A\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u5C31\u662F\u53EA\u6295\u8FDB\u4E86\u961F\u5217\u3001\u5BBF\u4E3B\u8FD8\u6CA1\u7ED9\u51FA\u8BC1\u636E\u2014\u2014\u4E0D\u8BB8\u628A\u672A\u786E\u8BA4\u8BF4\u6210\u5DF2\u6D3E\u6D3B\uFF1B\u56DE\u6267\u51FA\u73B0\u300C\u7EED\u63A5\u5931\u8D25\u5DF2\u6539\u65B0\u5EFA\u300D\u5C31\u662F\u90A3\u6761\u4F1A\u8BDD\u8FD9\u4E00\u8F6E\u5931\u8D25\u4E86\uFF08\u9519\u8BEF\u539F\u6587\u5728 reason \u91CC\uFF09\uFF0C\u7167\u5B9E\u8BF4\u662F\u6D3E\u6D3B\u5931\u8D25\u5E76\u6539\u7528\u4E86\u65B0\u5EFA\u4F1A\u8BDD\u3002",
  "\u5DF2\u6709\u9879\u76EE\u6587\u4EF6\u5939\u65F6 kind=existing \u5E76\u586B\u7EDD\u5BF9\u8DEF\u5F84 cwd\uFF08B\uFF09\uFF1B\u6CA1\u6709\u5BF9\u5E94\u9879\u76EE\u65F6 kind=new-folder \u4E14 cwd \u7559\u7A7A\uFF08C\uFF09\u3002\u4E0D\u8981\u518D\u7528 assistant \u7C7B\u578B\u3002",
  "\u5BBF\u4E3B\u53EA\u5EFA/\u7EED Computer Use \u6A21\u5F0F\u4F1A\u8BDD\u3002\u6807\u51C6\u4F1A\u8BDD\u7531 CU \u4F1A\u8BDD\u5728\u540E\u53F0\u81EA\u884C\u6D3E\u53D1\uFF0C\u4E0D\u5F52\u4F60\u7BA1\uFF0C\u4E5F\u4E0D\u8981\u7ED9\u5B83\u4EEC\u5EFA\u5361\u7247\u3002",
  "\u9009\u76EE\u5F55\u6309\u8FD9\u4E09\u5C42\u89C4\u5219\uFF1A",
  DISPATCH_RULES,
  "\u5224\u65AD\u300C\u5EF6\u7EED\u65E7\u4EFB\u52A1\u300D\u65F6\u53C2\u8003\u7CFB\u7EDF\u63D0\u793A\u91CC\u7ED9\u51FA\u7684\u65E2\u6709\u9879\u76EE\u76EE\u5F55\u4E0E\u6700\u8FD1\u4F1A\u8BDD\u6807\u9898\u3002",
  "\u53EA\u6709\u786E\u5B9E\u65E0\u6CD5\u5224\u65AD\u76EE\u5F55\u65F6\u624D\u7701\u7565 cwd\uFF1A\u5BBF\u4E3B\u4F1A\u6309\u540C\u4E00\u5957\u300C\u7EAF\u77E5\u8BC6\u76F4\u63A5\u7B54\uFF0C\u5176\u4F59 B/C\u300D\u89C4\u5219\u515C\u5E95\u3002"
].join("\n");
var PROJECTS_TTL_MS = 3e4;
var projectCache = { at: 0, rows: [] };
var projectsInflight = null;
function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1e12) return n * 1e3;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
function modelSelectionFromBlock(block) {
  const view = block?.values?.modelSelection;
  const selection = view?.next ?? view?.lastUsed;
  if (view === void 0 || view === null) return void 0;
  if (selection === null || selection === void 0) return null;
  if (typeof selection.provider === "string" && typeof selection.model === "string") {
    return { provider: selection.provider, model: selection.model };
  }
  return null;
}
function modelSelectionOf(ctx, source, live = false) {
  if (source === void 0 || source === null) return void 0;
  if (live) {
    try {
      const projections = typeof ctx?.get === "function" ? ctx.get("sessionProjections") : void 0;
      if (projections && typeof projections.cachedSnapshot === "function") {
        const value = modelSelectionFromBlock(projections.cachedSnapshot(source, ["modelSelection"]));
        if (value !== void 0) return value;
      }
    } catch {
    }
  }
  try {
    const cache3 = typeof ctx?.get === "function" ? ctx.get("sessionProjectionCache") : void 0;
    if (cache3 && typeof cache3.cachedSnapshot === "function") {
      return modelSelectionFromBlock(cache3.cachedSnapshot(source?.header ?? source, ["modelSelection"]));
    }
  } catch {
  }
  return void 0;
}
async function listSessionRows(ctx) {
  const rows = [];
  try {
    const query = ctx?.get?.("sessionQuery");
    if (query && typeof query.listSessions === "function") {
      const list = await query.listSessions(void 0);
      for (const record of Array.isArray(list) ? list : []) {
        const header = record?.header ?? {};
        rows.push({
          sessionId: String(header.id ?? record?.sessionId ?? ""),
          cwd: String(header.cwd ?? ""),
          title: String(header.title ?? ""),
          updatedAt: toMs(header.updatedAt ?? header.createdAt),
          agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : "",
          origin: typeof header.origin === "string" ? header.origin : "",
          delegationDepth: Number(header.delegationDepth) || 0,
          model: modelSelectionOf(ctx, header ?? record)
        });
      }
    }
  } catch {
  }
  try {
    const live = ctx?.sessions?.list?.() ?? [];
    for (const session of Array.isArray(live) ? live : []) {
      const header = session?.header ?? {};
      rows.push({
        sessionId: String(header.id ?? session?.id ?? ""),
        cwd: String(header.cwd ?? ""),
        title: String(header.title ?? ""),
        updatedAt: toMs(header.updatedAt),
        agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : "",
        origin: typeof session?.header?.origin === "string" ? session.header.origin : "",
        delegationDepth: Number(header.delegationDepth) || 0,
        model: modelSelectionOf(ctx, session, true) ?? modelSelectionOf(ctx, header)
      });
    }
  } catch {
  }
  return rows.filter((row) => String(row.cwd ?? "").trim() !== "");
}
async function candidateProjects(ctx, force = false) {
  const now = Date.now();
  if (!force && projectCache.at !== 0 && now - projectCache.at < PROJECTS_TTL_MS) {
    return buildProjects(projectCache.rows);
  }
  if (projectsInflight === null) {
    projectsInflight = listSessionRows(ctx).then((rows2) => {
      projectCache.at = Date.now();
      projectCache.rows = rows2;
      return rows2;
    }).catch(() => projectCache.rows).finally(() => {
      projectsInflight = null;
    });
  }
  const rows = await projectsInflight;
  return buildProjects(rows);
}
function buildProjects(rows) {
  return buildProjectsFromRegistry(readConsoleRegistry(), rows);
}
function buildProjectsFromRegistry(registry, rows) {
  const home = safeAssistantHome();
  return mergeConsoleProjects(registry, projectsFromSessions(rows, home ? [home] : []));
}
var PROMPT_SNAPSHOT_WINDOW_MS = 100;
var promptSnapshot = null;
function promptProjectSnapshot(ctx) {
  const now = Date.now();
  if (promptSnapshot !== null && now - promptSnapshot.at < PROMPT_SNAPSHOT_WINDOW_MS) {
    return promptSnapshot.projects;
  }
  const rows = [...projectCache.rows, ...liveSessionRows(ctx)];
  const projects = buildProjectsFromRegistry(readConsoleRegistryAll(), rows);
  promptSnapshot = { projects, at: now };
  void candidateProjects(ctx, true);
  return projects;
}
function liveSessionRows(ctx) {
  try {
    const live = ctx?.sessions?.list?.() ?? [];
    const rows = [];
    for (const session of Array.isArray(live) ? live : []) {
      const header = session?.header ?? {};
      rows.push({
        sessionId: String(header.id ?? session?.id ?? ""),
        cwd: String(header.cwd ?? ""),
        title: String(header.title ?? ""),
        updatedAt: toMs(header.updatedAt)
      });
    }
    return rows.filter((row) => String(row.cwd ?? "").trim() !== "");
  } catch {
    return [];
  }
}
function resetPromptSnapshotForTests() {
  promptSnapshot = null;
}
function parseConsoleProjects(raw, options = {}) {
  const projects = raw?.projects ?? raw?.state?.projects ?? null;
  if (projects === null || typeof projects !== "object") return [];
  const folders = projects.folders && typeof projects.folders === "object" ? projects.folders : {};
  const removed = new Set(Array.isArray(projects.removed) ? projects.removed : []);
  const hidden = new Set(Array.isArray(projects.hidden) ? projects.hidden : []);
  const names = projects.nameOverrides && typeof projects.nameOverrides === "object" ? projects.nameOverrides : {};
  const layouts = Array.isArray(projects.layouts) ? projects.layouts : [];
  const out = [];
  for (const [pid, dir] of Object.entries(folders)) {
    if (removed.has(pid)) continue;
    const isHidden = hidden.has(pid);
    if (isHidden && options.includeHidden !== true) continue;
    const cwd = String(dir ?? "").trim();
    if (cwd === "") continue;
    const layout = layouts.find((l) => l?.id === pid);
    const name3 = String(names[pid] ?? layout?.title ?? "").trim();
    out.push({ dir: cwd, name: name3, hidden: isHidden || void 0 });
  }
  return out;
}
function readConsoleRegistryAll() {
  try {
    const file = join16(registryDir || dispatchProfileDir(), "dsh-assistant-state.json");
    const raw = JSON.parse(readFileSync13(file, "utf8"));
    return parseConsoleProjects(raw, { includeHidden: true });
  } catch {
    return [];
  }
}
function readConsoleRegistry() {
  try {
    const file = join16(registryDir || dispatchProfileDir(), "dsh-assistant-state.json");
    const raw = JSON.parse(readFileSync13(file, "utf8"));
    return parseConsoleProjects(raw);
  } catch {
    return [];
  }
}
function dispatchProfileDir() {
  return process.env.DSH_HOME || join16(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "profiles", "desktop");
}
var registryDir = "";
function setDispatchRegistryDir(dir) {
  registryDir = String(dir ?? "");
}
function mergeConsoleProjects(registry, sessionProjects) {
  const norm2 = (dir) => String(dir ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const byDir = /* @__PURE__ */ new Map();
  for (const project of sessionProjects) byDir.set(norm2(project.dir), project);
  for (const entry of registry) {
    const key = norm2(entry.dir);
    if (key === "") continue;
    const existing = byDir.get(key);
    if (existing !== void 0) {
      if (entry.name !== "") existing.name = entry.name;
      continue;
    }
    byDir.set(key, { dir: entry.dir, name: entry.name !== "" ? entry.name : void 0, lastUsedAt: 0, titles: [], hidden: entry.hidden });
  }
  return [...byDir.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}
function safeAssistantHome() {
  try {
    return String(assistantHomeDir() ?? "");
  } catch {
    return "";
  }
}
function safeNewFolderParent() {
  try {
    return String(resolveNewProjectParent().parent ?? "");
  } catch {
    return "";
  }
}
function resetDispatchCacheForTests() {
  projectCache.at = 0;
  projectCache.rows = [];
  projectsInflight = null;
}
function isUsableTargetDir(cwd) {
  const dir = String(cwd ?? "").trim();
  if (dir === "") return false;
  if (/^[A-Za-z]:[\\/]/.test(dir)) return true;
  if (dir.startsWith("\\\\")) return true;
  return dir.startsWith("/");
}
function resolveDispatchTarget(input) {
  const task = String(input.task ?? "").trim();
  const cwd = String(input.cwd ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  if (isUsableTargetDir(cwd) && kind !== "assistant") {
    const normalized = cwd.replace(/[\\/]+$/, "");
    const decided = kind === "new-folder" || kind === "assistant" || kind === "existing" ? kind : "existing";
    return { kind: decided, cwd: normalized, reason: "\u79D8\u4E66\u6A21\u578B\u6307\u5B9A\u76EE\u5F55", decidedBy: "model" };
  }
  const decision = decideDispatchTarget({
    text: task,
    projects: input.projects ?? [],
    assistantHome: String(input.assistantHome ?? ""),
    newFolderParent: String(input.newFolderParent ?? ""),
    existingFolders: input.existingFolders ?? [],
    now: input.now
  });
  return { ...decision, decidedBy: "rules" };
}
function dispatchPromptSection(ctx, projects) {
  const home = safeAssistantHome();
  const parent = safeNewFolderParent();
  const lines = [];
  lines.push("# \u6D3E\u6D3B\u5206\u5C42\uFF08\u4E2A\u4EBA\u79D8\u4E66\uFF09");
  lines.push("");
  lines.push("\u4F60\u662F\u53EA\u8BFB\u7684\u4E2A\u4EBA\u79D8\u4E66\uFF1A\u53EA\u8BFB\u9650\u5236\u4F60\u81EA\u5DF1\u5199\u6587\u4EF6\u3001\u7F16\u8F91\u6587\u4EF6\u3001\u8DD1\u7EC8\u7AEF\u3001\u76F4\u63A5\u64CD\u4F5C\u5C4F\u5E55\u548C\u6D3E\u5B50\u4EE3\u7406\uFF0C\u4E0D\u9650\u5236\u5EFA\u4F1A\u8BDD\u4E0E\u6D3E\u6D3B\uFF0C\u4E5F\u4E0D\u9650\u5236\u53EA\u8BFB\u8054\u7F51\u67E5\u8BE2\u3002\u6309 A/B/C \u4E09\u5C42\u5904\u7406\uFF1A");
  lines.push("\u8BFB\u6587\u4EF6\u4E0E\u641C\u5185\u5BB9\uFF08read / glob / grep\uFF09\u4E0D\u7B97\u52A8\u624B\uFF1AComputer Use \u4F1A\u8BDD\u628A\u62A5\u544A\u5199\u8FDB\u6587\u4EF6\u540E\uFF0C\u8981\u76F4\u63A5\u628A\u5B83\u8BFB\u56DE\u6765\u518D\u6C47\u62A5\uFF0C\u4E0D\u8BB8\u53EA\u6839\u636E\u901A\u77E5\u91CC\u7684\u7247\u6BB5\u4F5C\u7B54\u3002");
  lines.push("\u7ACB\u957F\u671F\u76EE\u6807\uFF08create_goal / update_goal / get_goal\uFF09\u4E5F\u5FC5\u987B\u662F\u300C\u6D3E\u6D3B\u9A71\u52A8\u300D\u7684\u76EE\u6807\uFF1A\u79D8\u4E66\u4F1A\u8BDD\u91CC create_goal \u7684 objective \u5FC5\u987B\u5199\u660E\u52A8\u624B\u90E8\u5206\u7531 secretary_dispatch \u6D3E Computer Use \u4F1A\u8BDD\u5B8C\u6210\u3001\u4F60\u53EA\u505A\u8BFB\u56DE\u4E0E\u6C47\u62A5\uFF08\u4F8B\uFF1A\u300Cobjective\uFF1A\u7531 Computer Use \u4F1A\u8BDD\u6539\u5B8C X \u5E76\u8DD1\u6D4B\u8BD5\uFF1B\u79D8\u4E66\u53EA\u8BFB\u56DE\u62A5\u544A\u5E76\u6574\u7406\u6210\u7B80\u77ED\u56DE\u590D\u300D\uFF09\u3002\u9700\u8981\u770B\u5C4F\u5E55\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u751F\u6210\u6587\u4EF6\u7684\u590D\u6742\u4EFB\u52A1\uFF0C\u4E0D\u8BB8\u4F60\u5728\u79D8\u4E66\u4F1A\u8BDD\u91CC\u4EB2\u81EA\u4E00\u6B65\u6B65\u505A\u5B8C\uFF0C\u5FC5\u987B\u5148\u6D3E secretary_dispatch \u518D\u8BFB\u56DE\u7ED3\u679C\uFF0C\u5148\u6D3E\u518D\u8BFB\u3002");
  lines.push(DISPATCH_RULES);
  lines.push("");
  lines.push(`\u5206\u5C42 A \u76F4\u63A5\u56DE\u7B54\uFF0C\u4E0D\u8C03\u7528 ${SECRETARY_DISPATCH_TOOL}\u3001\u4E0D\u5EFA\u4F1A\u8BDD\u3002\u7EAF\u77E5\u8BC6\u95EE\u9898\uFF0C\u4EE5\u53CA\u53EA\u8BFB\u8054\u7F51\u4E00\u67E5\u5C31\u80FD\u7B54\u7684\u8F7B\u91CF\u4E8B\u5B9E\uFF08\u4F8B\u5982\u300C\u660E\u5929\u5929\u6C14\u300D\u76F4\u63A5\u7528 web_search \u67E5\uFF09\uFF0C\u90FD\u5C5E\u4E8E A\u3002`);
  lines.push(`\u5176\u4F59\u9700\u8981\u770B\u5C4F\u5E55\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u4FDD\u5B58/\u4E0B\u8F7D/\u6574\u7406\u6587\u4EF6\u6216\u52A8\u624B\u7684\u4EFB\u52A1\uFF0C\u4E00\u5F8B\u5148\u8C03\u7528 ${SECRETARY_DISPATCH_TOOL}\uFF0C\u628A\u7528\u6237\u539F\u8BDD\u539F\u6837\u653E\u8FDB task\uFF1B\u5BBF\u4E3B\u53EA\u5EFA/\u7EED **Computer Use \u6A21\u5F0F**\u4F1A\u8BDD\uFF0C\u7EDD\u4E0D\u6D3E\u8FDB\u6807\u51C6\u4F1A\u8BDD\u3002`);
  lines.push("\u6807\u51C6\u4F1A\u8BDD\u7531 Computer Use \u4F1A\u8BDD\u5728\u540E\u53F0\u81EA\u884C\u6D3E\u53D1\uFF0C\u4E0D\u5F52\u4F60\u7BA1\uFF0C\u4E5F\u4E0D\u8981\u7ED9\u5B83\u4EEC\u5EFA\u5361\u7247\u3002");
  lines.push("");
  lines.push("\u7981\u6B62\u6536\u5DE5\u5F0F\u56DE\u7B54\uFF1A\u4E0D\u5F97\u4EE5\u300C\u6211\u770B\u4E0D\u5230\u300D\u300C\u6CA1\u6709\u622A\u56FE\u80FD\u529B\u300D\u300C\u65E0\u6CD5\u76F4\u63A5\u786E\u8BA4\u300D\u300C\u6211\u505A\u4E0D\u4E86\u300D\u4F5C\u4E3A\u7EC8\u7B54\uFF0C\u4E5F\u4E0D\u8981\u5148\u731C\u4E00\u4E2A\u7B54\u6848\u518D\u7ED3\u675F\uFF1B\u4E0D\u5F97\u7528\u300C\u5DE5\u5177\u6E05\u5355\u91CC\u6CA1\u6709\u6D3E\u6D3B\u5DE5\u5177\u300D\u5F53\u7EC8\u7B54\u3002");
  lines.push(`\u9047\u5230\u81EA\u5DF1\u505A\u4E0D\u5230\u6216\u9700\u8981\u52A8\u624B\u7684\u4EFB\u52A1\uFF0C\u5FC5\u987B\u5148\u6D3E ${SECRETARY_DISPATCH_TOOL}\uFF0C\u5DE5\u5177\u6210\u529F\u540E\u518D\u7167\u5B9E\u56DE\u62A5\u56DE\u6267\u6587\u6848\uFF1A\u53EA\u6709\u300C\u5DF2\u6D3E\u6D3B\uFF08\u2026\u5DF2\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u624D\u662F\u90A3\u6761\u4F1A\u8BDD\u771F\u63A5\u4E0A\u4E86\u8BDD\uFF0C\u300C\u5DF2\u5165\u961F\uFF08\u672A\u786E\u8BA4\u5728\u8DD1\uFF09\u300D\u5C31\u662F\u53EA\u6295\u8FDB\u4E86\u961F\u5217\u3001\u4E0D\u8BB8\u8BF4\u6210\u5DF2\u6D3E\u6D3B\uFF0C\u56DE\u6267\u5E26\u300C\u7EED\u63A5\u5931\u8D25\u5DF2\u6539\u65B0\u5EFA\u300D\u5C31\u662F\u90A3\u6761\u4F1A\u8BDD\u8FD9\u4E00\u8F6E\u5931\u8D25\u4E86\u3002`);
  lines.push(`\u4F8B\uFF1A\u300C\u4F60\u770B\u6211\u6253\u5F00\u7684 QQ \u9875\u9762\uFF0C\u4ED6\u4EEC\u8BF4\u7684 38 fn \u6307\u4EC0\u4E48\u6A21\u578B\uFF1F\u300D\u9700\u8981\u770B\u5F53\u524D\u5C4F\u5E55\uFF0C\u5FC5\u987B\u5148\u8C03\u7528 ${SECRETARY_DISPATCH_TOOL}\uFF0C\u7EDD\u4E0D\u80FD\u5728\u79D8\u4E66\u9875\u56DE\u7B54\u770B\u4E0D\u5230\u3002`);
  lines.push("\u4F8B\uFF1A\u300C\u660E\u5929\u5929\u6C14\u300D\u662F\u53EA\u8BFB\u8054\u7F51\u53EF\u67E5\u7684\u8F7B\u91CF\u95EE\u9898\uFF0C\u76F4\u63A5\u7528 web_search / web_fetch \u67E5\u5E76\u7ED9\u51FA\u7ED3\u679C\uFF1B\u4E07\u4E00\u8054\u7F51\u5DE5\u5177\u4E0D\u53EF\u7528\uFF0C\u518D\u6D3E\u6D3B\uFF0C\u4E0D\u80FD\u76F4\u63A5\u8BF4\u6CA1\u529E\u6210\u3002");
  lines.push("\u4F8B\uFF1A\u300C\u4ECA\u5929\u51E0\u53F7\u300D\u662F\u7EAF\u77E5\u8BC6\u968F\u53E3\u95EE\uFF0C\u76F4\u63A5\u56DE\u7B54\uFF0C\u4E0D\u8C03\u7528\u5DE5\u5177\u3001\u4E0D\u5EFA\u4F1A\u8BDD\u3002");
  lines.push("");
  lines.push(`\u65B0\u9879\u76EE\u7236\u76EE\u5F55\uFF08\u5206\u5C42 C \u65B0\u5EFA\u6587\u4EF6\u5939\u7684\u4F4D\u7F6E\uFF09\uFF1A${parent || "\uFF08\u672A\u77E5\uFF09"}`);
  if (home !== "") lines.push(`\u4E2A\u4EBA\u52A9\u624B\u76EE\u5F55\uFF08\u4EC5\u4F9B\u4F60\u7406\u89E3\u73AF\u5883\uFF1B\u4E0D\u518D\u4F5C\u4E3A\u7B80\u5355\u6742\u6D3B\u7684\u6D3E\u6D3B\u76EE\u6807\uFF09\uFF1A${home}`);
  lines.push("");
  if (projects.length > 0) {
    lines.push("\u65E2\u6709\u9879\u76EE\u76EE\u5F55\uFF08\u5206\u5C42 B \u7684\u5224\u65AD\u4F9D\u636E\uFF0C\u4E0E\u63A7\u5236\u5BA4\u9879\u76EE\u5361\u7247\u540C\u4E00\u4EFD\u6570\u636E\uFF1B\u6700\u8FD1\u5728\u7528\u7684\u6392\u5728\u524D\u9762\uFF09\uFF1A");
    for (const project of projects.slice(0, 12)) {
      const titles = (project.titles ?? []).slice(0, 2).join(" / ");
      lines.push(`- ${project.dir}${project.name && project.name !== project.dir ? `\uFF08${project.name}\uFF09` : ""}${titles ? ` \u6700\u8FD1\u4F1A\u8BDD\uFF1A${titles}` : ""}`);
    }
  } else {
    lines.push("\u65E2\u6709\u9879\u76EE\u76EE\u5F55\uFF1A\uFF08\u6682\u65F6\u8BFB\u4E0D\u5230\uFF1B\u7EAF\u77E5\u8BC6\u95EE\u9898\u8D70 A\uFF0C\u5176\u4F59\u4E00\u5F8B\u8D70 C\uFF09");
  }
  lines.push("");
  lines.push(`\u518D\u6B21\u5F3A\u8C03\uFF1A\u300C\u4ECA\u5929\u51E0\u53F7\u300D\u300C\u660E\u5929\u5929\u6C14\u300D\u8FD9\u7C7B\u7EAF\u77E5\u8BC6\u6216\u53EA\u8BFB\u8054\u7F51\u53EF\u67E5\u7684\u95EE\u9898\u76F4\u63A5\u7B54\uFF08\u5929\u6C14\u7528 web_search / web_fetch\uFF09\uFF1B\u53EA\u8981\u9700\u8981\u770B\u5C4F\u5E55\u3001\u52A8\u624B\u6216\u64CD\u4F5C\u672C\u673A\uFF0C\u5C31\u5148\u8C03\u7528 ${SECRETARY_DISPATCH_TOOL}\uFF0C\u518D\u8BF4\u5DF2\u6D3E\u3002`);
  void ctx;
  return lines.join("\n");
}
function consoleProjectsPromptSection(projects) {
  const lines = [];
  lines.push("# \u63A7\u5236\u5BA4\u9879\u76EE\u6E05\u5355\uFF08\u5B9E\u65F6\u5FEB\u7167\uFF09");
  lines.push("");
  if (projects.length > 0) {
    lines.push("\u63A7\u5236\u5BA4\u5F53\u524D\u5168\u90E8\u4E13\u9879\u4EFB\u52A1\u9879\u76EE\u6587\u4EF6\u5939\uFF0C\u4E0E\u63A7\u5236\u5BA4\u9879\u76EE\u5361\u7247\u540C\u4E00\u4EFD\u6CE8\u518C\u8868\uFF08removed \u5DF2\u6392\u9664\uFF0C\u9690\u85CF\u5361\u7247\u4FDD\u7559\u5E76\u6807\u6CE8\uFF1B\u542B\u4F1A\u8BDD\u76EE\u5F55\u5F52\u5E76\uFF0C\u6700\u8FD1\u5728\u7528\u7684\u6392\u5728\u524D\u9762\uFF09\uFF1A");
    for (const project of projects) {
      const name3 = project.name && project.name !== project.dir ? `\uFF08${project.name}\uFF09` : "";
      lines.push(`- ${project.dir}${name3}${project.hidden ? "\uFF08\u9690\u85CF\uFF09" : ""}`);
    }
  } else {
    lines.push("\u63A7\u5236\u5BA4\u9879\u76EE\u6E05\u5355\uFF1A\uFF08\u6682\u65F6\u8BFB\u4E0D\u5230\uFF1B\u5206\u5C42 C \u65B0\u5EFA\u4E13\u9879\uFF0C\u6216\u7A0D\u540E\u91CD\u8BD5\uFF09");
  }
  lines.push("");
  lines.push("\u6B64\u6E05\u5355\u4E3A\u5F53\u8F6E\u5B9E\u65F6\u5FEB\u7167\uFF0C\u4EE5\u5B83\u4E3A\u51C6\uFF1B\u6D3E\u6D3B\u9009\u76EE\u5F55\u65F6\u9010\u5B57\u7167\u6284\u8FD9\u91CC\u7684\u8DEF\u5F84\u3002");
  return lines.join("\n");
}
function titleOf2(task) {
  const firstLine = String(task ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  const clean = firstLine.replace(/^[#*\s]+/, "").slice(0, 28);
  return `\u6D3E\u6D3B\uFF1A${clean === "" ? "\u65B0\u4EFB\u52A1" : clean}`;
}
function cuContinueCandidates(rows, cwd, secretaryId = "") {
  const norm2 = (dir) => String(dir ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const target = norm2(cwd);
  if (target === "") return [];
  return rows.filter((row) => {
    if (String(row.sessionId ?? "") === "") return false;
    if (row.sessionId === secretaryId) return false;
    if (row.agentPreset !== CU_AGENT_PRESET) return false;
    if (row.origin === "subagent" || (Number(row.delegationDepth) || 0) > 0) return false;
    return norm2(String(row.cwd ?? "")) === target;
  }).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}
function pickCuSessionToContinue(rows, cwd, secretaryId = "", isUnusable) {
  const candidates = typeof isUnusable === "function" ? cuContinueCandidates(rows, cwd, secretaryId).filter((row) => !isUnusable(row)) : cuContinueCandidates(rows, cwd, secretaryId);
  return candidates[0] ?? null;
}
var DISPATCH_VERIFY_TIMEOUT_MS = 1e4;
var DISPATCH_VERIFY_POLL_MS = 150;
var DISPATCH_VERIFY_GRACE_MS = 1500;
function clampMs(value, fallback, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}
function envMs(name3, fallback, max) {
  return clampMs(process.env[name3], fallback, max);
}
function pendingRequestInAgent(ctx, sessionId, requestId) {
  let agent;
  try {
    const agents = (typeof ctx?.get === "function" ? ctx.get("agents") : void 0) ?? ctx?.agents;
    agent = typeof agents?.get === "function" ? agents.get(sessionId) : void 0;
  } catch {
    return null;
  }
  if (agent === void 0 || agent === null) return null;
  const lists = [agent?.inbox?.nextTurn, agent?.inbox?.nextStep];
  let known = false;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    known = true;
    for (const message of list) {
      if (String(message?.source?.rpcId ?? "") === requestId) return true;
    }
  }
  return known ? false : null;
}
async function observeDispatchPrompt(input) {
  const ctx = input.ctx;
  const sessionId = String(input.sessionId ?? "");
  const requestId = String(input.requestId ?? "");
  const timeoutMs = input.timeoutMs !== void 0 ? clampMs(input.timeoutMs, DISPATCH_VERIFY_TIMEOUT_MS, 6e4) : envMs("DSH_ASSISTANT_DISPATCH_VERIFY_MS", DISPATCH_VERIFY_TIMEOUT_MS, 6e4);
  const pollMs = input.pollMs !== void 0 ? clampMs(input.pollMs, DISPATCH_VERIFY_POLL_MS, 2e3) : envMs("DSH_ASSISTANT_DISPATCH_POLL_MS", DISPATCH_VERIFY_POLL_MS, 2e3);
  const graceMs = input.graceMs !== void 0 ? clampMs(input.graceMs, DISPATCH_VERIFY_GRACE_MS, 3e4) : envMs("DSH_ASSISTANT_DISPATCH_GRACE_MS", DISPATCH_VERIFY_GRACE_MS, 3e4);
  const busAvailable = typeof ctx?.on === "function";
  const state = {
    turn: 0,
    opened: false,
    worked: false,
    consumed: false,
    ended: false,
    pending: false,
    busSeen: false,
    failure: null
  };
  let settled = false;
  let resolveDone = () => {
  };
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let timer;
  let tick;
  let graceTimer;
  let offBus;
  const evidenceOf = (verification) => ({
    verification,
    turn: state.turn,
    ...state.failure !== null ? { failure: state.failure } : {},
    pending: state.pending,
    observed_via: state.failure !== null && state.failure.kind === "queue-throw" ? "queue-throw" : state.busSeen ? "bus" : pendingKnown.value !== null ? "poll" : busAvailable ? "bus" : "none"
  });
  const finish = (verification) => {
    if (settled) return;
    settled = true;
    if (timer !== void 0) clearTimeout(timer);
    if (tick !== void 0) clearInterval(tick);
    if (graceTimer !== void 0) clearTimeout(graceTimer);
    if (typeof offBus === "function") {
      try {
        offBus();
      } catch {
      }
    }
    resolveDone(evidenceOf(verification));
  };
  const pendingKnown = { value: null };
  const readPending = () => {
    const value = pendingRequestInAgent(ctx, sessionId, requestId);
    pendingKnown.value = value;
    if (value !== null) state.pending = value;
    return value;
  };
  const evaluate = () => {
    if (settled) return;
    const pending = readPending();
    const absorbed = state.consumed || pending === false;
    if (state.failure !== null) return finish("failed");
    if (state.worked && pending !== true) return finish("confirmed");
    if (state.ended && absorbed) return finish("confirmed");
    if (state.opened && absorbed && graceMs > 0 && graceTimer === void 0) {
      graceTimer = setTimeout(() => {
        graceTimer = void 0;
        if (state.failure !== null) return finish("failed");
        finish("confirmed");
      }, graceMs);
    }
  };
  const handleEvent = (event) => {
    const type = String(event?.type ?? "");
    const data = event?.data ?? {};
    const turn = Number(data?.turn);
    state.busSeen = true;
    if (type === "agent/inbox/spliced") {
      const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
      if (inserted.some((message) => String(message?.source?.rpcId ?? "") === requestId)) {
        state.consumed = true;
        evaluate();
      }
      return;
    }
    if (type === "turn/start") {
      state.opened = true;
      if (Number.isFinite(turn) && turn > 0) state.turn = turn;
      evaluate();
      return;
    }
    if (type === "step/start" || type === "assistant/message" || type === "assistant/attempt" || type === "tool/call") {
      state.worked = true;
      if (Number.isFinite(turn) && turn > 0) state.turn = turn;
      evaluate();
      return;
    }
    if (type === "turn/end") {
      const kind = String(data?.reason?.kind ?? "");
      if (Number.isFinite(turn) && turn > 0) state.turn = turn;
      if (kind === "error" || kind === "aborted" || kind === "interrupted" || kind === "blocked") {
        if (readPending() === true) return;
        state.failure = {
          kind,
          message: String(data?.reason?.error?.message ?? "").trim(),
          code: String(data?.reason?.error?.code ?? "").trim()
        };
        evaluate();
        return;
      }
      if (kind !== "") state.ended = true;
      evaluate();
      return;
    }
  };
  if (busAvailable) {
    try {
      offBus = ctx.on("session/event", (session, event) => {
        if (String(session?.id ?? "") !== sessionId) return;
        handleEvent(event);
      });
    } catch {
      offBus = void 0;
    }
  }
  try {
    await input.prompt();
  } catch (error) {
    state.failure = {
      kind: "queue-throw",
      message: String(error?.message ?? error),
      code: String(error?.code ?? "")
    };
    finish("failed");
    return done;
  }
  if (!busAvailable && pendingRequestInAgent(ctx, sessionId, requestId) === null) {
    finish("unverified");
    return done;
  }
  if (input.signal?.aborted === true) {
    finish("unverified");
    return done;
  }
  try {
    input.signal?.addEventListener?.("abort", () => finish("unverified"));
  } catch {
  }
  evaluate();
  if (!settled) {
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish("unverified"), timeoutMs);
      tick = setInterval(evaluate, pollMs);
    } else {
      finish("unverified");
    }
  }
  return done;
}
var MODEL_CHECK_TTL_MS = 3e4;
var modelChecks = /* @__PURE__ */ new Map();
function resetModelChecksForTests() {
  modelChecks.clear();
}
async function isModelConfigured(ctx, selection) {
  if (selection === void 0 || selection === null) return null;
  const provider = String(selection.provider ?? "");
  const model = String(selection.model ?? "");
  if (provider === "" || model === "") return null;
  let llm;
  try {
    llm = (typeof ctx?.get === "function" ? ctx.get("llm") : void 0) ?? ctx?.llm;
  } catch {
    llm = void 0;
  }
  if (llm === void 0 || llm === null) return null;
  const key = `${provider}\0${model}`;
  const cached2 = modelChecks.get(key);
  if (cached2 !== void 0 && Date.now() - cached2.at < MODEL_CHECK_TTL_MS) return cached2.value;
  let value = null;
  if (typeof llm.listModels === "function") {
    try {
      const models = await llm.listModels(provider);
      value = Array.isArray(models) ? models.some((info) => String(info?.id ?? "") === model) : null;
    } catch {
      value = null;
    }
  }
  if (value === null && typeof llm.resolveModelInfo === "function") {
    try {
      value = await llm.resolveModelInfo(provider, model) !== void 0;
    } catch (error) {
      value = String(error?.code ?? "") === "UNKNOWN_MODEL" ? false : null;
    }
  }
  if (value === null) return null;
  modelChecks.set(key, { at: Date.now(), value });
  return value;
}
async function modelStatesForCandidates(ctx, rows, cwd, secretaryId) {
  const map = /* @__PURE__ */ new Map();
  for (const row of cuContinueCandidates(rows, cwd, secretaryId)) {
    if (row.model === void 0) continue;
    map.set(String(row.sessionId), await isModelConfigured(ctx, row.model));
  }
  return map;
}
function callerOf(exec) {
  return String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? "");
}
function dispatchReceiptText(value) {
  const verification = String(value?.verification ?? "unverified");
  const mode = value?.continued === true ? "\u7EED\u63A5" : "\u65B0\u5EFA";
  const decided = value?.decided_by === "model" ? "\u79D8\u4E66\u6A21\u578B\u5224\u65AD" : "\u89C4\u5219\u515C\u5E95";
  const head = verification === "confirmed" ? `\u5DF2\u6D3E\u6D3B\uFF08Computer Use ${mode}\xB7\u5DF2\u786E\u8BA4\u5728\u8DD1${Number(value?.turn) > 0 ? ` \u7B2C ${value.turn} \u8F6E` : ""}\uFF09` : `\u5DF2\u5165\u961F\uFF08\u672A\u786E\u8BA4\u5728\u8DD1\uFF0CComputer Use ${mode}${value?.pending === true ? "\xB7\u6D88\u606F\u8FD8\u6392\u5728\u5F85\u529E\u961F\u5217\u91CC" : "\xB7\u5BBF\u4E3B\u7A97\u53E3\u5185\u6CA1\u7ED9\u51FA\u8BC1\u636E"}\uFF09`;
  const redispatch = value?.redispatched === true ? "\uFF5C\u7EED\u63A5\u5931\u8D25\u5DF2\u6539\u65B0\u5EFA" : "";
  return `${head}${redispatch} \u2192 ${value?.cwd ?? ""}\uFF08${decided}\uFF1A${value?.reason ?? ""}\uFF09`;
}
function dispatchToolDefinition(ctx) {
  return {
    name: SECRETARY_DISPATCH_TOOL,
    description: DISPATCH_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: {
          type: "string",
          description: "\u7528\u6237\u8981\u5E72\u7684\u6D3B\uFF08\u7528\u6237\u539F\u8BDD\uFF0C\u522B\u6539\u5199\u3001\u522B\u603B\u7ED3\uFF09\u3002\u5FC5\u586B\u3002"
        },
        cwd: {
          type: "string",
          description: "\u5206\u5C42 B \u7684\u65E2\u6709\u9879\u76EE\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF1B\u5206\u5C42 C \u5FC5\u987B\u7559\u7A7A\u3002\u5B9E\u5728\u5224\u65AD\u4E0D\u4E86\u624D\u7701\u7565\uFF0C\u7531\u5BBF\u4E3B\u6309 B/C \u515C\u5E95\u3002"
        },
        kind: {
          type: "string",
          enum: ["existing", "new-folder"],
          description: "existing = \u5DF2\u6709\u9879\u76EE/\u65E7\u4EFB\u52A1\u5EF6\u7EED\uFF08B\uFF09\uFF1Bnew-folder = \u6CA1\u6709\u5BF9\u5E94\u9879\u76EE\uFF0C\u5BBF\u4E3B\u65B0\u5EFA\u4E13\u9879\u6587\u4EF6\u5939 + CU \u4F1A\u8BDD\uFF08C\uFF09\u3002"
        }
      },
      required: ["task"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          cwd: { type: "string" },
          kind: { type: "string" },
          reason: { type: "string" },
          decided_by: { type: "string" },
          created_folder: { type: "boolean" },
          continued: { type: "boolean" },
          agent_preset: { type: "string" },
          /** confirmed = 观测到会话接上了话；unverified = 只入队没能确认；failed 只在抛错时出现（没有回执） */
          verification: { type: "string", enum: ["confirmed", "unverified"] },
          verified: { type: "boolean" },
          /** 观测到的轮次号（0 = 没观测到） */
          turn: { type: "number" },
          /** 观测窗口内这条派活消息是否还在会话待办队列里 */
          pending: { type: "boolean" },
          /** 续接失败后自动改新建（回执如实写「续接失败已改新建」） */
          redispatched: { type: "boolean" },
          failed_session_id: { type: "string" }
        },
        required: ["session_id", "cwd", "kind", "reason", "decided_by", "created_folder", "continued", "agent_preset", "verification", "verified", "redispatched"]
      },
      render: (_args, value) => [{ type: "text", text: dispatchReceiptText(value) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = callerOf(exec);
      const secretary = secretarySessionRef.id;
      if (secretary === "") throw new Error("\u4E2A\u4EBA\u79D8\u4E66\u56FA\u5B9A\u4F1A\u8BDD\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u7A0D\u540E\u518D\u8BD5");
      if (caller !== secretary) throw new Error(`${SECRETARY_DISPATCH_TOOL} \u53EA\u80FD\u5728\u4E2A\u4EBA\u79D8\u4E66\u4F1A\u8BDD\u91CC\u8C03\u7528`);
      const task = String(args?.task ?? "").trim();
      if (task === "") throw new Error("task \u4E0D\u80FD\u4E3A\u7A7A");
      const assistantHome = safeAssistantHome();
      const parent = safeNewFolderParent();
      const projects = await candidateProjects(ctx);
      const target = resolveDispatchTarget({
        task,
        cwd: args?.cwd,
        kind: args?.kind,
        projects,
        assistantHome,
        newFolderParent: parent
      });
      if (target.kind === "chat" || target.kind === "assistant" || target.cwd === "") {
        throw new Error(`\u53EA\u6709\u7EAF\u77E5\u8BC6\u6027\u3001\u65E0\u9700\u52A8\u624B\u7684\u968F\u53E3\u95EE\u9898\uFF08\u4EE5\u53CA\u53EA\u8BFB\u8054\u7F51\u4E00\u67E5\u5C31\u80FD\u7B54\u7684\u8F7B\u91CF\u4E8B\u5B9E\uFF0C\u76F4\u63A5\u7528 web_search / web_fetch\uFF09\u624D\u76F4\u63A5\u5728\u79D8\u4E66\u4F1A\u8BDD\u91CC\u56DE\u7B54\u3002\u82E5\u8FD9\u53E5\u8BDD\u9700\u8981\u770B\u5C4F\u5E55\u3001\u64CD\u4F5C\u5E94\u7528\u3001\u8BFB\u5199\u672C\u673A\u6587\u4EF6\u3001\u4FDD\u5B58\u4E0B\u8F7D\u6216\u52A8\u624B\uFF0C\u5FC5\u987B\u91CD\u65B0\u8C03\u7528 ${SECRETARY_DISPATCH_TOOL}\uFF1A\u5DF2\u6709\u9879\u76EE\u7528 kind=existing\uFF0C\u6CA1\u6709\u9879\u76EE\u7528 kind=new-folder\uFF1B\u7981\u6B62\u4EE5\u300C\u6211\u770B\u4E0D\u5230\u300D\u6536\u5DE5\u3002`);
      }
      let createdFolder = false;
      if (target.folderName !== void 0 && target.folderName !== "") {
        try {
          mkdirSync12(target.cwd, { recursive: true });
          createdFolder = true;
        } catch (error) {
          throw new Error(`\u4E13\u9879\u6587\u4EF6\u5939\u521B\u5EFA\u5931\u8D25\uFF1A${error?.message ?? String(error)}`);
        }
      }
      let sessionController;
      try {
        sessionController = (typeof ctx?.get === "function" ? ctx.get("sessionController") : void 0) ?? ctx?.sessionController;
      } catch {
        sessionController = void 0;
      }
      if (sessionController === void 0 || typeof sessionController.create !== "function") {
        throw new Error("\u5BBF\u4E3B\u6CA1\u6709\u4F1A\u8BDD\u670D\u52A1\uFF0C\u65E0\u6CD5\u6D3E\u6D3B");
      }
      const rows = projectCache.rows;
      const candidates = cuContinueCandidates(rows, target.cwd, secretary);
      const modelStates = await modelStatesForCandidates(ctx, rows, target.cwd, secretary);
      const staleRows = candidates.filter((row) => modelStates.get(String(row.sessionId)) === false);
      const continuing = pickCuSessionToContinue(rows, target.cwd, secretary, (row) => modelStates.get(String(row.sessionId)) === false);
      const staleNote = staleRows.length === 0 ? "" : `\uFF1B\u8DF3\u8FC7 ${staleRows.length} \u6761\u9489\u7740\u5DF2\u9000\u5F79\u6A21\u578B\u7684 Computer Use \u4F1A\u8BDD\uFF08${staleRows.map((row) => `${row.sessionId}\u2192${row.model?.provider}/${row.model?.model}`).join("\u3001")}\uFF09`;
      const openNewCuSession = async (cwd) => {
        const created = await sessionController.create({ cwd, agentPreset: CU_AGENT_PRESET });
        const newId = String(created?.sessionId ?? "");
        if (newId === "") throw new Error("\u5BBF\u4E3B\u6CA1\u6709\u8FD4\u56DE\u65B0\u4F1A\u8BDD id");
        const reportedPreset = typeof created?.agentPreset === "string" ? created.agentPreset : "";
        if (reportedPreset !== "" && reportedPreset !== CU_AGENT_PRESET) {
          throw new Error(`\u65B0\u5EFA\u4F1A\u8BDD\u843D\u6210\u4E86 ${reportedPreset} \u6A21\u5F0F\uFF08\u8981\u6C42 computer-use\uFF09\uFF0C\u8FD9\u6B21\u4E0D\u6D3E\uFF1A\u8BF7\u786E\u8BA4\u5BBF\u4E3B\u5DF2\u6CE8\u518C computer-use \u9884\u8BBE`);
        }
        try {
          if (typeof sessionController.rename === "function") {
            await sessionController.rename({ sessionId: newId, title: titleOf2(task) });
          }
        } catch {
        }
        const requestId = randomUUID3();
        const evidence = await observeDispatchPrompt({
          ctx,
          sessionId: newId,
          requestId,
          signal: exec?.signal,
          prompt: () => sessionController.prompt({
            requestId,
            sessionId: newId,
            mode: "queue",
            content: [{ type: "text", text: task }]
          }, exec?.signal)
        });
        return { sessionId: newId, preset: reportedPreset || CU_AGENT_PRESET, evidence };
      };
      if (continuing !== null && !createdFolder) {
        const sessionId = String(continuing.sessionId);
        const requestId = randomUUID3();
        const evidence = await observeDispatchPrompt({
          ctx,
          sessionId,
          requestId,
          signal: exec?.signal,
          prompt: () => sessionController.prompt({
            requestId,
            sessionId,
            mode: "queue",
            content: [{ type: "text", text: task }]
          }, exec?.signal)
        });
        const failure = evidence.failure ?? { kind: "", message: "", code: "" };
        if (evidence.verification === "failed" && failure.kind === "queue-throw") {
          throw new Error(`\u6D3E\u6D3B\u5931\u8D25\uFF1A\u5BBF\u4E3B\u6CA1\u80FD\u628A\u4EFB\u52A1\u6295\u8FDB Computer Use \u4F1A\u8BDD ${sessionId}\uFF08${failure.message || "\u5165\u961F\u62A5\u9519"}\uFF09${staleNote}`);
        }
        if (evidence.verification === "failed") {
          const pinned = continuing.model !== void 0 && continuing.model !== null ? `\u5B83\u9489\u7684\u6A21\u578B ${continuing.model.provider}/${continuing.model.model} ` : "";
          const detail = `${failure.kind}${failure.code !== "" ? `/${failure.code}` : ""}\uFF1A${failure.message || "\u5BBF\u4E3B\u6CA1\u7ED9\u9519\u8BEF\u539F\u6587"}`;
          const fallback = await openNewCuSession(target.cwd);
          return {
            session_id: fallback.sessionId,
            cwd: target.cwd,
            kind: target.kind,
            reason: `${target.reason}\uFF1B\u7EED\u63A5\u4F1A\u8BDD ${sessionId} \u8FD9\u4E00\u8F6E\u5931\u8D25\uFF08${pinned}${detail}\uFF09\uFF1B\u5DF2\u6539\u65B0\u5EFA Computer Use \u4F1A\u8BDD ${fallback.sessionId} \u5E76\u91CD\u6295\u540C\u6837\u7684\u4EFB\u52A1${staleNote}`,
            decided_by: target.decidedBy,
            created_folder: false,
            continued: false,
            redispatched: true,
            failed_session_id: sessionId,
            agent_preset: fallback.preset,
            verification: fallback.evidence.verification === "failed" ? "unverified" : fallback.evidence.verification,
            verified: fallback.evidence.verification === "confirmed",
            turn: fallback.evidence.turn,
            pending: fallback.evidence.pending
          };
        }
        return {
          session_id: sessionId,
          cwd: target.cwd,
          kind: target.kind,
          reason: `${target.reason}\uFF1B\u7EED\u63A5\u8BE5\u9879\u76EE\u6700\u8FD1\u7684 Computer Use \u4F1A\u8BDD${staleNote}`,
          decided_by: target.decidedBy,
          created_folder: false,
          continued: true,
          redispatched: false,
          agent_preset: CU_AGENT_PRESET,
          verification: evidence.verification,
          verified: evidence.verification === "confirmed",
          turn: evidence.turn,
          pending: evidence.pending
        };
      }
      const fresh = await openNewCuSession(target.cwd);
      return {
        session_id: fresh.sessionId,
        cwd: target.cwd,
        kind: target.kind,
        reason: `${target.reason}${staleNote}`,
        decided_by: target.decidedBy,
        created_folder: createdFolder,
        continued: false,
        redispatched: false,
        agent_preset: fresh.preset,
        verification: fresh.evidence.verification,
        verified: fresh.evidence.verification === "confirmed",
        turn: fresh.evidence.turn,
        pending: fresh.evidence.pending
      };
    }
  };
}
function registerAssistantDispatch(ctx) {
  const disposers = [];
  try {
    const p = ctx?.get?.("profileContext");
    if (p && typeof p.dir === "string" && p.dir) setDispatchRegistryDir(p.dir);
    else {
      const h = ctx?.get?.("homePaths");
      if (h && typeof h.home === "string" && h.home) setDispatchRegistryDir(h.home);
    }
  } catch {
  }
  const tool = dispatchToolDefinition(ctx);
  const registerTool = (tools2) => {
    if (!tools2 || typeof tools2.register !== "function") return;
    try {
      const off = tools2.register(tool);
      if (typeof off === "function") disposers.push(off);
    } catch (error) {
      ctx?.logger?.warn?.(`[dsh-assistant] secretary_dispatch \u5DE5\u5177\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    }
  };
  let tools;
  try {
    tools = typeof ctx?.get === "function" ? ctx.get("tools") : void 0;
  } catch {
    tools = void 0;
  }
  if (tools && typeof tools.register === "function") {
    registerTool(tools);
  } else {
    let deferred = false;
    try {
      if (typeof ctx?.inject === "function") {
        ctx.inject(["tools"], (scope) => {
          registerTool(scope?.tools);
        });
        deferred = true;
      }
    } catch {
      deferred = false;
    }
    if (!deferred) {
      try {
        registerTool(ctx?.tools);
      } catch (error) {
        ctx?.logger?.warn?.(`[dsh-assistant] secretary_dispatch \u5DE5\u5177\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
      }
    }
  }
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      const off = systemPrompt.section({
        name: "assistant:secretary-console-projects",
        order: 1775,
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== secretarySessionRef.id) return "";
          return consoleProjectsPromptSection(promptProjectSnapshot(ctx));
        }
      });
      if (typeof off === "function") disposers.push(off);
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] \u63A7\u5236\u5BA4\u9879\u76EE\u6E05\u5355\u63D0\u793A\u8BCD\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
  }
  try {
    const systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
    if (systemPrompt && typeof systemPrompt.section === "function") {
      const off = systemPrompt.section({
        name: "assistant:secretary-dispatch",
        order: 1790,
        text: (context) => {
          const sessionId = String(context?.agent?.session?.id ?? "");
          if (sessionId === "" || sessionId !== secretarySessionRef.id) return "";
          const projects = promptProjectSnapshot(ctx).filter((project) => !project.hidden);
          return dispatchPromptSection(ctx, projects);
        }
      });
      if (typeof off === "function") disposers.push(off);
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] \u6D3E\u6D3B\u63D0\u793A\u8BCD\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
  }
  try {
    const off = ctx?.on?.("tools/pre-execute", async (exec, next) => {
      if (String(exec?.name ?? "") !== SECRETARY_DISPATCH_TOOL) return next();
      const caller = callerOf(exec);
      if (caller !== "" && caller === secretarySessionRef.id) return next();
      return { kind: "deny", reason: `${SECRETARY_DISPATCH_TOOL} \u53EA\u80FD\u5728\u4E2A\u4EBA\u79D8\u4E66\u4F1A\u8BDD\u91CC\u8C03\u7528\u3002` };
    });
    if (typeof off === "function") disposers.push(off);
  } catch {
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
var assistantDispatchTestSurface = {
  SECRETARY_DISPATCH_TOOL,
  CU_AGENT_PRESET,
  DISPATCH_RULES,
  resolveDispatchTarget,
  isUsableTargetDir,
  dispatchPromptSection,
  consoleProjectsPromptSection,
  promptProjectSnapshot,
  resetPromptSnapshotForTests,
  listSessionRows,
  candidateProjects,
  resetDispatchCacheForTests,
  dispatchToolDefinition,
  dispatchReceiptText,
  registerAssistantDispatch,
  pickCuSessionToContinue,
  cuContinueCandidates,
  modelSelectionOf,
  isModelConfigured,
  resetModelChecksForTests,
  observeDispatchPrompt,
  pendingRequestInAgent,
  DISPATCH_VERIFY_TIMEOUT_MS,
  DISPATCH_VERIFY_POLL_MS,
  DISPATCH_VERIFY_GRACE_MS,
  parseConsoleProjects,
  mergeConsoleProjects,
  setDispatchRegistryDir
};

// src/assistant-cu-watch.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { mkdirSync as mkdirSync13, realpathSync as realpathSync3, writeFileSync as writeFileSync13 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { dirname as dirname13, join as join17, resolve as pathResolve2, sep as sep4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var CU_PRESET = "computer-use";
var CU_NOTIFY_ROUTE = "/api/assistant/cu-watch/notify";
function presetOfSource(projected, header) {
  if (typeof projected === "string" && projected !== "") return projected;
  if (typeof header === "string" && header !== "") return header;
  return "";
}
function classifyCuTurn(reasonKind) {
  const kind = String(reasonKind ?? "");
  if (kind === "completed") return "completed";
  if (kind === "error" || kind === "aborted" || kind === "interrupted" || kind === "blocked") return "failed";
  return null;
}
function failureOfTurnEnd(data) {
  const reason = data?.reason ?? {};
  const error = reason?.error ?? {};
  return {
    kind: String(reason?.kind ?? ""),
    message: String(error?.message ?? "").trim(),
    code: String(error?.code ?? "").trim()
  };
}
function shouldReportTurn(input) {
  if (input.preset !== CU_PRESET) return false;
  if (classifyCuTurn(input.reasonKind) === null) return false;
  if (input.isSecretary === true) return false;
  if (input.origin === "subagent") return false;
  if (typeof input.delegationDepth === "number" && input.delegationDepth > 0) return false;
  return true;
}
function formatCuFailureLine(failure) {
  const bits = [];
  const kind = String(failure?.kind ?? "").trim();
  const code = String(failure?.code ?? "").trim();
  const message = String(failure?.message ?? "").trim();
  if (kind !== "") bits.push(`\u539F\u56E0 ${kind}`);
  if (code !== "") bits.push(`\u9519\u8BEF\u7801 ${code}`);
  if (message !== "") bits.push(`\u9519\u8BEF\u539F\u6587\u300C${message}\u300D`);
  return bits.length === 0 ? "" : `\uFF08${bits.join("\uFF1B")}\uFF09`;
}
function buildCompletionNotice(input) {
  const title = String(input.title ?? "").trim() || "\u7535\u8111\u4E0A\u7684\u4EFB\u52A1";
  const summary = String(input.summary ?? "").trim();
  const failed = input.outcome === "failed";
  const failureLine = formatCuFailureLine(input.failure);
  const truncated = input.truncation !== void 0 || summary.endsWith("\u2026");
  return [
    "\uFF08\u7CFB\u7EDF\u901A\u77E5\uFF0C\u4E0D\u662F\u7528\u6237\u8BF4\u7684\u8BDD\uFF09",
    failed ? `\u7535\u8111\u64CD\u4F5C\u4F1A\u8BDD\u300C${title}\u300D\u8FD9\u4E00\u8F6E\u5931\u8D25\u4E86${failureLine}\u3002` : `\u7535\u8111\u64CD\u4F5C\u4F1A\u8BDD\u300C${title}\u300D\u8FD9\u4E00\u8F6E\u5DF2\u7ECF\u5B8C\u6210\u3002`,
    summary !== "" ? truncated ? truncationNoticeLine(summary, input.truncation) : `\u5B83\u8FD9\u4E00\u8F6E\u7684\u8FD4\u56DE\u539F\u6587\u6309\u987A\u5E8F\u62FC\u63A5\u3001\u5B8C\u6574\u7167\u5F55\uFF08\u6574\u6BB5\u90FD\u5728\u8FD9\u6761\u901A\u77E5\u91CC\uFF09\uFF1A${summary}` : failed ? "\u5B83\u8FD9\u4E00\u8F6E\u6CA1\u6709\u7559\u4E0B\u6587\u5B57\u7ED3\u679C\u3002" : "\u5B83\u6CA1\u6709\u7559\u4E0B\u6587\u5B57\u7ED3\u679C\u3002",
    failed ? "\u5411\u7528\u6237\u6C47\u62A5\u65F6\u5FC5\u987B\u7167\u5B9E\u8BF4\u662F\u300C\u8FD9\u4E00\u8F6E\u5931\u8D25\uFF0F\u6D3E\u6D3B\u5931\u8D25\u300D\uFF0C\u4E0D\u8BB8\u8BF4\u6210\u5DF2\u5B8C\u6210\u3001\u5DF2\u843D\u5730\u3001\u5DF2\u6D3E\u6D3B\uFF1A\u628A\u4E0A\u9762\u90A3\u6761\u9519\u8BEF\u7801\u4E0E\u9519\u8BEF\u539F\u6587\u5B8C\u6574\u8F6C\u8FF0\uFF08\u5F15\u53F7\u3001\u8DEF\u5F84\u3001\u6A21\u578B\u540D\u3001\u9519\u8BEF\u7801\u90FD\u4E0D\u8BB8\u7701\uFF09\uFF0C\u5E76\u544A\u8BC9\u7528\u6237\u53EF\u4EE5\u6539\u6D3E\u2014\u2014\u6362\u4E00\u6761\u65B0\u5EFA\u7684 Computer Use \u4F1A\u8BDD\uFF08\u6D3E\u6D3B\u5931\u8D25\u540E\u63D2\u4EF6\u4F1A\u81EA\u52A8\u6539\u65B0\u5EFA\u5E76\u5982\u5B9E\u5199\u8FDB\u56DE\u6267\uFF09\uFF0C\u6216\u6362\u4E2A\u9879\u76EE\u76EE\u5F55\u518D\u6D3E\u4E00\u6B21\u3002" : "\u5411\u7528\u6237\u6C47\u62A5\u65F6\u4E0D\u8981\u6574\u5927\u6BB5\u539F\u5C01\u4E0D\u52A8\u7167\u6284\u4E0A\u9762\u8FD9\u6761\u7ED3\u679C\uFF1A\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u4F60\u81EA\u5DF1\u6574\u7406\u6210\u7B80\u77ED\u7684\u4E2D\u6587\u56DE\u590D\uFF0C\u4FDD\u7559\u5173\u952E\u786C\u4E8B\u5B9E\uFF08\u6587\u4EF6\u540D\u3001\u5927\u5C0F\u3001\u54C8\u5E0C\u3001\u6570\u5B57\u3001\u63D0\u4EA4\u53F7\u3001\u5224\u636E\u3001\u7ED3\u8BBA\u3001\u5F85\u529E\uFF09\uFF0C\u7981\u6B62\u6574\u5927\u6BB5\u539F\u5C01\u4E0D\u52A8\u7167\u6284\u3001\u7981\u6B62\u7167\u6284\u8868\u683C\u4E0E\u957F\u8DEF\u5F84\u3001\u7981\u6B62\u91CD\u590D\u901A\u77E5\u539F\u6587\uFF1B\u4F46\u5FC5\u987B\u5148\u62FF\u5230\u5B8C\u6574\u5185\u5BB9\u518D\u6574\u7406\u2014\u2014\u539F\u6587\u88AB\u88C1\u5C31\u6309\u4E0A\u9762\u7684\u843D\u76D8\u8DEF\u5F84\u7528 read \u6574\u6BB5\u8BFB\u56DE\uFF0C\u4E0D\u8BB8\u53EA\u4F9D\u636E\u88AB\u88C1\u7684\u6458\u5F55\u4F5C\u7B54\uFF0C\u4E5F\u4E0D\u8BB8\u81EA\u5DF1\u8865\u5199\u3002",
    "\u8FD9\u4E00\u56DE\u5408\u52A8\u624B\u7C7B\u5DE5\u5177\u5DF2\u7981\u7528\uFF1A\u4E0D\u8981\u5C1D\u8BD5\u6D3E\u6D3B\u3001\u8DD1\u547D\u4EE4\u6216\u8054\u7F51\u67E5\u8BE2\u3002\u539F\u6587\u88AB\u88C1\u65F6\u53EF\u4EE5\u6309\u4E0A\u9762\u7684\u843D\u76D8\u8DEF\u5F84\u8BFB\u6587\u4EF6\u6838\u5BF9\uFF08read/glob/grep \u653E\u884C\uFF09\uFF0C\u4E0D\u8BB8\u51ED\u88AB\u88C1\u7684\u5934\u5C3E\u7F16\u9020\u7EC6\u8282\u3002",
    `\u6700\u540E\u5355\u72EC\u4E00\u884C\u539F\u6837\u8F93\u51FA\uFF1A[[session:${input.sessionId}|${title}]]`
  ].join("\n");
}
function truncationNoticeLine(summary, truncation) {
  if (truncation === void 0) {
    return `\u5B83\u8FD9\u4E00\u8F6E\u7684\u8FD4\u56DE\u539F\u6587\u6309\u987A\u5E8F\u62FC\u63A5\uFF0C\u5176\u4E2D\u6309\u63D2\u4EF6\u4E0A\u9650\u622A\u65AD\u5230 ${CU_NOTICE_RESULT_MAX_CHARS} \u5B57\uFF08\u672B\u5C3E\u5E26 \u2026\uFF0C\u540E\u534A\u6BB5\u4E0D\u5728\u901A\u77E5\u91CC\uFF09\uFF1A${summary}`;
  }
  const path = truncation.fullTextPath !== "" ? truncation.fullTextPath : "\uFF08\u843D\u76D8\u5931\u8D25\uFF0C\u8FD9\u4E00\u8F6E\u6CA1\u7ED9\u51FA\u8DEF\u5F84\uFF09";
  return `\u5B83\u8FD9\u4E00\u8F6E\u7684\u8FD4\u56DE\u539F\u6587\u5171 ${truncation.originalChars} \u5B57\uFF0C\u8D85\u8FC7\u63D2\u4EF6\u5355\u6761\u4E0A\u9650 ${CU_NOTICE_RESULT_MAX_CHARS} \u5B57\uFF1A\u901A\u77E5\u91CC\u4FDD\u7559\u5934 ${truncation.keptHeadChars} \u5B57 + \u540E ${truncation.keptTailChars} \u5B57\uFF0C\u4E2D\u95F4\u7701\u7565 ${truncation.omittedChars} \u5B57\uFF08\u7EA6\u5728\u7B2C ${truncation.omittedFromChar}\u2013${truncation.omittedToChar} \u5B57\u4E4B\u95F4\uFF0C\u7ED3\u8BBA\u6BB5\u4E0E\u672B\u5C3E\u8DEF\u5F84\u90FD\u5728\u4FDD\u7559\u8303\u56F4\u5185\uFF09\u3002\u5B8C\u6574\u539F\u6587\u5DF2\u88AB\u88C1\u3001\u5DF2\u843D\u76D8\uFF1A${path}\u2014\u2014\u8981\u7EC6\u8282\u65F6\u7528 read \u628A\u8FD9\u4E2A\u6587\u4EF6\u6574\u6BB5\u8BFB\u56DE\uFF0C\u4E0D\u8BB8\u53EA\u4F9D\u636E\u4E0B\u9762\u7684\u5934\u5C3E\u4F5C\u7B54\uFF1A
${summary}`;
}
function buildNoticeMessage(input) {
  return {
    id: randomUUID4(),
    role: "user",
    content: [{ type: "text", text: buildCompletionNotice(input) }],
    source: { kind: "user" }
  };
}
var CU_NOTICE_RESULT_MAX_CHARS = 2e4;
var CU_NOTICE_HEAD_KEEP_CHARS = 15e3;
var CU_NOTICE_TAIL_KEEP_CHARS = 5e3;
var CU_NOTICE_DUMP_DIR_NAME = ".dsh-cu-notices";
var CU_NOTIFY_ROUTE_BODY_MAX_CHARS = CU_NOTICE_RESULT_MAX_CHARS * 10;
function cleanCuText(text) {
  return String(text ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function digestCuCompletion(text, max = CU_NOTICE_RESULT_MAX_CHARS) {
  const clean = cleanCuText(text);
  const originalChars = clean.length;
  if (originalChars <= max) {
    return {
      text: clean,
      fullText: clean,
      truncated: false,
      originalChars,
      keptHeadChars: originalChars,
      keptTailChars: 0,
      omittedChars: 0,
      omittedFromChar: 0,
      omittedToChar: 0
    };
  }
  const headChars = Math.min(CU_NOTICE_HEAD_KEEP_CHARS, Math.max(1, Math.round(max * 3 / 4)));
  const tailChars = Math.min(CU_NOTICE_TAIL_KEEP_CHARS, Math.max(1, max - headChars));
  const head = clean.slice(0, headChars);
  const tail = clean.slice(clean.length - tailChars);
  const omittedFromChar = headChars + 1;
  const omittedToChar = clean.length - tailChars;
  const omittedChars = omittedToChar - omittedFromChar + 1;
  const marker = `

\u2026\u3014\u4E2D\u95F4\u7701\u7565 ${omittedChars} \u5B57\uFF1A\u7B2C ${omittedFromChar}\u2013${omittedToChar} \u5B57\uFF1B\u7ED3\u8BBA\u6BB5\u4E0E\u672B\u5C3E\u8DEF\u5F84\u90FD\u5728\u4E0B\u9762\u8FD9\u6BB5\u539F\u6587\u91CC\uFF0C\u5B8C\u6574\u539F\u6587\u89C1\u843D\u76D8\u6587\u4EF6\u3015\u2026

`;
  return {
    text: `${head}${marker}${tail}`,
    fullText: clean,
    truncated: true,
    originalChars,
    keptHeadChars: headChars,
    keptTailChars: tailChars,
    omittedChars,
    omittedFromChar,
    omittedToChar
  };
}
function summarizeCompletion(text) {
  return digestCuCompletion(text).text;
}
function cuNoticeDumpFileName(now = /* @__PURE__ */ new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp2 = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `cu-notice-full-${stamp2}.md`;
}
function writeCuNoticeDump(input) {
  const dir = String(input.dir ?? "").trim();
  if (dir === "") return null;
  const body = String(input.text ?? "");
  const title = String(input.title ?? "").trim() || "\u7535\u8111\u4E0A\u7684\u4EFB\u52A1";
  const turn = Number(input.turn);
  const now = input.now ?? /* @__PURE__ */ new Date();
  try {
    mkdirSync13(dir, { recursive: true });
    const file = pathResolve2(dir, cuNoticeDumpFileName(now));
    const header = [
      "# CU \u4F1A\u8BDD\u5B8C\u6574\u539F\u6587\uFF08\u901A\u77E5\u88AB\u88C1\u524D\u7684\u5168\u6587\uFF0C\u63D2\u4EF6\u843D\u76D8\uFF09",
      "",
      `- \u4F1A\u8BDD\uFF1A${title}\uFF08${input.sessionId}\uFF09`,
      `- \u8F6E\u6B21\uFF1A${Number.isFinite(turn) ? turn : "\u672A\u77E5"}`,
      `- \u843D\u76D8\u65F6\u95F4\uFF1A${now.toISOString()}`,
      `- \u539F\u6587\u603B\u5B57\u6570\uFF1A${body.length}`,
      `- \u901A\u77E5\u53E3\u5F84\uFF1A\u5355\u6761\u4E0A\u9650 ${CU_NOTICE_RESULT_MAX_CHARS} \u5B57\uFF1B\u8D85\u51FA\u65F6\u901A\u77E5\u53EA\u5E26\u524D ${CU_NOTICE_HEAD_KEEP_CHARS} \u5B57 + \u540E ${CU_NOTICE_TAIL_KEEP_CHARS} \u5B57`,
      "",
      "---",
      ""
    ].join("\n");
    writeFileSync13(file, `${header}${body}`, "utf8");
    return file;
  } catch {
    return null;
  }
}
function pluginRootDirs() {
  const roots = [];
  try {
    const root = pathResolve2(dirname13(fileURLToPath2(import.meta.url)), "..");
    if (root !== "") roots.push(root);
    try {
      const real = realpathSync3(root);
      if (real !== root) roots.push(real);
    } catch {
    }
  } catch {
  }
  return roots;
}
function isInsideDir(child, parent) {
  if (parent === "") return false;
  const norm2 = (value) => pathResolve2(value).replace(/[\\/]+$/, "").toLowerCase();
  const childNorm = norm2(child);
  const parentNorm = norm2(parent);
  return childNorm === parentNorm || childNorm.startsWith(`${parentNorm}${sep4}`);
}
function cuNoticeDumpDirOf(session, profileDir6 = "") {
  const cwd = String(session?.header?.cwd ?? session?.cwd ?? "").trim();
  const root = cwd !== "" ? pathResolve2(cwd) : "";
  const roots = pluginRootDirs();
  if (root !== "" && !roots.some((pluginRoot) => isInsideDir(root, pluginRoot))) {
    return join17(root, CU_NOTICE_DUMP_DIR_NAME);
  }
  const home = profileDir6 !== "" ? pathResolve2(profileDir6) : pathResolve2(process.env.DSH_HOME || join17(homedir9(), ".dsh"));
  return join17(home, CU_NOTICE_DUMP_DIR_NAME);
}
function createCuWatch(deps) {
  const log = typeof deps.log === "function" ? deps.log : () => {
  };
  const titleOf3 = typeof deps.titleOf === "function" ? deps.titleOf : (session) => String(session?.header?.title ?? "");
  const texts = /* @__PURE__ */ new Map();
  const reported = /* @__PURE__ */ new Set();
  const isSecretary = (sessionId) => {
    try {
      return sessionId !== "" && sessionId === (deps.secretaryId?.() ?? "");
    } catch {
      return false;
    }
  };
  return {
    /** 测试/诊断：某会话某轮已收集的整段条数（一条 assistant 消息一条，段内 text 块已拼接）。 */
    collectedOf(sessionId, turn) {
      return texts.get(sessionId)?.get(turn)?.length ?? 0;
    },
    reportedOf(sessionId, turn) {
      return reported.has(`${sessionId}:${turn}`);
    },
    handleSessionEvent(session, event) {
      try {
        const sessionId = String(session?.id ?? "");
        if (sessionId === "") return;
        const type = String(event?.type ?? "");
        if (type === "assistant/message") {
          const preset2 = deps.presetOf(session);
          if (preset2 !== CU_PRESET) return;
          if (isSecretary(sessionId)) return;
          if (session?.header?.origin === "subagent") return;
          const turn2 = Number(event?.data?.turn);
          if (!Number.isFinite(turn2) || turn2 < 1) return;
          const content = Array.isArray(event?.data?.message?.content) ? event.data.message.content : [];
          const parts = [];
          for (const block of content) {
            if (block?.type !== "text") continue;
            const text = String(block?.text ?? "").trim();
            if (text !== "") parts.push(text);
          }
          if (parts.length === 0) return;
          let byTurn2 = texts.get(sessionId);
          if (byTurn2 === void 0) {
            byTurn2 = /* @__PURE__ */ new Map();
            texts.set(sessionId, byTurn2);
          }
          if (byTurn2.size > 4) {
            const oldest = byTurn2.keys().next().value;
            if (typeof oldest === "number") byTurn2.delete(oldest);
          }
          const list = byTurn2.get(turn2) ?? [];
          byTurn2.set(turn2, [...list, parts.join("\n\n")].slice(-24));
          if (texts.size > 40) {
            const oldest = texts.keys().next().value;
            if (typeof oldest === "string") texts.delete(oldest);
          }
          return;
        }
        if (type !== "turn/end") return;
        const data = event?.data ?? {};
        const turn = Number(data?.turn);
        const outcome = classifyCuTurn(data?.reason?.kind);
        const failure = outcome === "failed" ? failureOfTurnEnd(data) : void 0;
        const byTurn = texts.get(sessionId);
        const collected = Number.isFinite(turn) ? byTurn?.get(turn) ?? [] : [];
        if (Number.isFinite(turn) && byTurn !== void 0) byTurn.delete(turn);
        const preset = deps.presetOf(session);
        if (!shouldReportTurn({
          preset,
          reasonKind: data?.reason?.kind,
          origin: session?.header?.origin,
          delegationDepth: session?.header?.delegationDepth,
          isSecretary: isSecretary(sessionId)
        })) return;
        if (!Number.isFinite(turn) || turn < 1) return;
        const dedupKey = `${sessionId}:${turn}`;
        if (reported.has(dedupKey)) return;
        reported.add(dedupKey);
        if (reported.size > 200) {
          const oldest = reported.values().next().value;
          if (typeof oldest === "string") reported.delete(oldest);
        }
        const reportText = collected.join("\n\n");
        const title = titleOf3(session);
        const digest = digestCuCompletion(reportText);
        let truncation;
        if (digest.truncated) {
          const dumpDirOf = deps.dumpDirOf ?? ((target) => cuNoticeDumpDirOf(target));
          let dir = "";
          try {
            dir = String(dumpDirOf(session) ?? "");
          } catch {
            dir = "";
          }
          const dump = typeof deps.dumpText === "function" ? deps.dumpText : writeCuNoticeDump;
          let fullTextPath = null;
          try {
            fullTextPath = dump({ dir, text: digest.fullText, sessionId, title, turn });
          } catch {
            fullTextPath = null;
          }
          truncation = {
            originalChars: digest.originalChars,
            keptHeadChars: digest.keptHeadChars,
            keptTailChars: digest.keptTailChars,
            omittedChars: digest.omittedChars,
            omittedFromChar: digest.omittedFromChar,
            omittedToChar: digest.omittedToChar,
            fullTextPath: fullTextPath ?? ""
          };
          if (fullTextPath === null || fullTextPath === "") {
            log(`CU \u957F\u62A5\u544A\u843D\u76D8\u5931\u8D25\uFF08${sessionId} turn ${turn}\uFF0C\u76EE\u5F55 ${dir === "" ? "\uFF08\u672A\u914D\u7F6E\uFF09" : dir}\uFF09\uFF1A\u901A\u77E5\u53EA\u5E26\u5934\u5C3E\uFF0C\u8DEF\u5F84\u4E0D\u7F16\u9020`);
          } else {
            log(`CU \u957F\u62A5\u544A\u6574\u6BB5\u843D\u76D8\uFF1A${sessionId} turn ${turn} \u539F\u6587 ${digest.originalChars} \u5B57 \u2192 ${fullTextPath}`);
          }
        }
        const payload = {
          sessionId,
          title,
          summary: digest.text,
          outcome: outcome ?? "completed",
          ...failure !== void 0 ? { failure } : {},
          ...truncation !== void 0 ? { truncation } : {}
        };
        if (outcome === "failed") {
          log(`CU \u5931\u8D25\u8F6E\u6C47\u62A5\uFF1A${sessionId} turn ${turn} ${formatCuFailureLine(failure) || "\uFF08\u5BBF\u4E3B\u6CA1\u5E26\u9519\u8BEF\u539F\u6587\uFF09"}`);
        }
        Promise.resolve(deps.notify(payload)).catch((error) => {
          log(`CU ${outcome === "failed" ? "\u5931\u8D25" : "\u5B8C\u6210"}\u901A\u77E5\u53D1\u9001\u5931\u8D25\uFF08${sessionId} turn ${turn}\uFF09\uFF1A${String(error?.message ?? error)}`);
        });
      } catch (error) {
        log(`CU \u5B8C\u6210/\u5931\u8D25\u76D1\u542C\u5904\u7406\u4E8B\u4EF6\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
      }
    },
    handleSessionDisposed(session) {
      const sessionId = String(session?.id ?? "");
      if (sessionId !== "") texts.delete(sessionId);
    }
  };
}
function postSecretaryNotice(agent, notice) {
  if (agent === null || agent === void 0) return false;
  if (typeof agent.followup !== "function") return false;
  const message = buildNoticeMessage(notice);
  try {
    registerNoticeMessageId(message.id);
    agent.followup(message);
    return true;
  } catch {
    return false;
  }
}
function optionalService4(ctx, id) {
  try {
    return typeof ctx?.get === "function" ? ctx.get(id) : void 0;
  } catch {
    return void 0;
  }
}
function sessionPresetOf(ctx, session) {
  try {
    const projections = optionalService4(ctx, "sessionProjections");
    if (projections && typeof projections.cachedSnapshot === "function") {
      const block = projections.cachedSnapshot(session);
      const value = block?.values?.agentPreset;
      if (typeof value === "string" && value !== "") return value;
    }
  } catch {
  }
  try {
    const cache3 = optionalService4(ctx, "sessionProjectionCache");
    if (cache3 && typeof cache3.cachedSnapshot === "function") {
      const block = cache3.cachedSnapshot(session?.header ?? session);
      const value = block?.values?.agentPreset;
      if (typeof value === "string" && value !== "") return value;
    }
  } catch {
  }
  return presetOfSource("", session?.header?.agentPreset);
}
function sessionTitleOf(ctx, session) {
  try {
    const projections = optionalService4(ctx, "sessionProjections");
    const block = projections?.cachedSnapshot?.(session);
    const value = block?.values?.title;
    if (typeof value === "string" && value !== "") return value;
    if (value !== null && typeof value === "object" && typeof value.title === "string") return value.title;
  } catch {
  }
  const header = String(session?.header?.title ?? "").trim();
  return header !== "" ? header : "\u672A\u547D\u540D\u4EFB\u52A1";
}
function secretaryAgentOf(ctx) {
  const id = secretarySessionRef.id;
  if (id === "") return null;
  try {
    const agents = optionalService4(ctx, "agents");
    const agent = typeof agents?.get === "function" ? agents.get(id) : void 0;
    if (agent !== void 0 && agent !== null && typeof agent.followup === "function") return agent;
  } catch {
  }
  return null;
}
function secretarySessionOf(ctx) {
  const agent = secretaryAgentOf(ctx);
  if (agent?.session !== void 0 && agent.session !== null) return agent.session;
  const id = secretarySessionRef.id;
  if (id === "") return null;
  try {
    const sessions = optionalService4(ctx, "sessions") ?? ctx?.sessions;
    const live = typeof sessions?.get === "function" ? sessions.get(id) : void 0;
    if (live !== void 0 && live !== null) return live;
  } catch {
  }
  return null;
}
function notifySecretary(ctx, notice, log) {
  if (secretarySessionRef.id === "") {
    log("CU \u6C47\u62A5\uFF1A\u79D8\u4E66\u56FA\u5B9A\u4F1A\u8BDD\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u8FD9\u6761\u5148\u4E0D\u53D1");
    return false;
  }
  const agent = secretaryAgentOf(ctx);
  const ok = postSecretaryNotice(agent, notice);
  const head = notice.outcome === "failed" ? "CU \u5931\u8D25\u8F6E\u6C47\u62A5" : "CU \u5B8C\u6210\u6C47\u62A5";
  log(ok ? `${head}\u5DF2\u4EA4\u7ED9\u5BBF\u4E3B prompt \u901A\u9053\uFF08agent.followup\uFF09\uFF1A${notice.sessionId}\u300C${notice.title}\u300D${formatCuFailureLine(notice.failure)}` : `${head}\u6CA1\u53D1\u51FA\u53BB\uFF1A\u79D8\u4E66\u4F1A\u8BDD\u6CA1\u6709\u6D3B\u7684 agent\uFF08\u5BBF\u4E3B\u672A\u63D0\u4F9B agent.followup\uFF09\uFF0C\u5DF2\u8DF3\u8FC7\u800C\u4E0D\u662F\u81EA\u5DF1\u5199\u65E5\u5FD7\uFF08${notice.sessionId}\uFF09`);
  return ok;
}
function sendJson10(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function profileDirOf(ctx) {
  try {
    const profile = optionalService4(ctx, "profileContext");
    if (typeof profile?.dir === "string" && profile.dir) return profile.dir;
  } catch {
  }
  return "";
}
function registerAssistantCuWatch(ctx) {
  const log = (line) => {
    try {
      ctx?.logger?.info?.(`[dsh-assistant] ${line}`);
    } catch {
    }
  };
  const watch = createCuWatch({
    presetOf: (session) => sessionPresetOf(ctx, session),
    titleOf: (session) => sessionTitleOf(ctx, session),
    secretaryId: () => secretarySessionRef.id,
    notify: (payload) => {
      notifySecretary(ctx, payload, log);
    },
    // 长报告整段落盘：落在该 CU 会话的项目目录（.dsh-cu-notices/），不往仓库根写
    dumpDirOf: (session) => cuNoticeDumpDirOf(session, profileDirOf(ctx)),
    log
  });
  const disposers = [];
  try {
    const off = ctx?.on?.("session/event", (session, event) => watch.handleSessionEvent(session, event));
    if (typeof off === "function") disposers.push(off);
  } catch {
  }
  try {
    const off = ctx?.on?.("session/disposed", (session) => watch.handleSessionDisposed(session));
    if (typeof off === "function") disposers.push(off);
  } catch {
  }
  try {
    const server = ctx?.webServer;
    if (server && typeof server.register === "function") {
      const routes = manageWebRoutes(server);
      routes.webServer.register({
        kind: "exact",
        path: CU_NOTIFY_ROUTE,
        handler: async (req, res) => {
          if (String(req.method ?? "GET").toUpperCase() !== "POST") {
            sendJson10(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          let raw = "";
          for await (const chunk of req) {
            raw += String(chunk ?? "");
            if (raw.length > CU_NOTIFY_ROUTE_BODY_MAX_CHARS) {
              sendJson10(res, 413, { ok: false, error: "too-large" });
              return;
            }
          }
          let body = null;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            body = null;
          }
          const sessionId = String(body?.sessionId ?? "").trim();
          const title = String(body?.title ?? "").trim();
          const summary = String(body?.summary ?? "").trim();
          const outcome = String(body?.outcome ?? "") === "failed" || classifyCuTurn(body?.reasonKind) === "failed" ? "failed" : "completed";
          const failure = outcome === "failed" ? {
            kind: String(body?.reasonKind ?? body?.failure?.kind ?? "error"),
            message: String(body?.failure?.message ?? body?.error ?? ""),
            code: String(body?.failure?.code ?? body?.code ?? "")
          } : void 0;
          if (sessionId === "") {
            sendJson10(res, 400, { ok: false, error: "invalid-session-id" });
            return;
          }
          const ok = notifySecretary(ctx, {
            sessionId,
            title,
            summary,
            outcome,
            ...failure !== void 0 ? { failure } : {}
          }, log);
          sendJson10(res, ok ? 200 : 409, { ok, sessionId, outcome });
        }
      });
      disposers.push(() => {
        try {
          routes.dispose();
        } catch {
        }
      });
    }
  } catch {
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
var assistantCuWatchTestSurface = {
  CU_PRESET,
  CU_NOTIFY_ROUTE,
  presetOfSource,
  classifyCuTurn,
  shouldReportTurn,
  failureOfTurnEnd,
  formatCuFailureLine,
  buildCompletionNotice,
  buildNoticeMessage,
  CU_NOTICE_RESULT_MAX_CHARS,
  CU_NOTICE_HEAD_KEEP_CHARS,
  CU_NOTICE_TAIL_KEEP_CHARS,
  CU_NOTICE_DUMP_DIR_NAME,
  CU_NOTIFY_ROUTE_BODY_MAX_CHARS,
  summarizeCompletion,
  digestCuCompletion,
  cuNoticeDumpFileName,
  writeCuNoticeDump,
  cuNoticeDumpDirOf,
  createCuWatch,
  postSecretaryNotice,
  sessionPresetOf,
  secretaryAgentOf,
  secretarySessionOf,
  notifySecretary,
  registerAssistantCuWatch
};

// src/assistant-proactive.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync14, readFileSync as readFileSync14, renameSync as renameSync9, rmSync as rmSync3, writeFileSync as writeFileSync14 } from "node:fs";
import { dirname as dirname14, join as join18 } from "node:path";
import { randomUUID as randomUUID5 } from "node:crypto";
var ASSISTANT_PROACTIVE_ROUTE = "/api/assistant/proactive";
var PROACTIVE_CARD_TOOL = "proactive_card";
var STATE_FILENAME5 = "dsh-assistant-proactive.json";
var MAX_CARDS = 40;
var MAX_BODY_BYTES7 = 64 * 1024;
function demoCard(now = /* @__PURE__ */ new Date()) {
  return {
    id: "demo-wuhan-trip",
    sessionId: "",
    title: "\u4E3B\u52A8\u5173\u5FC3 \xB7 \u660E\u65E5\u6B66\u6C49\u51FA\u5DEE",
    summary: "\u660E\u5929\u53BB\u6B66\u6C49\u5F00\u4F1A\uFF0C\u884C\u7A0B\u3001\u8F66\u6B21\u548C\u5929\u6C14\u90FD\u66FF\u4F60\u6838\u8FC7\u4E86\u3002",
    items: [
      "\u5929\u6C14\uFF1A\u6B66\u6C49\u660E\u65E5 8\u201314\u2103\uFF0C\u591A\u4E91\u8F6C\u5C0F\u96E8\uFF0C\u5E26\u4F1E\u548C\u8584\u5916\u5957",
      "\u8F66\u6B21\uFF1AG1545 \u5B5D\u611F\u4E1C 08:12 \u2192 \u6C49\u53E3 08:49",
      "10:30 \u534E\u5DE5\xB7\u7ED3\u6784\u5B9E\u9A8C\u5BA4\u5F00\u4F1A\uFF08\u6750\u6599\u5DF2\u653E\u8FDB notes/\uFF09",
      "\u5EFA\u8BAE 07:30 \u4ECE\u5BB6\u51FA\u53D1\uFF0C\u7559 40 \u5206\u949F\u8FDB\u7AD9"
    ],
    details: [
      "\u4E00\u3001\u5929\u6C14",
      "\u6B66\u6C49\u5168\u5929 8\u201314\u2103\uFF0C\u591A\u4E91\u8F6C\u5C0F\u96E8\uFF0C\u4E0A\u5348\u6E7F\u5EA6\u9AD8\uFF1B\u4F1A\u573A\u7A7A\u8C03\u504F\u51B7\uFF0C\u5EFA\u8BAE\u7A7F\u5916\u5957\u3002",
      "",
      "\u4E8C\u3001\u884C\u7A0B",
      "\xB7 07:30 \u51FA\u53D1 \u2192 \u5B5D\u611F\u4E1C\u7AD9\uFF08\u9884\u7559 40 \u5206\u949F\u8FDB\u7AD9\uFF09",
      "\xB7 08:12 G1545 \u5B5D\u611F\u4E1C \u2192 08:49 \u6C49\u53E3",
      "\xB7 09:20 \u6C49\u53E3\u7AD9\u6253\u8F66\u53BB\u534E\u5DE5\uFF08\u7EA6 40 \u5206\u949F\uFF0C\u9884\u7559\u5835\u8F66\uFF09",
      "\xB7 10:30 \u7ED3\u6784\u5B9E\u9A8C\u5BA4\u5F00\u4F1A\uFF08\u5E26\u4E0A\u6253\u5370\u7248\u6750\u6599\u4E0E U \u76D8\uFF09",
      "",
      "\u4E09\u3001\u5907\u6CE8",
      "\u56DE\u7A0B\u7968\u8FD8\u6CA1\u8BA2\uFF1B\u4F1A\u8BAE\u82E5\u63D0\u524D\u7ED3\u675F\uFF0C15:00 \u540E\u6709\u4E00\u73ED\u8FD4\u7A0B\u53EF\u9009\u3002"
    ].join("\n"),
    time: "\u4ECA\u5929 07:40",
    badge: "\u4E3B\u52A8\u670D\u52A1",
    createdAt: now.toISOString()
  };
}
function normalizeCard(raw, now = /* @__PURE__ */ new Date()) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const title = String(record.title ?? "").trim();
  if (title === "") return null;
  const items = Array.isArray(record.items) ? record.items.map((entry) => String(entry ?? "").trim()).filter((entry) => entry !== "").slice(0, 12) : [];
  return {
    id: String(record.id ?? "").trim() || `card-${randomUUID5()}`,
    sessionId: String(record.sessionId ?? "").trim(),
    title: title.slice(0, 120),
    summary: String(record.summary ?? "").trim().slice(0, 400),
    items,
    details: String(record.details ?? "").trim().slice(0, 4e3),
    time: String(record.time ?? "").trim().slice(0, 40) || `\u4ECA\u5929 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    badge: String(record.badge ?? "").trim().slice(0, 20) || "\u4E3B\u52A8\u670D\u52A1",
    createdAt: String(record.createdAt ?? "").trim() || now.toISOString(),
    refSessionId: String(record.refSessionId ?? "").trim().slice(0, 80) || void 0,
    refTitle: String(record.refTitle ?? "").trim().slice(0, 120) || void 0
  };
}
function cardsForSession(cards, sessionId, secretaryId) {
  const id = String(sessionId ?? "").trim();
  if (id === "") return [];
  return cards.filter((card) => {
    const bound = card.sessionId;
    if (bound === id) return true;
    if (bound === "") return id === secretaryId;
    return false;
  });
}
function profileDir5(ctx) {
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
function sendJson11(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readJsonBody9(req) {
  return new Promise((resolve) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      const text = String(chunk ?? "");
      size += Buffer.byteLength(text);
      if (size <= MAX_BODY_BYTES7) raw += text;
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES7) {
        resolve({ __tooLarge: true });
        return;
      }
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
function readCardsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync14(file, "utf8"));
    const list = Array.isArray(parsed?.cards) ? parsed.cards : [];
    const out = [];
    for (const row of list) {
      const card = normalizeCard(row);
      if (card !== null) out.push(card);
    }
    return out;
  } catch {
    return [];
  }
}
function writeCardsFile(file, cards) {
  mkdirSync14(dirname14(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync14(tmp, JSON.stringify({ version: 1, cards: cards.slice(-MAX_CARDS) }, null, 2), "utf8");
  renameSync9(tmp, file);
}
function proactiveCardToolDefinition() {
  return {
    name: PROACTIVE_CARD_TOOL,
    description: [
      "\u628A\u4E00\u6761\u4E3B\u52A8\u670D\u52A1\u6D88\u606F\u843D\u6210\u4F1A\u8BDD\u9875\u91CC\u7684\u4E00\u5F20\u5361\u7247\uFF08\u53EA\u5BF9\u4E2A\u4EBA\u79D8\u4E66\u4F1A\u8BDD\u751F\u6548\uFF09\u3002",
      "\u7528\u6237\u5728\u4F1A\u8BDD\u91CC\u770B\u4E0D\u5230\u4F60\u8C03\u7528\u4E86\u5DE5\u5177\uFF0C\u53EA\u770B\u5230\u5361\u7247\uFF1B\u5361\u7247\u53EF\u4EE5\u70B9\u5F00\u770B details\u3002",
      "\u4EC0\u4E48\u65F6\u5019\u7528\uFF1A\u4F60\u60F3\u4E3B\u52A8\u63D0\u9192/\u6C47\u62A5/\u6C47\u62A5\u8FDB\u5EA6\uFF0C\u5E76\u4E14\u5185\u5BB9\u9002\u5408\u300C\u6807\u9898 + \u6458\u8981 + \u8981\u70B9 + \u8BE6\u60C5\u300D\u8FD9\u79CD\u7ED3\u6784\u5316\u5F62\u6001\u65F6\u3002",
      "\u4EC0\u4E48\u65F6\u5019\u522B\u7528\uFF1A\u666E\u901A\u95EE\u7B54\u3001\u4EE3\u7801\u3001\u957F\u6587\u5206\u6790\u2014\u2014\u76F4\u63A5\u5199\u5728\u56DE\u590D\u91CC\u66F4\u5408\u9002\u3002",
      "items \u662F\u8981\u70B9\uFF08\u6BCF\u6761\u4E00\u884C\uFF0C\u6700\u591A 12 \u6761\uFF09\uFF1Bdetails \u662F\u5C55\u5F00\u540E\u7684\u8BE6\u60C5\uFF08\u53EF\u591A\u884C\uFF09\u3002"
    ].join(""),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "\u5361\u7247\u6807\u9898\uFF0C\u4F8B\u5982\u300C\u4E3B\u52A8\u5173\u5FC3 \xB7 \u660E\u65E5\u6B66\u6C49\u51FA\u5DEE\u300D\u3002\u5FC5\u586B\u3002" },
        summary: { type: "string", description: "\u5361\u7247\u6458\u8981\uFF08\u4E00\u4E24\u53E5\uFF09\u3002" },
        items: {
          type: "array",
          items: { type: "string" },
          description: "\u8981\u70B9\u5217\u8868\uFF08\u6BCF\u6761\u4E00\u884C\uFF09\u3002"
        },
        details: { type: "string", description: "\u70B9\u5F00\u300C\u67E5\u770B\u8BE6\u60C5\u300D\u540E\u663E\u793A\u7684\u6B63\u6587\uFF08\u53EF\u591A\u884C\uFF09\u3002" },
        time: { type: "string", description: "\u5361\u7247\u53F3\u4E0B\u89D2\u65F6\u95F4\uFF0C\u4F8B\u5982\u300C\u4ECA\u5929 07:40\u300D\uFF1B\u7701\u7565\u5219\u7528\u5F53\u524D\u65F6\u95F4\u3002" },
        badge: { type: "string", description: "\u5DE6\u4E0A\u89D2\u5C0F\u6807\u7B7E\uFF0C\u9ED8\u8BA4\u300C\u4E3B\u52A8\u670D\u52A1\u300D\u3002" },
        ref_session_id: { type: "string", description: "\u5361\u7247\u5F15\u7528\u7684\u4F1A\u8BDD id\uFF08\u53EF\u9009\uFF09\uFF1A\u6E32\u67D3\u6210\u53EF\u70B9\u5F15\u7528\u5757\uFF0C\u70B9\u51FB\u8DF3\u8FDB\u8BE5\u4F1A\u8BDD\u3002" },
        ref_title: { type: "string", description: "\u5F15\u7528\u4F1A\u8BDD\u7684\u663E\u793A\u6807\u9898\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u7528 ref_session_id\uFF09\u3002" }
      },
      required: ["title"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          card_id: { type: "string" }
        },
        required: ["ok", "card_id"]
      },
      render: (_args, value) => [{
        type: "text",
        text: value?.ok === true ? `\u5DF2\u53D1\u51FA\u4E00\u6761\u4E3B\u52A8\u670D\u52A1\u5361\u7247\uFF08${value?.card_id ?? ""}\uFF09\u3002` : "\u5361\u7247\u6CA1\u6709\u53D1\u51FA\u53BB\u3002"
      }]
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? "");
      if (secretarySessionRef.id === "" || caller !== secretarySessionRef.id) {
        throw new Error(`${PROACTIVE_CARD_TOOL} \u53EA\u80FD\u5728\u4E2A\u4EBA\u79D8\u4E66\u4F1A\u8BDD\u91CC\u8C03\u7528`);
      }
      const card = normalizeCard({
        ...args,
        sessionId: "",
        refSessionId: args?.ref_session_id,
        refTitle: args?.ref_title
      });
      if (card === null) throw new Error("title \u4E0D\u80FD\u4E3A\u7A7A");
      appendCard(card);
      return { ok: true, card_id: card.id };
    }
  };
}
var moduleFile = "";
var moduleCards = [];
function saveModuleCards() {
  if (moduleFile === "") return;
  try {
    writeCardsFile(moduleFile, moduleCards);
  } catch (error) {
    try {
      console.warn("[dsh-assistant] \u4E3B\u52A8\u5361\u7247\u5199\u5165\u5931\u8D25\uFF1A", String(error?.message ?? error));
    } catch {
    }
  }
}
function appendCard(card) {
  moduleCards = [...moduleCards.filter((row) => row.id !== card.id), card].slice(-MAX_CARDS);
  saveModuleCards();
}
function cardsSnapshot() {
  return moduleCards;
}
function registerAssistantProactive(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const file = join18(profileDir5(ctx), STATE_FILENAME5);
  moduleFile = file;
  moduleCards = readCardsFile(file);
  const seededFile = `${file}.seeded`;
  try {
    if (!existsSync11(seededFile)) {
      if (!moduleCards.some((card) => card.id === "demo-wuhan-trip")) appendCard(demoCard());
      writeFileSync14(seededFile, (/* @__PURE__ */ new Date()).toISOString(), "utf8");
    }
  } catch {
  }
  const disposers = [];
  try {
    const off = webServer.register({
      kind: "exact",
      path: ASSISTANT_PROACTIVE_ROUTE,
      handler: async (req, res) => {
        const method = String(req.method ?? "GET").toUpperCase();
        try {
          if (method === "GET" || method === "HEAD") {
            const url = new URL(String(req.url ?? ""), "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") ?? "");
            const visible = cardsForSession(moduleCards, sessionId, secretarySessionRef.id);
            sendJson11(res, 200, { ok: true, cards: visible, secretarySessionId: secretarySessionRef.id });
            return;
          }
          if (method === "POST" || method === "PUT") {
            const body = await readJsonBody9(req);
            if (body?.__tooLarge === true) {
              sendJson11(res, 413, { ok: false, error: "too-large" });
              return;
            }
            const card = normalizeCard(body);
            if (card === null) {
              sendJson11(res, 400, { ok: false, error: "invalid-card" });
              return;
            }
            appendCard(card);
            sendJson11(res, 200, { ok: true, card });
            return;
          }
          if (method === "DELETE") {
            moduleCards = [];
            saveModuleCards();
            sendJson11(res, 200, { ok: true, cards: [] });
            return;
          }
          res.writeHead(405, { allow: "GET, HEAD, POST, PUT, DELETE" });
          res.end();
        } catch (error) {
          sendJson11(res, 500, { ok: false, error: "internal", message: String(error?.message ?? error) });
        }
      }
    });
    if (typeof off === "function") disposers.push(off);
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] \u4E3B\u52A8\u5361\u7247\u8DEF\u7531\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
  }
  try {
    if (ctx?.tools && typeof ctx.tools.register === "function") {
      const off = ctx.tools.register(proactiveCardToolDefinition());
      if (typeof off === "function") disposers.push(off);
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] proactive_card \u5DE5\u5177\u6CE8\u518C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
      }
    }
    try {
      routes.dispose();
    } catch {
    }
  };
}
var assistantProactiveTestSurface = {
  ASSISTANT_PROACTIVE_ROUTE,
  PROACTIVE_CARD_TOOL,
  normalizeCard,
  cardsForSession,
  readCardsFile,
  demoCard,
  appendCard,
  cardsSnapshot,
  proactiveCardToolDefinition,
  registerAssistantProactive,
  rmSync: rmSync3
};

// src/assistant-tts.ts
import { spawn as spawn3, spawnSync } from "node:child_process";
import { existsSync as existsSync12 } from "node:fs";
import { join as join19 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var ASSISTANT_TTS_VOICE_DEFAULT = "zh-CN-XiaoxiaoNeural";
var ASSISTANT_TTS_ROUTE = "/api/assistant/tts";
var ASSISTANT_TTS_STATUS_ROUTE = "/api/assistant/tts/status";
var SYNTH_TIMEOUT_MS = 3e4;
var MAX_TEXT = 2e3;
function edgePythonCandidates() {
  const env = globalThis.process?.env ?? {};
  const explicit = [env.ASSISTANT_TTS_EDGE_PY, env.ASSISTANT_TTS_EDGE_PYTHON].filter((v) => typeof v === "string" && v !== "");
  const system = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  return [...explicit, ...system];
}
function assistantTtsVoice() {
  const env = String(globalThis.process?.env?.ASSISTANT_TTS_EDGE_VOICE ?? "").trim();
  if (env !== "") return { voice: env, source: "env" };
  return { voice: ASSISTANT_TTS_VOICE_DEFAULT, source: "default" };
}
function edgeTtsScriptPath() {
  try {
    const here = fileURLToPath3(new URL(".", import.meta.url));
    return join19(here, "..", "scripts", "edge-tts.py");
  } catch {
    return join19(process.cwd(), "scripts", "edge-tts.py");
  }
}
function edgeTtsWorkerScriptPath() {
  try {
    const here = fileURLToPath3(new URL(".", import.meta.url));
    return join19(here, "..", "scripts", "edge-tts-worker.py");
  } catch {
    return join19(process.cwd(), "scripts", "edge-tts-worker.py");
  }
}
function probeEdgeRuntime() {
  const script = edgeTtsScriptPath();
  for (const python of edgePythonCandidates()) {
    try {
      const check = spawnSync(python, ["-c", "import edge_tts,sys;print(edge_tts.__version__)"], {
        timeout: 4e3,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false
      });
      if (check.status === 0) {
        const version = String(check.stdout ?? "").trim().split("\n").pop() ?? "";
        return { ok: existsSync12(script), python, script, version };
      }
    } catch {
    }
  }
  return { ok: false, python: "", script, error: "\u627E\u4E0D\u5230\u88C5\u4E86 edge_tts \u7684 python\uFF08\u5019\u9009\uFF1A" + edgePythonCandidates().join(", ") + "\uFF09" };
}
var probeCache = null;
function probeEdgeRuntimeCached(ttlMs = 6e4, now = Date.now()) {
  if (probeCache === null || now - probeCache.at > ttlMs) probeCache = { at: now, value: probeEdgeRuntime() };
  return probeCache.value;
}
function resetProbeCacheForTests() {
  probeCache = null;
}
function sendJson12(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}
function readJsonBody10(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      if (raw.length < 8 * 1024) raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
function ttsRuntimeInfo() {
  const probe = probeEdgeRuntime();
  const voice = assistantTtsVoice();
  return {
    python: probe.python,
    script: probe.script,
    voice: voice.voice,
    source: voice.source,
    endpoint: "edge-tts \u2192 wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud"
  };
}
var EdgeTtsWorkerConn = class {
  constructor(opts) {
    this.opts = opts;
    this.onExitKill = () => {
      try {
        this.dispose(new Error("host exit"));
      } catch {
      }
    };
    try {
      process.once("exit", this.onExitKill);
    } catch {
    }
  }
  child = null;
  buf = Buffer.alloc(0);
  expecting = null;
  queue = [];
  active = null;
  timedOut = /* @__PURE__ */ new Set();
  nextId = 1;
  dead = false;
  stderrTail = "";
  onExitKill;
  isDead() {
    return this.dead;
  }
  ensureChild() {
    if (this.child !== null || this.dead) return;
    const child = this.opts.spawnImpl(this.opts.python, ["-u", this.opts.script], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      try {
        this.onData(chunk);
      } catch {
      }
    });
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-400);
    });
    const die = (reason) => {
      if (this.dead) return;
      this.dead = true;
      this.failAll(new Error(reason));
    };
    child.on("error", (error) => {
      die(`edge-tts worker spawn \u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    });
    child.on("close", (code) => {
      die(`edge-tts worker \u9000\u51FA\uFF08code=${code ?? "?"}\uFF09${this.stderrTail ? "\uFF1A" + this.stderrTail.split("\n").filter(Boolean).slice(-2).join(" ") : ""}`);
    });
  }
  synth(text, voice, timeoutMs) {
    if (this.dead) return Promise.reject(new Error("edge-tts worker \u5DF2\u9000\u51FA"));
    this.ensureChild();
    const req = {
      id: this.nextId++,
      text,
      voice,
      rate: this.opts.rate,
      // python 侧 wait_for 兜底比宿主超时略短，宿主 timer 只是 backstop
      timeout: Math.max(1, Math.round((timeoutMs - 2e3) / 1e3)),
      proxy: this.opts.proxy
    };
    return new Promise((resolve, reject) => {
      const item = { req, resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        item.timer = null;
        this.timedOut.add(req.id);
        if (this.active === item) {
          this.active = null;
        } else this.queue = this.queue.filter((q) => q !== item);
        reject(new Error("edge-tts worker \u54CD\u5E94\u8D85\u65F6"));
        this.pump();
      }, timeoutMs + 3e3);
      this.queue.push(item);
      this.pump();
    });
  }
  pump() {
    if (this.active !== null || this.dead || this.child === null) return;
    const item = this.queue.shift();
    if (item === void 0) return;
    this.active = item;
    try {
      this.child.stdin?.write(JSON.stringify(item.req) + "\n");
    } catch (error) {
      this.active = null;
      this.finish(item, void 0, error instanceof Error ? error : new Error(String(error)));
      this.pump();
    }
  }
  finish(item, buf, error) {
    if (item.timer !== null) {
      clearTimeout(item.timer);
      item.timer = null;
    }
    if (this.active === item) this.active = null;
    if (error !== void 0) item.reject(error);
    else if (buf !== void 0) item.resolve(buf);
    else item.reject(new Error("edge-tts \u7A7A\u8F93\u51FA"));
    this.pump();
  }
  onData(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (; ; ) {
      if (this.expecting === null) {
        const nl = this.buf.indexOf(10);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        if (msg === null || typeof msg !== "object") {
          this.dispose(new Error("edge-tts worker \u534F\u8BAE\u9519\u8BEF\uFF08\u975E JSON \u5E27\uFF09"));
          return;
        }
        if (msg.ok === true) this.expecting = { id: Number(msg.id), bytes: Math.max(0, Number(msg.bytes) || 0) };
        else {
          const error = new Error(String(msg.error ?? "edge-tts \u5408\u6210\u5931\u8D25"));
          const item = this.take(Number(msg.id));
          if (item !== null) this.finish(item, void 0, error);
        }
      } else {
        if (this.buf.length < this.expecting.bytes) return;
        const payload = this.buf.subarray(0, this.expecting.bytes);
        this.buf = this.buf.subarray(this.expecting.bytes);
        const frame = this.expecting;
        this.expecting = null;
        if (this.timedOut.has(frame.id)) {
          this.timedOut.delete(frame.id);
          continue;
        }
        const item = this.take(frame.id);
        if (item !== null) this.finish(item, Buffer.from(payload), void 0);
      }
    }
  }
  take(id) {
    if (this.active !== null && this.active.req.id === id) return this.active;
    const idx = this.queue.findIndex((q) => q.req.id === id);
    if (idx >= 0) return this.queue.splice(idx, 1)[0];
    return null;
  }
  failAll(error) {
    const items = [...this.queue];
    this.queue = [];
    if (this.active !== null) {
      items.push(this.active);
      this.active = null;
    }
    for (const item of items) {
      if (item.timer !== null) clearTimeout(item.timer);
      try {
        item.reject(error);
      } catch {
      }
    }
  }
  dispose(reason) {
    this.dead = true;
    try {
      process.removeListener("exit", this.onExitKill);
    } catch {
    }
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.kill();
      } catch {
      }
      try {
        child.stdin?.end();
      } catch {
      }
    }
    this.failAll(reason ?? new Error("edge-tts worker \u5DF2\u91CA\u653E"));
  }
};
var EdgeTtsWorkerPool = class {
  constructor(opts) {
    this.opts = opts;
    this.size = Math.max(1, opts.size ?? 2);
  }
  conns = [];
  rr = 0;
  size;
  synth(text, voice, timeoutMs) {
    return this.pick().synth(text, voice, timeoutMs);
  }
  pick() {
    this.conns = this.conns.filter((c) => !c.isDead());
    while (this.conns.length < this.size) {
      this.conns.push(new EdgeTtsWorkerConn({
        python: this.opts.python,
        script: edgeTtsWorkerScriptPath(),
        rate: this.opts.rate,
        proxy: this.opts.proxy,
        spawnImpl: this.opts.spawnImpl ?? ((cmd, args, o) => spawn3(cmd, args, o)),
        logger: this.opts.logger
      }));
    }
    this.rr = (this.rr + 1) % this.conns.length;
    return this.conns[this.rr];
  }
  dispose() {
    for (const conn of this.conns.splice(0)) {
      try {
        conn.dispose();
      } catch {
      }
    }
  }
};
function synthOneShot(probe, text, voice, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn3(probe.python, ["-u", probe.script, "--text", text, "--voice", voice], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let errored = "";
    const chunks = [];
    child.stderr?.on("data", (chunk) => {
      errored += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      reject(new Error("edge-tts \u5408\u6210\u8D85\u65F6"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) resolve(buf);
      else reject(new Error(`edge-tts \u5408\u6210\u5931\u8D25\uFF08exit=${code ?? "?"}\uFF09${errored ? "\uFF1A" + errored.slice(0, 200) : ""}`));
    });
  });
}
function registerAssistantTts(ctx) {
  const server = ctx?.webServer;
  if (!server || typeof server.register !== "function") return () => void 0;
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  const disposers = [];
  let pool = null;
  const poolFor = (python) => {
    if (pool === null || pool.__python !== python) {
      try {
        pool?.dispose();
      } catch {
      }
      pool = new EdgeTtsWorkerPool({
        python,
        rate: process.env.ASSISTANT_TTS_EDGE_RATE || "+45%",
        proxy: process.env.ASSISTANT_TTS_EDGE_PROXY || null,
        size: 2,
        logger: ctx?.logger
      });
      pool.__python = python;
    }
    return pool;
  };
  try {
    const off = webServer.register({
      kind: "exact",
      path: ASSISTANT_TTS_STATUS_ROUTE,
      handler: (_req, res) => {
        const info = ttsRuntimeInfo();
        sendJson12(res, info.python ? 200 : 503, {
          ok: Boolean(info.python),
          engine: "edge-tts\uFF08\u5FAE\u8F6F\uFF0C\u65E0\u8BA2\u9605 key\uFF09",
          worker: existsSync12(edgeTtsWorkerScriptPath()),
          ...info
        });
      }
    });
    if (typeof off === "function") disposers.push(off);
  } catch (err) {
    ctx?.logger?.warn?.(`[dsh-assistant] TTS \u72B6\u6001\u8DEF\u7531\u6CE8\u518C\u5931\u8D25\uFF1A${String(err?.message ?? err)}`);
  }
  try {
    const off = webServer.register({
      kind: "exact",
      path: ASSISTANT_TTS_ROUTE,
      handler: async (req, res) => {
        const method = String(req.method ?? "GET").toUpperCase();
        if (method !== "POST") {
          sendJson12(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const body = await readJsonBody10(req);
        const text = String(body?.text ?? "").trim();
        if (text === "") {
          sendJson12(res, 400, { ok: false, error: "text \u4E0D\u80FD\u4E3A\u7A7A" });
          return;
        }
        if (text.length > MAX_TEXT) {
          sendJson12(res, 400, { ok: false, error: `text \u8D85\u8FC7 ${MAX_TEXT} \u5B57` });
          return;
        }
        const probe = probeEdgeRuntimeCached();
        if (!probe.ok || probe.python === "") {
          sendJson12(res, 503, {
            ok: false,
            engine: "edge-tts\uFF08\u5FAE\u8F6F\uFF09",
            missing: [probe.error ?? "python \u4E0D\u53EF\u7528", existsSync12(probe.script) ? "" : "scripts/edge-tts.py \u4E0D\u5B58\u5728"].filter(Boolean),
            hint: 'pip install "edge-tts>=7.3.1" \u5230\u4EFB\u4E00\u5019\u9009 python\uFF08\u9ED8\u8BA4\u7CFB\u7EDF python\uFF09'
          });
          return;
        }
        const voice = String(body?.voice ?? "").trim() || assistantTtsVoice().voice;
        let mp3 = null;
        let lastError = null;
        try {
          mp3 = await poolFor(probe.python).synth(text, voice, SYNTH_TIMEOUT_MS);
        } catch (error) {
          lastError = error;
          try {
            ctx?.logger?.warn?.(`[dsh-assistant] edge-tts worker \u5931\u8D25\uFF0C\u56DE\u9000\u4E00\u6B21\u6027\u5408\u6210\uFF1A${String(error?.message ?? error)}`);
          } catch {
          }
        }
        if (mp3 === null) {
          try {
            mp3 = await synthOneShot(probe, text, voice, SYNTH_TIMEOUT_MS);
          } catch (error) {
            lastError = error;
          }
        }
        if (mp3 === null || mp3.length === 0) {
          sendJson12(res, 502, { ok: false, engine: "edge-tts\uFF08\u5FAE\u8F6F\uFF09", error: String(lastError?.message ?? lastError ?? "edge-tts \u5408\u6210\u5931\u8D25") });
          return;
        }
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
          "x-tts-engine": "edge-tts",
          "x-tts-voice": voice
        });
        try {
          res.write(mp3);
          res.end();
        } catch {
        }
      }
    });
    if (typeof off === "function") disposers.push(off);
  } catch (err) {
    ctx?.logger?.warn?.(`[dsh-assistant] TTS \u8DEF\u7531\u6CE8\u518C\u5931\u8D25\uFF1A${String(err?.message ?? err)}`);
  }
  disposers.push(() => {
    try {
      pool?.dispose();
    } catch {
    }
  });
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
      }
    }
    try {
      routes.dispose();
    } catch {
    }
  };
}
var assistantTtsTestSurface = {
  ASSISTANT_TTS_ROUTE,
  ASSISTANT_TTS_STATUS_ROUTE,
  edgePythonCandidates,
  edgeTtsScriptPath,
  edgeTtsWorkerScriptPath,
  probeEdgeRuntime,
  probeEdgeRuntimeCached,
  resetProbeCacheForTests,
  ttsRuntimeInfo,
  registerAssistantTts,
  EdgeTtsWorkerConn,
  EdgeTtsWorkerPool
};

// src/assistant.ts
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync16, readFileSync as readFileSync16, rmSync as rmSync5, statSync as statSync9, writeFileSync as writeFileSync16 } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { join as joinPathNode } from "node:path";

// src/session-log-guard.ts
import { copyFileSync as copyFileSync4, existsSync as existsSync13, mkdirSync as mkdirSync15, readFileSync as readFileSync15, renameSync as renameSync10, rmSync as rmSync4, writeFileSync as writeFileSync15 } from "node:fs";
import { createRequire as createRequire4 } from "node:module";
import { dirname as dirname15, join as join20, basename as basename3, resolve as resolvePath5 } from "node:path";
import zlib2 from "node:zlib";
var ZSTD_MAGIC2 = Buffer.from([40, 181, 47, 253]);
function decompressLogBytes(data) {
  const zlib22 = zlib2;
  if (typeof zlib22.zstdDecompressSync !== "function") throw new Error("zstdDecompressSync not available");
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const first = buffer.indexOf(ZSTD_MAGIC2);
  if (first === -1) {
    if (buffer.length === 0) return "";
    return Buffer.from(zlib22.zstdDecompressSync(buffer)).toString("utf8");
  }
  const chunks = [];
  for (let cursor = first; cursor < buffer.length; ) {
    const next = buffer.indexOf(ZSTD_MAGIC2, cursor + ZSTD_MAGIC2.length);
    const end = next === -1 ? buffer.length : next;
    chunks.push(Buffer.from(zlib22.zstdDecompressSync(buffer.subarray(cursor, end))).toString("utf8"));
    cursor = end;
  }
  return chunks.join("");
}
function compressLogText(text) {
  const zlib22 = zlib2;
  if (typeof zlib22.zstdCompressSync !== "function") throw new Error("zstdCompressSync not available");
  const checksumFlag = zlib22.constants?.ZSTD_c_checksumFlag;
  if (typeof checksumFlag !== "number") {
    throw new Error("zlib.constants.ZSTD_c_checksumFlag \u4E0D\u53EF\u7528\uFF1A\u8FD9\u4E2A Node \u7ED9\u4E0D\u51FA zstd \u6821\u9A8C\u548C\u53C2\u6570\uFF0C\u4E0D\u80FD\u6309\u5BBF\u4E3B\u7684\u5E27\u683C\u5F0F\u5199\uFF0C\u62D2\u7EDD\u6539\u5199");
  }
  return Buffer.from(zlib22.zstdCompressSync(Buffer.from(String(text ?? ""), "utf8"), { params: { [checksumFlag]: 1 } }));
}
function scanHostZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  const magic = buffer.length >= 4 ? ZSTD_MAGIC2.readUInt32LE(0) : 0;
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== magic) throw new Error(`zstd \u4EA7\u7269\u5728 byte ${offset} \u5904\u5E27\u9B54\u6570\u4E0D\u5BF9`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`zstd \u4EA7\u7269\u5728 byte ${offset - 1} \u5904\u4FDD\u7559\u4F4D\u88AB\u7F6E\u4E0A\u4E86`);
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const contentSizeFlag = descriptor >>> 6;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`zstd \u4EA7\u7269\u5728 byte ${offset - 3} \u5904\u6709\u4FDD\u7559\u5757\u7C7B\u578B`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames, tornStart: null };
  }
  return { frames, tornStart: null };
}
function assertHostReadableArtifact(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { frames, tornStart } = scanHostZstdFrames(buffer);
  if (tornStart !== null) throw new Error(`zstd \u4EA7\u7269\u5728 byte ${tornStart} \u5904\u6709\u6CA1\u5199\u5B8C\u7684\u5E27`);
  if (frames.length === 0) throw new Error("zstd \u4EA7\u7269\u91CC\u6CA1\u6709\u5B8C\u6574\u5E27");
  const zlib22 = zlib2;
  for (const frame of frames) {
    const descriptor = buffer.readUInt8(frame.start + 4);
    if ((descriptor & 4) === 0) {
      throw new Error(`zstd \u5E27\uFF08byte ${frame.start}\uFF09\u6CA1\u6709\u6821\u9A8C\u548C\uFF1A\u5BBF\u4E3B\u6301\u4E45\u5316\u5C42\u6309 CHECKSUM_OPTIONS \u5199\u65E5\u5FD7\uFF0C\u63D2\u4EF6\u5FC5\u987B\u5199\u540C\u6B3E\u5E27\uFF0C\u5426\u5219\u91CD\u542F\u540E\u8FD9\u6761\u4F1A\u8BDD\u8BFB\u4E0D\u56DE\u6765`);
    }
    try {
      Buffer.from(zlib22.zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    } catch (error) {
      throw new Error(`zstd \u5E27\uFF08byte ${frame.start}\uFF09\u89E3\u538B\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
    }
  }
  return { frames: frames.length, bytes: buffer.length };
}
function parseLogText(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("\u65E5\u5FD7\u662F\u7A7A\u7684");
  let rawHeader;
  try {
    rawHeader = JSON.parse(lines[0]);
  } catch {
    throw new Error("\u9996\u884C\u4E0D\u662F JSON\uFF08\u4E0D\u662F v4 \u65E5\u5FD7\uFF09");
  }
  if (rawHeader === null || typeof rawHeader !== "object" || rawHeader.type !== "session" || rawHeader.version !== 4) {
    throw new Error("\u9996\u884C\u4E0D\u662F v4 session \u5934");
  }
  const { type: _type, ...header } = rawHeader;
  const events = [];
  for (let index = 1; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      throw new Error(`\u7B2C ${index} \u884C\u4E0D\u662F JSON`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error(`\u7B2C ${index} \u884C\u4E0D\u662F\u4E8B\u4EF6\u5BF9\u8C61`);
    if (event.seq !== index - 1) throw new Error(`\u7B2C ${index} \u884C seq \u4E0D\u662F\u5BC6\u7684\uFF08seq=${String(event.seq)}\uFF0C\u671F\u671B ${index - 1}\uFF09`);
    events.push(event);
  }
  return { header, inheritedEventCount: 0, events };
}
function defaultHostParserPaths() {
  const out = [];
  const explicit = String(process.env.DSH_HOST_PARSER ?? "").trim();
  if (explicit !== "") out.push(explicit);
  out.push("D:\\deepseek-harness\\packages\\session\\session-format-v3-to-v4\\lib\\index.js");
  out.push("D:\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-session-format-v3-to-v4\\lib\\index.js");
  return out;
}
function vocabularyCandidates(parserPath) {
  const out = [];
  const explicit = String(process.env.DSH_HOST_SESSION_MODULE ?? "").trim();
  if (explicit !== "") out.push(explicit);
  const normalized = resolvePath5(parserPath);
  out.push(join20(dirname15(dirname15(dirname15(normalized))), "core", "session", "lib", "index.js"));
  out.push("D:\\deepseek-harness\\packages\\core\\session\\lib\\index.js");
  out.push("D:\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-session\\lib\\index.js");
  return out;
}
function requireModule(path) {
  const loader = createRequire4(import.meta.url);
  return loader(path);
}
function loadHostLogParser(explicitPath = "") {
  const requested = String(explicitPath ?? "").trim();
  const candidates = requested !== "" ? [requested] : defaultHostParserPaths();
  const problems = [];
  let parserModule;
  let parserPath = "";
  for (const candidate of candidates) {
    try {
      if (!existsSync13(candidate)) {
        problems.push(`${candidate}\uFF08\u4E0D\u5B58\u5728\uFF09`);
        continue;
      }
      const module = requireModule(candidate);
      if (typeof module?.restoreReleasedV4Artifact !== "function") {
        problems.push(`${candidate}\uFF08\u6CA1\u6709 restoreReleasedV4Artifact\uFF09`);
        continue;
      }
      parserModule = module;
      parserPath = candidate;
      break;
    } catch (error) {
      problems.push(`${candidate}\uFF08${String(error?.message ?? error)}\uFF09`);
    }
  }
  if (parserModule === void 0) {
    throw new Error(`\u5BBF\u4E3B\u771F\u5B9E\u89E3\u6790\u5668\u4E0D\u53EF\u7528\uFF0C\u5DF2\u62D2\u7EDD\u5199\u5165\u4F1A\u8BDD\u65E5\u5FD7\uFF1A${problems.join("\uFF1B") || "\u6CA1\u6709\u4EFB\u4F55\u5019\u9009\u8DEF\u5F84"}`);
  }
  let known;
  let vocabPath = "";
  for (const candidate of vocabularyCandidates(parserPath)) {
    try {
      if (!existsSync13(candidate)) continue;
      const module = requireModule(candidate);
      if (module?.KNOWN_SESSION_EVENT_TYPES instanceof Set) {
        known = module.KNOWN_SESSION_EVENT_TYPES;
        vocabPath = candidate;
        break;
      }
    } catch {
    }
  }
  if (known === void 0) {
    throw new Error(`\u62FF\u5230\u5BBF\u4E3B\u89E3\u6790\u5668\u4F46\u8BFB\u4E0D\u5230 KNOWN_SESSION_EVENT_TYPES\uFF08${parserPath}\uFF09\uFF0C\u5DF2\u62D2\u7EDD\u5199\u5165\u4F1A\u8BDD\u65E5\u5FD7`);
  }
  const vocabulary = known;
  return {
    source: parserPath,
    vocabulary: vocabPath,
    assertAccepted(text) {
      const artifact = parseLogText(text);
      parserModule.restoreReleasedV4Artifact(artifact, vocabulary);
    }
  };
}
function stamp() {
  const now = /* @__PURE__ */ new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
function defaultSessionLogBackupPath(file) {
  const sessionDir = basename3(dirname15(String(file ?? "")));
  const env = globalThis.process?.env ?? {};
  const home = String(env.DSH_ASSISTANT_BACKUP_HOME ?? (env.USERPROFILE ?? env.HOME ?? "")).trim();
  const root = home !== "" ? join20(home, ".dsh", "sessions-backup") : join20(dirname15(String(file ?? "")), "sessions-backup");
  return join20(root, `${sessionDir === "" ? "session" : sessionDir}-backup-${stamp()}`);
}
function rewriteSessionLogFileSync(options) {
  const file = String(options.file ?? "");
  if (file === "") throw new Error("rewriteSessionLogFileSync: \u7F3A\u5C11 file");
  if (typeof options.transform !== "function") throw new Error("rewriteSessionLogFileSync: \u7F3A\u5C11 transform");
  if (options.parser === null || typeof options.parser?.assertAccepted !== "function") {
    throw new Error("rewriteSessionLogFileSync: \u7F3A\u5C11\u5BBF\u4E3B\u89E3\u6790\u5668\uFF08\u5FC5\u987B fail closed\uFF09");
  }
  const parser = options.parser;
  const dryRun = options.dryRun === true;
  const original = readFileSync15(file);
  const beforeText = decompressLogBytes(original);
  const beforeEvents = parseLogText(beforeText).events.length;
  const candidate = String(options.transform(beforeText));
  parser.assertAccepted(candidate);
  const afterEvents = parseLogText(candidate).events.length;
  const backupPath2 = String(options.backupPath ?? "").trim() || defaultSessionLogBackupPath(file);
  const report = {
    ok: true,
    dryRun,
    file,
    backupPath: dryRun ? "" : backupPath2,
    beforeEvents,
    afterEvents,
    beforeBytes: original.length,
    afterBytes: 0,
    restored: false
  };
  if (dryRun) {
    report.afterBytes = original.length;
    return report;
  }
  const compressed = compressLogText(candidate);
  if (decompressLogBytes(compressed) !== candidate) {
    throw new Error("\u538B\u7F29\u56DE\u73AF\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u653E\u5F03\u5199\u5165\uFF08\u539F\u6587\u4EF6\u672A\u6539\u52A8\uFF09");
  }
  assertHostReadableArtifact(compressed);
  mkdirSync15(dirname15(file), { recursive: true });
  mkdirSync15(dirname15(backupPath2), { recursive: true });
  copyFileSync4(file, backupPath2);
  if (!readFileSync15(backupPath2).equals(original)) {
    throw new Error(`\u5907\u4EFD\u6821\u9A8C\u5931\u8D25\uFF08${backupPath2}\uFF09\uFF0C\u5DF2\u653E\u5F03\u5199\u5165`);
  }
  const restore = () => {
    try {
      copyFileSync4(backupPath2, file);
      const restored = readFileSync15(file);
      if (!restored.equals(original)) return false;
      report.restored = true;
      return true;
    } catch {
      return false;
    }
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync15(tmp, compressed);
    renameSync10(tmp, file);
  } catch (error) {
    rmSync4(tmp, { force: true });
    const restored = restore();
    throw new Error(`\u5199\u5165\u5931\u8D25\uFF08${String(error?.message ?? error)}\uFF09\uFF1B\u56DE\u6EDA${restored ? "\u6210\u529F" : "\u5931\u8D25\uFF0C\u8BF7\u624B\u5DE5\u7528\u5907\u4EFD\u8FD8\u539F"}`);
  }
  report.afterBytes = readFileSync15(file).length;
  try {
    parser.assertAccepted(decompressLogBytes(readFileSync15(file)));
  } catch (error) {
    rmSync4(tmp, { force: true });
    const restored = restore();
    throw new Error(`\u5199\u5165\u540E\u56DE\u8BFB\u6821\u9A8C\u5931\u8D25\uFF08${String(error?.message ?? error)}\uFF09\uFF1B\u56DE\u6EDA${restored ? "\u6210\u529F" : "\u5931\u8D25\uFF0C\u8BF7\u624B\u5DE5\u7528\u5907\u4EFD\u8FD8\u539F"}`);
  }
  return report;
}
function assertSessionLogFileAccepted(file, parser) {
  const bytes = readFileSync15(file);
  const text = decompressLogBytes(bytes);
  parser.assertAccepted(text);
  return { events: parseLogText(text).events.length, bytes: bytes.length };
}

// src/client/pocket/orb/secretary-cards.ts
var UNIT_READINGS = [
  [/℃/g, "\u6444\u6C0F\u5EA6"],
  [/°C/gi, "\u6444\u6C0F\u5EA6"],
  [/°F/gi, "\u534E\u6C0F\u5EA6"],
  [/(\d)km\/h/gi, "$1 \u516C\u91CC\u6BCF\u5C0F\u65F6"],
  [/(\d)km\b/gi, "$1 \u516C\u91CC"],
  [/(\d)mm\b/g, "$1 \u6BEB\u7C73"],
  [/(\d)cm\b/g, "$1 \u5398\u7C73"],
  [/(\d)m\b/g, "$1 \u7C73"],
  [/(\d)kg\b/gi, "$1 \u516C\u65A4"],
  [/(\d)g\b/g, "$1 \u514B"],
  [/(\d)ml\b/gi, "$1 \u6BEB\u5347"],
  [/(\d)l\b/gi, "$1 \u5347"]
];
function expandRanges(text) {
  return text.replace(/(\d)\s*[–—-]\s*(\d)/g, "$1 \u5230 $2");
}
function stripSessionRefs(text) {
  return String(text ?? "").replace(/\[\[session:[^\]|]*\|[^\]]*\]\]/g, "");
}
function normalizeForSpeech(raw) {
  let text = stripSessionRefs(stripAttachRefs(String(raw ?? "")));
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/^#{1,6}\s*/gm, "");
  text = text.replace(/(\*\*|__)([^*_]*)\1/g, "$2");
  text = text.replace(/(\*|\b_)([^*_]+)\1/g, "$2");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^-{3,}\s*$/gm, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^\s*(?:[-*+]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+/gm, "");
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/\S+@\S+\.\S+/g, " ");
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ");
  for (const [pattern, reading] of UNIT_READINGS) text = text.replace(pattern, reading);
  text = expandRanges(text);
  text = text.replace(/(\d)([\u4e00-\u9fff])/g, "$1 $2");
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, " ").replace(/\n/g, "\uFF0C").trim();
}
var SPEECH_CHUNK_MIN_CHARS = 40;
var SPEECH_CHUNK_MAX_CHARS = 200;
var SPEECH_CHUNK_FIRST_MAX_CHARS = 80;
var CHUNK_HARD_STOPS = /* @__PURE__ */ new Set(["\u3002", "\uFF01", "\uFF1F", "\uFF1B", "!", "?", ";", "\n"]);
var CHUNK_SECONDARY_STOPS = /* @__PURE__ */ new Set(["\uFF0C", ",", "\u3001", "\uFF1A", ":", " "]);
var CHUNK_PAIRS = {
  "\u201C": "\u201D",
  "\u2018": "\u2019",
  "\u300C": "\u300D",
  "\u300E": "\u300F",
  "\uFF08": "\uFF09",
  "\u300A": "\u300B",
  "\u3008": "\u3009",
  "\u3010": "\u3011",
  "\u3014": "\u3015",
  "\u3016": "\u3017",
  "(": ")",
  "[": "]",
  "{": "}"
};
var CHUNK_CLOSERS = new Set(Object.values(CHUNK_PAIRS));
var CHUNK_TOKEN_RES = [
  /`[^`\n]*`/g,
  // 行内代码
  /https?:\/\/[^\s，。！？；）】」』]+/gi,
  // URL（吃到句读/闭括号前）
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.\.?[\\/])[\w.\\/\\-]*/g,
  // 文件路径（Windows / ~ / 相对）
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,
  // 2026-11-22
  /\d{1,2}:\d{2}(?::\d{2})?/g,
  // 10:30 / 10:30:00
  /\d+(?:[.,]\d+)*(?:\s*(?:%|‰|℃|°[CFcf]|[a-zA-Zμ°²³]{1,6}))?/g
  // 数字/小数/千分位 + 单位百分号
];
function chunkProtectedSpans(text) {
  const spans = [];
  for (const re of CHUNK_TOKEN_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] !== "") spans.push({ start: m.index, end: m.index + m[0].length, inclusiveEnd: false });
      if (m[0] === "") re.lastIndex += 1;
    }
  }
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (CHUNK_PAIRS[ch] !== void 0) {
      stack.push([ch, i]);
      continue;
    }
    if (CHUNK_CLOSERS.has(ch)) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (CHUNK_PAIRS[stack[j][0]] === ch) {
          spans.push({ start: stack[j][1], end: i, inclusiveEnd: true });
          stack.splice(j, 1);
          break;
        }
      }
    }
  }
  return spans;
}
function chunkIsBoundary(_text, spans, pos) {
  if (pos <= 0 || pos >= _text.length) return false;
  for (const span of spans) {
    if (span.inclusiveEnd) {
      if (span.start < pos && pos <= span.end) return false;
    } else if (span.start < pos && pos < span.end) return false;
  }
  return true;
}
function chunkIsSafeHardSplit(text, spans, pos) {
  if (!chunkIsBoundary(text, spans, pos)) return false;
  const prev = text.charCodeAt(pos - 1);
  const next = text.charCodeAt(pos);
  if (prev >= 55296 && prev <= 56319) return false;
  if (next >= 56320 && next <= 57343) return false;
  const wordy = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
  if (wordy(prev) && wordy(next)) return false;
  if (prev === 46 || prev === 44 || next === 46 || next === 44) {
    if (wordy(text.charCodeAt(pos - 2) || 0) || wordy(text.charCodeAt(pos + 1) || 0)) return false;
  }
  return true;
}
function advanceCodePoints(text, start, count) {
  let i = start;
  let n = 0;
  while (i < text.length && n < count) {
    const code = text.charCodeAt(i);
    i += code >= 55296 && code <= 56319 ? 2 : 1;
    n += 1;
  }
  return i;
}
function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 55296 || code > 56319) n += 1;
  }
  return n;
}
function splitSpeechChunks(text, options = {}) {
  const src = String(text ?? "");
  if (src === "") return [];
  const minChars = Math.max(1, options.minChars ?? SPEECH_CHUNK_MIN_CHARS);
  const maxChars = Math.max(minChars, options.maxChars ?? SPEECH_CHUNK_MAX_CHARS);
  const firstMaxChars = Math.max(minChars, options.firstMaxChars ?? Math.min(SPEECH_CHUNK_FIRST_MAX_CHARS, maxChars));
  if (codePointLength(src) <= maxChars) return [src];
  const spans = chunkProtectedSpans(src);
  const out = [];
  let start = 0;
  while (start < src.length) {
    const maxForThis = out.length === 0 ? firstMaxChars : maxChars;
    const remaining = codePointLength(src.slice(start));
    if (remaining <= maxForThis) {
      out.push(src.slice(start));
      break;
    }
    const limit = advanceCodePoints(src, start, maxForThis);
    const minLimit = advanceCodePoints(src, start, minChars);
    let cut = -1;
    for (let p = limit; p >= minLimit; p--) {
      if (CHUNK_HARD_STOPS.has(src[p - 1]) && chunkIsBoundary(src, spans, p)) {
        cut = p;
        break;
      }
    }
    if (cut < 0) {
      for (let p = limit; p >= minLimit; p--) {
        if (CHUNK_SECONDARY_STOPS.has(src[p - 1]) && chunkIsBoundary(src, spans, p)) {
          cut = p;
          break;
        }
      }
    }
    if (cut < 0) {
      for (let p = limit; p > start; p--) {
        if (chunkIsSafeHardSplit(src, spans, p)) {
          cut = p;
          break;
        }
      }
    }
    if (cut <= start) {
      let p = limit;
      while (p > start && !chunkIsBoundary(src, spans, p)) p--;
      cut = p > start ? p : limit;
    }
    out.push(src.slice(start, cut));
    start = cut;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== "" && /^\s*$/.test(out[i])) {
      if (i > 0) {
        out[i - 1] += out[i];
        out.splice(i, 1);
      } else if (out.length > 1) {
        out[1] = out[0] + out[1];
        out.splice(0, 1);
      }
    }
  }
  return out.length === 0 ? [src] : out;
}
function parseSessionRefs2(raw) {
  const out = [];
  const text = String(raw ?? "");
  const pattern = /\[\[session:([^\]|]*)\|([^\]]*)\]\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const sessionId = String(match[1] ?? "").trim();
    const title = String(match[2] ?? "").trim();
    if (sessionId !== "") out.push({ sessionId, title: title === "" ? sessionId : title });
  }
  return out;
}
var ATTACH_REF_SOURCE = /\[\[attach:([^\]|]*)(?:\|([^\]]*))?\]\]/g;
function attachPathKey(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLowerCase();
}
function attachBaseName(path) {
  const parts = String(path ?? "").replace(/\\/g, "/").split("/").filter((part) => part !== "");
  return parts.length === 0 ? String(path ?? "") : parts[parts.length - 1];
}
function parseAttachRefs(raw) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const text = String(raw ?? "");
  const pattern = new RegExp(ATTACH_REF_SOURCE.source, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const path = String(match[1] ?? "").trim();
    if (path === "") continue;
    const key = attachPathKey(path);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const name3 = String(match[2] ?? "").trim();
    out.push({ path, name: name3 === "" ? attachBaseName(path) : name3 });
  }
  return out;
}
function stripAttachRefs(text) {
  return String(text ?? "").replace(ATTACH_REF_SOURCE, "");
}
var ATTACH_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
function attachExtensionOf(pathOrName) {
  const name3 = attachBaseName(pathOrName);
  const dot = name3.lastIndexOf(".");
  return dot <= 0 || dot === name3.length - 1 ? "" : name3.slice(dot + 1).toLowerCase();
}
function isAttachImage(pathOrName) {
  return ATTACH_IMAGE_EXTENSIONS.includes(attachExtensionOf(pathOrName));
}
function attachTypeBadge(pathOrName) {
  const ext = attachExtensionOf(pathOrName);
  if (ext === "") return "\u6587\u4EF6";
  if (ext === "jpeg") return "JPG";
  return ext.toUpperCase();
}
function attachFileUrl(path) {
  return `/api/worktable/file?path=${encodeURIComponent(String(path ?? ""))}`;
}
function attachDownloadUrl(path) {
  return `${attachFileUrl(path)}&download=1`;
}
function attachOpenViaDownload(userAgent) {
  return /\bAndroid\b/i.test(String(userAgent ?? ""));
}
function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
var SPEECH_IDLE = { status: "idle", key: "", error: "" };
function reduceSpeech(state, event) {
  switch (event.type) {
    case "play": {
      if (state.key === event.key && (state.status === "loading" || state.status === "playing" || state.status === "paused")) return state;
      return { status: "loading", key: event.key, error: "" };
    }
    case "playing":
      return state.key === event.key && state.status === "loading" ? { status: "playing", key: event.key, error: "" } : state;
    case "pause":
      return state.status === "playing" ? { status: "paused", key: state.key, error: "" } : state;
    case "resume":
      return state.status === "paused" ? { status: "playing", key: state.key, error: "" } : state;
    case "toggle": {
      if (state.key === event.key && state.status === "playing") return { status: "paused", key: state.key, error: "" };
      if (state.key === event.key && state.status === "paused") return { status: "playing", key: state.key, error: "" };
      if (state.key === event.key && state.status === "loading") return state;
      if (state.key === event.key && state.status === "error") return { status: "loading", key: event.key, error: "" };
      return { status: "loading", key: event.key, error: "" };
    }
    case "restart":
      return { status: "loading", key: event.key, error: "" };
    case "ended":
    case "stop":
      return SPEECH_IDLE;
    case "error":
      return { status: "error", key: state.key, error: String(event.error ?? "\u6717\u8BFB\u5931\u8D25") };
    default:
      return state;
  }
}
function createSpeechController(factory) {
  let state = SPEECH_IDLE;
  let player = null;
  let currentText = "";
  const listeners = /* @__PURE__ */ new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const setState = (next) => {
    if (next.status === state.status && next.key === state.key && next.error === state.error) return;
    state = next;
    emit();
  };
  const start = (key) => {
    player?.stop();
    player = null;
    currentText = "";
    const text = pendingText;
    if (text === "") {
      setState(SPEECH_IDLE);
      return;
    }
    currentText = text;
    const next = factory(key, text);
    player = next;
    next.onEnded(() => {
      if (player === next) {
        player = null;
        setState(reduceSpeech(state, { type: "ended" }));
      }
    });
    try {
      next.onPlaying?.(() => {
        if (player === next && state.key === key) setState({ status: "playing", key, error: "" });
      });
    } catch {
    }
    try {
      next.onError?.((message) => {
        if (player !== next) return;
        player = null;
        try {
          next.stop();
        } catch {
        }
        setState(reduceSpeech(state, { type: "error", error: message }));
      });
    } catch {
    }
    next.play().then(() => {
      if (player === next) setState(reduceSpeech(state, { type: "playing", key }));
    }).catch((error) => {
      if (player === next) {
        player = null;
        setState(reduceSpeech(state, { type: "error", error: String(error?.message ?? error) }));
      }
    });
  };
  let pendingText = "";
  const api = {
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * 请求朗读一条内容（key 换 = 停上一条从头读；同 key 的 toggle 语义见状态机）。
     *
     * **同 key 且已在 loading 时必须什么都不做**：状态机对「同 key + loading/playing/paused」
     * 会原样返回同一个 state 对象，所以「next !== before」就是「这次 request 真的换了一条 /
     * 从 error 重来」。早先用 `next.status === 'loading'` 判，会把「同 key 仍在 loading」也当成
     * 要起播，于是同一段文本被第二次 start()（丢掉已排好的首块、整条从头重排）——
     * 一次朗读被反复起播，正是「有时候」几路声音一起来的一半来源。
     */
    request(key, text) {
      pendingText = text;
      const before = state;
      const next = reduceSpeech(state, { type: "play", key });
      setState(next);
      if (next !== before) start(key);
    },
    /**
     * 单击：暂停/继续；空闲/报错/换 key 时用**调用方传入的文本**起播。
     * text 必须是按钮所属卡片自己的规范化朗读文本 —— 绝不允许回退到
     * pendingText（那是「最后一次 request」的文本 = 自动朗读的最新一轮，
     * 历史卡点击会错读成最新一条，2026-11-21 实测 bug）。
     */
    toggle(key, text) {
      if (state.key !== key || state.status === "idle" || state.status === "error") {
        api.request(key, text);
        return;
      }
      if (state.status === "loading") return;
      if (state.status === "playing") {
        player?.pause();
        setState(reduceSpeech(state, { type: "pause" }));
      } else if (state.status === "paused") {
        player?.resume();
        setState(reduceSpeech(state, { type: "resume" }));
      }
    },
    /** 长按：从头发起（player 层 ensure 0 再播）。 */
    restart(key, text) {
      if (state.key === key && player !== null) {
        setState(reduceSpeech(state, { type: "restart", key }));
        player.restart();
        return;
      }
      api.request(key, text);
    },
    stop() {
      player?.stop();
      player = null;
      setState(SPEECH_IDLE);
    }
  };
  return api;
}
function stepTextWithEmphasis(el) {
  const nodes = el?.childNodes ?? null;
  if (nodes === null || nodes.length === 0) return String(el?.textContent ?? "");
  let out = "";
  for (const node of nodes) {
    if (node?.nodeType === 3) {
      out += String(node.textContent ?? "");
    } else if (node?.nodeType === 1) {
      const tag = String(node.tagName ?? "").toLowerCase();
      const inner = stepTextWithEmphasis(node);
      if (tag === "strong" || tag === "b") out += `**${inner}**`;
      else if (tag === "br") out += "\n";
      else out += inner;
    }
  }
  return out;
}
function collectTurnText(doc, turn) {
  const out = [];
  const turnNo = String(turn ?? "").trim();
  if (turnNo === "") return "";
  for (const el of doc.querySelectorAll(`[data-chat-turn="${turnNo}"][data-chat-flow-kind="assistant-step"]`)) {
    if (el.getAttribute("data-chat-group-part") === "reasoning") continue;
    const text = stepTextWithEmphasis(el).trim();
    if (text !== "") out.push(text);
  }
  return out.join("\n").trim();
}
function latestTurnNo(doc) {
  let max = -1;
  let out = "";
  for (const el of doc.querySelectorAll("[data-chat-turn]")) {
    const value = Number(el.getAttribute("data-chat-turn"));
    if (Number.isFinite(value) && value > max) {
      max = value;
      out = String(value);
    }
  }
  return out;
}
function latestReplyTurnNo(doc) {
  let max = -1;
  let out = "";
  for (const el of doc.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-turn]')) {
    if (el.getAttribute("data-dsh-scard-kind") === CARD_KIND_USER2) continue;
    if (el.getAttribute("data-empty") === "1") continue;
    const value = Number(el.getAttribute("data-dsh-scard-turn"));
    if (Number.isFinite(value) && value > max) {
      max = value;
      out = String(value);
    }
  }
  return out;
}
function badgeTone(badge, title = "") {
  const text = `${String(badge ?? "")} ${String(title ?? "")}`;
  if (/授权|批准|确认/.test(text)) return "auth";
  if (/完成|搞定|办结|交付/.test(text)) return "done";
  if (/探索|发现|调研|找找|搜索/.test(text)) return "explore";
  if (/关心|提醒|注意|建议|注意身体|出行|天气/.test(text)) return "care";
  return "serve";
}
function splitItemPrefix(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^([一-鿿][^：:，,\d]{0,7}[：:])([\s\S]*)$/);
  if (match === null) return { prefix: "", rest: raw };
  return { prefix: match[1], rest: match[2].trim() };
}
function itemIcon(text) {
  const raw = String(text ?? "");
  if (/天气|温度|气温|雨|雪|晴|阴|风/.test(raw)) return "\u{1F324}";
  if (/车|高铁|火车|航班|飞机|站|行程|出发|到达/.test(raw)) return "\u{1F684}";
  if (/地点|地址|会场|实验室|家里|公司|武汉|孝感/.test(raw)) return "\u{1F4CD}";
  if (/时间|点钟|会议|截止|提醒|日程|安排/.test(raw)) return "\u{1F550}";
  return "\xB7";
}
function summarize(text, max = 22) {
  const line = String(text ?? "").split("\n").map((s) => s.trim()).find((s) => s !== "") ?? "";
  const clean = line.replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}\u2026` : clean;
}
var MODEL_NAME_RE = /\b(?:qwen[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|deepseek[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|glm(?:[-_.][A-Za-z0-9]+)*|kimi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|llama[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|mistral[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|phi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gpt[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|claude[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gemini[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|grok[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|IQ[1-9]_[A-Z][A-Z0-9]*|fp[1-9]\d*)\b/gi;
function parseAnswerBody(text) {
  const lines = String(text ?? "").split(/\n{2,}|\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return { title: "", paragraphs: [] };
  let [title, ...paragraphs] = lines;
  if (title.length > 48) {
    const match = title.match(/^([\s\S]{1,48}?[。！？!?.])([\s\S]*)$/);
    if (match !== null) {
      title = match[1].trim();
      const rest = match[2].trim();
      if (rest !== "") paragraphs = [rest, ...paragraphs];
    }
  }
  return { title, paragraphs };
}
function splitStrongSegments(text) {
  const raw = String(text ?? "");
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) parts.push({ kind: "text", value: raw.slice(cursor, match.index) });
    if (match[1] !== "") parts.push({ kind: "strong", value: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) parts.push({ kind: "text", value: raw.slice(cursor) });
  return parts;
}
function splitModelTokens(text) {
  const raw = String(text ?? "");
  const tokens = [];
  const pattern = new RegExp(MODEL_NAME_RE.source, MODEL_NAME_RE.flags);
  let cursor = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) tokens.push({ kind: "text", value: raw.slice(cursor, match.index) });
    tokens.push({ kind: "model", value: match[0] });
    cursor = match.index + match[0].length;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  if (cursor < raw.length) tokens.push({ kind: "text", value: raw.slice(cursor) });
  return tokens;
}
function answerInlineTokens(text) {
  return splitStrongSegments(text).flatMap((segment) => segment.kind === "strong" ? [{ kind: "strong", value: segment.value }] : splitModelTokens(segment.value)).filter((token) => token.value !== "");
}
function formatClock(input, now = /* @__PURE__ */ new Date()) {
  const raw = String(input ?? "").trim();
  if (raw === "") return "";
  const date = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(date)) / 864e5);
  if (dayDiff <= 0) return hm;
  if (dayDiff === 1) return `\u6628\u5929 ${hm}`;
  return `${date.getMonth() + 1}\u6708${date.getDate()}\u65E5 ${hm}`;
}
var CARD_KIND_ASSISTANT2 = "assistant";
var CARD_KIND_USER2 = "user";
var CARD_KIND_NOTICE2 = "notice";
var FOLD_BODY_LINE_BUDGET = 3;
var FOLD_TITLE_LINE_BUDGET = 2;
var FOLD_BLOCK_GAP = 10;
var FOLD_FALLBACK_LINE_HEIGHT_PX = 26;
function foldCollapsedCapPx(input) {
  const budget = Math.max(1, Number(input.budget ?? FOLD_BODY_LINE_BUDGET));
  const titleBudget = Math.max(1, Number(input.titleBudget ?? FOLD_TITLE_LINE_BUDGET));
  const gap = Math.max(0, Number(input.gap ?? FOLD_BLOCK_GAP));
  const lineHeightRaw = Number(input.lineHeight);
  const lineHeight = Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : FOLD_FALLBACK_LINE_HEIGHT_PX;
  const titleLineRaw = Number(input.titleLineHeight);
  const titleLine = Number.isFinite(titleLineRaw) && titleLineRaw > 0 ? titleLineRaw : lineHeight;
  const bodyPart = budget * lineHeight + gap * (budget - 1);
  const titlePart = input.hasTitle === true ? titleBudget * titleLine + gap : 0;
  return Math.max(1, Math.round(titlePart + bodyPart));
}
function cardFoldStyle(open, measured, collapsedMaxHeight) {
  if (open) return { maxHeight: "none" };
  if (!measured) return void 0;
  if (collapsedMaxHeight === void 0) return { maxHeight: "none" };
  return { maxHeight: `${collapsedMaxHeight}px` };
}
function foldClipFromBlocks(input) {
  const budget = Math.max(1, Number(input.budget ?? FOLD_BODY_LINE_BUDGET));
  const titleBudget = Math.max(1, Number(input.titleBudget ?? FOLD_TITLE_LINE_BUDGET));
  const lineHeightRaw = Number(input.lineHeight);
  const lineHeight = Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : FOLD_FALLBACK_LINE_HEIGHT_PX;
  const titleLineRaw = Number(input.titleLineHeight);
  const titleLine = Number.isFinite(titleLineRaw) && titleLineRaw > 0 ? titleLineRaw : lineHeight;
  const natural = Math.max(1, Math.round(Number(input.naturalHeight) || 1));
  const hasTitle = input.blocks.some((block) => block.kind === "title");
  const cap = foldCollapsedCapPx({ lineHeight, titleLineHeight: titleLine, hasTitle, budget, titleBudget });
  if (input.blocks.length === 0) return { collapsedMaxHeight: void 0, overflow: false, bodyLines: 0, clip: natural, cap };
  let bodyLines = 0;
  let titleLines = 0;
  let lastBottom = 0;
  let clip;
  for (const block of input.blocks) {
    const isTitle = block.kind === "title";
    const unit = isTitle ? titleLine : lineHeight;
    const top = Math.max(0, Math.round(block.top));
    const height = Math.max(1, Math.round(block.height || unit));
    const lines = block.kind === "ref" ? 1 : Math.max(1, Math.round(height / unit));
    const allowance = isTitle ? titleBudget : budget;
    const used = isTitle ? titleLines : bodyLines;
    const remaining = allowance - used;
    if (remaining <= 0) {
      clip = lastBottom > 0 ? lastBottom : top;
      break;
    }
    if (lines <= remaining) {
      if (isTitle) titleLines += lines;
      else bodyLines += lines;
      lastBottom = top + height;
      continue;
    }
    clip = top + remaining * unit;
    if (isTitle) titleLines = allowance;
    else bodyLines = allowance;
    break;
  }
  const titleClipped = input.titleClippedHidden === true;
  if (clip === void 0) {
    if (!titleClipped) return { collapsedMaxHeight: void 0, overflow: false, bodyLines, clip: natural, cap };
    clip = lastBottom > 0 ? lastBottom : cap;
  }
  const maxHeight = Math.max(1, Math.min(Math.round(clip), cap, natural));
  const overflow = maxHeight < natural - 1 || titleClipped;
  return { collapsedMaxHeight: overflow ? maxHeight : void 0, overflow, bodyLines, clip: maxHeight, cap };
}
function parseUserCardBody(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (text === "") return [];
  return text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== "");
}
function parseNoticeCardBody(raw) {
  return parseAnswerBody(stripNoticeSyntheticHead(raw));
}
function formatUserCardClock(clockText) {
  const raw = String(clockText ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return "";
  const stripped = raw.replace(/^今天\s+/, "");
  const match = stripped.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match === null ? stripped : stripped;
}
var USER_TEXT_RUN_SELECTOR = '[data-slot="conversation.user.text.node"]';
var USER_ATTACHMENT_ROW_SELECTOR = "[data-message-attachments]";
var USER_IMAGES_SLOT_SELECTOR = '[data-slot="conversation.chat.user.images"]';
var HOST_IMAGE_FRAME_TITLE = "\u67E5\u770B\u539F\u56FE";
function elementMatches(el, selector) {
  return typeof el.matches === "function" ? el.matches(selector) : false;
}
function insideAttachmentRow(el, row) {
  let node = el;
  while (node !== null && node !== row) {
    if (elementMatches(node, USER_ATTACHMENT_ROW_SELECTOR)) return true;
    node = node.parentElement;
  }
  return false;
}
function hasBlockBearingChild(el) {
  for (const child of Array.from(el.children)) {
    if (elementMatches(child, USER_ATTACHMENT_ROW_SELECTOR)) return true;
    if (child.querySelectorAll(USER_ATTACHMENT_ROW_SELECTOR).length > 0) return true;
    if (child.querySelectorAll(USER_TEXT_RUN_SELECTOR).length > 0) return true;
  }
  return false;
}
function runsFromContainer(container, row) {
  const out = [];
  for (const child of Array.from(container.children)) {
    if (elementMatches(child, USER_ATTACHMENT_ROW_SELECTOR)) {
      out.push(...attachmentRunsIn(child, row));
      continue;
    }
    const attachments = Array.from(child.querySelectorAll(USER_ATTACHMENT_ROW_SELECTOR));
    const texts = Array.from(child.querySelectorAll(USER_TEXT_RUN_SELECTOR)).filter((anchor) => !insideAttachmentRow(anchor, row));
    if (attachments.length > 0 && texts.length > 0) {
      out.push(...runsFromContainer(child, row));
      continue;
    }
    if (attachments.length > 0) {
      for (const attach of attachments) out.push(...attachmentRunsIn(attach, row));
      continue;
    }
    if (texts.length === 0) continue;
    if (hasBlockBearingChild(child)) {
      out.push(...runsFromContainer(child, row));
      continue;
    }
    const text = String(child.textContent ?? "");
    if (text.trim() !== "") out.push({ type: "text", text });
  }
  return out;
}
function collectUserCardRuns(row) {
  if (row.querySelectorAll(`${USER_TEXT_RUN_SELECTOR}, ${USER_ATTACHMENT_ROW_SELECTOR}`).length === 0) return [];
  return runsFromContainer(row, row);
}
function attachmentNameOf(el, row, fallback) {
  const alt = String(el.getAttribute("alt") ?? "").trim();
  if (alt !== "") return alt;
  let node = el;
  while (node !== null && node !== row) {
    const label = String(node.getAttribute("aria-label") ?? "").trim();
    if (label !== "") return label.split("\uFF0C")[0].trim();
    node = node.parentElement;
  }
  const title = String(el.getAttribute("title") ?? "").trim();
  return title !== "" && title !== HOST_IMAGE_FRAME_TITLE ? title : fallback;
}
function attachmentRunsIn(el, row) {
  const out = [];
  for (const img of Array.from(el.querySelectorAll("img"))) {
    out.push({ type: "attachment", attachment: { kind: "image", name: attachmentNameOf(img, row, "\u56FE\u7247"), src: String(img.getAttribute("src") ?? ""), meta: "" } });
  }
  if (out.length > 0) return out;
  const imageSlot = elementMatches(el, USER_IMAGES_SLOT_SELECTOR) ? el : el.querySelector(USER_IMAGES_SLOT_SELECTOR);
  if (imageSlot !== null) {
    for (const frame of Array.from(imageSlot.querySelectorAll("button"))) {
      out.push({ type: "attachment", attachment: { kind: "image", name: attachmentNameOf(frame, row, "\u56FE\u7247"), src: String(frame.getAttribute("src") ?? ""), meta: "" } });
    }
    if (out.length > 0) return out;
  }
  for (const card of Array.from(el.querySelectorAll("[title]"))) {
    const name3 = String(card.getAttribute("title") ?? "").trim();
    const text = String(card.textContent ?? "").replace(/\s+/g, " ").trim();
    if (name3 === "" || name3 === HOST_IMAGE_FRAME_TITLE || text === "") continue;
    const meta = text === name3 ? "" : text.startsWith(name3) ? text.slice(name3.length).trim() : text;
    out.push({ type: "attachment", attachment: { kind: "file", name: name3, src: "", meta } });
  }
  return out;
}
function userCardRunText(runs) {
  return runs.filter((run) => run.type === "text").map((run) => String(run.text ?? "").trim()).filter((text) => text !== "").join("\n");
}
function userCardAttachments(runs) {
  return runs.filter((run) => run.type === "attachment").map((run) => run.attachment);
}
function buildUserCardBody(runs) {
  const out = [];
  for (const run of runs) {
    if (run.type === "attachment") {
      out.push({ type: "attachment", attachment: run.attachment });
      continue;
    }
    for (const paragraph of parseUserCardBody(run.text)) out.push({ type: "para", text: paragraph });
  }
  return out;
}
var USER_FLOW_KIND_USER = "user";
var USER_FLOW_KIND_STEERING = "steering";
var SECRETARY_USER_FLOW_KINDS = [USER_FLOW_KIND_USER, USER_FLOW_KIND_STEERING];
var SECRETARY_USER_ROW_SELECTOR = SECRETARY_USER_FLOW_KINDS.map((kind) => `[data-chat-flow-kind="${kind}"]`).join(", ");
function collectSecretaryCardRows(doc) {
  const out = [];
  for (const row of doc.querySelectorAll(SECRETARY_USER_ROW_SELECTOR)) {
    const key = row.getAttribute("data-chat-node-key") ?? row.getAttribute("data-chat-flow-key") ?? "";
    const turnNo = row.getAttribute("data-chat-turn") ?? "";
    const runs = collectUserCardRuns(row);
    const attachments = userCardAttachments(runs);
    const text = userCardRunText(runs);
    if (text === "" && attachments.length === 0) continue;
    const clockEl = row.querySelector("[data-clock]");
    const kind = text !== "" && isSyntheticNoticeUserText(text) ? CARD_KIND_NOTICE2 : CARD_KIND_USER2;
    out.push({ element: row, key, turnNo, text, clockText: String(clockEl?.textContent ?? "").trim(), kind, runs, attachments });
  }
  return out;
}
function collectSecretaryUserRows(doc) {
  return collectSecretaryCardRows(doc).filter((row) => row.kind === CARD_KIND_USER2);
}
function collectSecretaryCardElements(doc) {
  const out = [];
  for (const element of doc.querySelectorAll('[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]')) {
    const cardKey = String(element.getAttribute("data-dsh-scard-key") ?? "").trim();
    const kind = String(element.getAttribute("data-dsh-scard-kind") ?? "").trim();
    const turnNo = String(element.getAttribute("data-dsh-scard-turn") ?? "").trim();
    if (cardKey === "" || kind === "") continue;
    let text = "";
    let timeText = "";
    if (kind === CARD_KIND_USER2 || kind === CARD_KIND_NOTICE2) {
      const row = element.closest(SECRETARY_USER_ROW_SELECTOR) ?? element;
      text = userCardRunText(collectUserCardRuns(row));
      timeText = formatUserCardClock(row.querySelector("[data-clock]")?.textContent ?? "");
    } else {
      text = collectTurnText(doc, turnNo);
    }
    out.push({ element, cardKey, kind, turnNo, text, timeText });
  }
  return out;
}
var ASSISTANT_SECRETARY_READ_ROUTE2 = "/api/assistant/secretary-read";
var READ_STORAGE_PREFIX = "dsh.assistant.secretary.read:";
var MAX_READ_KEYS = 400;
var CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/;
function buildSecretaryPagerCards(doc) {
  const now = Date.now();
  const arrivals = noticeArrivalStore();
  const rows = collectSecretaryCardRows(doc).filter((row) => row.kind !== CARD_KIND_NOTICE2 || !noticeCardExpired(row, now, NOTICE_CARD_TTL_MS, arrivals.at(noticeCardSpeechKey(row.key, row.turnNo)))).map((row) => ({
    cardKey: row.kind === CARD_KIND_NOTICE2 ? noticeCardSpeechKey(row.key, row.turnNo) : userCardSpeechKey(row.key, row.turnNo),
    kind: row.kind,
    turnNo: row.turnNo,
    text: row.text,
    timeText: formatUserCardClock(row.clockText)
  }));
  const mountedAssistant = collectSecretaryCardElements(doc).filter((card) => card.kind === CARD_KIND_ASSISTANT2);
  const turnOrder = [];
  for (const element of doc.querySelectorAll("[data-chat-turn]")) {
    const turnNo = String(element.getAttribute("data-chat-turn") ?? "");
    if (turnNo === "" || turnOrder.includes(turnNo)) continue;
    turnOrder.push(turnNo);
  }
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (const turnNo of turnOrder) {
    for (const card of rows.filter((row) => row.turnNo === turnNo)) {
      if (used.has(card.cardKey)) continue;
      used.add(card.cardKey);
      out.push(card);
    }
    const mounted = mountedAssistant.find((card) => card.turnNo === turnNo);
    if (mounted !== void 0) {
      if (!used.has(mounted.cardKey)) {
        used.add(mounted.cardKey);
        out.push({ cardKey: mounted.cardKey, kind: mounted.kind, turnNo: mounted.turnNo, text: mounted.text, timeText: mounted.timeText });
      }
      continue;
    }
    const text = collectTurnText(doc, turnNo);
    if (text === "") continue;
    const key = assistantCardSpeechKey(turnNo);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ cardKey: key, kind: CARD_KIND_ASSISTANT2, turnNo, text, timeText: "" });
  }
  for (const card of rows) {
    if (used.has(card.cardKey)) continue;
    used.add(card.cardKey);
    out.push(card);
  }
  for (const card of mountedAssistant) {
    if (used.has(card.cardKey)) continue;
    used.add(card.cardKey);
    out.push({ cardKey: card.cardKey, kind: card.kind, turnNo: card.turnNo, text: card.text, timeText: card.timeText });
  }
  return out;
}
function normalizeCardKey(raw) {
  const value = String(raw ?? "").trim();
  return CARD_KEY_RE.test(value) ? value : "";
}
function normalizeReadKeys(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const key = normalizeCardKey(item);
    if (key === "" || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > MAX_READ_KEYS ? out.slice(out.length - MAX_READ_KEYS) : out;
}
function createSecretaryReadStore(deps = {}) {
  const read = /* @__PURE__ */ new Set();
  const order = [];
  const listeners = /* @__PURE__ */ new Set();
  const storageKey = READ_STORAGE_PREFIX;
  let session = "";
  let version = 0;
  let hydrateCall = null;
  let hostBroken = false;
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const bump = () => {
    version += 1;
    emit();
  };
  const add = (cardKey) => {
    const key = normalizeCardKey(cardKey);
    if (key === "" || read.has(key)) return false;
    read.add(key);
    order.push(key);
    while (order.length > MAX_READ_KEYS) {
      const oldest = order.shift() ?? "";
      if (oldest !== "") read.delete(oldest);
    }
    return true;
  };
  const addAll = (keys) => {
    let added = 0;
    for (const key of keys) if (add(key)) added += 1;
    if (added > 0) bump();
    return added;
  };
  const storage = deps.storage ?? null;
  const readCache = () => {
    if (storage === null || session === "") return [];
    try {
      return normalizeReadKeys(JSON.parse(String(storage.getItem(`${storageKey}${session}`) ?? "[]")));
    } catch {
      return [];
    }
  };
  const writeCache = () => {
    if (storage === null || session === "") return;
    try {
      storage.setItem(`${storageKey}${session}`, JSON.stringify(order.slice(-MAX_READ_KEYS)));
    } catch {
    }
  };
  const postRead = (cardKey) => {
    const fetchImpl = deps.fetchImpl;
    if (hostBroken || typeof fetchImpl !== "function" || session === "") return;
    void Promise.resolve(fetchImpl(ASSISTANT_SECRETARY_READ_ROUTE2, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session, cardKey, mark: "read" })
    })).then((res) => {
      if (res?.ok !== true) {
        hostBroken = true;
        return;
      }
      return res.json?.().then((payload) => {
        if (payload?.ok !== true) hostBroken = true;
      });
    }).catch(() => {
      hostBroken = true;
    });
  };
  return {
    session: () => session,
    setSession(sessionId) {
      const id = String(sessionId ?? "").trim();
      if (id === session) return;
      session = id;
      hydrateCall = null;
      addAll(readCache());
    },
    isRead(cardKey) {
      const key = normalizeCardKey(cardKey);
      return key !== "" && read.has(key);
    },
    markRead(cardKey) {
      const key = normalizeCardKey(cardKey);
      if (key === "") return false;
      if (read.has(key)) return true;
      add(key);
      bump();
      writeCache();
      postRead(key);
      return true;
    },
    hydrate() {
      if (hydrateCall !== null) return hydrateCall;
      hydrateCall = (async () => {
        addAll(readCache());
        const fetchImpl = deps.fetchImpl;
        if (hostBroken || session === "" || typeof fetchImpl !== "function") {
          return { ok: true, hostOk: false, count: order.length };
        }
        try {
          const res = await fetchImpl(`${ASSISTANT_SECRETARY_READ_ROUTE2}?sessionId=${encodeURIComponent(session)}`, { cache: "no-store" });
          if (res?.ok !== true) {
            hostBroken = true;
            return { ok: true, hostOk: false, count: order.length };
          }
          const payload = await res.json();
          const hostKeys = normalizeReadKeys(payload?.cards);
          if (payload?.ok !== true) {
            hostBroken = true;
            return { ok: true, hostOk: false, count: order.length };
          }
          addAll(hostKeys);
          writeCache();
          return { ok: true, hostOk: true, count: order.length };
        } catch {
          hostBroken = true;
          return { ok: true, hostOk: false, count: order.length };
        }
      })();
      return hydrateCall;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
    keys() {
      return [...order];
    }
  };
}
var cardReadStore = null;
function secretaryReadStore() {
  if (cardReadStore !== null) return cardReadStore;
  const g = globalThis;
  const fetchImpl = typeof g.fetch === "function" ? (url, init) => g.fetch(url, init) : void 0;
  let storage = null;
  try {
    if (g.localStorage && typeof g.localStorage.getItem === "function") storage = g.localStorage;
  } catch {
    storage = null;
  }
  cardReadStore = createSecretaryReadStore({ fetchImpl, storage });
  return cardReadStore;
}
var ASSISTANT_SECRETARY_HISTORY_ROUTE2 = "/api/assistant/secretary/history";
function collapsedCardTitle(domText, hostTitle = "") {
  const fromHost = String(hostTitle ?? "").trim();
  if (fromHost !== "") return fromHost;
  return truncateCardTitle(domText);
}
function scrollAnchorTopPatch(beforeScrollHeight, afterScrollHeight) {
  const delta = Math.round(Number(afterScrollHeight) - Number(beforeScrollHeight));
  return delta > 0 ? delta : 0;
}
var HISTORY_FOLLOW_BOTTOM_PX = 80;
function planHistoryScrollRestore(before, after, options = {}) {
  const userGestured = options.userGestured === true;
  const beforeFloor = Math.max(0, Number(before.scrollHeight) - Number(before.clientHeight));
  const afterFloor = Math.max(0, Number(after.scrollHeight) - Number(after.clientHeight));
  const beforeBottomGap = beforeFloor - Number(before.scrollTop);
  const afterBottomGap = afterFloor - Number(after.scrollTop);
  const floorGrowth = Math.max(0, afterFloor - beforeFloor);
  if (floorGrowth > 0.5 && beforeBottomGap < HISTORY_FOLLOW_BOTTOM_PX && afterBottomGap <= beforeBottomGap + floorGrowth + 1) {
    return { scrollTop: Math.round(afterFloor), reason: "follow-tail", delta: 0 };
  }
  if (before.anchorKey !== null && before.anchorOffset !== null && after.anchorKey === before.anchorKey && after.anchorOffset !== null) {
    const delta = userGestured ? Number(after.anchorOffset) + Number(after.scrollTop) - (Number(before.anchorOffset) + Number(before.scrollTop)) : Number(after.anchorOffset) - Number(before.anchorOffset);
    const target = Math.max(0, Math.round(Number(after.scrollTop) + delta));
    if (Math.abs(target - Number(after.scrollTop)) <= 0.5) return { scrollTop: null, reason: "keep", delta };
    return { scrollTop: target, reason: "anchor", delta };
  }
  return { scrollTop: null, reason: "keep", delta: 0 };
}
var HISTORY_GUARD_MAX_MS = 600;
var HISTORY_GUARD_QUIET_FRAMES = 8;
var HISTORY_GUARD_MIN_MS = 300;
var HISTORY_GUARD_MISSING_GRACE_FRAMES = 45;
function startHistoryScrollGuard(options) {
  const scroller = options?.scroller;
  const key = String(options?.anchorKey ?? "");
  if (scroller === null || scroller === void 0 || key === "") return () => {
  };
  const view = typeof window === "undefined" ? null : window;
  const raf = options.raf ?? ((cb) => view === null ? 0 : view.requestAnimationFrame(cb));
  const caf = options.caf ?? ((id) => {
    try {
      view?.cancelAnimationFrame(id);
    } catch {
    }
  });
  const now = options.now ?? (() => typeof performance === "undefined" ? Date.now() : performance.now());
  const maxMs = Math.max(1, Number(options.maxMs ?? HISTORY_GUARD_MAX_MS) || HISTORY_GUARD_MAX_MS);
  const quietFrames = Math.max(1, Number(options.quietFrames ?? HISTORY_GUARD_QUIET_FRAMES) || HISTORY_GUARD_QUIET_FRAMES);
  const graceFrames = Math.max(1, Number(options.missingGraceFrames ?? HISTORY_GUARD_MISSING_GRACE_FRAMES) || HISTORY_GUARD_MISSING_GRACE_FRAMES);
  let expectOffset = Number(options.expectOffset) || 0;
  const startTop = options.startScrollTop === void 0 ? Number(scroller?.scrollTop) || 0 : Number(options.startScrollTop) || 0;
  let lastTop = startTop;
  let lastHeight = Number(scroller?.scrollHeight) || 0;
  const startedAt = now();
  let quiet = 0;
  let missing = 0;
  let observer = null;
  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== 0) {
      caf(frame);
      frame = 0;
    }
    if (observer !== null) {
      try {
        observer.disconnect();
      } catch {
      }
      observer = null;
    }
  };
  const findRow = () => {
    const rows = scroller?.querySelectorAll?.(HISTORY_CARD_ROW_SELECTOR) ?? [];
    for (const item of Array.from(rows)) {
      if (String(item?.getAttribute?.("data-dsh-scard-key") ?? "") === key) return item;
    }
    return null;
  };
  const correct = () => {
    if (stopped) return false;
    if (scroller?.isConnected === false) {
      stop();
      return false;
    }
    const row = findRow();
    const scrollerTop = Number(scroller?.getBoundingClientRect?.().top) || 0;
    const rowTop = row === null ? null : Number(row?.getBoundingClientRect?.().top) || 0;
    const rowHeight = row === null ? 0 : Number(row?.getBoundingClientRect?.().height) || 0;
    if (rowTop === null || rowHeight <= 0) {
      missing += 1;
      quiet = 0;
      if (missing > graceFrames) {
        stop();
        return false;
      }
      return true;
    }
    missing = 0;
    const scrollTop = Number(scroller?.scrollTop) || 0;
    const scrollHeight = Number(scroller?.scrollHeight) || 0;
    const anchorOffset = rowTop - scrollerTop;
    const heightChanged = Math.abs(scrollHeight - lastHeight) > 0.5;
    const scrollChanged = Math.abs(scrollTop - lastTop) > 0.5;
    if (scrollChanged && !heightChanged) {
      expectOffset = anchorOffset;
      quiet = 0;
    } else {
      const drift = anchorOffset - expectOffset;
      if (Math.abs(drift) >= 1) {
        quiet = 0;
        const floor = Math.max(0, scrollHeight - (Number(scroller?.clientHeight) || 0));
        scroller.scrollTop = Math.max(0, Math.min(floor, scrollTop + drift));
      } else {
        quiet += 1;
      }
    }
    lastTop = Number(scroller?.scrollTop) || 0;
    lastHeight = scrollHeight;
    if (now() - startedAt >= maxMs) {
      stop();
      return false;
    }
    if (quiet >= quietFrames && now() - startedAt >= HISTORY_GUARD_MIN_MS) {
      stop();
      return false;
    }
    return true;
  };
  const step = () => {
    frame = 0;
    if (stopped) return;
    if (!correct()) return;
    frame = raf(step);
  };
  if (options.observeMutations !== false && typeof MutationObserver !== "undefined") {
    try {
      observer = new MutationObserver(() => {
        try {
          correct();
        } catch {
        }
      });
      observer.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "src", "height", "data-open"] });
    } catch {
      observer = null;
    }
  }
  const stopAll = () => {
    stop();
    if (observer !== null) {
      try {
        observer.disconnect();
      } catch {
      }
      observer = null;
    }
  };
  frame = raf(step);
  return stopAll;
}
function pickHistoryAnchorKey(rows, scrollerTop) {
  const top = Number(scrollerTop) || 0;
  for (const row of rows) {
    if (Number(row?.height) > 0 && Number(row?.bottom) > top + 1) return String(row?.key ?? "") || null;
  }
  return null;
}
var HISTORY_CARD_ROW_SELECTOR = '[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]';
function captureHistoryScrollSnapshot(scroller, anchorKey = null) {
  const scrollerTop = Number(scroller?.getBoundingClientRect?.().top) || 0;
  const rows = [];
  const list = scroller?.querySelectorAll?.(HISTORY_CARD_ROW_SELECTOR) ?? [];
  for (const row of Array.from(list)) {
    const rect = row?.getBoundingClientRect?.() ?? { top: 0, bottom: 0, height: 0 };
    rows.push({
      key: String(row?.getAttribute?.("data-dsh-scard-key") ?? ""),
      top: Number(rect.top) || 0,
      bottom: Number(rect.bottom) || 0,
      height: Number(rect.height) || 0
    });
  }
  const key = anchorKey ?? pickHistoryAnchorKey(rows, scrollerTop);
  const anchor = key === null ? null : rows.find((row) => row.key === key) ?? null;
  return {
    scrollTop: Number(scroller?.scrollTop) || 0,
    scrollHeight: Number(scroller?.scrollHeight) || 0,
    clientHeight: Number(scroller?.clientHeight) || 0,
    anchorKey: key,
    anchorOffset: anchor === null ? null : anchor.top - scrollerTop
  };
}
function createSecretaryPager(deps = {}) {
  const baseWindowSize = Math.max(1, Number(deps.windowSize) || CARD_WINDOW_DEFAULT);
  const pageSize = Math.max(1, Number(deps.pageSize) || CARD_PAGE_SIZE);
  const cap = Math.max(baseWindowSize, Number(deps.cap) || CARD_RENDER_CAP);
  const listeners = /* @__PURE__ */ new Set();
  let version = 0;
  let sessionId = "";
  let domOrder = [];
  const domCards = /* @__PURE__ */ new Map();
  const metas = /* @__PURE__ */ new Map();
  let windowSize = baseWindowSize;
  let windowInitialized = false;
  let cursorSeq = 0;
  let hasMore = true;
  let loadingCall = null;
  let source = "dom";
  let expandedBatches = 0;
  let capped = false;
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const bump = () => {
    version += 1;
    emit();
  };
  const rankFromNewest = (cardKey) => {
    const index = domOrder.indexOf(cardKey);
    if (index === -1) return -1;
    return domOrder.length - 1 - index;
  };
  const isCappedNow = () => windowSize >= cap || !canRenderMore(windowSize);
  const applyPage = (page, oldestSide) => {
    const items = [];
    const rawItems = Array.isArray(page?.items) ? page.items : [];
    for (const raw of rawItems) {
      const cardKey = String(raw?.cardKey ?? "").trim();
      if (cardKey === "") continue;
      const meta = {
        cardKey,
        seq: Number(raw?.seq) || 0,
        kind: String(raw?.kind ?? ""),
        turnNo: String(raw?.turn ?? ""),
        title: String(raw?.title ?? ""),
        preview: String(raw?.preview ?? ""),
        time: Number(raw?.time) || 0
      };
      metas.set(cardKey, meta);
      items.push(meta);
    }
    const reportedCursor = Number(page?.nextBefore) || 0;
    if (oldestSide && reportedCursor > 0) cursorSeq = reportedCursor;
    else if (items.length > 0) {
      const oldest = Math.min(...items.map((item) => item.seq));
      if (oldest > 0) cursorSeq = oldest;
    }
    if (typeof page?.hasMore === "boolean") hasMore = page.hasMore;
    return items.length;
  };
  const fetchPage = async (before) => {
    const fetchImpl = deps.fetchImpl;
    if (typeof fetchImpl !== "function" || sessionId === "") return { ok: false, error: "no fetch", page: null };
    const params = [`sessionId=${encodeURIComponent(sessionId)}`, `limit=${normalizeHistoryLimit(pageSize)}`];
    if (before !== void 0) params.push(`before=${encodeURIComponent(String(before))}`);
    const url = `${ASSISTANT_SECRETARY_HISTORY_ROUTE2}?${params.join("&")}`;
    try {
      const res = await fetchImpl(url, { cache: "no-store" });
      if (res?.ok !== true) return { ok: false, error: `status:${res?.status ?? "unknown"}`, page: null };
      const payload = await res.json();
      if (payload?.ok !== true) return { ok: false, error: "payload-not-ok", page: null };
      return { ok: true, error: "", page: payload.page ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), page: null };
    }
  };
  return {
    session: () => sessionId,
    setSession(next) {
      const id = String(next ?? "").trim();
      if (id === sessionId) return;
      sessionId = id;
      windowInitialized = false;
      windowSize = baseWindowSize;
      domOrder = [];
      domCards.clear();
      metas.clear();
      cursorSeq = 0;
      hasMore = true;
      expandedBatches = 0;
      capped = false;
      loadingCall = null;
      source = "dom";
      bump();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
    ensureWindow() {
      if (loadingCall !== null) return loadingCall;
      const run = async () => {
        if (windowInitialized) return { ok: true, source, cards: windowSize, backfilled: false, error: "" };
        const fetched = await fetchPage(void 0);
        if (fetched.ok) {
          const cards = applyPage(fetched.page, false);
          source = "host";
          windowInitialized = true;
          bump();
          return { ok: true, source, cards, backfilled: false, error: "" };
        }
        source = "dom";
        windowInitialized = true;
        hasMore = domOrder.length > windowSize;
        bump();
        return { ok: false, source, cards: 0, backfilled: false, error: fetched.error };
      };
      loadingCall = run().then((result) => {
        loadingCall = null;
        return result;
      }, () => {
        loadingCall = null;
        return { ok: false, source: "dom", cards: 0, backfilled: false, error: "fetch-failed" };
      });
      return loadingCall;
    },
    noteDomCards(cards) {
      let changed = false;
      const order = [];
      for (const card of cards) {
        const key = String(card?.cardKey ?? "").trim();
        if (key === "") continue;
        order.push(key);
        const previous = domCards.get(key);
        if (previous === void 0 || previous.text !== card.text || previous.timeText !== card.timeText || previous.kind !== card.kind) {
          domCards.set(key, { cardKey: key, kind: card.kind, turnNo: card.turnNo, text: card.text, timeText: card.timeText });
          changed = true;
        }
      }
      if (order.join("|") !== domOrder.join("|")) {
        domOrder = order;
        changed = true;
      }
      if (changed) bump();
      if (!windowInitialized && loadingCall === null && domOrder.length > 0) void this.ensureWindow();
    },
    windowSize() {
      return windowSize;
    },
    isFullCard(cardKey) {
      const rank = rankFromNewest(cardKey);
      if (rank === -1) return true;
      return rank < windowSize;
    },
    isCollapsedCard(cardKey) {
      const rank = rankFromNewest(cardKey);
      if (rank === -1) return false;
      return rank >= windowSize;
    },
    collapsedTitle(cardKey) {
      const meta = metas.get(cardKey);
      return collapsedCardTitle(domCards.get(cardKey)?.text ?? "", meta?.title ?? "");
    },
    previewText(cardKey) {
      const meta = metas.get(cardKey);
      if (meta !== void 0 && meta.preview !== "") return meta.preview;
      return truncatePreview(domCards.get(cardKey)?.text ?? "");
    },
    expandOlder() {
      if (loadingCall !== null) return loadingCall;
      if (isCappedNow()) {
        capped = true;
        bump();
        return Promise.resolve({ ok: false, added: 0, capped: true, hasMore, source, windowSize });
      }
      const run = async () => {
        let added = 0;
        let ok = false;
        if (source === "host" && cursorSeq > 0) {
          const fetched = await fetchPage(cursorSeq);
          if (fetched.ok) {
            ok = true;
            added = applyPage(fetched.page, true);
          } else {
            hasMore = domOrder.length > windowSize;
          }
        } else {
          ok = false;
          hasMore = domOrder.length > windowSize;
        }
        const next = Math.min(cap, windowSize + pageSize);
        added = Math.max(added, Math.min(pageSize, Math.max(0, domOrder.length - windowSize)));
        windowSize = next;
        expandedBatches += 1;
        capped = isCappedNow();
        if (capped) hasMore = false;
        bump();
        return { ok, added, capped, hasMore, source, windowSize };
      };
      loadingCall = run().then((result) => {
        loadingCall = null;
        return result;
      }, () => {
        loadingCall = null;
        return { ok: false, added: 0, capped, hasMore, source, windowSize };
      });
      return loadingCall;
    },
    renderedCount() {
      const known = domOrder.length === 0 ? windowSize : Math.min(windowSize, domOrder.length);
      return Math.max(0, Math.min(known, cap));
    },
    isCapped() {
      return capped;
    },
    hintVisible() {
      return capped || !hasMore && domOrder.length > windowSize;
    },
    loading() {
      return loadingCall !== null;
    },
    state() {
      return {
        sessionId,
        source,
        windowSize,
        renderedCount: this.renderedCount(),
        capped,
        hasMore,
        loading: loadingCall !== null,
        windowInitialized,
        cursorSeq,
        expandedBatches
      };
    },
    reset() {
      windowInitialized = false;
      windowSize = baseWindowSize;
      cursorSeq = 0;
      hasMore = true;
      expandedBatches = 0;
      capped = false;
      loadingCall = null;
      bump();
    }
  };
}
var cardPager = null;
function secretaryPager() {
  if (cardPager !== null) return cardPager;
  const g = globalThis;
  const fetchImpl = typeof g.fetch === "function" ? (url, init) => g.fetch(url, init) : void 0;
  cardPager = createSecretaryPager({ fetchImpl });
  return cardPager;
}
var NOTICE_CARD_TTL_MS = 10 * 1e3;
var NOTICE_CLOCK_MINUTE_MS = 60 * 1e3;
var NOTICE_ARRIVAL_STORAGE_KEY = "dsh.assistant.secretary.notice-arrival";
var MAX_NOTICE_ARRIVAL_KEYS = 200;
var CLOCK_DATED_RE = /(昨天|前天|上周|[01]?\d月[0-3]?\d日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/;
var CLOCK_TODAY_RE = /^(今天\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
function noticeExpiryFromClock(clockText, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS) {
  const raw = String(clockText ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return { sentAt: null, expiresAt: null, expired: false, reason: "unknown-time" };
  const day = new Date(now);
  const today = raw.match(CLOCK_TODAY_RE);
  if (today !== null) {
    const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(today[2]), Number(today[3]), 0, 0).getTime();
    const minuteStart = Number.isFinite(startMs) && startMs <= now ? startMs : now;
    const expiresAt = minuteStart + NOTICE_CLOCK_MINUTE_MS - 1 + ttlMs;
    return { sentAt: minuteStart, expiresAt, expired: now >= expiresAt, reason: "same-day" };
  }
  if (CLOCK_DATED_RE.test(raw)) return { sentAt: null, expiresAt: null, expired: true, reason: "dated-label" };
  return { sentAt: null, expiresAt: null, expired: false, reason: "unknown-time" };
}
function noticeExpiry(row, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS, arrivalAt = null) {
  const clock = noticeExpiryFromClock(row.clockText, now, ttlMs);
  if (row.kind !== CARD_KIND_NOTICE2) {
    return { sentAt: clock.sentAt, expiresAt: null, expired: false, reason: clock.reason, precision: "none" };
  }
  const secondsAt = typeof arrivalAt === "number" && Number.isFinite(arrivalAt) && arrivalAt > 0 ? arrivalAt + ttlMs : null;
  if (clock.reason === "dated-label") {
    return { sentAt: clock.sentAt, expiresAt: secondsAt, expired: true, reason: clock.reason, precision: secondsAt === null ? "minute" : "seconds" };
  }
  const candidates = [secondsAt, clock.expiresAt].filter((value) => value !== null && Number.isFinite(value));
  const expiresAt = candidates.length === 0 ? null : Math.min(...candidates);
  const precision = secondsAt !== null ? "seconds" : clock.reason === "same-day" ? "minute" : "none";
  const expired = expiresAt === null ? false : now >= expiresAt;
  return { sentAt: clock.sentAt, expiresAt, expired, reason: clock.reason, precision };
}
function nearestNoticeExpiryMs(rows, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS, arrivalOf = null) {
  let nearest = null;
  for (const row of rows) {
    if (row.kind !== CARD_KIND_NOTICE2) continue;
    const arrivalAt = arrivalOf === null ? null : arrivalOf(row);
    const expiry = noticeExpiry(row, now, ttlMs, arrivalAt);
    if (expiry.expiresAt === null || expiry.expired) continue;
    if (nearest === null || expiry.expiresAt < nearest) nearest = expiry.expiresAt;
  }
  return nearest;
}
function noticeCardExpired(row, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS, arrivalAt = null) {
  if (row.kind !== CARD_KIND_NOTICE2) return false;
  return noticeExpiry(row, now, ttlMs, arrivalAt).expired;
}
function createSecretaryNoticeArrivalStore(deps = {}) {
  const storage = deps.storage ?? null;
  const maxKeys = Math.max(1, Number(deps.maxKeys ?? MAX_NOTICE_ARRIVAL_KEYS));
  const memory = /* @__PURE__ */ new Map();
  const load = () => {
    if (storage === null) return;
    try {
      const raw = storage.getItem(NOTICE_ARRIVAL_STORAGE_KEY);
      if (raw === null || raw === "") return;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [key, value] of Object.entries(parsed)) {
        const ms = Number(value);
        if (key === "" || !Number.isFinite(ms) || ms <= 0) continue;
        if (!memory.has(key)) memory.set(key, ms);
      }
    } catch {
    }
  };
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(NOTICE_ARRIVAL_STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
    } catch {
    }
  };
  load();
  const prune = () => {
    if (memory.size <= maxKeys) return;
    const ordered = [...memory.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of ordered.slice(0, memory.size - maxKeys)) memory.delete(key);
  };
  return {
    at(cardKey) {
      const key = String(cardKey ?? "");
      if (key === "") return null;
      const value = memory.get(key);
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    },
    observe(cardKey, now = Date.now()) {
      const key = String(cardKey ?? "");
      if (key === "") return 0;
      const existing = memory.get(key);
      if (typeof existing === "number" && existing > 0) return existing;
      memory.set(key, now);
      prune();
      persist();
      return now;
    },
    observeAll(cardKeys, now = Date.now()) {
      let changed = false;
      for (const raw of cardKeys) {
        const key = String(raw ?? "");
        if (key === "") continue;
        if (memory.has(key)) continue;
        memory.set(key, now);
        changed = true;
      }
      if (changed) {
        prune();
        persist();
      }
    },
    prune,
    snapshot() {
      return Object.fromEntries(memory);
    },
    reset() {
      memory.clear();
      persist();
    }
  };
}
var noticeArrivalSingleton = null;
function noticeArrivalStore() {
  if (noticeArrivalSingleton !== null) return noticeArrivalSingleton;
  const g = globalThis;
  const storage = g.localStorage !== null && g.localStorage !== void 0 ? g.localStorage : null;
  noticeArrivalSingleton = createSecretaryNoticeArrivalStore({ storage });
  return noticeArrivalSingleton;
}
var COMPACT_SUMMARY_HINT_RE = /compact[^\n]{0,40}(?:已压缩[^\n]{0,40}条历史记录|Compacted[^\n]{0,40}history items)/i;
var COMPACT_FAILURE_HINT_RE = /Compaction could not produce a useful summary/i;
var COMPACT_HINT_ATTRIBUTE = "data-dsh-scard-compact";
function isCompactHintText(text) {
  const raw = String(text ?? "");
  return COMPACT_SUMMARY_HINT_RE.test(raw) || COMPACT_FAILURE_HINT_RE.test(raw);
}
function tagSecretaryCompactHintRows(doc) {
  let kindRows = 0;
  let textRows = 0;
  for (const row of doc.querySelectorAll("[data-chat-flow-kind]")) {
    if (row.querySelector('[data-dsh-scard="card"]') !== null) continue;
    const kind = String(row.getAttribute("data-chat-flow-kind") ?? "");
    const compactKind = kind === "compaction" || kind === "manual-compaction";
    if (compactKind) {
      row.setAttribute(COMPACT_HINT_ATTRIBUTE, "hint");
      kindRows += 1;
      continue;
    }
    if (isCompactHintText(row.textContent)) {
      row.setAttribute(COMPACT_HINT_ATTRIBUTE, "hint");
      textRows += 1;
    }
  }
  return { kindRows, textRows };
}
function clearSecretaryCompactHintRows(doc) {
  let cleared = 0;
  for (const row of doc.querySelectorAll(`[data-chat-flow-kind][${COMPACT_HINT_ATTRIBUTE}]`)) {
    row.removeAttribute(COMPACT_HINT_ATTRIBUTE);
    cleared += 1;
  }
  return cleared;
}
var PROCESS_VISIBLE_ATTRIBUTE = "data-dsh-process-visible";
var PROCESS_VISIBLE_KINDS = ["tool-call", "context", "model-retry", "turn-error", "turn-max-tokens"];
function tagLatestTurnProcessRows(doc, options) {
  const attribute = options?.attribute ?? PROCESS_VISIBLE_ATTRIBUTE;
  const kinds = options?.kinds ?? PROCESS_VISIBLE_KINDS;
  const anchorKinds = ["user", "steering"];
  const get = (el, name3) => String(el.getAttribute(name3) ?? "");
  const empty = { marked: 0, turnNo: "", anchorKind: "" };
  if (doc === null || doc === void 0) return empty;
  for (const el of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
    try {
      el.removeAttribute(attribute);
    } catch {
    }
  }
  const list = Array.from(doc.querySelectorAll("[data-chat-flow-kind], [data-chat-group-key], [data-turn-process-member]"));
  let anchorIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (anchorKinds.includes(get(list[i], "data-chat-flow-kind"))) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) return empty;
  const anchor = list[anchorIndex];
  const anchorKind = get(anchor, "data-chat-flow-kind");
  const turnNo = get(anchor, "data-chat-turn");
  let marked = 0;
  for (let i = anchorIndex + 1; i < list.length; i += 1) {
    const el = list[i];
    const kind = get(el, "data-chat-flow-kind");
    if (anchorKinds.includes(kind)) continue;
    const rowTurn = get(el, "data-chat-turn");
    if (turnNo !== "" && rowTurn !== "" && rowTurn !== turnNo) continue;
    if (typeof el.querySelector === "function" && el.querySelector("[data-dsh-scard]") !== null) continue;
    const groupPart = get(el, "data-chat-group-part");
    const isProcessRow = kinds.includes(kind) || kind === "assistant-step" && groupPart === "reasoning" || kind === "" && (el.hasAttribute("data-chat-group-key") || el.hasAttribute("data-turn-process-member"));
    if (!isProcessRow) continue;
    el.setAttribute(attribute, "1");
    marked += 1;
  }
  return { marked, turnNo, anchorKind };
}
function clearLatestTurnProcessTags(doc, options) {
  const attribute = options?.attribute ?? PROCESS_VISIBLE_ATTRIBUTE;
  let cleared = 0;
  for (const el of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
    try {
      el.removeAttribute(attribute);
      cleared += 1;
    } catch {
    }
  }
  return cleared;
}
var ASSISTANT_SECRETARY_QUOTE_ROUTE2 = "/api/assistant/secretary-quote";
var QUOTE_STORAGE_PREFIX = "dsh.assistant.secretary.quote:";
var QUOTE_BASELINE_STORAGE_PREFIX = "dsh.assistant.secretary.quote-baseline:";
var QUOTE_TTL_MS2 = 30 * 60 * 1e3;
var QUOTE_PREVIEW_MAX_CHARS2 = 600;
var QUOTE_CHIP_FLAG_TEXT = "\u5E26\u5F15\u7528";
var QUOTE_CHIP_CANCEL_TEXT = "\u53D6\u6D88\u5F15\u7528";
var QUOTE_CHIP_PREVIEW_MAX_CHARS = 34;
var QUOTE_CHIP_KIND_LABELS = {
  assistant: "\u79D8\u4E66\u56DE\u590D\u5361",
  user: "\u7528\u6237\u6D88\u606F\u5361",
  notice: "\u7CFB\u7EDF\u901A\u77E5\u5361"
};
function quoteTurnNumber(turnNo) {
  const raw = String(turnNo ?? "").trim();
  if (raw === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}
function quoteConsumedByUserRow(baseline, newest) {
  const newestKey = normalizeCardKey(newest?.cardKey);
  if (newestKey === "") return false;
  if (baseline === null) return false;
  const baselineKey = normalizeCardKey(baseline.cardKey);
  if (baselineKey === "") return false;
  const baselineTurn = quoteTurnNumber(baseline.turnNo);
  const newestTurn = quoteTurnNumber(newest.turnNo);
  if (baselineTurn !== null && newestTurn !== null) return newestTurn > baselineTurn;
  return newestKey !== baselineKey;
}
function latestRealUserCardRef(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (String(row?.kind ?? "") !== CARD_KIND_USER2) continue;
    return { cardKey: userCardSpeechKey(row.key, row.turnNo), turnNo: String(row.turnNo ?? "") };
  }
  return { cardKey: "", turnNo: "" };
}
function quoteTurnFromCardKey(cardKey) {
  const key = String(cardKey ?? "").trim();
  if (key === "") return "";
  const named = key.match(/^(?:assistant|user|notice):turn:(\d{1,6})$/);
  if (named) return named[1];
  const bare = key.match(/^(?:user|notice):(\d{1,6}):/);
  if (bare) return bare[1];
  return "";
}
function quoteChipVisible(secretarySessionId, slotSessionId) {
  const secretary = String(secretarySessionId ?? "");
  const slot = String(slotSessionId ?? "");
  return secretary !== "" && slot !== "" && secretary === slot;
}
function quoteChipPreview(preview, maxChars = QUOTE_CHIP_PREVIEW_MAX_CHARS) {
  const collapsed = String(preview ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  const limit = Math.max(1, Math.trunc(maxChars));
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}\u2026`;
}
function quoteChipParts(record) {
  if (record === null) return null;
  const kindLabel = QUOTE_CHIP_KIND_LABELS[record.kind] ?? "\u5361\u7247";
  const turnNumber = quoteTurnNumber(record.turnNo) ?? quoteTurnNumber(quoteTurnFromCardKey(record.cardKey));
  const turnLabel = turnNumber !== null ? `\u7B2C ${turnNumber} \u8F6E` : "\u8F6E\u6B21\u672A\u77E5";
  const preview = quoteChipPreview(record.preview);
  const meta = `${turnLabel} \xB7 ${kindLabel}`;
  const parts = {
    flag: QUOTE_CHIP_FLAG_TEXT,
    turnLabel,
    kindLabel,
    meta,
    preview,
    label: preview === "" ? `\u672C\u6761\u6D88\u606F\u5E26\u5F15\u7528\uFF1A\u63A5\u7740${meta}\u8BF4\uFF08\u53D1\u51FA\u53BB\u5373\u5931\u6548\uFF0C\u70B9\u53D6\u6D88\u5C31\u4E0D\u5E26\u5F15\u7528\uFF09` : `\u672C\u6761\u6D88\u606F\u5E26\u5F15\u7528\uFF1A\u63A5\u7740${meta}\u8BF4\uFF0C\u90A3\u5F20\u5361\u6B63\u6587\u5F00\u5934\u300C${preview}\u300D\uFF08\u53D1\u51FA\u53BB\u5373\u5931\u6548\uFF0C\u70B9\u53D6\u6D88\u5C31\u4E0D\u5E26\u5F15\u7528\uFF09`
  };
  return parts;
}
function quoteExpiryDelayMs(record, now = Date.now(), ttlMs = QUOTE_TTL_MS2) {
  if (record === null) return 0;
  const left = record.updatedAt + ttlMs - now;
  if (!(left > 0)) return 0;
  return Math.min(Math.max(1, Math.trunc(left)), 2147483647);
}
var QUOTE_BODY_MAX_CHARS2 = 2e4;
var QUOTE_ATTACHMENT_MAX2 = 12;
var QUOTE_ATTACHMENT_TEXT_MAX2 = 160;
var QUOTE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
function normalizeQuoteSessionIds2(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (id === "" || !QUOTE_SESSION_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}
function normalizeQuoteAttachments2(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const source = item;
    const name3 = String(source.name ?? "").trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX2);
    if (name3 === "") continue;
    const kind = String(source.kind ?? "").trim() === "image" ? "image" : "file";
    const meta = String(source.meta ?? "").trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX2);
    if (out.some((existing) => existing.name === name3 && existing.kind === kind)) continue;
    out.push({ name: name3, kind, meta });
    if (out.length >= QUOTE_ATTACHMENT_MAX2) break;
  }
  return out;
}
function normalizeQuoteBody2(raw) {
  const text = String(raw ?? "").trim();
  if (text.length <= QUOTE_BODY_MAX_CHARS2) return text;
  return `${text.slice(0, QUOTE_BODY_MAX_CHARS2)}
\uFF08\u5361\u6B63\u6587\u8D85\u8FC7 ${QUOTE_BODY_MAX_CHARS2} \u5B57\uFF0C\u5F15\u7528\u94FE\u8DEF\u53EA\u4FDD\u5230\u8FD9\u91CC\uFF1B\u540E\u9762\u8FD8\u6709 ${text.length - QUOTE_BODY_MAX_CHARS2} \u5B57\u672A\u6CE8\u5165\uFF09`;
}
function normalizeQuoteRecord2(raw, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : null;
  if (source === null) return null;
  const cardKey = normalizeCardKey(source.cardKey);
  const kind = String(source.kind ?? "").trim();
  if (cardKey === "" || kind !== CARD_KIND_ASSISTANT2 && kind !== CARD_KIND_USER2 && kind !== CARD_KIND_NOTICE2) return null;
  const previewRaw = String(source.preview ?? "");
  const preview = previewRaw.length > QUOTE_PREVIEW_MAX_CHARS2 ? `${previewRaw.slice(0, QUOTE_PREVIEW_MAX_CHARS2 - 1)}\u2026` : previewRaw;
  const updatedAtRaw = Number(source.updatedAt);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : now;
  return {
    cardKey,
    kind,
    turnNo: String(source.turnNo ?? "").trim(),
    preview,
    body: normalizeQuoteBody2(source.body),
    attachments: normalizeQuoteAttachments2(source.attachments),
    refSessionIds: normalizeQuoteSessionIds2(source.refSessionIds),
    updatedAt
  };
}
function quoteAlive2(record, now = Date.now(), ttlMs = QUOTE_TTL_MS2) {
  if (record === null) return false;
  return now - record.updatedAt <= ttlMs;
}
function createSecretaryQuoteStore(deps = {}) {
  const listeners = /* @__PURE__ */ new Set();
  const storage = deps.storage ?? null;
  const storageKey = QUOTE_STORAGE_PREFIX;
  const ttlMs = Number.isFinite(deps.ttlMs) && Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : QUOTE_TTL_MS2;
  let session = "";
  let version = 0;
  let active = null;
  let hostBroken = false;
  let hydrateCall = null;
  let latestUser = null;
  let baseline = null;
  let expiryTimer = null;
  const g = globalThis;
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const bump = () => {
    version += 1;
    emit();
  };
  const readCache = () => {
    if (storage === null || session === "") return null;
    try {
      return normalizeQuoteRecord2(JSON.parse(String(storage.getItem(`${storageKey}${session}`) ?? "null")));
    } catch {
      return null;
    }
  };
  const writeCache = (record) => {
    if (storage === null || session === "") return;
    try {
      storage.setItem(`${storageKey}${session}`, JSON.stringify(record));
    } catch {
    }
  };
  const readBaselineCache = () => {
    if (storage === null || session === "") return null;
    try {
      const raw = JSON.parse(String(storage.getItem(`${QUOTE_BASELINE_STORAGE_PREFIX}${session}`) ?? "null"));
      const cardKey = normalizeCardKey(raw?.cardKey);
      if (cardKey === "") return null;
      return { cardKey, turnNo: String(raw?.turnNo ?? "") };
    } catch {
      return null;
    }
  };
  const writeBaselineCache = (ref) => {
    if (storage === null || session === "") return;
    try {
      storage.setItem(`${QUOTE_BASELINE_STORAGE_PREFIX}${session}`, JSON.stringify(ref ?? null));
    } catch {
    }
  };
  const clearExpiryTimer = () => {
    if (expiryTimer === null) return;
    try {
      g.clearTimeout?.(expiryTimer);
    } catch {
    }
    expiryTimer = null;
  };
  const scheduleExpiry = (record) => {
    clearExpiryTimer();
    if (record === null) return;
    const delay = quoteExpiryDelayMs(record, Date.now(), ttlMs);
    if (typeof g.setTimeout !== "function") return;
    expiryTimer = g.setTimeout(() => {
      expiryTimer = null;
      if (active === null) return;
      if (quoteAlive2(active, Date.now(), ttlMs)) {
        scheduleExpiry(active);
        return;
      }
      baseline = null;
      writeBaselineCache(null);
      apply5(null, true);
    }, delay > 0 ? delay : 1);
    try {
      expiryTimer?.unref?.();
    } catch {
    }
  };
  const apply5 = (record, persistHost) => {
    active = record;
    writeCache(record);
    scheduleExpiry(record);
    bump();
    if (persistHost) void postQuote(record);
  };
  let pendingPost = null;
  const postQuote = (record) => {
    const fetchImpl = deps.fetchImpl;
    if (typeof fetchImpl !== "function") return Promise.resolve();
    if (session === "") {
      pendingPost = { record };
      return Promise.resolve();
    }
    pendingPost = null;
    const body = record === null ? { sessionId: session, mark: "clear" } : { sessionId: session, mark: "quote", ...record };
    return fetchImpl(ASSISTANT_SECRETARY_QUOTE_ROUTE2, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(() => {
      hostBroken = false;
    }, () => {
      hostBroken = true;
    });
  };
  return {
    session() {
      return session;
    },
    setSession(sessionId) {
      const id = String(sessionId ?? "");
      if (id === session) return;
      session = id;
      active = readCache();
      baseline = readBaselineCache();
      scheduleExpiry(active);
      bump();
      if (pendingPost !== null) {
        const queued = pendingPost.record;
        pendingPost = null;
        void postQuote(queued);
      }
    },
    active() {
      return quoteAlive2(active, Date.now(), ttlMs) ? active : null;
    },
    isQuoted(cardKey) {
      const current = quoteAlive2(active, Date.now(), ttlMs) ? active : null;
      return current !== null && current.cardKey === normalizeCardKey(cardKey);
    },
    setQuote(record) {
      const next = normalizeQuoteRecord2({
        cardKey: record.cardKey,
        kind: record.kind,
        turnNo: record.turnNo ?? "",
        preview: record.preview ?? "",
        body: record.body ?? "",
        attachments: record.attachments ?? [],
        refSessionIds: record.refSessionIds ?? [],
        updatedAt: Date.now()
      });
      if (next === null) return false;
      if (active !== null && active.cardKey === next.cardKey) return false;
      baseline = latestUser !== null && normalizeCardKey(latestUser.cardKey) !== "" ? { ...latestUser } : null;
      writeBaselineCache(baseline);
      apply5(next, true);
      return true;
    },
    clearQuote(cardKey) {
      const key = normalizeCardKey(cardKey);
      if (active === null) return false;
      if (key !== "" && active.cardKey !== key) return false;
      baseline = null;
      writeBaselineCache(null);
      apply5(null, true);
      return true;
    },
    noteLatestUserCard(ref) {
      const cardKey = normalizeCardKey(ref?.cardKey);
      latestUser = { cardKey, turnNo: String(ref?.turnNo ?? "") };
      if (active === null) return false;
      if (!quoteAlive2(active, Date.now(), ttlMs)) return false;
      if (baseline === null) {
        if (cardKey === "") return false;
        baseline = { ...latestUser };
        writeBaselineCache(baseline);
        return false;
      }
      if (!quoteConsumedByUserRow(baseline, latestUser)) return false;
      baseline = null;
      writeBaselineCache(null);
      apply5(null, false);
      return true;
    },
    baselineUserCard() {
      return baseline;
    },
    hydrate() {
      if (hydrateCall !== null) return hydrateCall;
      hydrateCall = (async () => {
        const cached2 = readCache();
        if (cached2 !== null && active === null) {
          active = cached2;
          baseline = readBaselineCache();
          scheduleExpiry(cached2);
          bump();
        }
        const fetchImpl = deps.fetchImpl;
        if (hostBroken || session === "" || typeof fetchImpl !== "function") {
          return { ok: true, hostOk: false, active: quoteAlive2(active, Date.now(), ttlMs) };
        }
        try {
          const res = await fetchImpl(`${ASSISTANT_SECRETARY_QUOTE_ROUTE2}?sessionId=${encodeURIComponent(session)}`, { cache: "no-store" });
          if (res?.ok !== true) {
            hostBroken = true;
            return { ok: true, hostOk: false, active: quoteAlive2(active, Date.now(), ttlMs) };
          }
          const payload = await res.json();
          if (payload?.ok !== true) {
            hostBroken = true;
            return { ok: true, hostOk: false, active: quoteAlive2(active, Date.now(), ttlMs) };
          }
          const fromHost = normalizeQuoteRecord2(payload?.quote);
          active = fromHost;
          writeCache(fromHost);
          if (fromHost === null) {
            baseline = null;
            writeBaselineCache(null);
          }
          scheduleExpiry(fromHost);
          bump();
          return { ok: true, hostOk: true, active: quoteAlive2(fromHost, Date.now(), ttlMs) };
        } catch {
          hostBroken = true;
          return { ok: true, hostOk: false, active: quoteAlive2(active, Date.now(), ttlMs) };
        }
      })();
      return hydrateCall;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    }
  };
}
var cardQuoteStore = null;
function secretaryQuoteStore() {
  if (cardQuoteStore !== null) return cardQuoteStore;
  const g = globalThis;
  const fetchImpl = typeof g.fetch === "function" ? (url, init) => g.fetch(url, init) : void 0;
  let storage = null;
  try {
    if (g.localStorage && typeof g.localStorage.getItem === "function") storage = g.localStorage;
  } catch {
    storage = null;
  }
  cardQuoteStore = createSecretaryQuoteStore({ fetchImpl, storage });
  return cardQuoteStore;
}
var secretaryCardsTestSurface = {
  normalizeForSpeech,
  stripSessionRefs,
  parseSessionRefs: parseSessionRefs2,
  parseAttachRefs,
  stripAttachRefs,
  ATTACH_IMAGE_EXTENSIONS,
  attachExtensionOf,
  isAttachImage,
  attachTypeBadge,
  attachFileUrl,
  attachDownloadUrl,
  attachOpenViaDownload,
  formatFileSize,
  splitSpeechChunks,
  SPEECH_CHUNK_MIN_CHARS,
  SPEECH_CHUNK_MAX_CHARS,
  SPEECH_CHUNK_FIRST_MAX_CHARS,
  reduceSpeech,
  createSpeechController,
  SPEECH_IDLE,
  latestTurnNo,
  latestReplyTurnNo,
  collectTurnText,
  badgeTone,
  splitItemPrefix,
  itemIcon,
  summarize,
  parseAnswerBody,
  answerInlineTokens,
  formatClock,
  CARD_KIND_ASSISTANT: CARD_KIND_ASSISTANT2,
  CARD_KIND_USER: CARD_KIND_USER2,
  CARD_KIND_NOTICE: CARD_KIND_NOTICE2,
  FOLD_BODY_LINE_BUDGET,
  FOLD_TITLE_LINE_BUDGET,
  FOLD_BLOCK_GAP,
  FOLD_FALLBACK_LINE_HEIGHT_PX,
  foldCollapsedCapPx,
  isSyntheticNoticeUserText,
  stripNoticeSyntheticHead,
  parseNoticeCardBody,
  parseUserCardBody,
  userCardSpeechKey,
  noticeCardSpeechKey,
  assistantCardSpeechKey,
  formatUserCardClock,
  collectSecretaryUserRows,
  collectSecretaryCardRows,
  SECRETARY_USER_ROW_SELECTOR,
  SECRETARY_USER_FLOW_KINDS,
  USER_FLOW_KIND_USER,
  USER_FLOW_KIND_STEERING,
  collectSecretaryCardElements,
  collectUserCardRuns,
  userCardRunText,
  userCardAttachments,
  buildUserCardBody,
  USER_TEXT_RUN_SELECTOR,
  USER_ATTACHMENT_ROW_SELECTOR,
  USER_IMAGES_SLOT_SELECTOR,
  buildSecretaryPagerCards,
  foldClipFromBlocks,
  cardFoldStyle,
  NOTICE_CARD_TTL_MS,
  NOTICE_CLOCK_MINUTE_MS,
  NOTICE_ARRIVAL_STORAGE_KEY,
  MAX_NOTICE_ARRIVAL_KEYS,
  noticeExpiryFromClock,
  noticeExpiry,
  nearestNoticeExpiryMs,
  noticeCardExpired,
  createSecretaryNoticeArrivalStore,
  noticeArrivalStore,
  COMPACT_HINT_ATTRIBUTE,
  COMPACT_SUMMARY_HINT_RE,
  COMPACT_FAILURE_HINT_RE,
  isCompactHintText,
  tagSecretaryCompactHintRows,
  clearSecretaryCompactHintRows,
  PROCESS_VISIBLE_ATTRIBUTE,
  PROCESS_VISIBLE_KINDS,
  tagLatestTurnProcessRows,
  clearLatestTurnProcessTags,
  ASSISTANT_SECRETARY_QUOTE_ROUTE: ASSISTANT_SECRETARY_QUOTE_ROUTE2,
  QUOTE_STORAGE_PREFIX,
  QUOTE_BASELINE_STORAGE_PREFIX,
  QUOTE_TTL_MS: QUOTE_TTL_MS2,
  QUOTE_PREVIEW_MAX_CHARS: QUOTE_PREVIEW_MAX_CHARS2,
  QUOTE_BODY_MAX_CHARS: QUOTE_BODY_MAX_CHARS2,
  QUOTE_ATTACHMENT_MAX: QUOTE_ATTACHMENT_MAX2,
  QUOTE_CHIP_FLAG_TEXT,
  QUOTE_CHIP_CANCEL_TEXT,
  QUOTE_CHIP_PREVIEW_MAX_CHARS,
  QUOTE_CHIP_KIND_LABELS,
  normalizeQuoteRecord: normalizeQuoteRecord2,
  normalizeQuoteSessionIds: normalizeQuoteSessionIds2,
  normalizeQuoteAttachments: normalizeQuoteAttachments2,
  normalizeQuoteBody: normalizeQuoteBody2,
  quoteAlive: quoteAlive2,
  quoteTurnNumber,
  quoteConsumedByUserRow,
  latestRealUserCardRef,
  quoteChipVisible,
  quoteChipPreview,
  quoteChipParts,
  quoteExpiryDelayMs,
  quoteTurnFromCardKey,
  createSecretaryQuoteStore,
  secretaryQuoteStore,
  ASSISTANT_SECRETARY_READ_ROUTE: ASSISTANT_SECRETARY_READ_ROUTE2,
  READ_STORAGE_PREFIX,
  MAX_READ_KEYS,
  normalizeCardKey,
  normalizeReadKeys,
  createSecretaryReadStore,
  secretaryReadStore,
  ASSISTANT_SECRETARY_HISTORY_ROUTE: ASSISTANT_SECRETARY_HISTORY_ROUTE2,
  createSecretaryPager,
  secretaryPager,
  collapsedCardTitle,
  scrollAnchorTopPatch,
  HISTORY_FOLLOW_BOTTOM_PX,
  planHistoryScrollRestore,
  pickHistoryAnchorKey,
  captureHistoryScrollSnapshot,
  HISTORY_CARD_ROW_SELECTOR,
  startHistoryScrollGuard,
  HISTORY_GUARD_MAX_MS,
  HISTORY_GUARD_QUIET_FRAMES,
  HISTORY_GUARD_MIN_MS,
  HISTORY_GUARD_MISSING_GRACE_FRAMES,
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  truncateCardTitle,
  truncatePreview,
  countWords,
  windowOfItems,
  canRenderMore,
  shouldExpandOnScroll
};

// src/client/pocket/orb/secretary-speech-flight.ts
var SPEECH_FLIGHT_KEY = "__dshSecretarySpeechFlight";
var SPEECH_FLIGHT_VERSION = 2;
function createSpeechFlightBus() {
  let current = 0;
  const flights = /* @__PURE__ */ new Map();
  const runAll = (set) => {
    for (const cancel of [...set]) {
      try {
        cancel();
      } catch {
      }
    }
  };
  const bus = {
    version: SPEECH_FLIGHT_VERSION,
    begin() {
      for (const [token, set] of [...flights]) {
        if (token <= current) runAll(set);
      }
      flights.clear();
      current += 1;
      flights.set(current, /* @__PURE__ */ new Set());
      return current;
    },
    current() {
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    cancel(token) {
      const set = flights.get(token);
      if (set === void 0) return;
      flights.delete(token);
      runAll(set);
    },
    cancelAll() {
      for (const set of [...flights.values()]) runAll(set);
      flights.clear();
    },
    register(cancel, token) {
      const set = flights.get(token);
      if (set === void 0 || token !== current) {
        try {
          cancel();
        } catch {
        }
        return () => {
        };
      }
      let live = true;
      const wrapped = () => {
        if (!live) return;
        live = false;
        try {
          cancel();
        } catch {
        }
      };
      set.add(wrapped);
      return () => {
        live = false;
        set.delete(wrapped);
      };
    }
  };
  return bus;
}
function speechFlightBus(root = globalThis) {
  const host = root;
  const existing = host?.[SPEECH_FLIGHT_KEY];
  if (existing !== void 0 && existing !== null && existing.version === SPEECH_FLIGHT_VERSION && typeof existing.begin === "function" && typeof existing.register === "function") {
    return existing;
  }
  try {
    existing?.cancelAll?.();
  } catch {
  }
  const bus = createSpeechFlightBus();
  try {
    host[SPEECH_FLIGHT_KEY] = bus;
  } catch {
  }
  return bus;
}
var secretarySpeechFlightTestSurface = {
  SPEECH_FLIGHT_KEY,
  SPEECH_FLIGHT_VERSION,
  createSpeechFlightBus,
  speechFlightBus
};

// src/client/pocket/orb/secretary-speech-pipeline.ts
function speechClipCacheKey(text) {
  const s = String(text);
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `sp1:${s.length}:${hash.toString(16).padStart(8, "0")}`;
}
function createSpeechClipCache(limit = 64) {
  const map = /* @__PURE__ */ new Map();
  const capped = Math.max(1, limit);
  return {
    get(key) {
      const clip = map.get(key);
      if (clip !== void 0) {
        map.delete(key);
        map.set(key, clip);
      }
      return clip;
    },
    set(key, clip) {
      if (map.has(key)) map.delete(key);
      map.set(key, clip);
      while (map.size > capped) {
        const oldest = map.keys().next().value;
        if (oldest === void 0) break;
        map.delete(oldest);
      }
    }
  };
}
var abortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};
function createChunkPipeline(io, options) {
  const text = String(options.text ?? "");
  const prefetch = Math.max(1, options.prefetch ?? 2);
  const leadInSec = options.leadInSec ?? 0.03;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const cache3 = options.cache ?? void 0;
  const flight = options.flight ?? speechFlightBus();
  let generation = 0;
  let endedCb = null;
  let playingCb = null;
  let errorCb = null;
  const stats = { scheduled: 0, underruns: 0 };
  let current = null;
  async function synthOne(chunk, signal, gen) {
    const key = speechClipCacheKey(chunk);
    const hit = cache3?.get(key);
    if (hit !== void 0) return hit;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || gen !== generation) throw abortError();
      try {
        const clip = await io.synthesize(chunk, signal);
        if (signal.aborted || gen !== generation) throw abortError();
        cache3?.set(key, clip);
        return clip;
      } catch (error) {
        if (signal.aborted || gen !== generation || error?.name === "AbortError") throw abortError();
        lastError = error;
        if (attempt === 0 && retryDelayMs > 0 && typeof io.wait === "function") {
          try {
            await io.wait(retryDelayMs);
          } catch {
          }
          if (signal.aborted || gen !== generation) throw abortError();
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("TTS \u5408\u6210\u5931\u8D25");
  }
  function swallow(state) {
    for (const off of state.unregisters) {
      try {
        off();
      } catch {
      }
    }
    state.unregisters.length = 0;
    for (const ac of state.aborts) {
      try {
        ac.abort();
      } catch {
      }
    }
    for (const pb of state.playbacks) {
      try {
        pb.stop();
      } catch {
      }
    }
    for (const p of state.results) {
      p?.catch(() => {
      });
    }
  }
  const alive = (state) => state.gen === generation && flight.isCurrent(state.token);
  async function run(state, chunks, firstResolve, firstReject) {
    let scheduleEnd = 0;
    let firstScheduled = false;
    let lastPlayback = null;
    const requestOne = (index) => {
      const ac = new AbortController();
      state.aborts.push(ac);
      const p = synthOne(chunks[index], ac.signal, state.gen);
      p.catch(() => {
      });
      state.results[index] = p;
      state.requestIndex = index + 1;
    };
    try {
      for (let index = 0; index < chunks.length; index++) {
        while (state.requestIndex < chunks.length && state.requestIndex - index < prefetch) requestOne(state.requestIndex);
        const clip = await state.results[index];
        if (!alive(state)) return;
        const startAt = Math.max(io.now() + leadInSec, scheduleEnd);
        if (firstScheduled && startAt > scheduleEnd + 5e-3) {
          stats.underruns += 1;
          try {
            options.onUnderrun?.({ index, lateSec: startAt - scheduleEnd });
          } catch {
          }
        }
        if (!alive(state)) return;
        const playback = io.schedule(clip, startAt);
        state.unregisters.push(flight.register(() => {
          try {
            playback.stop();
          } catch {
          }
        }, state.token));
        playback.finished.catch(() => {
        });
        state.playbacks.push(playback);
        scheduleEnd = startAt + Math.max(0, clip.durationSec);
        stats.scheduled += 1;
        if (!firstScheduled) {
          firstScheduled = true;
          firstResolve();
          try {
            playingCb?.();
          } catch {
          }
        }
        lastPlayback = playback;
      }
      if (lastPlayback !== null) {
        void lastPlayback.finished.then(() => {
          if (alive(state)) {
            try {
              endedCb?.();
            } catch {
            }
          }
        });
      } else {
        try {
          endedCb?.();
        } catch {
        }
      }
    } catch (error) {
      if (state.gen !== generation) return;
      const message = String(error?.message ?? error ?? "TTS \u5408\u6210\u5931\u8D25");
      swallow(state);
      try {
        errorCb?.(message);
      } catch {
      }
      if (!firstScheduled) firstReject(error instanceof Error ? error : new Error(message));
    }
  }
  const play = () => {
    generation += 1;
    const gen = generation;
    if (current !== null) swallow(current);
    const token = flight.begin();
    const state = { gen, token, aborts: [], playbacks: [], unregisters: [], results: [], requestIndex: 0 };
    current = state;
    try {
      io.resume?.();
    } catch {
    }
    const chunks = splitSpeechChunks(text, options);
    return new Promise((resolve, reject) => {
      void run(state, chunks, resolve, reject).catch(() => {
      });
    });
  };
  return {
    play,
    pause() {
      try {
        io.suspend?.();
      } catch {
      }
    },
    resume() {
      try {
        io.resume?.();
      } catch {
      }
    },
    restart() {
      void play();
    },
    stop() {
      generation += 1;
      if (current !== null) {
        const state = current;
        swallow(state);
        current = null;
        flight.cancel(state.token);
      }
    },
    onEnded(cb) {
      endedCb = cb;
    },
    onPlaying(cb) {
      playingCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
    stats() {
      return { ...stats };
    }
  };
}
var secretarySpeechPipelineTestSurface = {
  createChunkPipeline,
  createSpeechClipCache,
  speechClipCacheKey
};

// src/assistant.ts
var FOCUS_DIAG_LOG = joinPathNode(homedir10(), ".dsh", "dsh-assistant-focus.log");
function appendFocusDiag(raw) {
  const text = String(raw ?? "").slice(0, 8e3);
  if (!text) return;
  try {
    if (statSync9(FOCUS_DIAG_LOG).size > 512 * 1024) writeFileSync16(FOCUS_DIAG_LOG, "");
  } catch {
  }
  appendFileSync3(FOCUS_DIAG_LOG, text.replace(/\s+/g, " ") + "\n", "utf8");
}
var name2 = "dsh-assistant";
var inject = ["webServer", "sessions", "tools"];
function apply4(ctx, config = {}) {
  const disposers = [];
  const routes = manageWebRoutes(ctx.webServer);
  const webServer = routes.webServer;
  disposers.push(routes.dispose);
  const registerPiece = (label, fn) => {
    try {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (err) {
      try {
        ctx.logger?.("dsh-assistant")?.error?.(`${label} failed: %s`, String(err));
      } catch {
      }
    }
  };
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
    const dispose = apply3?.(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("turn-guard half failed: %s", String(err));
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
    appendOpenDiag({ step: "host-click-intent", intent, waiters: clickWaiters.size, source: "desktop-ball" });
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, intent);
  };
  disposers.push(() => {
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, null);
  });
  const readBallState = () => {
    let enabled = true;
    let avatar = "";
    try {
      const parsed = JSON.parse(readFileSync16(ballStateFile, "utf8"));
      if (parsed && typeof parsed.enabled === "boolean") enabled = parsed.enabled;
    } catch {
    }
    try {
      avatar = readFileSync16(ballAvatarFile, "utf8");
    } catch {
    }
    return { enabled, avatar };
  };
  const ballState = readBallState();
  const saveBallState = () => {
    try {
      if (ballStateFile) {
        mkdirSync16(ballDir, { recursive: true });
        writeFileSync16(ballStateFile, JSON.stringify({ enabled: ballState.enabled }), "utf8");
      }
      if (ballAvatarFile) {
        if (ballState.avatar) writeFileSync16(ballAvatarFile, ballState.avatar, "utf8");
        else rmSync5(ballAvatarFile, { force: true });
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
  registerPiece("assistant secretary", () => registerAssistantSecretary(ctx));
  registerPiece("assistant secretary history", () => registerAssistantSecretaryHistory(ctx));
  registerPiece("assistant secretary context", () => registerAssistantSecretaryContext(ctx));
  registerPiece("assistant dispatch", () => registerAssistantDispatch(ctx));
  registerPiece("assistant cu watch", () => registerAssistantCuWatch(ctx));
  registerPiece("assistant proactive", () => registerAssistantProactive(ctx));
  registerPiece("assistant tts", () => registerAssistantTts(ctx));
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
        const gestures = {
          shortPress: BALL_GESTURE_INTENT["short-press"],
          longPress: BALL_GESTURE_INTENT["long-press"],
          hotkey: BALL_GESTURE_INTENT.hotkey
        };
        const payload = JSON.stringify({ native: nativeBall, enabled: ballState.enabled, hasAvatar: !!ballState.avatar, gestures });
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
        appendOpenDiag({ step: "host-open-request", intent: "console", source: "open-console" });
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
        appendOpenDiag({ step: "host-open-request", intent: "assistant", source: "open-assistant" });
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
    registerAssistantOpenDiagRoute(webServer);
    webServer.register({
      kind: "exact",
      path: "/api/assistant/ball-click",
      handler: (req, res) => {
        const pending = takeOpenClick();
        if (pending !== null) {
          appendOpenDiag({ step: "host-click-pull", intent: pending, source: "ball-click" });
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
    webServer.register({
      kind: "exact",
      path: "/api/assistant/capabilities",
      handler: (_req, res) => {
        let nativeFocus = { available: false, reason: "unknown" };
        try {
          nativeFocus = nativeFocusAvailability();
        } catch {
        }
        const payload = JSON.stringify({
          ok: true,
          platform: process.platform,
          nativeFocus,
          desktopBall: nativeBall,
          electron: Boolean(process.versions.electron)
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(payload);
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
  ESCAPE_HATCH_FILENAME,
  LOCAL_FILE_MAX_BYTES,
  OPEN_DIAG_PATH,
  appendOpenDiag,
  apply4 as apply,
  assertHostReadableArtifact,
  assertSessionLogFileAccepted,
  assistantArchiveTestSurface,
  assistantConfigTestSurface,
  assistantCuWatchTestSurface,
  assistantDiagnosticsTestSurface,
  assistantDispatchTestSurface,
  assistantMemoryTestSurface,
  assistantProactiveTestSurface,
  assistantSecretaryContextTestSurface,
  assistantSecretaryHistoryTestSurface,
  assistantSecretaryTestSurface,
  assistantTtsTestSurface,
  collectArchive,
  compressLogText,
  createPathGuard,
  decompressLogBytes,
  defaultAllowedRoots,
  defaultHostParserPaths,
  defaultSessionLogBackupPath,
  desktopBallTestSurface,
  escapeHatchStatus,
  escapeHatchTestSurface,
  expandHome,
  fileDispositionTestSurface,
  handleOpenDiag,
  importArchiveBundle,
  inject,
  isDirectory,
  loadHostLogParser,
  localFileRouteTestSurface,
  minimalTermEnv,
  name2 as name,
  parseLogText,
  readOpenDiagTail,
  redactText,
  registerAssistantArchive,
  registerAssistantDiagnostics,
  registerAssistantHome,
  registerAssistantOpenDiagRoute,
  renderDiagnosticsBundle,
  rewriteSessionLogFileSync,
  scanHostZstdFrames,
  secretCardSharedTestSurface,
  secretaryCardsTestSurface,
  secretarySpeechFlightTestSurface,
  secretarySpeechPipelineTestSurface,
  turnGuardTestSurface,
  writeArchiveBundle,
  writeDiagnosticsBundle
};
