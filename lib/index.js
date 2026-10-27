// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve as pathResolve, sep } from "node:path";
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

// src/index.ts
import { homedir } from "node:os";
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
  const value = env !== void 0 && env.trim().length > 0 ? env : pathResolve(homedir(), ".dsh");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return pathResolve(homedir(), value.slice(2));
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
var PLUGIN_VERSION = false ? "dev" : "0.2.5";
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
    starts.add(dirname(fileURLToPath(import.meta.url)));
  } catch {
  }
  try {
    starts.add(realpathSync(dirname(fileURLToPath(import.meta.url))));
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
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
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
async function readJsonBody(req) {
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
  const raw = await Promise.all(dirents.map(async (d) => {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(abs + sep + d.name)).mtimeMs;
    } catch {
    }
    return { name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith("."), mtimeMs };
  }));
  const entries = raw.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  const truncated = entries.length > MAX_ENTRIES;
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated };
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
function setupTerminal(webServer, ctx) {
  if (typeof webServer.registerUpgrade !== "function") return;
  const wsMod = loadPkg("ws");
  const ptyMod = loadPkg("node-pty");
  ctx.logger?.info?.("[dsh-worktable] term deps: ws=" + (wsMod ? "ok" : "MISSING") + " node-pty=" + (ptyMod ? "ok" : "MISSING"));
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn("[dsh-worktable] \u7EC8\u7AEF\u8DEF\u7531\u672A\u6CE8\u518C\uFF1Aws/node-pty \u4E0D\u53EF\u7528");
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
        const cols = clampDim(Number(u.searchParams.get("cols")), 80);
        const rows = clampDim(Number(u.searchParams.get("rows")), 24);
        let term = null;
        try {
          const shell = spawnShell();
          term = pty.spawn(shell.cmd, shell.args, { name: "xterm-256color", cols, rows, cwd, env: process.env });
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
  }), "dsh-worktable: terminal upgrade");
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
    let name2 = "";
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
      if (key === "name") name2 = val;
      else description = val;
    }
    if (!name2 && !description) return null;
    return { name: name2, description };
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
    { path: pathResolve(homedir(), ".agents", "skills"), source: "user-agents" }
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
    ctx?.logger?.warn?.("[dsh-worktable] ctx.skills \u4E0D\u53EF\u7528\uFF0C\u56DE\u9000\u626B\u63CF\u6280\u80FD\u76EE\u5F55\uFF1A" + String(err));
  }
  if (fromService.length > 0) return { skills: fromService, source: "service", skipped: [] };
  const scanned = await scanSkillDirs(cwd);
  return { skills: scanned.skills, source: "scan", skipped: scanned.skipped };
}
function apply(ctx) {
  const server = ctx.webServer;
  if (!server) {
    ctx.logger?.warn("[dsh-worktable] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531");
    return;
  }
  const routes = manageWebRoutes(server);
  const webServer = routes.webServer;
  try {
    webServer.register({
      kind: "exact",
      path: HEALTH_PATH,
      handler: (_req, res) => {
        json(res, 200, { plugin: "dsh-worktable", version: PLUGIN_VERSION, ok: true });
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
          const root = pathResolve(rootToken);
          let abs = pathResolve(root, rel);
          if (abs !== root && !abs.startsWith(root + sep)) {
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
          const body = await readJsonBody(req);
          const path = typeof body.path === "string" && body.path ? body.path : serverCwd(ctx, body.sessionId, body.cwd);
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
          const { skills, source, skipped } = await listSkills(ctx, cwd);
          if (skipped.length > 0) {
            ctx?.logger?.info?.("[dsh-worktable] \u6280\u80FD\u76EE\u5F55\u4E2D\u4EE5\u4E0B\u6761\u76EE\u56E0\u6280\u80FD\u540D\u975E\u6CD5\u4E0D\u53EF\u7528\uFF08\u4E0D\u5F71\u54CD\u5176\u5B83\u6280\u80FD\uFF09\uFF1A" + skipped.join("\uFF1B"));
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
          const body = await readJsonBody(req);
          const p = typeof body.path === "string" ? body.path : "";
          const content = typeof body.content === "string" ? body.content : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
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
          const body = await readJsonBody(req);
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
          const abs = pathResolve(p);
          const fsx = await import("node:fs/promises");
          const parent = dirname(abs);
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
        const body = await readJsonBody(req);
        const cwd = serverCwd(ctx, body.sessionId, body.cwd);
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
          const body = await readJsonBody(req);
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) {
            json(res, 400, { error: "missing path" });
            return;
          }
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
    setupTerminal(webServer, ctx);
    return routes.dispose;
  } catch (err) {
    routes.dispose();
    throw err;
  }
}

// src/tuoguan-host.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
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
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { off: {}, on: {}, defaultOn: true, revision: 0, updatedAt: "" };
  }
}
function writeStateSync(file, state) {
  const payload = `${JSON.stringify(state, void 0, 2)}
`;
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname2(file), { recursive: true });
  writeFileSync(temporary, payload, "utf8");
  renameSync(temporary, file);
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
function sendJson(res, status, body) {
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
async function readJsonBody2(req) {
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
      sendJson(res, 200, await store.read());
      return;
    }
    if (path === STATE_ROUTE && method === "POST") {
      const body = await readJsonBody2(req);
      if (typeof body.defaultOn === "boolean") {
        sendJson(res, 200, await store.setDefault(body.defaultOn));
        return;
      }
      const sessionId = body.sessionId;
      const on = body.on;
      if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH) {
        sendJson(res, 400, { error: "invalid-session" });
        return;
      }
      if (typeof on !== "boolean") {
        sendJson(res, 400, { error: "invalid-on" });
        return;
      }
      sendJson(res, 200, await store.setSession(sessionId, on));
      return;
    }
    if (path === STATE_ROUTE) {
      res.writeHead(405, { allow: "GET, POST, OPTIONS" });
      res.end();
      return;
    }
    sendJson(res, 404, { error: "not-found" });
  } catch (error) {
    const status = error?.status;
    if (status === 413) {
      sendJson(res, 413, { error: "too-large" });
      return;
    }
    if (!res.headersSent) sendJson(res, 500, { error: "internal", message: String(error?.message ?? error) });
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
  const store = new TuoguanStore(join(directory, STATE_FILENAME));
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
import { dirname as dirname3, join as join2 } from "node:path";
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
function sendJson2(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
async function readJsonBody3(req) {
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
  const file = join2(profileDir(ctx), STATE_FILENAME2);
  let cached = null;
  let loaded = false;
  let chain = Promise.resolve();
  const readState = async () => {
    if (loaded) return cached;
    try {
      cached = normalize(JSON.parse(await readFile2(file, "utf8")));
    } catch {
      cached = null;
    }
    loaded = true;
    return cached;
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
      await mkdir(dirname3(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
      cached = next;
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
        sendJson2(res, 404, { error: "not-found" });
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
          sendJson2(res, 200, { ok: true, state });
          return;
        }
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody3(req);
          if (!body.projects || typeof body.projects !== "object" || Array.isArray(body.projects)) {
            sendJson2(res, 400, { error: "invalid-projects" });
            return;
          }
          const base = typeof body.baseRevision === "number" ? body.baseRevision : null;
          const out = await writeState(body.projects, body.view ?? null, base);
          if (out && typeof out === "object" && "conflict" in out) {
            sendJson2(res, 409, { ok: false, conflict: true, state: out.conflict });
            return;
          }
          sendJson2(res, 200, { ok: true, state: out });
          return;
        }
        res.writeHead(405, { allow: "GET, PUT, POST" });
        res.end();
      } catch (err) {
        if (err?.status === 413) {
          sendJson2(res, 413, { error: "too-large" });
          return;
        }
        sendJson2(res, 500, { error: "internal", message: String(err?.message ?? err) });
      }
    }
  });
  return routes.dispose;
}

// src/coordinate-mode.ts
import { mkdir as mkdir2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname4, join as join3 } from "node:path";
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
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    if (parsed && typeof parsed.enabled === "boolean") return parsed.enabled;
  } catch {
  }
  return defaultMillifraction();
}
function sendJson3(res, status, body) {
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
  const file = join3(profileDir2(ctx), SETTINGS_FILE);
  let enabled = readMillifraction(file);
  const currentMode = () => enabled ? "millifraction" : "pixel";
  const setEnabled = async (next) => {
    const previous = enabled;
    enabled = next;
    try {
      await mkdir2(dirname4(file), { recursive: true });
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
            sendJson3(res, 200, {
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
              sendJson3(res, 400, { ok: false, error: "invalid-enabled" });
              return;
            }
            await setEnabled(body.enabled);
            sendJson3(res, 200, {
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
          sendJson3(res, 500, { ok: false, error: "internal", message: String(err?.message ?? err) });
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

// src/desktop-ball.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync as mkdirSync2, openSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
function dshHome() {
  return process.env.DSH_HOME || join4(homedir2(), ".dsh");
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
  return dshHome();
}
function ballProfileDir(ctx) {
  return join4(profileDir3(ctx), "dsh-assistant-ball");
}
function findElectron() {
  const candidates = [
    join4(dshHome(), "dsh-orb", "electron-runtime", "electron.exe"),
    join4(dshHome(), "dsh-assistant", "electron", "electron.exe"),
    process.env.DSH_ASSISTANT_ELECTRON || ""
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
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
let down = false, sx = 0, sy = 0, moved = 0
b.addEventListener('mousedown', (e) => { if (e.button !== 0) return; down = true; moved = 0; sx = e.screenX; sy = e.screenY; ipcRenderer.send('ball-down', { x: sx, y: sy }) })
window.addEventListener('mousemove', (e) => { if (!down) return; moved = Math.max(moved, Math.hypot(e.screenX - sx, e.screenY - sy)); ipcRenderer.send('ball-move', { x: e.screenX, y: e.screenY }) })
window.addEventListener('mouseup', () => { if (!down) return; down = false; ipcRenderer.send('ball-up', { moved }) })
</script></body></html>`;
var HELPER_MAIN = `const { app, BrowserWindow, ipcMain, screen } = require('electron')
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
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true, show: false,
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
  connect()
})
app.on('window-all-closed', () => { try { app.quit() } catch {} })
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
  try {
    console.error("[dsh-assistant] \u684C\u9762\u60AC\u6D6E\u7403\uFF1A\u4F7F\u7528", exe);
  } catch {
  }
  const dir = join4(profileDir3(ctx), "dsh-assistant-ball");
  try {
    mkdirSync2(dir, { recursive: true });
    writeFileSync2(join4(dir, "package.json"), JSON.stringify({ name: "dsh-assistant-ball", version: "1.0.0", main: "main.js" }), "utf8");
    writeFileSync2(join4(dir, "main.js"), HELPER_MAIN, "utf8");
    const avatar = String(opts.avatar ?? "").trim();
    const safeAvatar = avatar.startsWith("data:image/") ? avatar.replace(/"/g, "&quot;") : "";
    const avatarScript = safeAvatar ? `<script>document.getElementById('b').innerHTML=${JSON.stringify(`<img src="${safeAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none" alt="">`)}</script>` : "";
    writeFileSync2(join4(dir, "index.html"), BALL_HTML.replace("</body>", `${avatarScript}</body>`), "utf8");
  } catch (err) {
    try {
      console.error("[dsh-assistant] \u5199\u60AC\u6D6E\u7403 helper \u5931\u8D25\uFF1A", err);
    } catch {
    }
    return null;
  }
  const token = randomBytes(16).toString("hex");
  let pendingClick = false;
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
        if (text === "click") {
          pendingClick = true;
          for (const listener of [...clickListeners]) {
            try {
              listener();
            } catch {
            }
          }
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
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RUN_AS_NODE_OPTIONS;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    let logFd = "ignore";
    try {
      logFd = openSync(join4(dir, "helper.log"), "a");
    } catch {
    }
    child = spawn(exe, [dir, "--port", String(port), "--token", token], {
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
  const dispose = () => {
    pendingClick = false;
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
  };
  return {
    dispose,
    takeClick: () => {
      const v = pendingClick;
      pendingClick = false;
      return v;
    },
    onClick: (listener) => {
      clickListeners.add(listener);
      return () => {
        clickListeners.delete(listener);
      };
    }
  };
}

// src/assistant.ts
import { appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, rmSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as joinPathNode } from "node:path";
var FOCUS_DIAG_LOG = joinPathNode(homedir3(), ".dsh", "dsh-assistant-focus.log");
function appendFocusDiag(raw) {
  const text = String(raw ?? "").slice(0, 8e3);
  if (!text) return;
  try {
    if (statSync(FOCUS_DIAG_LOG).size > 512 * 1024) writeFileSync3(FOCUS_DIAG_LOG, "");
  } catch {
  }
  appendFileSync(FOCUS_DIAG_LOG, text.replace(/\s+/g, " ") + "\n", "utf8");
}
var name = "dsh-assistant";
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
  let pendingOpenConsole = false;
  const clickWaiters = /* @__PURE__ */ new Set();
  const sendClick = (res, open) => {
    if (res?.destroyed || res?.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ open, longPoll: true }));
  };
  const finishClickWaiter = (waiter, open, respond = true) => {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    clickWaiters.delete(waiter);
    if (respond) {
      try {
        sendClick(waiter.res, open);
      } catch {
      }
    }
  };
  const takeOpenClick = () => {
    let open = ballHandle ? ballHandle.takeClick() === true : false;
    if (pendingOpenConsole) {
      pendingOpenConsole = false;
      open = true;
    }
    return open;
  };
  const wakeClickWaiters = () => {
    for (const waiter of [...clickWaiters]) {
      if (takeOpenClick()) finishClickWaiter(waiter, true);
    }
  };
  disposers.push(() => {
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, false);
  });
  const readBallState = () => {
    let enabled = true;
    let avatar = "";
    try {
      const parsed = JSON.parse(readFileSync3(ballStateFile, "utf8"));
      if (parsed && typeof parsed.enabled === "boolean") enabled = parsed.enabled;
    } catch {
    }
    try {
      avatar = readFileSync3(ballAvatarFile, "utf8");
    } catch {
    }
    return { enabled, avatar };
  };
  const ballState = readBallState();
  const saveBallState = () => {
    try {
      if (ballStateFile) {
        mkdirSync3(ballDir, { recursive: true });
        writeFileSync3(ballStateFile, JSON.stringify({ enabled: ballState.enabled }), "utf8");
      }
      if (ballAvatarFile) {
        if (ballState.avatar) writeFileSync3(ballAvatarFile, ballState.avatar, "utf8");
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
        pendingOpenConsole = true;
        wakeClickWaiters();
        const payload = JSON.stringify({ ok: true, opened: true });
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
        if (takeOpenClick()) {
          sendClick(res, true);
          return;
        }
        const wantsWait = /[?&]wait=1(?:&|$)/.test(String(req.url ?? ""));
        if (!wantsWait) {
          sendClick(res, false);
          return;
        }
        const waiter = { res, timer: null, done: false };
        waiter.timer = setTimeout(() => finishClickWaiter(waiter, false), 15e3);
        clickWaiters.add(waiter);
        req.on("close", () => finishClickWaiter(waiter, false, false));
      }
    });
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
  apply3 as apply,
  inject,
  name
};
