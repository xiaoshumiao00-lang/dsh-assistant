// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { createRequire } from "node:module";
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
var PLUGIN_VERSION = false ? "dev" : "0.2.1";
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
async function listDirectory(path3) {
  const abs = pathResolve(path3);
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
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[dsh-worktable] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531");
    return;
  }
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
        const stat3 = await import("node:fs/promises").then((m) => m.stat(abs));
        if (stat3.size > 20 * 1024 * 1024) {
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
        const path3 = typeof body.path === "string" && body.path ? body.path : serverCwd(ctx, body.sessionId, body.cwd);
        json(res, 200, await listDirectory(path3));
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
        const cp2 = await import("node:child_process");
        const child = cp2.spawn(opener.cmd, opener.args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        json(res, 200, { ok: true, path: abs });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  setupTerminal(webServer, ctx);
}

// src/pocket-host/index.js
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { spawn as spawn4 } from "node:child_process";
import { readFileSync as readFileSync4, mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { writeFile as writeFile2, readFile as readFile3, mkdir as mkdir3, rm as rm3 } from "node:fs/promises";
import { join as join6, dirname as dirname6 } from "node:path";
import { homedir as homedir5 } from "node:os";
import { randomBytes as randomBytes2, randomInt } from "node:crypto";

// src/pocket-host/service.mjs
import { networkInterfaces } from "node:os";
import { createRequire as createRequire2 } from "node:module";
import { readFileSync as readFileSync2 } from "node:fs";
import { execFile as execFile3 } from "node:child_process";
import { mkdir as mkdir2, readFile as readFile2, rm as rm2, writeFile } from "node:fs/promises";
import { join as join3, dirname as dirname4 } from "node:path";

// src/pocket-host/proxy.mjs
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createGzip, createBrotliCompress, constants as zlibConstants2 } from "node:zlib";
import { createHash, timingSafeEqual } from "node:crypto";

// src/pocket-host/diagnostics.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join } from "node:path";
var MAX_BYTES = 1024 * 1024;
var MAX_TAIL = 200;
function diagnosticPath() {
  return join(process.env.DSH_HOME ?? join(homedir2(), ".dsh"), "dsh-pocket", "diagnostic.jsonl");
}
function rotate(file) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size <= MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
  }
}
function appendDiagnostic(record) {
  try {
    const file = diagnosticPath();
    mkdirSync(dirname2(file), { recursive: true });
    rotate(file);
    appendFileSync(file, `${JSON.stringify({ ...record, at: record?.at ?? Date.now() })}
`, "utf8");
  } catch {
  }
}
function readDiagnosticTail(limit = MAX_TAIL) {
  try {
    const file = diagnosticPath();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(-Math.max(1, Math.min(limit, 1e3)));
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function diagnosticSummary({ minutes = 30, limit = 120 } = {}) {
  const since = Date.now() - Math.max(1, minutes) * 6e4;
  const entries = readDiagnosticTail(2e3).filter((entry) => Number(entry?.at) >= since);
  const counts = {};
  for (const entry of entries) {
    const key = String(entry?.ev ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const pages = entries.filter((entry) => entry?.ev === "page");
  const wsOpen = entries.filter((entry) => entry?.ev === "ws-open");
  const wsClose = entries.filter((entry) => entry?.ev === "ws-close");
  return {
    path: diagnosticPath(),
    minutes,
    entries: entries.length,
    counts,
    pages: pages.slice(-50),
    wsOpen: wsOpen.slice(-50),
    wsClose: wsClose.slice(-50),
    tail: entries.slice(-limit)
  };
}

// src/pocket-host/ws-deflate.mjs
import {
  createDeflateRaw,
  createInflateRaw,
  constants as zlibConstants
} from "node:zlib";
var TAIL = Buffer.from([0, 0, 255, 255]);
var MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
var MAX_QUEUED_BYTES = 32 * 1024 * 1024;
var MIN_COMPRESS_BYTES = 128;
var WsFrameParser = class {
  constructor(onFrame, onError) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {
    });
  }
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (; ; ) {
      const b = this.buf;
      if (b.length < 2) return;
      const b0 = b[0];
      const b1 = b[1];
      const fin = (b0 & 128) !== 0;
      const rsv1 = (b0 & 64) !== 0;
      const opcode = b0 & 15;
      const masked = (b1 & 128) !== 0;
      let len = b1 & 127;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (len > MAX_MESSAGE_BYTES) {
        this.onError(new Error(`ws frame too large: ${len}`));
        return;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      this.onFrame({ fin, rsv1, opcode, payload });
    }
  }
};
function encodeFrame({ fin = true, rsv1 = false, opcode = 1, payload = Buffer.alloc(0), clientMask = false }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = (fin ? 128 : 0) | (rsv1 ? 64 : 0) | opcode & 15;
  if (!clientMask) return Buffer.concat([header, payload]);
  header[1] |= 128;
  const mask = Buffer.from([17, 34, 51, 68]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
var DeflateQueue = class {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createDeflateRaw({ level: 6, windowBits: 15, memLevel: 8 });
    this.stream.on("data", (c) => this.chunks.push(c));
    this.stream.on("error", (e) => this._fail(e));
  }
  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.onError(err);
  }
  push(payload, opts, cb) {
    if (this.failed) return;
    this.queue.push({ payload, cb, raw: opts?.raw === true });
    this._next();
  }
  _next() {
    if (this.busy || this.failed) return;
    while (this.queue.length && this.queue[0].raw) {
      const item2 = this.queue.shift();
      item2.cb(item2.payload);
      if (this.failed) return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.chunks = [];
    this.stream.write(item.payload);
    this.stream.flush(zlibConstants.Z_SYNC_FLUSH, () => {
      if (this.failed) return;
      let out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [];
      if (out.length >= 4 && out.subarray(out.length - 4).equals(TAIL)) out = out.subarray(0, out.length - 4);
      this.busy = false;
      item.cb(out);
      this._next();
    });
  }
  close() {
    try {
      this.stream.close();
    } catch {
    }
  }
};
var InflateQueue = class {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createInflateRaw({ windowBits: 15 });
    this.stream.on("data", (c) => this.chunks.push(c));
    this.stream.on("error", (e) => this._fail(e));
  }
  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.onError(err);
  }
  push(payload, opts, cb) {
    if (this.failed) return;
    this.queue.push({ payload, cb, raw: opts?.raw === true });
    this._next();
  }
  _next() {
    if (this.busy || this.failed) return;
    while (this.queue.length && this.queue[0].raw) {
      const item2 = this.queue.shift();
      item2.cb(item2.payload);
      if (this.failed) return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.chunks = [];
    this.stream.write(Buffer.concat([item.payload, TAIL]));
    this.stream.flush(zlibConstants.Z_SYNC_FLUSH, () => {
      if (this.failed) return;
      const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [];
      this.busy = false;
      item.cb(out);
      this._next();
    });
  }
  close() {
    try {
      this.stream.close();
    } catch {
    }
  }
};
function negotiatePermessageDeflate(headerValue) {
  const offer = String(headerValue ?? "");
  if (offer === "") return null;
  for (const part of offer.split(",")) {
    const [name3, ...params] = part.split(";").map((s) => s.trim());
    if (name3.toLowerCase() !== "permessage-deflate") continue;
    const unsupported = params.find((p) => {
      const k = p.split("=")[0].trim().toLowerCase();
      return k !== "client_max_window_bits";
    });
    if (unsupported) continue;
    return "permessage-deflate";
  }
  return null;
}
function attachWsDeflate({ client, upstream, onError = null, onFailure = null }) {
  const stats = { downIn: 0, downOut: 0, upIn: 0, upOut: 0, messages: 0, failures: 0 };
  let closed = false;
  const fail2 = (err) => {
    if (closed) return;
    closed = true;
    stats.failures += 1;
    try {
      onError?.(err);
    } catch {
    }
    try {
      onFailure?.();
    } catch {
    }
    try {
      client.destroy();
    } catch {
    }
    try {
      upstream.destroy();
    } catch {
    }
  };
  const deflate = new DeflateQueue(fail2);
  const inflate = new InflateQueue(fail2);
  let downParts = [];
  let downOpcode = 1;
  let downSize = 0;
  const downParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, opcode, payload } = frame;
    if (opcode >= 8) {
      try {
        client.write(encodeFrame({ fin: true, opcode, payload }));
      } catch (e) {
        fail2(e);
      }
      return;
    }
    downOpcode = opcode === 0 ? downOpcode : opcode;
    downParts.push(payload);
    downSize += payload.length;
    if (!fin) {
      if (downSize > MAX_QUEUED_BYTES) fail2(new Error("ws-deflate: upstream message too large"));
      return;
    }
    const whole = downParts.length === 1 ? downParts[0] : Buffer.concat(downParts);
    downParts = [];
    downSize = 0;
    stats.downIn += whole.length;
    stats.messages += 1;
    const op = downOpcode;
    if (whole.length < MIN_COMPRESS_BYTES) {
      deflate.push(whole, { raw: true }, () => {
        if (closed) return;
        stats.downOut += whole.length;
        try {
          client.write(encodeFrame({ fin: true, opcode: op, payload: whole }));
        } catch (e) {
          fail2(e);
        }
      });
      return;
    }
    deflate.push(whole, {}, (packed) => {
      if (closed) return;
      let out = packed;
      let rsv1 = true;
      if (packed.length >= whole.length) {
        out = whole;
        rsv1 = false;
      }
      stats.downOut += out.length;
      try {
        client.write(encodeFrame({ fin: true, rsv1, opcode: op, payload: out }));
      } catch (e) {
        fail2(e);
      }
    });
  }, fail2);
  let upParts = [];
  let upOpcode = 1;
  let upCompressed = false;
  const upParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, rsv1, opcode, payload } = frame;
    if (opcode >= 8) {
      try {
        upstream.write(encodeFrame({ fin: true, opcode, payload, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
      return;
    }
    upOpcode = opcode === 0 ? upOpcode : opcode;
    if (opcode !== 0) {
      upParts = [];
      upCompressed = false;
    }
    if (rsv1) upCompressed = true;
    upParts.push(payload);
    if (!fin) {
      if (upParts.reduce((n, b) => n + b.length, 0) > MAX_QUEUED_BYTES) fail2(new Error("ws-deflate: client message too large"));
      return;
    }
    const whole = upParts.length === 1 ? upParts[0] : Buffer.concat(upParts);
    upParts = [];
    const op = upOpcode;
    const writePlain = () => {
      if (closed) return;
      stats.upIn += whole.length;
      try {
        upstream.write(encodeFrame({ fin: true, opcode: op, payload: whole, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
    };
    if (!upCompressed) {
      inflate.push(whole, { raw: true }, writePlain);
      return;
    }
    inflate.push(whole, {}, (out) => {
      if (closed) return;
      stats.upIn += out.length;
      try {
        upstream.write(encodeFrame({ fin: true, opcode: op, payload: out, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
    });
  }, fail2);
  const onClientData = (chunk) => upParser.push(chunk);
  const onUpstreamData = (chunk) => downParser.push(chunk);
  client.on("data", onClientData);
  upstream.on("data", onUpstreamData);
  return {
    close() {
      closed = true;
      client.off("data", onClientData);
      upstream.off("data", onUpstreamData);
      deflate.close();
      inflate.close();
    },
    stats: () => ({ ...stats })
  };
}

// src/pocket-host/proxy.mjs
var DEFAULT_UPSTREAM = { host: "127.0.0.1", port: 3080 };
var RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* \u6CE8\uFF1A\u66FE\u7528\u300C\u5168\u5C40 let location + Proxy\u300D\u4F2A\u88C5 location.hostname \u4FEE DSH isLoopback \u5224\u5B9A
\uFF08issue #58\uFF1A\u5C40\u57DF\u7F51\u8BBF\u95EE\u6A21\u578B\u8BBE\u7F6E\u9875\u62A5 settings unavailable\uFF09\u2014\u2014\u4F46 let location \u5168\u5C40
\u8BCD\u6CD5\u7ED1\u5B9A\u4F1A\u8BA9\u4EFB\u4F55\u6070\u597D\u9876\u5C42\u58F0\u660E location \u7684\u811A\u672C\uFF08DSH \u63D2\u4EF6\u7ECF\u5178 script\uFF09SyntaxError \u5D29\u6E83\uFF0C
\u5BFC\u81F4\u4F1A\u8BDD\u5217\u8868\u4E0D\u663E\u793A\uFF08\u5B9E\u6D4B PAGEERROR: Identifier 'location' has already been declared\uFF09\u3002
\u5DF2\u56DE\u9000\uFF1B\u8BE5\u95EE\u9898\u5C5E DSH \u5BA2\u6237\u7AEF\u9650\u5236\uFF08location.hostname \u662F unforgeable \u5C5E\u6027\uFF09\u65E0\u6CD5\u5B89\u5168\u7ED5\u8FC7\u3002*/</script>`;
var TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-pocket-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'&&typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}}catch(e){}return t;}if(cur)patch(cur);Object.defineProperty(globalThis,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;
var INJECT_MARK = 'data-dsh-pocket-polyfill="1"';
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers["content-encoding"] ?? ""));
}
var HASHED_ASSET_RE = /\/(?:assets|static)\/[^/?#]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf)$/;
function staticCacheHeaders(reqUrl, headers) {
  if (!headers || typeof headers !== "object") return headers;
  if (headers["cache-control"]) return headers;
  const pathOnly = String(reqUrl ?? "").split(/[?#]/)[0];
  if (!HASHED_ASSET_RE.test(pathOnly)) return headers;
  return { ...headers, "cache-control": "public, max-age=31536000, immutable" };
}
var WS_DEFLATE_BREAKER_THRESHOLD = 2;
var WS_DEFLATE_COOLDOWN_MS = 10 * 60 * 1e3;
var wsDeflateBreaker = { failures: 0, until: 0 };
function wsDeflateAllowed() {
  return Date.now() >= wsDeflateBreaker.until;
}
function noteWsDeflateFailure() {
  wsDeflateBreaker.failures += 1;
  if (wsDeflateBreaker.failures >= WS_DEFLATE_BREAKER_THRESHOLD) {
    wsDeflateBreaker.failures = 0;
    wsDeflateBreaker.until = Date.now() + WS_DEFLATE_COOLDOWN_MS;
  }
}
var DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM;
function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH \u684C\u9762\u7AEF\u5904\u4E8E advanced \u6A21\u5F0F\uFF0C\u624B\u673A\u8BBF\u95EE\u6682\u4E0D\u652F\u6301\u3002\u8BF7\u5728\u684C\u9762\u7AEF\u8BBE\u7F6E\u4E2D\u5207\u56DE compatibility \u6A21\u5F0F\u540E\u91CD\u542F\u3002| DSH Desktop is in advanced mode \u2014 phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}
var TOKEN_COOKIE = "dsh_pocket_token";
var COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash("sha256").update(`${token}:${sessionKey}`).digest("hex");
}
var DEFAULT_RATE_LIMIT = {
  windowMs: 6e4,
  // 失败计数滑动窗口
  maxFailures: 5,
  // 窗口内失败阈值 → 触发单 IP 锁
  lockMs: 6e4,
  // 单 IP 锁定时长
  globalMaxFailures: 50,
  // 全局失败阈值（同窗口）→ 触发全局锁
  globalLockMs: 3e4
  // 全局锁定时长
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = /* @__PURE__ */ new Map();
  const ipLocks = /* @__PURE__ */ new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    /** 该 IP 当前是否被锁；返回 { locked, retryAfter }。 */
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1e3) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1e3) };
      return { locked: false, retryAfter: 0 };
    },
    /** 记一次失败：维护滑动窗口计数，达阈值触发单 IP / 全局锁。 */
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) {
        global.count = 0;
        global.windowStart = now;
      }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      if (failCounts.size > 2e3) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
    },
    /** 成功登录：清空该 IP 计数与锁。 */
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
    }
  };
}
function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? "");
  if (classifySource(addr) === "loopback") {
    const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
    if (cf) return cf;
  }
  return addr || "unknown";
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
function carryAttr(carry) {
  const text = String(carry ?? "");
  if (!text) return "";
  return `?${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}`;
}
function loginPageHtml(error, isPublic, retryAfter = 0, carry = "") {
  const where = isPublic ? "\u6B64\u516C\u7F51\u5730\u5740" : "\u6B64\u5C40\u57DF\u7F51\u5730\u5740";
  const whereEn = isPublic ? "This public address" : "This LAN address";
  const errMsg = error === "locked" ? `\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 ${retryAfter} \u79D2\u540E\u518D\u8BD5 | Too many attempts \u2014 try again in ${retryAfter}s` : error ? "\u5BC6\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5 | Wrong PIN, try again" : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u8BBF\u95EE\u9A8C\u8BC1</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>\u{1F510} DSH Pocket</h1>
<p>${where}\u53D7\u8BBF\u95EE\u5BC6\u7801\u4FDD\u62A4\uFF0C\u8BF7\u8F93\u5165 8 \u4F4D\u5BC6\u7801\uFF08\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57\uFF09 | ${whereEn} is password-protected \u2014 enter the 8-character PIN (letters/digits)</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login${carryAttr(carry)}">
<input name="token" type="password" maxlength="8" autocomplete="one-time-code" autofocus required>
<button type="submit">\u8FDB\u5165 | Enter</button>
</form>
</div></body></html>`;
}
function classifyHost(host) {
  let name3 = String(host ?? "").trim().toLowerCase();
  if (name3.startsWith("[")) {
    const end = name3.indexOf("]");
    if (end >= 0) name3 = name3.slice(1, end);
  } else {
    name3 = name3.replace(/:\d+$/, "");
  }
  if (name3 === "localhost" || name3 === "0.0.0.0" || name3 === "::1" || /^127\./.test(name3)) return "loopback";
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name3)) return "lan";
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name3) && name3.includes(":")) return "lan";
  if (name3 === "" || name3.includes(":")) return "loopback";
  if (name3.endsWith(".local") || !name3.includes(".")) return "lan";
  return "public";
}
function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === "public";
}
var HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };
function classifySource(addr) {
  let a = String(addr ?? "").trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || /^127\./.test(a)) return "loopback";
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return "lan";
  if (/^169\.254\./.test(a)) return "lan";
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return "lan";
  return "public";
}
function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith("::ffff:")) addr = addr.slice(7);
  return addr;
}
function isLoopbackHost(host) {
  let name3 = String(host ?? "").trim().toLowerCase();
  if (name3.startsWith("[")) {
    const end = name3.indexOf("]");
    if (end >= 0) name3 = name3.slice(1, end);
  } else {
    name3 = name3.replace(/:\d+$/, "");
  }
  return name3 === "localhost" || name3 === "127.0.0.1" || name3 === "::1" || name3 === "0.0.0.0";
}
function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u5C40\u57DF\u7F51\u8BBF\u95EE\u5DF2\u5173\u95ED</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>\u{1F512} DSH Pocket</h1>
<p>\u5C40\u57DF\u7F51\u8BBF\u95EE\u5DF2\u5173\u95ED\uFF0C\u626B\u7801/\u94FE\u63A5\u5747\u4E0D\u53EF\u7528\u3002<br>\u8BF7\u5728\u7535\u8111\u4E0A\u91CD\u65B0\u5F00\u542F\u540E\u518D\u8BD5\u3002<br><br>LAN access is disabled \u2014 the QR code and link are unavailable.<br>Re-enable it on the computer to continue.</p>
</div></body></html>`;
}
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u684C\u9762\u7AEF\u672A\u5F00\u542F\u6D4F\u89C8\u5668\u8BBF\u95EE</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>\u{1F5A5}\uFE0F DSH Pocket</h1>
<p>\u4F60\u5DF2\u901A\u8FC7\u8BBF\u95EE\u5BC6\u7801\uFF0C\u4F46\u9875\u9762\u4ECD\u88AB\u62E6\u622A\u3002<br>\u56E0\u4E3A\u672C\u673A DSH Desktop \u672A\u5F00\u542F\u300C\u6D4F\u89C8\u5668\u8BBF\u95EE\u300D\uFF0C\u684C\u9762\u95E8\u7981\u62D2\u7EDD\u4E86\u666E\u901A\u6D4F\u89C8\u5668\uFF08\u542B\u624B\u673A\uFF09\u7684\u9875\u9762\u8BF7\u6C42\u3002</p>
<div class="step">
<strong>\u89E3\u51B3\u65B9\u6CD5\uFF08\u4EFB\u9009\u5176\u4E00\uFF09\uFF1A</strong><br>
1. DSH Desktop \u2192 \u8BBE\u7F6E \u2192 \u7A97\u53E3 / \u6A21\u5F0F \u2192 \u5F00\u542F\u300C\u6D4F\u89C8\u5668\u8BBF\u95EE\u300D\uFF08\u81EA\u52A8\u5207\u5230 compatibility \u6A21\u5F0F\uFF09\u2192 <strong>\u91CD\u542F DSH Desktop</strong>\u3002<br>
2. \u6216\u5728\u914D\u7F6E\u6587\u4EF6\u4E2D\u8BBE\u7F6E\uFF1A<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
\u7136\u540E\u91CD\u542F DSH Desktop\uFF0C\u518D\u5237\u65B0\u672C\u9875\u3002
</div>
<p style="margin-top:14px">\u6CE8\u610F\uFF1A\u8BBF\u95EE\u5BC6\u7801\u767B\u5F55\u6210\u529F \u2260 \u5DF2\u83B7\u5F97\u684C\u9762 Web \u8BBF\u95EE\u6388\u6743\u3002\u95E8\u7981\u7531 DSH Desktop \u63A7\u5236\uFF0Cpocket \u65E0\u6CD5\u4EE3\u4E3A\u7ED5\u8FC7\u3002</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings \u2192 window/mode \u2192 browser access \u2192 restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/html")) return true;
  const url = String(req.url ?? "");
  let pathname = url;
  try {
    pathname = new URL(url || "/", "http://dsh.invalid").pathname;
  } catch {
  }
  return pathname === "/" || /\.html?$/i.test(pathname);
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function hasQueryToken(req) {
  try {
    return new URL(req.url ?? "/", "http://x").searchParams.get("token") != null;
  } catch {
    return false;
  }
}
function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  const qTok = new URL(req.url ?? "/", "http://x").searchParams.get("token");
  if (qTok) {
    for (const token of list) {
      if (safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
    }
  }
  return { ok: false, rawQueryToken: null };
}
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function(statusCode, headers) {
    const h = { ...headers ?? {} };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    const prev = h["set-cookie"];
    if (Array.isArray(prev)) h["set-cookie"] = [...prev, cookie];
    else if (typeof prev === "string") h["set-cookie"] = [prev, cookie];
    else h["set-cookie"] = cookie;
    return origWriteHead(statusCode, h);
  };
}
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "origin" || lk === "referer" || lk === "sec-fetch-site") continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = "http:";
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out["sec-fetch-site"] = "same-origin";
  return out;
}
var DSH_AUTH_COOKIE = "dsh-auth-";
function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith("dsh-desktop-"));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}
function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== "GET") return reqUrl;
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  if (u.pathname !== "/") return reqUrl;
  const force = u.searchParams.has("dsh-pocket-auth");
  if (!force && String(cookieHeader ?? "").includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set("token", launchToken);
  return `${u.pathname}${u.search}`;
}
var DEFAULT_HANDSHAKE_LIMIT = 3;
var HANDSHAKE_WINDOW_MS = 6e4;
var HANDSHAKE_RETRY_PARAM = "dsh-pocket-retry";
function stripQueryParam(reqUrl, name3) {
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  if (!u.searchParams.has(name3)) return reqUrl;
  u.searchParams.delete(name3);
  return `${u.pathname}${u.search}`;
}
var LOGIN_DROP_PARAMS = ["token", "dsh-pocket-auth", "dsh-pocket-retry"];
var LOGIN_CARRY_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
var LOGIN_CARRY_SENSITIVE_RE = /(token|password|passwd|secret|cookie|authorization|apikey|api_key)/i;
var LOGIN_CARRY_MAX_PARAMS = 8;
var LOGIN_CARRY_VALUE_MAX = 120;
function carryKeyAllowed(key) {
  const name3 = String(key ?? "");
  if (!LOGIN_CARRY_KEY_RE.test(name3)) return false;
  const lower = name3.toLowerCase();
  if (LOGIN_DROP_PARAMS.includes(lower)) return false;
  if (lower.startsWith("dsh-desktop-")) return false;
  if (LOGIN_CARRY_SENSITIVE_RE.test(lower)) return false;
  return true;
}
function carryParams(rawUrl, into) {
  if (!rawUrl) return;
  let u;
  try {
    u = new URL(String(rawUrl), "http://dsh.invalid");
  } catch {
    return;
  }
  for (const [key, value] of u.searchParams) {
    if (!carryKeyAllowed(key)) continue;
    if (into.has(key)) continue;
    if (into.size >= LOGIN_CARRY_MAX_PARAMS) break;
    into.append(key, String(value).slice(0, LOGIN_CARRY_VALUE_MAX));
  }
}
function loginCarryQuery(reqUrl) {
  const sp = new URLSearchParams();
  carryParams(reqUrl, sp);
  return sp.toString();
}
function postLoginRedirectLocation(postUrl, referer = "") {
  const sp = new URLSearchParams();
  carryParams(postUrl, sp);
  carryParams(referer, sp);
  sp.set("dsh-pocket-auth", "1");
  const qs = sp.toString();
  return qs ? `/?${qs}` : "/?dsh-pocket-auth=1";
}
function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  const hits = /* @__PURE__ */ new Map();
  return {
    /** 记一次握手注入，返回窗口内的累计次数。 */
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    /** 握手成功（拿到会话 cookie 的请求）→ 清零。 */
    clear(ip) {
      hits.delete(ip);
    },
    /** 该 IP 是否已达重试上限。 */
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    /** 清理过期条目，防长期运行内存膨胀。 */
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    }
  };
}
function handshakePageHtml(carry = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/${carryAttr(carry)}">
<title>DSH Pocket \xB7 \u6B63\u5728\u8FDB\u5165 | opening\u2026</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>\u6B63\u5728\u8FDB\u5165\u2026 | opening\u2026</p></body></html>`;
}
function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u65E0\u6CD5\u5B8C\u6210\u767B\u5F55\u63E1\u624B</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>\u{1F501} \u65E0\u6CD5\u5B8C\u6210\u767B\u5F55\u63E1\u624B</h1>
<p>\u6D4F\u89C8\u5668\u6CA1\u6709\u4FDD\u5B58 DSH \u4E0B\u53D1\u7684\u4F1A\u8BDD cookie\uFF0C\u4EE3\u7406\u53CD\u590D\u91CD\u8BD5\u540E\u4ECD\u672A\u6210\u529F\uFF0C\u56E0\u6B64\u505C\u5728\u8FD9\u91CC\u800C\u4E0D\u662F\u65E0\u9650\u8DF3\u8F6C\u3002</p>
<p><strong>Safari\uFF08iOS/macOS\uFF09</strong> \u5728 <code>http://</code> \u7EAF IP \u5730\u5740\u4E0A\u4E0D\u4F1A\u4FDD\u5B58\u8FD9\u7C7B cookie\uFF0C\u5C40\u57DF\u7F51\u5165\u53E3\u56E0\u6B64\u8FDB\u4E0D\u53BB\u3002</p>
<p>\u53EF\u4EE5\u8BD5\u8BD5\uFF1A<br>
\u2460 \u6362 Chromium \u7CFB\u6D4F\u89C8\u5668\uFF08Chrome / Edge\uFF09\u6253\u5F00\u5C40\u57DF\u7F51\u5730\u5740\uFF1B<br>
\u2461 \u6539\u7528<strong>\u516C\u7F51\u5165\u53E3</strong>\uFF08\u8BBE\u7F6E\u9875\u5F00\u542F\u516C\u7F51\u8BBF\u95EE\uFF0C\u62FF\u5230 <code>https://\u2026trycloudflare.com</code> \u5730\u5740\uFF09\u2014\u2014HTTPS \u57DF\u540D\u4E0A Safari \u6B63\u5E38\u3002</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">\u91CD\u8BD5\u4E00\u6B21 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete (issue #91). Safari over plain <code>http://</code> + IP is the known case \u2014 try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}
var WS_PING_FRAME = Buffer.from([137, 0]);
function attachWebSocketHeartbeat(socket, { intervalMs = 3e4, missLimit = 2 } = {}, onDead = null) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => {
    misses = 0;
  };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      try {
        onDead?.("heartbeat-miss");
      } catch {
      }
      socket.destroy();
      return;
    }
    if (!socket.destroyed) {
      try {
        socket.write(WS_PING_FRAME);
      } catch {
      }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on("data", onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("data", onInbound);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
var DIAG_PATH = "/.dsh-pocket/diag";
var DIAG_BODY_MAX = 16 * 1024;
var DIAG_HITS = /* @__PURE__ */ new Map();
function diagRateLimited(ip) {
  const now = Date.now();
  const entry = DIAG_HITS.get(ip) ?? { start: now, count: 0 };
  if (now - entry.start > 6e4) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count += 1;
  DIAG_HITS.set(ip, entry);
  if (DIAG_HITS.size > 500) {
    for (const [key, value] of DIAG_HITS) {
      if (now - value.start > 12e4) DIAG_HITS.delete(key);
    }
  }
  return entry.count > 120;
}
function isLoopbackRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function readDiagBody(req) {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > DIAG_BODY_MAX) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => resolve(tooLarge ? null : body));
    req.on("error", () => resolve(null));
  });
}
function createPocketProxy({ port = 3081, host = "0.0.0.0", upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, auth = null, rateLimit = null, heartbeat = {}, lanAccessEnabled = () => true, launchToken = () => "", handshakeLimit } = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  const wsDeflateEnabled = process.env.DSH_POCKET_WS_DEFLATE !== "0";
  const decideWsDeflate = (headerValue) => wsDeflateEnabled && wsDeflateAllowed() ? negotiatePermessageDeflate(headerValue) : null;
  const wsDeflate = attachWsDeflate;
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === "number" ? { max: handshakeLimit } : {}
  );
  const server = createServer((req, res) => {
    let urlPath = "";
    try {
      urlPath = new URL(req.url ?? "/", "http://diag.invalid").pathname;
    } catch {
      urlPath = "";
    }
    if (urlPath === DIAG_PATH) {
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (diagRateLimited(ip)) {
          res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
          res.end('{"error":"too-many-events"}');
          return;
        }
        void readDiagBody(req).then((body) => {
          if (body === null) {
            res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"too-large"}');
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (parsed === null || typeof parsed !== "object") {
            res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"invalid-json"}');
            return;
          }
          const { ev, ...rest } = parsed;
          appendDiagnostic({
            ev: "client",
            name: String(ev ?? "event").slice(0, 48),
            ip,
            ua: String(req.headers["user-agent"] ?? "").slice(0, 220),
            ...rest
          });
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        });
        return;
      }
      if (req.method === "GET") {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          res.end('{"error":"loopback-only"}');
          return;
        }
        const summary = diagnosticSummary({ minutes: 30, limit: 120 });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(summary));
        return;
      }
      res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
      res.end('{"error":"method-not-allowed"}');
      return;
    }
    if (req.method === "GET" && (urlPath === "/" || /\.html?$/i.test(urlPath))) {
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 220);
      if (!ua.includes("dsh-pocket-tunnel-probe")) {
        appendDiagnostic({
          ev: "page",
          host: policyHost(req, String(req.headers.host ?? "")),
          ip: clientIp(req),
          path: String(req.url ?? "").slice(0, 240),
          ref: String(req.headers.referer ?? "").slice(0, 200),
          ua
        });
      }
    }
    const host2 = policyHost(req, String(req.headers.host ?? ""));
    const isPublic = classifyHost(host2) === "public";
    if (!isPublic && !isLoopbackHost(host2) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    if (auth) {
      const protectedHost = isProtectedHost(host2, auth.isProtected);
      const token = protectedHost ? auth.getToken?.(host2) ?? null : null;
      const altTokens = protectedHost && token && typeof auth.getAltTokens === "function" ? auth.getAltTokens(host2) ?? [] : [];
      const sessionKey = auth.sessionKey ?? null;
      const acceptedTokens = token ? [token, ...altTokens] : [];
      if (protectedHost && token) {
        const ip = clientIp(req);
        if (req.method === "POST" && req.url?.startsWith("/pocket-login")) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            res.writeHead(429, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "retry-after": String(rl.retryAfter)
            });
            res.end(loginPageHtml("locked", isPublic, rl.retryAfter, loginCarryQuery(req.url)));
            return;
          }
          let body = "";
          req.on("data", (c) => {
            body += c;
            if (body.length > 1024) req.destroy();
          });
          req.on("end", () => {
            const submitted = String(new URLSearchParams(body).get("token") ?? "");
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== void 0) {
              limiter?.clear(ip);
              res.writeHead(302, {
                // 带上 dsh-pocket-auth=1：登录成功后强制重做一次浏览器会话握手，
                // 换掉可能已过期/被撤销的 dsh web 会话 cookie（issue #77）。
                // 同时保住用户原 URL 上除 token 之外的 query（本次 B 项）：
                // 原先写死 '/?dsh-pocket-auth=1' 会把 ?dsh-layout=auto 之类吞掉。
                location: postLoginRedirectLocation(req.url, req.headers.referer ?? ""),
                "set-cookie": `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                "cache-control": "no-store"
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`dsh-pocket: login failed from ${ip} | \u767B\u5F55\u5931\u8D25 IP: ${ip}`);
              res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              res.end(loginPageHtml(true, isPublic, 0, loginCarryQuery(req.url)));
            }
          });
          return;
        }
        const isGuess = hasQueryToken(req);
        if (isGuess) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              res.end(loginPageHtml("locked", isPublic, rl.retryAfter));
            } else {
              res.writeHead(429, {
                "content-type": "application/json",
                "cache-control": "no-store",
                "retry-after": String(rl.retryAfter)
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`dsh-pocket: bad ?token= from ${ip} | URL \u5BC6\u7801\u9519\u8BEF IP: ${ip}`);
          }
          if (isHtmlRequest(req)) {
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(loginPageHtml(rl.locked ? "locked" : false, isPublic, rl.retryAfter, loginCarryQuery(req.url)));
          } else {
            res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        if (authResult.rawQueryToken) {
          limiter?.clear(ip);
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const launchTok = (typeof launchToken === "function" ? launchToken() : "") || "";
    const handshakeIp = clientIp(req);
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== "" && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver ? cleanPath : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    if (!didInjectToken && String(req.headers.cookie ?? "").includes(DSH_AUTH_COOKIE)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      res.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-dsh-pocket-handshake": "blocked"
      });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers["content-type"] ?? "");
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out["content-length"];
          delete out["transfer-encoding"];
          delete out.location;
          const page = Buffer.from(handshakePageHtml(loginCarryQuery(req.url)), "utf8");
          out["content-type"] = "text/html; charset=utf-8";
          out["content-length"] = String(page.length);
          out["cache-control"] = "no-store";
          out["x-dsh-pocket-handshake"] = "transition";
          proxyRes.resume();
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        if (proxyRes.statusCode === 403 && contentType.includes("text/plain")) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateOverflow = false;
          const passRaw403 = () => {
            if (res.headersSent) return;
            res.writeHead(403, { ...proxyRes.headers });
            if (gateChunks.length) res.write(Buffer.concat(gateChunks));
            proxyRes.pipe(res);
          };
          proxyRes.on("data", (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            if (Buffer.concat(gateChunks).length > 65536) {
              gateOverflow = true;
              gateChunks.length = 0;
              passRaw403();
            }
          });
          proxyRes.on("end", () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString("utf8").trim();
            if (navReq && body === "forbidden") {
              res.writeHead(403, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "x-dsh-pocket-gate": "desktop-browser-access"
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on("error", () => res.destroy());
          return;
        }
        if (injectHtml && contentType.includes("text/html") && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on("data", (c) => chunks.push(c));
          proxyRes.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8");
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            const out = Buffer.from(html, "utf8");
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders["content-length"];
            delete outHeaders["transfer-encoding"];
            outHeaders["content-length"] = String(out.length);
            outHeaders["cache-control"] = "no-store";
            delete outHeaders["etag"];
            delete outHeaders["last-modified"];
            delete outHeaders["expires"];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on("error", () => res.destroy());
          return;
        }
        const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes("text/event-stream");
        const knownLen = Number(proxyRes.headers["content-length"] || 0);
        const shouldCompress = (canGzip || canBr) && !isCompressed(proxyRes.headers) && !isEventStream && (contentType.includes("application/json") || contentType.startsWith("text/")) && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? "br" : "gzip";
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders["content-length"];
          delete outHeaders["transfer-encoding"];
          outHeaders["content-encoding"] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, staticCacheHeaders(req.url, outHeaders));
          const z = enc === "br" ? createBrotliCompress({ params: { [zlibConstants2.BROTLI_PARAM_QUALITY]: 6 } }) : createGzip();
          proxyRes.pipe(z).pipe(res);
          res.on("close", () => {
            proxyRes.destroy();
            z.destroy();
          });
          proxyRes.on("error", () => {
            z.destroy();
            res.destroy();
          });
          proxyRes.on("aborted", () => {
            z.destroy();
            res.destroy();
          });
          z.on("error", () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, staticCacheHeaders(req.url, proxyRes.headers));
        proxyRes.pipe(res);
        res.on("close", () => proxyRes.destroy());
        proxyRes.on("error", () => res.destroy());
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.destroy();
        });
      }
    );
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dsh-pocket: \u65E0\u6CD5\u8FDE\u63A5\u4E0A\u6E38 dsh web\uFF08${upstream.host}:${upstream.port}\uFF09\u2014\u2014\u5148\u542F\u52A8 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  });
  server.on("upgrade", (req, socket, head) => {
    const host2 = policyHost(req, String(req.headers.host ?? ""));
    const isPublic = classifyHost(host2) === "public";
    if (!isPublic && !isLoopbackHost(host2) && !lanAccessEnabled()) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (auth) {
      const token = isProtectedHost(host2, auth.isProtected) ? auth.getToken?.(host2) ?? null : null;
      const altTokens = token && typeof auth.getAltTokens === "function" ? auth.getAltTokens(host2) ?? [] : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      const wsIp2 = clientIp(req);
      const wsGuess = hasQueryToken(req);
      if (token && wsGuess) {
        const rl = limiter?.status(wsIp2) ?? { locked: false, retryAfter: 0 };
        if (rl.locked) {
          socket.write(`HTTP/1.1 429 Too Many Requests\r
Retry-After: ${rl.retryAfter}\r
Connection: close\r
\r
`);
          socket.destroy();
          return;
        }
      }
      const wsAuth = authCheck(req, acceptedTokens, auth.sessionKey ?? null);
      if (token && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp2);
          log?.(`dsh-pocket: bad ws ?token= from ${wsIp2} | WS \u5BC6\u7801\u9519\u8BEF IP: ${wsIp2}`);
        }
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp2);
    }
    const wsId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wsStarted = Date.now();
    const wsPath = String(req.url ?? "").slice(0, 240);
    const wsUa = String(req.headers["user-agent"] ?? "").slice(0, 220);
    const wsIp = clientIp(req);
    let wsOpened = false;
    let wsLogged = false;
    let wsBytesIn = 0;
    let wsBytesOut = 0;
    let wsCloseReason = "";
    const logWsClose = () => {
      if (!wsOpened || wsLogged) return;
      wsLogged = true;
      appendDiagnostic({
        ev: "ws-close",
        id: wsId,
        host: host2,
        ip: wsIp,
        ua: wsUa,
        path: wsPath,
        durMs: Date.now() - wsStarted,
        bytesIn: wsBytesIn,
        bytesOut: wsBytesOut,
        reason: wsCloseReason || "unknown"
      });
    };
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: stripDesktopMarkers(req.url),
      headers,
      agent: false
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      const wsDeflateValue = wsDeflate && decideWsDeflate(req.headers["sec-websocket-extensions"]);
      if (wsDeflateValue) raw.push(`Sec-WebSocket-Extensions: ${wsDeflateValue}`);
      socket.write(`${raw.join("\r\n")}\r
\r
`);
      if (proxyHead?.length) socket.write(proxyHead);
      wsOpened = true;
      appendDiagnostic({
        ev: "ws-open",
        id: wsId,
        host: host2,
        ip: wsIp,
        ua: wsUa,
        path: wsPath
      });
      socket.on("data", (chunk) => {
        wsBytesIn += chunk.length;
      });
      proxySocket.on("data", (chunk) => {
        wsBytesOut += chunk.length;
      });
      if (wsDeflateValue && wsDeflate) {
        const wsDef = wsDeflate({
          client: socket,
          upstream: proxySocket,
          onFailure: noteWsDeflateFailure,
          onError: (err) => log?.(`dsh-pocket: ws-deflate failed: ${err?.message ?? err}`)
        });
        socket.on("close", () => {
          try {
            wsDef.close();
          } catch {
          }
        });
        proxySocket.on("close", () => {
          try {
            wsDef.close();
          } catch {
          }
        });
      } else {
        socket.pipe(proxySocket, { end: false });
        proxySocket.pipe(socket, { end: false });
      }
      if (heartbeat !== false) {
        attachWebSocketHeartbeat(socket, heartbeat ?? {}, (reason) => {
          wsCloseReason ||= reason;
        });
      }
      const teardown = () => {
        try {
          proxySocket.resetAndDestroy?.() ?? proxySocket.destroy();
        } catch {
          try {
            proxySocket.destroy();
          } catch {
          }
        }
        try {
          socket.destroy();
        } catch {
        }
      };
      proxySocket.on("error", () => {
        wsCloseReason ||= "upstream-error";
        try {
          socket.destroy();
        } catch {
        }
        logWsClose();
      });
      proxySocket.on("close", () => {
        wsCloseReason ||= "upstream";
        logWsClose();
        teardown();
      });
      socket.on("close", () => {
        wsCloseReason ||= "browser";
        logWsClose();
        teardown();
      });
      socket.on("end", () => {
        wsCloseReason ||= "browser-end";
        tapEnd();
      });
      proxySocket.on("end", () => {
        wsCloseReason ||= "upstream-end";
        tapEnd();
      });
      function tapEnd() {
        logWsClose();
        teardown();
      }
    });
    proxyReq.on("response", (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ""}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
        }
        socket.end(raw.join("\r\n") + "\r\n\r\n");
        proxyRes.resume();
      } catch {
        socket.destroy();
      }
    });
    proxyReq.on("error", () => socket.destroy());
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on("error", () => socket.destroy());
  });
  const clientSockets = /* @__PURE__ */ new Set();
  server.on("connection", (sock) => {
    clientSockets.add(sock);
    sock.on("close", () => clientSockets.delete(sock));
    sock.on("error", () => {
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) {
            try {
              s.destroy();
            } catch {
            }
          }
          server.close(() => r());
        })
      });
    });
  });
}

// src/pocket-host/tunnel.mjs
import { spawn, execSync } from "node:child_process";
import { mkdir, access, chmod, rm, stat as stat2, rename, cp, open } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join2, dirname as dirname3 } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
var QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
var TUNNEL_PROTOCOLS = ["quic", "http2"];
async function startWithProtocolFallback(label, signal, attempt) {
  const failures = [];
  for (const protocol of TUNNEL_PROTOCOLS) {
    if (signal?.aborted) throw new Error("\u5DF2\u53D6\u6D88 | cancelled");
    try {
      return await attempt(protocol);
    } catch (err) {
      const msg = err?.message ?? String(err);
      failures.push(`${protocol}: ${msg}`);
      if (signal?.aborted || /已取消|cancelled/.test(msg)) throw err;
      console.warn(`dsh-pocket: ${label} \u534F\u8BAE ${protocol} \u672A\u5C31\u7EEA\uFF0C\u56DE\u9000\u4E0B\u4E00\u4E2A | ${label} protocol ${protocol} failed: ${msg}`);
    }
  }
  throw new Error(
    `cloudflared \u65E0\u6CD5\u5EFA\u7ACB\u8FB9\u7F18\u8FDE\u63A5\uFF08\u5DF2\u5C1D\u8BD5 ${TUNNEL_PROTOCOLS.join(" / ")}\uFF09| no Cloudflare edge connection (tried ${TUNNEL_PROTOCOLS.join(" / ")}): ${failures.join(" || ")}`
  );
}
async function confirmPublicReachable(url, { signal, timeoutMs = 15e3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "timeout";
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5e3) });
      if (res.status < 500) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 1e3));
  }
  console.warn(`dsh-pocket: \u516C\u7F51\u53EF\u8FBE\u6027\u786E\u8BA4\u8D85\u65F6\uFF08${lastErr}\uFF09\uFF0C\u4ECD\u6309\u5DF2\u5C31\u7EEA\u8FD4\u56DE | reachability confirm timed out: ${lastErr}`);
  return false;
}
function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? "").trim().split(/\r?\n/);
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l.trim()));
  if (usageIdx >= 0) return lines[usageIdx].trim().slice(0, 500);
  return lines.slice(-4).join("\n").trim().slice(0, 500);
}
function platformBinary() {
  const archMap = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" };
  const a = archMap[process.arch] ?? process.arch;
  const os3 = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return { os: os3, a, ext: os3 === "windows" ? ".exe" : "" };
}
function platformAssets() {
  const { os: os3, a } = platformBinary();
  if (os3 === "windows") return [`cloudflared-windows-${a}.exe`];
  if (os3 === "darwin") return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}
var CLOUDFLARED_MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
];
var TUNA_BOTTLES = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/";
var PARALLEL_SEGMENTS = 8;
var MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
var PROBE_SIZE = 2 * 1024 * 1024;
var SLOW_SPEED_THRESHOLD = 0.3;
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import("node:fs");
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on("error", reject);
        rs.pipe(out, { end: false });
        rs.on("end", resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}
async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  let head = null;
  try {
    head = await fetch(url, { method: "HEAD", signal });
  } catch {
    head = null;
  }
  const len = head ? Number(head.headers.get("content-length") || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get("accept-ranges") || "").toLowerCase() === "bytes" : false;
  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      const { createWriteStream: createWriteStream2, createReadStream } = await import("node:fs");
      const w = createWriteStream2(dest);
      await new Promise((resolve, reject) => {
        w.on("error", reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), createWriteStream2(dest, { flags: "a" }));
      return len;
    }
    await rm(dest, { force: true }).catch(() => {
    });
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {
    });
    if (!/HTTP|fetch/i.test(String(err?.message ?? ""))) throw err;
  }
  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {
    })));
  }
  return len;
}
async function tsinghuaBottleUrl({ os: os3, a }) {
  if (os3 !== "darwin") return null;
  let res;
  try {
    res = await fetch(TUNA_BOTTLES, { signal: AbortSignal.timeout(2e4) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let html;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  const MACOS_CODES = "monterey|ventura|sonoma|sequoia|tahoe";
  const pattern = os3 === "darwin" ? new RegExp(`cloudflared-([0-9.]+)\\.${a === "arm64" ? "arm64_" : ""}(${MACOS_CODES})\\.bottle\\.tar\\.gz`, "g") : new RegExp(`cloudflared-([0-9.]+)\\.${a === "arm64" ? "arm64" : "x86_64"}_linux\\.bottle\\.tar\\.gz`, "g");
  let best = null;
  let bestV = "";
  for (const m of html.matchAll(pattern)) {
    if (m[1] > bestV) {
      bestV = m[1];
      best = m[0];
    }
  }
  return best ? `${TUNA_BOTTLES}${best}` : null;
}
async function downloadCloudflared(binPath, signal) {
  const { os: os3, a, ext } = platformBinary();
  const dir = dirname3(binPath);
  const tmpFile = join2(dir, `cloudflared.download`);
  const isWindows = os3 === "windows";
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12e4)]) : AbortSignal.timeout(12e4);
  const bottle = os3 === "darwin" ? await tsinghuaBottleUrl({ os: os3, a }).catch(() => null) : null;
  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;
  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    const sources = [];
    if (bottle && asset.endsWith(".tgz")) {
      sources.push({ url: bottle, host: "mirrors.tuna.tsinghua.edu.cn" });
    }
    for (const m of CLOUDFLARED_MIRRORS) sources.push({ url: m(asset), host: hostOf(m(asset)) });
    for (let i = 0; i < sources.length; i++) {
      const { url, host } = sources[i];
      console.log(`\u2B07\uFE0F  \u4E0B\u8F7D cloudflared\uFF08${asset}\uFF0C\u6E90 ${i + 1}/${sources.length}\uFF1A${host}\uFF09\u2026`);
      try {
        await downloadFile(url, tmpFile, { signal: fetchSignal });
        const st = await stat2(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`\u6587\u4EF6\u5F02\u5E38\u5C0F\uFF08${st.size} \u5B57\u8282\uFF09\uFF0C\u7591\u4F3C\u955C\u50CF\u9519\u8BEF\u9875`);
        usedAsset = asset;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {
        });
        console.warn(`  \u26A0\uFE0F \u6E90 ${i + 1} \u5931\u8D25\uFF1A${err?.message ?? err}\uFF0C\u5C1D\u8BD5\u4E0B\u4E00\u4E2A\u2026`);
      }
    }
  }
  if (usedAsset === null) {
    throw new Error(
      `cloudflared \u4E0B\u8F7D\u5931\u8D25\uFF1A\u6240\u6709\u6E90\u90FD\u4E0D\u901A\uFF08\u6700\u540E\u9519\u8BEF\uFF1A${lastErr?.message ?? lastErr}\uFF09\u3002` + (isWindows ? `Windows \u53EF\u624B\u52A8\u5B89\u88C5\u540E\u91CD\u8BD5\uFF1Awinget install cloudflared\uFF1B\u6216\u4E0B\u8F7D ${assets[0]} \u653E\u5230 ${dir} \u76EE\u5F55 | download failed \u2014 try: winget install cloudflared, or put the exe into ${dir}` : `\u4E5F\u53EF\u4EE5\u81EA\u5DF1\u88C5\u597D\u540E\u5728 settings.json \u5199 "cloudflaredPath": "/path/to/cloudflared" \u8DF3\u8FC7\u4E0B\u8F7D\uFF08\u6216\u7528\u73AF\u5883\u53D8\u91CF DSH_POCKET_CLOUDFLARED\uFF09\uFF1B\u6216\u7528\u5305\u7BA1\u7406\u5668\u5B89\u88C5\uFF1Aapt/dnf install cloudflared | all mirrors failed \u2014 install cloudflared manually and set "cloudflaredPath" in settings.json, or: apt/dnf install cloudflared`)
    );
  }
  let extracted = join2(dir, `cloudflared${ext}`);
  if (!usedAsset.endsWith(".tgz")) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {
      });
    });
  } else {
    const extractDir = join2(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tmpFile, "-C", extractDir], { stdio: "ignore", windowsHide: true });
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`cloudflared \u89E3\u538B\u5931\u8D25\uFF08code=${code}\uFF09`)));
        child.once("error", (err) => reject(
          err?.code === "ENOENT" ? new Error(`\u7CFB\u7EDF\u91CC\u6CA1\u6709 tar \u547D\u4EE4\uFF0C\u65E0\u6CD5\u89E3\u538B ${usedAsset} \u2014\u2014 \u53EF\u6539\u7528 linux \u88F8\u4E8C\u8FDB\u5236\uFF08\u9ED8\u8BA4\u5DF2\u5982\u6B64\uFF09\u6216\u624B\u52A8\u5B89\u88C5\u540E\u8BBE\u7F6E cloudflaredPath | no tar on this system`) : err
        ));
      });
      const { readdir: readdir2 } = await import("node:fs/promises");
      let found = null;
      const direct = join2(extractDir, `cloudflared${ext}`);
      try {
        if ((await stat2(direct)).isFile()) found = direct;
      } catch {
      }
      if (!found) {
        const verDir = join2(extractDir, "cloudflared");
        try {
          const vers = await readdir2(verDir);
          for (const v of vers) {
            const bin = join2(verDir, v, "bin", `cloudflared${ext}`);
            try {
              if ((await stat2(bin)).isFile()) {
                found = bin;
                break;
              }
            } catch {
            }
          }
        } catch {
        }
      }
      if (!found) throw new Error("cloudflared \u89E3\u538B\u6210\u529F\u4F46\u672A\u627E\u5230\u4E8C\u8FDB\u5236 | binary not found after extract");
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => {
          await cp(found, extracted).catch(() => {
          });
        });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  if (!isWindows) await chmod(extracted, 493);
  await rm(tmpFile, { force: true }).catch(() => {
  });
  return extracted;
}
function cloudflaredOnPath() {
  try {
    execSync(process.platform === "win32" ? "where cloudflared" : "command -v cloudflared", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
var downloading = null;
async function resolveCloudflared({ home, onPhase = () => {
}, signal } = {}) {
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(
        `DSH_POCKET_CLOUDFLARED \u6307\u5411\u7684\u8DEF\u5F84\u4E0D\u53EF\u6267\u884C\uFF1A${explicit} | cloudflaredPath is set but not accessible: ${explicit}`
      );
    }
  }
  if (cloudflaredOnPath()) return "cloudflared";
  const dshHome3 = home ?? process.env.DSH_HOME ?? join2(homedir3(), ".dsh");
  const cacheDir = join2(dshHome3, "dsh-pocket", "bin");
  const { os: os3, a, ext } = platformBinary();
  const candidates = [
    join2(cacheDir, `cloudflared${ext}`),
    join2(cacheDir, `cloudflared-${os3}-${a}${ext}`)
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      if (os3 === "linux") {
        try {
          const fd = await open(bin, "r");
          const head = Buffer.alloc(8192);
          await fd.read(head, 0, 8192, 0);
          await fd.close();
          if (head.includes("@@HOMEBREW_PREFIX@@")) {
            await rm(bin, { force: true }).catch(() => {
            });
            console.warn("dsh-pocket: discarding unusable Homebrew-bottle cloudflared cache | \u4E22\u5F03\u4E0D\u53EF\u7528\u7684 Homebrew bottle \u7F13\u5B58\uFF0C\u91CD\u65B0\u4E0B\u8F7D");
            continue;
          }
        } catch {
        }
      }
      return bin;
    } catch {
    }
  }
  onPhase("downloading");
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join2(cacheDir, `cloudflared${ext}`), signal).finally(() => {
      downloading = null;
    });
  }
  return downloading;
}
async function startNamedTunnel(opts) {
  return startWithProtocolFallback("named", opts?.signal, (protocol) => startNamedTunnelOnce(opts, protocol));
}
async function startNamedTunnelOnce({ token, home, signal, onPhase = () => {
} }, protocol) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase("starting");
  const child = spawn(bin, ["--no-autoupdate", "tunnel", "run", "--protocol", protocol], {
    stdio: ["ignore", "pipe", "pipe"],
    // GUI 宿主（DSH Desktop）里不隐藏会弹一个黑控制台窗口——用户明确不要
    windowsHide: true,
    env: { ...process.env, TUNNEL_TOKEN: String(token ?? "") }
  });
  let cleanup = null;
  let rejectErr = null;
  child.on("error", (err) => {
    cleanup?.();
    onPhase?.("error");
    rejectErr?.(new Error(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err?.message ?? err}\uFF08\u53EF\u5220\u9664 $DSH_HOME/dsh-pocket/bin \u7F13\u5B58\u540E\u91CD\u8BD5\uFF09`));
  });
  onPhase("registering");
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      if (/Registered tunnel connection/i.test(buf)) {
        cleanup();
        onPhase("ready");
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(
        `cloudflared \u9000\u51FA\uFF08code=${code}\uFF09${tail ? "\uFF1A" + tail : ""}\u2014\u2014\u8BF7\u68C0\u67E5 Tunnel Token \u662F\u5426\u6709\u6548\u3001\u57DF\u540D Service \u662F\u5426\u6307\u5411\u672C\u673A\u4EE3\u7406\u7AEF\u53E3 | tunnel exited (code=${code})${tail ? ": " + tail : ""} \u2014 check the Tunnel Token and the ingress hostname`
      ));
    };
    cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error("\u5DF2\u53D6\u6D88 | cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        "cloudflared \u542F\u52A8\u8D85\u65F6\uFF0830s\uFF09\u2014\u2014\u8BF7\u68C0\u67E5 Tunnel Token \u662F\u5426\u6709\u6548\u3001\u57DF\u540D Service \u662F\u5426\u6307\u5411\u672C\u673A\u4EE3\u7406\u7AEF\u53E3\uFF0C\u4EE5\u53CA\u662F\u5426\u5F00\u7740\u4EE3\u7406/VPN\uFF08Clash \u7B49 TUN \u6A21\u5F0F\u4F1A\u6390\u65AD\u96A7\u9053\u8FDE\u63A5\uFF09 | timeout \u2014 check the token, the ingress hostname, and quit any proxy/VPN (TUN mode)"
      ));
    }, 3e4);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    rejectErr = reject;
  });
  const exitListeners = /* @__PURE__ */ new Set();
  child.on("exit", (code) => {
    for (const cb of exitListeners) cb(code);
  });
  return {
    url: null,
    // 固定域名由调用方（service）按设置拼 https://<hostname>
    kill: () => {
      try {
        child.kill();
      } catch {
      }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    }
  };
}
async function startQuickTunnel(opts) {
  return startWithProtocolFallback("quick", opts?.signal, (protocol) => startQuickTunnelOnce(opts, protocol));
}
async function startQuickTunnelOnce({ port, home, signal, onPhase = () => {
} }, protocol) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase("starting");
  const child = spawn(bin, ["--no-autoupdate", "tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", protocol], {
    stdio: ["ignore", "pipe", "pipe"],
    // GUI 宿主（DSH Desktop）里不隐藏会弹一个黑控制台窗口——用户明确不要
    windowsHide: true
  });
  child.on("error", (err) => {
    cleanup?.();
    onPhase?.("error");
    rejectErr?.(new Error(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err?.message ?? err}\uFF08\u53EF\u5220\u9664 $DSH_HOME/dsh-pocket/bin \u7F13\u5B58\u540E\u91CD\u8BD5\uFF09`));
  });
  onPhase("registering");
  let cleanup = null;
  let rejectErr = null;
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    let foundUrl = null;
    const onData = (chunk) => {
      buf += String(chunk);
      if (!foundUrl) {
        const m = buf.match(QUICK_TUNNEL_URL_RE);
        if (m) foundUrl = m[0];
      }
      if (foundUrl && /Registered tunnel connection/i.test(buf)) {
        cleanup();
        resolve(foundUrl);
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared \u9000\u51FA\uFF08code=${code}\uFF09${tail ? "\uFF1A" + tail : ""}`));
    };
    cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error("\u5DF2\u53D6\u6D88 | cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        "cloudflared \u542F\u52A8\u8D85\u65F6\uFF0830s\uFF09\u2014\u2014\u8BF7\u68C0\u67E5\u662F\u5426\u5F00\u7740\u4EE3\u7406/VPN\uFF08Clash \u7B49 TUN \u6A21\u5F0F\u4F1A\u6390\u65AD\u96A7\u9053\u8FDE\u63A5\uFF09\uFF0C\u9000\u51FA\u4EE3\u7406\u540E\u91CD\u8BD5 | timeout \u2014 if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry"
      ));
    }, 3e4);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    rejectErr = reject;
  });
  await confirmPublicReachable(url, { signal });
  onPhase("ready");
  const exitListeners = /* @__PURE__ */ new Set();
  child.on("exit", (code) => {
    for (const cb of exitListeners) cb(code);
  });
  return {
    url,
    kill: () => {
      try {
        child.kill();
      } catch {
      }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    }
  };
}

// src/pocket-host/ssh-tunnel.mjs
import { spawn as spawn2, execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import http from "node:http";
var POWERSHELL = process.platform === "win32" ? existsSync2("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe" : "";
var STDERR_LIMIT = 4e3;
var MAX_AUTO_CLEANUPS = 3;
var MAX_KILL_TARGETS = 6;
function findTunnelProcesses(cfg, { execFn = execFile2 } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Write-Output $_.ProcessId }`;
        execFn(
          POWERSHELL,
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
          { windowsHide: true, timeout: 1e4 },
          (err, stdout) => {
            resolve(String(stdout ?? "").split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
          }
        );
      } else {
        execFn("pgrep", ["-f", `${needle}`], { timeout: 1e4 }, (err, stdout) => {
          resolve(err ? [] : String(stdout ?? "").split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
        });
      }
    } catch {
      resolve([]);
    }
  });
}
function killStaleTunnels(cfg, { onKill, execFn = execFile2 } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`;
        execFn(
          POWERSHELL,
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
          { windowsHide: true, timeout: 1e4 },
          (err, stdout) => {
            const killed = String(stdout ?? "").split(/\s+/).filter(Boolean);
            if (killed.length) onKill?.(killed);
            resolve(killed);
          }
        );
      } else {
        execFile2(
          "pkill",
          ["-f", `${needle}.*${target}`],
          { windowsHide: true, timeout: 1e4 },
          (err) => {
            if (!err) onKill?.(["pkill"]);
            resolve(err ? [] : ["pkill"]);
          }
        );
      }
    } catch {
      resolve([]);
    }
  });
}
var SSH_TUNNEL_DEFAULTS = Object.freeze({
  enabled: false,
  host: "",
  port: 22,
  user: "root",
  remotePort: 7080,
  keyPath: "",
  /** 0 = 跟随插件代理实际端口（推荐）；>0 用于手工指到别的本地端口 */
  localPort: 0
});
function toPort(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
function normalizeSshTunnelConfig(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: v.enabled === true,
    host: String(v.host ?? "").trim(),
    port: toPort(v.port, SSH_TUNNEL_DEFAULTS.port),
    user: String(v.user ?? SSH_TUNNEL_DEFAULTS.user).trim() || SSH_TUNNEL_DEFAULTS.user,
    remotePort: toPort(v.remotePort, SSH_TUNNEL_DEFAULTS.remotePort),
    keyPath: String(v.keyPath ?? "").trim(),
    localPort: Number.isInteger(Number(v.localPort)) && Number(v.localPort) > 0 ? Number(v.localPort) : 0
  };
}
function sshTunnelConfigured(cfg) {
  return Boolean(cfg && cfg.host && cfg.keyPath);
}
function sshBinary() {
  if (process.platform === "win32") {
    const p = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
    if (existsSync2(p)) return p;
  }
  return "ssh";
}
function knownHostsNull() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}
function childEnv() {
  return { ...process.env, SSH_ASKPASS: "", DISPLAY: "" };
}
function buildSshArgs(cfg, localPort) {
  const args = [
    "-N",
    "-R",
    `0.0.0.0:${cfg.remotePort}:127.0.0.1:${localPort}`,
    "-i",
    cfg.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsNull()}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    // ERROR 级别仍会打印 `Error: remote port forwarding failed for listen port N`
    // （2026-10-20 实测），足够分类，又不至于把 stderr 灌满。
    "-o",
    "LogLevel=ERROR",
    "-o",
    "BatchMode=yes"
  ];
  if (cfg.port && cfg.port !== 22) args.push("-p", String(cfg.port));
  args.push(`${cfg.user}@${cfg.host}`);
  return args;
}
function buildRemoteCmdArgs(cfg) {
  const args = [
    "-T",
    "-i",
    cfg.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsNull()}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "BatchMode=yes"
  ];
  if (cfg.port && cfg.port !== 22) args.push("-p", String(cfg.port));
  args.push(`${cfg.user}@${cfg.host}`);
  return args;
}
function oneLine(s, limit = 320) {
  const lines = String(s ?? "").replace(/\r/g, "").split("\n").map((x) => x.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).filter(Boolean);
  return lines.slice(-3).join(" / ").slice(0, limit);
}
var FAILURE_PATTERNS = Object.freeze([
  ["port_occupied", /remote port forwarding failed|remote forward failure|port forwarding failed|could not request remote|address already in use/i],
  ["auth", /permission denied|too many authentication|no supported authentication|no matching (?:key|host key|public key)|invalid format|unprotected private key|bad permissions|load private key|no such identity|not allowed because/i],
  ["hostkey", /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|man-in-the-middle/i],
  ["dns", /could not resolve hostname|name or service not known|temporary failure in name resolution/i],
  ["network", /ssh: connect to host|connection timed out|connection refused|no route to host|network is unreachable|connection reset by peer|connection closed by remote host|kex_exchange_identification|server unexpectedly closed|timeout, server not responding|broken pipe|packet write/i]
]);
function classifySshFailure(stderr, code = null) {
  const s = String(stderr ?? "");
  for (const [reason, re] of FAILURE_PATTERNS) {
    const m = s.match(re);
    if (m) return { reason, detail: oneLine(m[0], 120), code };
  }
  return { reason: s ? "unknown" : "unknown", detail: "", code };
}
function classifyProbeFailure(message) {
  const s = String(message ?? "");
  if (/ECONNREFUSED/i.test(s)) return "no_listener";
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|probe timeout|timed out/i.test(s)) {
    return /probe timeout|socket hang up|ECONNRESET|EPIPE/i.test(s) ? "stale_or_halfopen" : "network";
  }
  return "unknown";
}
var DIAG_MARKS = Object.freeze({
  tools: "@@DSHPOCKET_TOOLS@@",
  holders: "@@DSHPOCKET_HOLDERS@@",
  sshd: "@@DSHPOCKET_SSHD@@",
  tree: "@@DSHPOCKET_TREE@@",
  end: "@@DSHPOCKET_END@@"
});
var DIAG_ORDER = [DIAG_MARKS.tools, DIAG_MARKS.holders, DIAG_MARKS.sshd, DIAG_MARKS.tree, DIAG_MARKS.end];
function awkPortFilter(port) {
  return `awk '$4 ~ /:${port}$/'`;
}
function remoteDiagnoseCommand(cfg) {
  const p = Number(cfg.remotePort);
  const s = Number(cfg.port) || 22;
  return [
    `echo ${DIAG_MARKS.tools}`,
    "command -v ss; command -v awk; command -v ps",
    `echo ${DIAG_MARKS.holders}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(p)}`,
    `echo ${DIAG_MARKS.sshd}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(s)}`,
    `echo ${DIAG_MARKS.tree}`,
    "ps -o pid=,ppid=,comm= -C sshd,sshd-session 2>/dev/null",
    `echo ${DIAG_MARKS.end}`
  ].join("; ");
}
function parseRemoteDiagnosis(stdout) {
  const text = String(stdout ?? "").replace(/\r/g, "");
  const pos = [];
  for (const mark of DIAG_ORDER) {
    const i = text.indexOf(mark);
    if (i < 0) return { ok: false, error: "\u8FDC\u7AEF\u8BCA\u65AD\u8F93\u51FA\u4E0D\u5B8C\u6574\uFF08ssh \u672A\u5EFA\u7ACB\u6216\u8F93\u51FA\u88AB\u6539\u5199\uFF09\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote diagnosis incomplete" };
    pos.push(i);
  }
  for (let i = 1; i < pos.length; i += 1) {
    if (pos[i] <= pos[i - 1]) return { ok: false, error: "\u8FDC\u7AEF\u8BCA\u65AD\u8F93\u51FA\u987A\u5E8F\u5F02\u5E38\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote diagnosis out of order" };
  }
  const section = (mark) => {
    const idx = DIAG_ORDER.indexOf(mark);
    const start = pos[idx] + mark.length;
    const end = idx + 1 < DIAG_ORDER.length ? pos[idx + 1] : text.length;
    return text.slice(start, end).split("\n").map((l) => l.trim()).filter(Boolean);
  };
  const tools = section(DIAG_MARKS.tools);
  const has = (name3) => tools.some((t) => new RegExp(`(^|/)${name3}$`).test(t));
  if (!has("ss") || !has("awk") || !has("ps")) {
    return { ok: false, error: `\u8FDC\u7AEF\u7F3A\u5C11 ss/awk/ps\uFF0C\u65E0\u6CD5\u786E\u8BA4\u7AEF\u53E3\u5360\u7528\u8005\u8EAB\u4EFD\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote lacks ss/awk/ps: ${tools.join(",") || "(empty)"}` };
  }
  return { ok: true, tools, holders: section(DIAG_MARKS.holders), sshdListeners: section(DIAG_MARKS.sshd), tree: section(DIAG_MARKS.tree) };
}
function parseSsLine(line) {
  const cols = line.split(/\s+/);
  const owners = [];
  const usersMatch = line.match(/users:\((.+)\)\s*$/);
  const body = usersMatch ? usersMatch[1] : "";
  const quoted = /"([^"]*)",\s*pid=(\d+)/g;
  let m;
  while ((m = quoted.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  if (!owners.length) {
    const plain = /([A-Za-z0-9_@:.[\]+%/ -]+),\s*pid=(\d+)/g;
    while ((m = plain.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  }
  return { state: cols[0] ?? "", addr: cols[3] ?? "", owners, raw: line.slice(0, 200) };
}
function parsePsLine(line) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] };
}
function planRemoteKills(parsed, cfg) {
  const port = Number(cfg?.remotePort);
  const sshPort = Number(cfg?.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "\u8FDC\u7AEF\u7AEF\u53E3\u914D\u7F6E\u975E\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | invalid remote port" };
  if (port === sshPort) return { ok: false, error: `\u8FDC\u7AEF\u7AEF\u53E3\u5C31\u662F SSH \u670D\u52A1\u7AEF\u53E3 :${sshPort}\uFF0C\u62D2\u7EDD\u6E05\u7406 | refusing to touch the sshd service port` };
  if (!parsed || parsed.ok === false) return { ok: false, error: parsed?.error ?? "\u7F3A\u5C11\u8BCA\u65AD\u7ED3\u679C | no diagnosis" };
  const holders = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of parsed.holders) {
    const line = parseSsLine(raw);
    if (!/^(LISTEN|UNQ)/i.test(line.state)) {
      return { ok: false, error: `\u7AEF\u53E3 ${port} \u7684\u76D1\u542C\u884C\u65E0\u6CD5\u89E3\u6790\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | unparsable listener line: ${line.raw}` };
    }
    if (!line.owners.length) {
      return { ok: false, error: `\u7AEF\u53E3 ${port} \u7684\u5360\u7528\u8005\u8EAB\u4EFD\u4E0D\u53EF\u89C1\uFF08\u6743\u9650\u6216\u5185\u6838 socket\uFF09\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | cannot identify holder: ${line.raw}` };
    }
    for (const o of line.owners) {
      if (!/^sshd/i.test(o.name) || !Number.isInteger(o.pid)) {
        return { ok: false, error: `\u7AEF\u53E3 ${port} \u88AB\u975E sshd \u8FDB\u7A0B\u5360\u7528\uFF08${o.name || "?"} pid=${o.pid}\uFF09\uFF0C\u62D2\u7EDD\u6E05\u7406 | port held by non-sshd process` };
      }
      if (!seen.has(o.pid)) {
        seen.add(o.pid);
        holders.push({ pid: o.pid, name: o.name, addr: line.addr });
      }
    }
  }
  if (!holders.length) return { ok: true, holders: [], kill: [], note: `\u8FDC\u7AEF\u7AEF\u53E3 ${port} \u7A7A\u95F2\uFF0C\u65E0\u9700\u6E05\u7406 | remote port free` };
  const protectedPids = /* @__PURE__ */ new Set([1]);
  for (const raw of parsed.sshdListeners) for (const o of parseSsLine(raw).owners) if (Number.isInteger(o.pid)) protectedPids.add(o.pid);
  const tree = parsed.tree.map(parsePsLine).filter(Boolean);
  const byPid = new Map(tree.map((p) => [p.pid, p]));
  const childrenOf = /* @__PURE__ */ new Map();
  for (const p of tree) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p.pid);
  }
  const kill = [];
  const killSet = /* @__PURE__ */ new Set();
  const add = (entry) => {
    if (!killSet.has(entry.pid)) {
      killSet.add(entry.pid);
      kill.push(entry);
    }
  };
  for (const h of holders) {
    if (h.pid <= 1) return { ok: false, error: `\u5360\u7528\u8FDB\u7A0B pid=${h.pid} \u975E\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | refusing to touch pid ${h.pid}` };
    if (protectedPids.has(h.pid)) return { ok: false, error: `\u5360\u7528\u8FDB\u7A0B\u540C\u65F6\u662F SSH(:${sshPort}) \u76D1\u542C\u8FDB\u7A0B\uFF0C\u62D2\u7EDD\u6E05\u7406 | holder is also the sshd service listener` };
    add({ pid: h.pid, name: h.name, role: "holder" });
    let cur = h.pid;
    for (let depth = 0; depth < 3; depth += 1) {
      const node = byPid.get(cur);
      if (!node) break;
      const parent = byPid.get(node.ppid);
      if (!parent || parent.pid <= 1) break;
      if (protectedPids.has(parent.pid)) break;
      if (!/^sshd/i.test(parent.comm)) break;
      const kids = childrenOf.get(parent.pid) ?? [];
      if (!kids.length || !kids.every((k) => killSet.has(k))) break;
      add({ pid: parent.pid, name: parent.comm, role: "priv-parent" });
      cur = parent.pid;
    }
  }
  if (kill.length > MAX_KILL_TARGETS) {
    return { ok: false, error: `\u6E05\u7406\u76EE\u6807\u8FC7\u591A\uFF08${kill.length} \u4E2A pid\uFF09\uFF0C\u5224\u5B9A\u4E3A\u5F02\u5E38\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | too many kill targets` };
  }
  return { ok: true, holders, kill };
}
function runRemoteSsh(cfg, command, timeoutMs = 2e4, { execFn = execFile2 } = {}) {
  if (!sshTunnelConfigured(cfg)) return Promise.resolve({ ok: false, error: "SSH \u96A7\u9053\u672A\u914D\u7F6E | not configured", stdout: "", stderr: "" });
  return new Promise((resolve) => {
    let args;
    try {
      args = [...buildRemoteCmdArgs(cfg), command];
    } catch (err) {
      resolve({ ok: false, error: oneLine(err?.message ?? err), stdout: "", stderr: "" });
      return;
    }
    try {
      execFn(
        sshBinary(),
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20, env: childEnv() },
        (err, stdout, stderr) => {
          const killed = Boolean(err && err.killed);
          resolve({
            ok: !err,
            killed,
            exitCode: err && Number.isInteger(err.code) ? err.code : err ? 1 : 0,
            error: err ? killed ? `timeout after ${timeoutMs}ms` : oneLine(err.message ?? err) : "",
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            reason: err ? classifySshFailure(stderr).reason : ""
          });
        }
      );
    } catch (err) {
      resolve({ ok: false, error: `ssh \u6267\u884C\u5931\u8D25: ${oneLine(err?.message ?? err)}`, stdout: "", stderr: "", killed: false, exitCode: 1, reason: "unknown" });
    }
  });
}
async function reclaimRemotePort(cfg, {
  log = console,
  run = runRemoteSsh,
  // 注意：不能 unref——这是被 await 的清理间隔，unref 会让短命进程（维护脚本）在
  // 清理进行到一半时因为没有其它句柄而直接退出（2026-10-20 故障注入实测踩到）。
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  diagnoseCommand = remoteDiagnoseCommand,
  timeoutMs = 2e4
} = {}) {
  const rec = { at: Date.now(), ok: false, holders: [], kill: [], killed: [], error: "", note: "", stage: "diagnose" };
  const info = (...a) => (log.info ?? log.log)?.call(log, ...a);
  const warn = (...a) => log.warn?.(...a);
  if (!sshTunnelConfigured(cfg)) {
    rec.error = "SSH \u96A7\u9053\u672A\u914D\u7F6E | not configured";
    return rec;
  }
  if (Number(cfg.remotePort) === (Number(cfg.port) || 22)) {
    rec.error = "\u8FDC\u7AEF\u7AEF\u53E3\u5373 SSH \u670D\u52A1\u7AEF\u53E3\uFF0C\u62D2\u7EDD\u6E05\u7406 | refusing ssh port";
    return rec;
  }
  const diag = await run(cfg, diagnoseCommand(cfg), timeoutMs);
  rec.stage = "diagnose";
  if (diag.killed) {
    rec.error = "\u8FDC\u7AEF\u8BCA\u65AD\u8D85\u65F6\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | diagnosis timed out";
    return rec;
  }
  if (diag.error && !diag.stdout.trim()) {
    const tail = oneLine(diag.stderr || diag.error, 200);
    rec.error = `\u8FDC\u7AEF\u8BCA\u65AD\u8FDE\u63A5\u5931\u8D25\uFF08${diag.reason || "unknown"}\uFF09\uFF1A${tail}`;
    return rec;
  }
  const parsed = parseRemoteDiagnosis(diag.stdout);
  if (!parsed.ok) {
    rec.error = parsed.error;
    return rec;
  }
  const plan = planRemoteKills(parsed, cfg);
  rec.holders = (plan.holders ?? []).map((h) => ({ pid: h.pid, name: h.name }));
  rec.kill = (plan.kill ?? []).map((k) => ({ pid: k.pid, name: k.name, role: k.role }));
  if (!plan.ok) {
    rec.error = plan.error;
    return rec;
  }
  if (!plan.kill.length) {
    rec.ok = true;
    rec.note = plan.note ?? "\u65E0\u9700\u6E05\u7406";
    rec.stage = "free";
    return rec;
  }
  const pids = plan.kill.map((k) => k.pid).filter((p) => Number.isInteger(p) && p > 1);
  const pidArg = pids.join(" ");
  if (!pids.length || !/^\d+( \d+)*$/.test(pidArg)) {
    rec.error = "\u6E05\u7406\u76EE\u6807 pid \u4E0D\u5408\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | invalid pid list";
    return rec;
  }
  warn(`dsh-pocket: remote port ${cfg.remotePort} held by ${rec.kill.map((k) => `${k.name}(pid=${k.pid})`).join(", ")} \u2014 cleaning up | \u8FDC\u7AEF\u7AEF\u53E3\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u81EA\u52A8\u6E05\u7406`);
  rec.stage = "term";
  await run(cfg, `kill ${pidArg}`, 15e3);
  rec.killed = pids;
  await sleep(1500);
  let still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15e3);
  if (String(still.stdout ?? "").trim()) {
    rec.stage = "kill";
    await run(cfg, `kill -KILL ${pidArg}`, 15e3);
    await sleep(1200);
    still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15e3);
  }
  const free = !String(still.stdout ?? "").trim();
  rec.ok = free;
  rec.error = free ? "" : `\u6E05\u7406\u540E\u8FDC\u7AEF\u7AEF\u53E3 ${cfg.remotePort} \u4ECD\u88AB\u5360\u7528 | port still held`;
  if (free) info(`dsh-pocket: remote port ${cfg.remotePort} released (pid ${pidArg}) | \u8FDC\u7AEF\u7AEF\u53E3\u5DF2\u91CA\u653E`);
  return rec;
}
var DEFAULT_CLEANUP_LIMIT = MAX_AUTO_CLEANUPS;
function createSshTunnel({
  getConfig,
  getLocalPort = () => 3081,
  log = console,
  probeIntervalMs = 2e4,
  probeTimeoutMs = 8e3,
  maxBackoffMs = 6e4,
  startingGraceMs = 45e3,
  cleanupLimit = DEFAULT_CLEANUP_LIMIT,
  spawnFn = spawn2,
  execFn = execFile2,
  reclaim = reclaimRemotePort,
  findProcesses = findTunnelProcesses
} = {}) {
  const info = (...a) => (log.info ?? log.log).call(log, ...a);
  const warn = (...a) => log.warn.call(log, ...a);
  const state = {
    phase: "off",
    // off | starting | online | retrying | error
    reason: "",
    // port_occupied | auth | hostkey | dns | network | key_missing | cleanup_limit | probe | spawn | unknown
    adopted: false,
    // 已有一份健康隧道，不是本进程拉起的
    adoptedExternal: false,
    // 收养的是外部（手动/维护进程）起的隧道
    adoptedPid: null,
    // 收养时看到的本机 ssh pid
    pid: null,
    restarts: 0,
    attempts: 0,
    // 连续重连轮次（上线归零）
    autoKills: 0,
    // 连续自动清理次数（上线归零）
    cleanups: [],
    // 自动清理记录（最近 8 条）
    lastError: "",
    lastErrorAt: null,
    lastStderr: "",
    lastProbeAt: null,
    lastProbeStatus: 0,
    nextRetryAt: null,
    spawnedAt: null,
    url: ""
  };
  let child = null;
  let stopped = true;
  let probeTimer = null;
  let retryTimer = null;
  let backoff = 3e3;
  let failures = 0;
  const expectedExits = /* @__PURE__ */ new WeakSet();
  let starting = null;
  const currentConfig = () => normalizeSshTunnelConfig(typeof getConfig === "function" ? getConfig() : getConfig);
  function currentLocalPort(cfg) {
    const p = cfg.localPort > 0 ? cfg.localPort : Number(getLocalPort());
    return toPort(p, 3081);
  }
  function urlOf(cfg) {
    return cfg.host ? `http://${cfg.host}:${cfg.remotePort}` : "";
  }
  function setFailed(reason, message) {
    state.reason = reason || "unknown";
    state.lastError = oneLine(message, 400);
    state.lastErrorAt = Date.now();
  }
  function pushCleanup(rec) {
    state.cleanups = [rec, ...state.cleanups].slice(0, 8);
  }
  function probeOnce(cfg) {
    return new Promise((resolve) => {
      try {
        const req = http.request(
          {
            host: cfg.host,
            port: cfg.remotePort,
            path: "/",
            method: "GET",
            timeout: probeTimeoutMs,
            headers: { "user-agent": "dsh-pocket-tunnel-probe" }
          },
          (res) => {
            res.resume();
            state.lastProbeAt = Date.now();
            state.lastProbeStatus = res.statusCode ?? 0;
            resolve({ ok: true, status: res.statusCode ?? 0 });
          }
        );
        req.on("timeout", () => {
          req.destroy(new Error("probe timeout"));
        });
        req.on("error", (err) => {
          state.lastProbeAt = Date.now();
          state.lastProbeStatus = 0;
          resolve({ ok: false, error: err?.message ?? String(err) });
        });
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }
  function clearTimers() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }
  function ensureProbeTimer() {
    if (probeTimer || stopped) return;
    probeTimer = setInterval(() => {
      void checkOnceSafely(false);
    }, probeIntervalMs);
    if (probeTimer.unref) probeTimer.unref();
  }
  function scheduleRetry(cfg, why, { reason = null, delayMs = null } = {}) {
    if (stopped) return;
    setFailed(reason ?? state.reason, why ?? state.lastError);
    state.attempts += 1;
    state.phase = "retrying";
    const delay = Number.isInteger(delayMs) ? Math.max(500, delayMs) : backoff;
    state.nextRetryAt = Date.now() + delay;
    info(`dsh-pocket: ssh tunnel down (${reason ?? state.reason}, attempt ${state.attempts}) \u2014 retry in ${Math.round(delay / 1e3)}s | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u65AD\u5F00\uFF08${state.attempts} \u6B21\u91CD\u8BD5\uFF0C${Math.round(delay / 1e3)} \u79D2\u540E\u91CD\u8FDE\uFF09`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      void startSafely();
    }, delay);
    if (retryTimer.unref) retryTimer.unref();
    backoff = Math.min(maxBackoffMs, Math.round(backoff * 2));
  }
  function markOnline(cfg) {
    failures = 0;
    backoff = 3e3;
    state.attempts = 0;
    state.autoKills = 0;
    state.phase = "online";
    state.reason = "";
    state.lastError = "";
    state.nextRetryAt = null;
    state.url = urlOf(cfg);
  }
  function killChild() {
    if (!child) return;
    const c = child;
    child = null;
    state.pid = null;
    expectedExits.add(c);
    try {
      c.kill();
    } catch {
    }
  }
  function spawnTunnel(cfg, localPort) {
    const args = buildSshArgs(cfg, localPort);
    info(`dsh-pocket: starting ssh reverse tunnel ${cfg.host}:${cfg.remotePort} -> 127.0.0.1:${localPort} | \u542F\u52A8\u56FA\u5B9A\u516C\u7F51\u96A7\u9053`);
    let c;
    try {
      c = spawnFn(sshBinary(), args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: childEnv()
      });
    } catch (err) {
      setFailed("spawn", `spawn failed: ${err?.message ?? err}`);
      warn(`dsh-pocket: ssh spawn threw | \u62C9\u8D77 ssh \u5931\u8D25: ${state.lastError}`);
      scheduleRetry(cfg, state.lastError, { reason: "spawn" });
      return;
    }
    child = c;
    state.pid = c.pid ?? null;
    state.spawnedAt = Date.now();
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.phase = "starting";
    let stderrTail = "";
    if (c.stderr) {
      try {
        c.stderr.setEncoding("utf8");
      } catch {
      }
      c.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_LIMIT);
      });
      c.stderr.on("error", () => {
      });
    }
    c.once("error", (err) => {
      if (child === c) {
        child = null;
        state.pid = null;
      }
      scheduleRetry(cfg, `spawn failed: ${err?.message ?? err}`, { reason: "spawn" });
    });
    c.once("exit", (code, signal) => {
      if (child === c) {
        child = null;
        state.pid = null;
      }
      if (expectedExits.has(c)) {
        expectedExits.delete(c);
        return;
      }
      if (stopped) return;
      const cls = classifySshFailure(stderrTail, code);
      state.lastStderr = oneLine(stderrTail, 300);
      setFailed(cls.reason, `ssh exited (code=${code}${signal ? `, signal=${signal}` : ""})${state.lastStderr ? `: ${state.lastStderr}` : ""}`);
      state.restarts += 1;
      if (cls.reason === "port_occupied") {
        warn("dsh-pocket: ssh refused to bind remote port \u2014 stale remote tunnel | \u8FDC\u7AEF\u7AEF\u53E3\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u51C6\u5907\u81EA\u52A8\u6E05\u7406");
        scheduleRetry(cfg, state.lastError, { reason: "port_occupied", delayMs: Math.min(backoff, 2e3) });
        return;
      }
      scheduleRetry(cfg, state.lastError, { reason: cls.reason });
    });
    const t = setTimeout(() => {
      void checkOnceSafely(true);
    }, 3500);
    if (t.unref) t.unref();
  }
  async function maybeReclaimRemotePort(cfg, probeClass) {
    if (probeClass === "no_listener") return true;
    if (state.autoKills >= cleanupLimit) {
      const msg = `\u8FDC\u7AEF 0.0.0.0:${cfg.remotePort} \u4ECD\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u81EA\u52A8\u6E05\u7406\u5DF2\u8FDE\u7EED\u5C1D\u8BD5 ${state.autoKills} \u6B21\u4ECD\u672A\u6062\u590D\uFF0C\u9700\u8981\u4EBA\u5DE5\u5904\u7406\uFF08\u6216\u5728\u670D\u52A1\u5668\u4E0A kill \u6389\u76D1\u542C ${cfg.remotePort} \u7684 sshd-session\uFF09| auto cleanup limit reached`;
      setFailed("cleanup_limit", msg);
      warn(`dsh-pocket: remote port cleanup limit reached (${state.autoKills}/${cleanupLimit}) \u2014 giving up on reclaim | \u81EA\u52A8\u6E05\u7406\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u9700\u4EBA\u5DE5\u5904\u7406`);
      pushCleanup({ at: Date.now(), ok: false, stage: "limit", error: msg, holders: [], kill: [], killed: [] });
      return false;
    }
    state.autoKills += 1;
    let rec;
    try {
      rec = await reclaim(cfg, { log, run: (c, command, ms) => runRemoteSsh(c, command, ms, { execFn }) });
    } catch (err) {
      rec = { at: Date.now(), ok: false, stage: "error", error: oneLine(err?.message ?? err), holders: [], kill: [], killed: [] };
    }
    pushCleanup(rec);
    if (rec.ok) {
      info(`dsh-pocket: remote port reclaimed (attempt ${state.autoKills}/${cleanupLimit})${rec.killed?.length ? ` pid=${rec.killed.join(",")}` : ""} | \u8FDC\u7AEF\u7AEF\u53E3\u5DF2\u6E05\u7406`);
      return true;
    }
    setFailed("port_occupied", rec.error || "\u8FDC\u7AEF\u7AEF\u53E3\u6E05\u7406\u5931\u8D25 | remote reclaim failed");
    warn(`dsh-pocket: remote port reclaim failed: ${state.lastError} | \u8FDC\u7AEF\u7AEF\u53E3\u81EA\u52A8\u6E05\u7406\u5931\u8D25`);
    return false;
  }
  async function checkOnce(afterSpawn = false) {
    if (stopped) return;
    const cfg = currentConfig();
    if (!cfg.enabled) {
      stop();
      return;
    }
    if (!sshTunnelConfigured(cfg)) {
      setFailed("not_configured", "sshTunnel \u7F3A\u5C11 host \u6216 keyPath | missing host/keyPath");
      ensureProbeTimer();
      return;
    }
    if (child && state.phase === "starting" && state.spawnedAt && Date.now() - state.spawnedAt > startingGraceMs) {
      info("dsh-pocket: ssh not online within grace period \u2014 recycling | ssh \u957F\u65F6\u95F4\u672A\u5EFA\u7ACB\uFF0C\u56DE\u6536\u91CD\u8FDE");
      killChild();
      scheduleRetry(cfg, "ssh not online within grace period", { reason: "network", delayMs: 1e3 });
      return;
    }
    const probe = await probeOnce(cfg);
    if (stopped) return;
    if (probe.ok) {
      markOnline(cfg);
      if (afterSpawn) info(`dsh-pocket: ssh tunnel online \u2014 ${state.url} | \u56FA\u5B9A\u516C\u7F51\u5730\u5740\u5DF2\u53EF\u7528`);
      return;
    }
    if (!child && state.phase !== "online") return;
    if (!afterSpawn && child && state.spawnedAt && Date.now() - state.spawnedAt < 12e3) return;
    failures += 1;
    const need = afterSpawn ? 4 : 2;
    if (failures < need) return;
    failures = 0;
    if (child) {
      info("dsh-pocket: ssh tunnel probe failed \u2014 recycling process | \u96A7\u9053\u63A2\u6D3B\u5931\u8D25\uFF0C\u56DE\u6536 ssh \u8FDB\u7A0B\u91CD\u8FDE");
      killChild();
    } else {
      state.adopted = false;
      state.adoptedPid = null;
      state.adoptedExternal = false;
    }
    setFailed("probe", `probe failed: ${probe.error ?? "unknown"}`);
    scheduleRetry(currentConfig(), state.lastError, { reason: "probe" });
  }
  function checkOnceSafely(afterSpawn = false) {
    return Promise.resolve().then(() => checkOnce(afterSpawn)).catch((err) => {
      warn(`dsh-pocket: ssh tunnel probe threw | \u96A7\u9053\u63A2\u6D3B\u5F02\u5E38: ${oneLine(err?.message ?? err)}`);
      if (!stopped) scheduleRetry(currentConfig(), `probe threw: ${err?.message ?? err}`, { reason: "unknown" });
    });
  }
  function startSafely() {
    return Promise.resolve().then(() => start()).catch((err) => {
      setFailed("unknown", `start failed: ${err?.message ?? err}`);
      warn(`dsh-pocket: ssh tunnel start threw | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u542F\u52A8\u5F02\u5E38: ${state.lastError}`);
      if (!stopped) scheduleRetry(currentConfig(), state.lastError, { reason: "unknown" });
    });
  }
  async function start() {
    if (starting) return starting;
    starting = (async () => {
      await null;
      const cfg = currentConfig();
      state.url = urlOf(cfg);
      if (!cfg.enabled || !sshTunnelConfigured(cfg)) {
        state.reason = cfg.enabled ? "not_configured" : "";
        stop();
        return;
      }
      stopped = false;
      if (!existsSync2(cfg.keyPath)) {
        setFailed("key_missing", `private key not found: ${cfg.keyPath} | \u627E\u4E0D\u5230\u79C1\u94A5`);
        warn(`dsh-pocket: ssh key not found: ${cfg.keyPath} | \u627E\u4E0D\u5230\u79C1\u94A5\uFF0C\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u6682\u65F6\u65E0\u6CD5\u542F\u52A8\uFF08\u4F1A\u6301\u7EED\u91CD\u8BD5\uFF09`);
        scheduleRetry(cfg, state.lastError, { reason: "key_missing" });
        return;
      }
      if (child) {
        ensureProbeTimer();
        return;
      }
      const probe = await probeOnce(cfg);
      if (stopped) return;
      if (probe.ok) {
        markOnline(cfg);
        state.adopted = true;
        state.phase = "online";
        let pids = [];
        try {
          pids = await findProcesses(cfg, { execFn });
        } catch {
        }
        state.adoptedPid = pids[0] ?? null;
        state.adoptedExternal = true;
        info(`dsh-pocket: existing ssh tunnel adopted \u2014 ${state.url}${state.adoptedPid ? ` (local ssh pid=${state.adoptedPid})` : " (external process)"} | \u5DF2\u6709\u56FA\u5B9A\u516C\u7F51\u96A7\u9053\uFF0C\u76F4\u63A5\u6CBF\u7528\uFF08\u4E0D\u518D\u65B0\u5EFA\uFF09`);
        ensureProbeTimer();
        return;
      }
      const killedLocal = await killStaleTunnels(cfg, {
        execFn,
        onKill: (pids) => info(`dsh-pocket: killed stale local ssh tunnel pid=${pids.join(",")} | \u6E05\u7406\u672C\u673A\u6B8B\u7559\u96A7\u9053`)
      });
      if (killedLocal.length) pushCleanup({ at: Date.now(), ok: true, stage: "local", holders: [], kill: [], killed: killedLocal, error: "" });
      if (stopped) return;
      const probeClass = classifyProbeFailure(probe.error);
      if (probeClass === "stale_or_halfopen" || probeClass === "unknown") {
        await maybeReclaimRemotePort(cfg, probeClass);
      } else {
        setFailed("network", `probe failed: ${probe.error ?? "unknown"}`);
      }
      if (stopped) return;
      spawnTunnel(cfg, currentLocalPort(cfg));
      ensureProbeTimer();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  function stop() {
    stopped = true;
    clearTimers();
    killChild();
    state.phase = "off";
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.nextRetryAt = null;
    state.attempts = 0;
  }
  async function restart() {
    stop();
    state.restarts = 0;
    state.autoKills = 0;
    state.reason = "";
    state.lastError = "";
    backoff = 3e3;
    failures = 0;
    return start();
  }
  function status() {
    const cfg = currentConfig();
    return {
      enabled: cfg.enabled,
      configured: sshTunnelConfigured(cfg),
      host: cfg.host,
      remotePort: cfg.remotePort,
      sshPort: cfg.port,
      user: cfg.user,
      keySet: Boolean(cfg.keyPath),
      // 只暴露私钥文件名（不含目录）与是否存在——足够诊断 key_missing，不把本机路径全发给手机
      keyName: String(cfg.keyPath ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "",
      keyExists: Boolean(cfg.keyPath) && existsSync2(cfg.keyPath),
      localPort: currentLocalPort(cfg),
      url: state.url || urlOf(cfg),
      phase: state.phase,
      reason: state.reason,
      adopted: state.adopted,
      adoptedExternal: state.adoptedExternal,
      adoptedPid: state.adoptedPid,
      pid: state.pid,
      restarts: state.restarts,
      attempts: state.attempts,
      autoKills: state.autoKills,
      cleanupLimit,
      cleanups: state.cleanups.slice(0, 4).map((r) => ({
        at: r.at,
        ok: r.ok,
        stage: r.stage,
        killed: r.killed ?? [],
        holders: (r.holders ?? []).map((h) => `${h.name || "?"}:${h.pid}`),
        error: r.error ?? ""
      })),
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      lastStderr: state.lastStderr,
      lastProbeAt: state.lastProbeAt,
      lastProbeStatus: state.lastProbeStatus,
      nextRetryAt: state.nextRetryAt
    };
  }
  return { start, startSafely, stop, restart, status, checkOnce, probeOnce, _state: state };
}

// src/pocket-host/ip.mjs
function isValidIpv4(value) {
  const m = String(value ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m !== null && m.slice(1).every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

// src/pocket-host/service.mjs
var require2 = createRequire2(import.meta.url);
async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  const QRCode = require2("qrcode");
  return QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin, width, type: "image/png" });
}
var PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;
var PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;
var VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;
function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name3, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name3)) score += 20;
      else if (VPN_IFACE_RE.test(name3)) score -= 50;
      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}
function detectWsl() {
  try {
    const v = readFileSync2("/proc/version", "utf8").toLowerCase();
    if (v.includes("microsoft") || v.includes("wsl")) return true;
  } catch {
  }
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}
function parseIpconfig(text, { includeVpn = false } = {}) {
  const out = [];
  const blocks = String(text).split(/\r?\n(?=\S)/);
  const ipRe = /IPv4[^0-9]{0,40}((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/;
  for (const block of blocks) {
    const title = String(block.split(/\r?\n/)[0] ?? "");
    if (!includeVpn && VPN_IFACE_RE.test(title)) continue;
    const m = block.match(ipRe);
    if (m) out.push(m[0].replace(/^IPv4[^0-9]*/i, ""));
  }
  return out;
}
function runIpconfig() {
  const candidates = ["ipconfig.exe", "/mnt/c/Windows/System32/ipconfig.exe"];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) return resolve(null);
      execFile3(candidates[i], [], { timeout: 5e3, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return tryNext(i + 1);
        resolve(String(stdout));
      });
    };
    tryNext(0);
  });
}
async function lanIPv4() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const candidates = parseIpconfig(out ?? "");
      const ip = candidates.find((c) => PRIVATE_IPV4_RE.test(c)) ?? candidates[0];
      if (ip) return ip;
    } catch {
    }
  }
  return selectLanIPv4(networkInterfaces());
}
async function listLanCandidates() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const ips2 = parseIpconfig(out ?? "", { includeVpn: true });
      if (ips2.length) return [...new Set(ips2)];
    } catch {
    }
  }
  const ips = [];
  for (const [name3, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}
function createPocketService({
  dshPort,
  port = 3081,
  home,
  internals = {},
  /** 局域网地址手动覆盖：返回 IPv4 字符串；空值表示自动选择 */
  getLanIpOverride,
  /** 局域网访问总开关：返回 boolean；默认开启。关闭后代理拒绝局域网 Host 请求 */
  getLanEnabled = () => true,
  /** 代理注入 HTML 的内容（桌面端补丁等由 lib/index.js 传入；默认 randomUUID polyfill） */
  injectHtml,
  /** 访问令牌认证配置（issue #13）：{ getToken, isProtected }，传给代理 */
  auth,
  /** @type {() => string} dsh web 浏览器会话启动 token（issue #77；老版本返回空字符串） */
  launchToken = () => "",
  /** 隧道配置（issue #66）：() => ({ mode:'quick'|'named', token, hostname })；named 用固定域名 */
  getTunnelConfig,
  /** 固定公网地址（SSH 反向隧道）配置读取：() => normalized config；由 lib/index.js 传入 */
  getSshTunnelConfig,
  /** 固定公网地址守护（测试注入：{ start, stop, restart, status }） */
  sshTunnel,
  /** 隧道就绪回调（lib/index.js 用它轮换公网密码；参数为 'quick'|'named'） */
  onTunnelReady,
  /** 日志（DSH 宿主 ctx.logger 有 info/warn/error；默认 console 无 info，自动退回 log）。
   *  隧道自动恢复的成败必须走这里：console 输出在 DSH Desktop 里不进日志文件，
   *  出问题时无法排查（2026-09-07 实测教训）。 */
  log = console
} = {}) {
  const logInfo = (...args) => (log.info ?? log.log).call(log, ...args);
  const logWarn = (...args) => log.warn(...args);
  const createProxy = internals.createProxy ?? createPocketProxy;
  const startTunnel = internals.startTunnel ?? startQuickTunnel;
  const startNamed = internals.startNamedTunnel ?? startNamedTunnel;
  const getLanOverride = () => {
    const value = String(getLanIpOverride?.() ?? "").trim();
    return isValidIpv4(value) ? value : "";
  };
  const getLan = async () => getLanOverride() || (internals.lanIPv4 ? internals.lanIPv4() : lanIPv4());
  let lanCandidateCache = null;
  const getLanCandidates = async () => {
    if (internals.lanCandidates) return internals.lanCandidates();
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15e3) {
      lanCandidateCache = { at: now, ips: await listLanCandidates() };
    }
    return lanCandidateCache.ips;
  };
  let proxy = null;
  const fixedTunnel = sshTunnel ?? (getSshTunnelConfig ? createSshTunnel({
    getConfig: getSshTunnelConfig,
    getLocalPort: () => proxy?.port ?? port,
    log
  }) : null);
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: "idle", detail: "", startedAt: null };
  const qrCache = /* @__PURE__ */ new Map();
  const encodeQr = internals.encodeQr ?? qrDataUrl;
  async function qrCached(text) {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) {
        const oldest = qrCache.keys().next().value;
        qrCache.delete(oldest);
      }
      qrCache.set(text, encodeQr(text).catch(() => null));
    }
    return qrCache.get(text);
  }
  const autoStatePath = home ? join3(home, "dsh-pocket", "tunnel-auto.json") : null;
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await mkdir2(dirname4(autoStatePath), { recursive: true });
        await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), "utf8");
      } catch {
      }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await rm2(autoStatePath, { force: true });
      } catch {
      }
    });
    return autoStateQueue;
  }
  return {
    dshPort,
    /** 启动局域网代理（幂等）。端口被占（EADDRINUSE，如桌面版与普通环境同时运行）时自动尝试下一个端口。 */
    async startProxy() {
      if (proxy) return proxy;
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          proxy = await createProxy({
            port: p,
            host: "0.0.0.0",
            upstream: { host: "127.0.0.1", port: dshPort },
            ...injectHtml ? { injectHtml } : {},
            ...auth ? { auth } : {},
            // 每次请求实时读开关：设置页切换后立即生效，无需重启代理
            lanAccessEnabled: () => getLanEnabled(),
            // dsh web 浏览器会话启动 token（issue #77）：实时取，新版 dsh 才有
            ...launchToken ? { launchToken } : {}
          });
          if (p !== port) {
            logInfo(`dsh-pocket: port ${port} busy, proxy on ${p} | \u7AEF\u53E3 ${port} \u88AB\u5360\u7528\uFF0C\u4EE3\u7406\u6539\u7528 ${p}`);
          }
          break;
        } catch (err) {
          if (err?.code !== "EADDRINUSE") throw err;
          lastErr = err;
        }
      }
      if (!proxy) throw lastErr ?? new Error("proxy start failed | \u4EE3\u7406\u542F\u52A8\u5931\u8D25");
      if (fixedTunnel) {
        void fixedTunnel.start().catch((err) => {
          logWarn("dsh-pocket: fixed tunnel start failed | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u542F\u52A8\u5931\u8D25: %s", err?.message ?? err);
        });
      }
      return proxy;
    },
    /** 启动公网隧道（幂等；返回公网 URL）。进度写进 tunnelState。并发调用单飞。 */
    async startTunnel() {
      await this.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        if (phase === "downloading") tunnelState.detail = "\u9996\u6B21\u4E0B\u8F7D cloudflared\uFF08\u7EA6 20MB\uFF09| first run downloads cloudflared (~20MB)";
        else if (phase === "starting") tunnelState.detail = "\u542F\u52A8\u96A7\u9053\u8FDB\u7A0B\u2026 | starting tunnel\u2026";
        else if (phase === "registering") tunnelState.detail = "\u8FDE\u63A5 Cloudflare \u8FB9\u7F18\uFF08\u901A\u5E38 5-30 \u79D2\uFF09| connecting to Cloudflare edge (usually 5-30s)";
        else if (phase === "ready") tunnelState.detail = "\u96A7\u9053\u5C31\u7EEA | ready";
      };
      const p = (async () => {
        await null;
        try {
          const cfg = typeof getTunnelConfig === "function" ? getTunnelConfig() ?? {} : {};
          if (cfg?.mode === "named") {
            if (!cfg.token || !cfg.hostname) {
              throw new Error(
                "\u547D\u540D\u96A7\u9053\u672A\u914D\u7F6E\u5B8C\u6574\uFF1A\u9700\u8981 Tunnel Token \u548C\u56FA\u5B9A\u57DF\u540D\uFF08\u8BBE\u7F6E\u9875\u300C\u56FA\u5B9A\u57DF\u540D\u300D\u91CC\u586B\u5199\uFF09 | named tunnel is incomplete \u2014 set the Tunnel Token and the fixed hostname in Settings"
              );
            }
            const result = await startNamed({ token: cfg.token, home, signal: controller.signal, onPhase });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            const result = await startTunnel({ port: proxy.port, home, signal: controller.signal, onPhase });
            tunnel = typeof result === "string" ? { url: result, kill: () => {
            } } : result;
          }
          tunnelState.phase = "ready";
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = "error";
            tunnelState.detail = `\u96A7\u9053\u8FDB\u7A0B\u9000\u51FA\uFF08code=${code}\uFF09 | tunnel process exited (code=${code})`;
          });
          void persistAutoTunnel();
          try {
            onTunnelReady?.(cfg?.mode === "named" ? "named" : "quick");
          } catch {
          }
          return tunnel.url;
        } catch (err) {
          if (!controller.signal.aborted) {
            tunnelState.phase = "error";
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null;
          throw err;
        } finally {
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },
    /**
     * 停止公网隧道（代理保持）。
     * @param {{ keepAutoMarker?: boolean }} [opts] - keepAutoMarker=true 用于进程退出/
     *   自重启（dispose / pocketRestart）：隧道是随进程被动消失的，不是用户主动关闭，
     *   必须保留 tunnel-auto.json，下次启动才能自动恢复（issue #11 的本意）。
     *   默认（设置页手动关闭、恢复出厂）删除标记。
     */
    stopTunnel({ keepAutoMarker = false } = {}) {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = "idle";
      tunnelState.detail = "";
      tunnelState.startedAt = null;
      if (!keepAutoMarker) void clearAutoTunnel();
    },
    /** 启动时自动恢复上次开启的公网隧道（DSH 重启后 cloudflared 子进程被杀，issue #11）。 */
    async restoreTunnelIfNeeded() {
      logInfo("dsh-pocket: auto-restore check | \u81EA\u52A8\u6062\u590D\u68C0\u67E5\uFF1A\u8BFB\u53D6\u4E0A\u6B21\u96A7\u9053\u72B6\u6001");
      if (!autoStatePath || tunnel || tunnelPromise) return;
      let has = false;
      try {
        const raw = await readFile2(autoStatePath, "utf8");
        has = /"at"\s*:/.test(raw);
      } catch {
        return;
      }
      if (!has) return;
      logInfo("dsh-pocket: auto-restore: marker found, starting tunnel | \u53D1\u73B0\u4E0A\u6B21\u5F00\u542F\u6807\u8BB0\uFF0C\u5C1D\u8BD5\u81EA\u52A8\u6062\u590D");
      try {
        await this.startTunnel();
        logInfo("dsh-pocket: public tunnel auto-restored | \u5DF2\u81EA\u52A8\u6062\u590D\u516C\u7F51\u96A7\u9053");
      } catch (err) {
        logWarn("dsh-pocket: tunnel auto-restore failed | \u81EA\u52A8\u6062\u590D\u96A7\u9053\u5931\u8D25: %s", err?.message ?? err);
      }
    },
    /** 状态快照（RPC 返回，不含敏感信息；二维码 data URL 本地生成 + 缓存）。 */
    async status() {
      const lan = await getLan();
      const proxyPort2 = proxy?.port ?? null;
      const lanUrl = lan && proxyPort2 ? `http://${lan}:${proxyPort2}` : null;
      const lanIpOverride2 = getLanOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride2 && !lanCandidates.includes(lanIpOverride2)) lanCandidates.push(lanIpOverride2);
      return {
        proxyRunning: proxy !== null,
        proxyPort: proxyPort2,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates,
        lanIpOverride: lanIpOverride2,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelState: { ...tunnelState },
        // 隧道配置脱敏视图（issue #66）：token 永不回显，只有 tokenSet 布尔值
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === "function" ? getTunnelConfig() ?? {} : {};
          return {
            mode: cfg?.mode === "named" ? "named" : "quick",
            hostname: typeof cfg?.hostname === "string" ? cfg.hostname : "",
            tokenSet: Boolean(cfg?.token)
          };
        })(),
        // 固定公网地址（SSH 反向隧道）状态：地址/在线阶段/是否沿用已有隧道/失败原因
        sshTunnel: fixedTunnel?.status() ?? null,
        dshPort
      };
    },
    /** 固定公网地址：按当前配置重启（设置改完后调用）。 */
    restartFixedTunnel() {
      return fixedTunnel?.restart?.() ?? Promise.resolve();
    },
    /** 固定公网地址：立即停止（关闭开关时调用）。 */
    stopFixedTunnel() {
      fixedTunnel?.stop?.();
    },
    /** 停止一切（插件卸载时）。 */
    /** 停止一切（插件卸载时）。进程退出不是用户手动关闭：保留自动恢复标记。 */
    async dispose() {
      try {
        fixedTunnel?.stop?.();
      } catch {
      }
      this.stopTunnel({ keepAutoMarker: true });
      if (proxy) {
        const p = proxy;
        proxy = null;
        try {
          await p.close();
        } catch {
        }
      }
    }
  };
}

// src/pocket-host/web-rpc.js
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
import os2 from "node:os";

// src/client/pocket/api.js
var POCKET_RPC_CHANNEL = "/dsh-pocket";
var POCKET_ENDPOINTS = Object.freeze({
  status: "pocket.status",
  tunnelStart: "tunnel.start",
  tunnelStop: "tunnel.stop",
  tunnelSetConfig: "tunnel.setConfig",
  version: "pocket.version",
  update: "pocket.update",
  restart: "pocket.restart",
  lanTokenRefresh: "token.lanRefresh",
  lanAuthSetEnabled: "lanAuth.setEnabled",
  lanSetOverride: "lan.setOverride",
  lanSetEnabled: "lan.setEnabled",
  pinSetCustom: "pin.setCustom",
  pocketReset: "pocket.reset",
  // 固定公网地址（SSH 反向隧道）：开关；地址/主机等配置写 settings.json
  sshTunnelSetEnabled: "sshTunnel.setEnabled",
  // 立即重连（自愈失败时的人工触发）：会先收养健康隧道，再清理远端旧占用，最后新建
  sshTunnelReconnect: "sshTunnel.reconnect",
  // 移动端「复制文件内容」（issue #17）：手机经此 RPC 让主机读取文件正文，
  // 再写入剪贴板——因为手机无法直接打开电脑上的文件。
  fileRead: "pocket.fileRead",
  // 悬浮球：浏览电脑上的目录/文件（一定是电脑磁盘，不是手机存储）。
  fsList: "fs.list",
  // 悬浮球：手机附件落盘到电脑，返回绝对路径（正文内联 [file: 路径] 引用）。
  fsSaveUpload: "fs.saveUpload"
});
function redactStatus(s) {
  return {
    proxyRunning: s?.proxyRunning === true,
    proxyPort: s?.proxyPort ?? null,
    lanUrl: s?.lanUrl ?? null,
    lanQr: s?.lanQr ?? null,
    lanCandidates: Array.isArray(s?.lanCandidates) ? s.lanCandidates : [],
    lanIpOverride: s?.lanIpOverride ?? "",
    tunnelRunning: s?.tunnelRunning === true,
    tunnelUrl: s?.tunnelUrl ?? null,
    tunnelQr: s?.tunnelQr ?? null,
    tunnelState: s?.tunnelState ?? { phase: "idle" },
    tunnelConfig: s?.tunnelConfig ?? { mode: "quick", hostname: "", tokenSet: false },
    // 固定公网地址（SSH 反向隧道）状态：{ enabled, configured, url, phase, adopted, restarts, lastError, … }
    sshTunnel: s?.sshTunnel ?? null,
    dshPort: s?.dshPort ?? null
  };
}

// src/pocket-host/fs-rpc.mjs
import { execFile as execFile4 } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}
function uploadsDir() {
  return path.join(dshHome(), "dsh-pocket", "uploads");
}
function resolvePath(raw, cwd) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    if (/^~[/\\]?/.test(s)) return path.resolve(os.homedir(), s.replace(/^~[/\\]?/, ""));
    if (path.isAbsolute(s)) return path.resolve(s);
    return path.resolve(typeof cwd === "string" && cwd ? cwd : process.cwd(), s);
  } catch {
    return null;
  }
}
var MAX_LIST_ENTRIES = 1e3;
var desktopCache = null;
function desktopDir() {
  if (process.env.DSH_POCKET_DESKTOP) return Promise.resolve(process.env.DSH_POCKET_DESKTOP);
  if (desktopCache) return desktopCache;
  const fallback = path.join(os.homedir(), "Desktop");
  if (process.platform !== "win32") {
    desktopCache = Promise.resolve(fallback);
    return desktopCache;
  }
  desktopCache = new Promise((resolve) => {
    execFile4(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")'],
      { encoding: "utf8", timeout: 5e3, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout ?? "").trim();
        resolve(err || !out ? fallback : out);
      }
    );
  });
  return desktopCache;
}
async function listDrives() {
  if (process.platform !== "win32") return ["/"];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const found = await Promise.all(letters.map(async (letter) => {
    try {
      await fs.access(`${letter}:\\`);
      return `${letter}:\\`;
    } catch {
      return null;
    }
  }));
  const drives = found.filter(Boolean);
  return drives.length > 0 ? drives : ["C:\\"];
}
function byName(a, b) {
  return a.name.localeCompare(b.name);
}
function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (; ; ) {
    const parent = path.dirname(current);
    crumbs.unshift({ name: parent === current ? current : path.basename(current), path: current });
    if (parent === current) return crumbs;
    current = parent;
  }
}
async function listFs(rawPath, opts = {}) {
  const { includeFiles = false, cwd, maxEntries = MAX_LIST_ENTRIES } = opts;
  const home = os.homedir();
  if (rawPath !== void 0 && rawPath !== null && String(rawPath).trim() !== "" && resolvePath(rawPath, cwd) === null) {
    throw new Error(`\u8DEF\u5F84\u975E\u6CD5\uFF1A${rawPath} | invalid path`);
  }
  const target = resolvePath(rawPath, home) ?? home;
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55\uFF1A${target}\uFF08${err?.message ?? String(err)}\uFF09 | cannot list directory`);
  }
  const rows = [];
  let truncated = false;
  for (const dirent of dirents) {
    const isDir = dirent.isDirectory();
    if (!isDir && !dirent.isFile()) continue;
    if (rows.length >= maxEntries) {
      truncated = true;
      break;
    }
    rows.push({
      name: dirent.name,
      path: path.join(target, dirent.name),
      kind: isDir ? "dir" : "file",
      hidden: dirent.name.startsWith(".")
    });
  }
  rows.sort((a, b) => a.kind === b.kind ? byName(a, b) : a.kind === "dir" ? -1 : 1);
  const entries = [];
  for (const row of rows) {
    if (!includeFiles && row.kind !== "dir") continue;
    let stat3 = null;
    try {
      stat3 = await fs.stat(row.path);
    } catch {
      continue;
    }
    entries.push({ ...row, size: stat3.size, mtimeMs: stat3.mtimeMs });
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
  }
  const [desktop, drives] = await Promise.all([desktopDir(), listDrives()]);
  return { path: target, home, desktop, drives, crumbs: ancestryCrumbs(target), entries, truncated };
}
var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
function leafName(name3) {
  const leaf = path.basename(String(name3 ?? "").replace(/\\/g, "/")).trim();
  if (!leaf || leaf === "." || leaf === "..") return null;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(leaf)) return null;
  return leaf;
}
async function saveUpload(input) {
  const leaf = leafName(input?.name);
  if (!leaf) throw new Error(`\u6587\u4EF6\u540D\u975E\u6CD5\uFF1A${input?.name} | invalid file name`);
  let buf;
  try {
    buf = Buffer.from(String(input?.data ?? ""), "base64");
  } catch {
    throw new Error("\u9644\u4EF6\u6570\u636E\u975E\u6CD5\uFF08\u9700 base64\uFF09 | invalid attachment data");
  }
  if (buf.length === 0) throw new Error("\u9644\u4EF6\u4E3A\u7A7A | empty attachment");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`\u9644\u4EF6\u8FC7\u5927\uFF08${(buf.length / 1024 / 1024).toFixed(1)} MB\uFF09\uFF0C\u4E0A\u9650 25 MB | attachment too large`);
  }
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const target = path.join(dir, `${stamp}-${suffix}-${leaf}`);
  await fs.writeFile(target, buf);
  return { path: target, size: buf.length };
}

// src/pocket-host/web-rpc.js
var FILE_READ_MAX = 4 * 1024 * 1024;
var POCKET_RPC_BODY_MAX = 8 * 1024 * 1024;
var POCKET_RPC_UPLOAD_MAX = 40 * 1024 * 1024;
var ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
var INVALID_REQUEST_RPC_ID = "invalid-request";
var LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return void 0;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return void 0;
  }
  return endpoint;
}
function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: "server-response", rpcId, result });
}
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostName = host.split(":")[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function pocketFetchHandler(channel, handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== "POST" || endpoint === void 0) {
        return new Response("not found", { status: 404 });
      }
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = body && typeof body.rpcId === "string" ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === "string" ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return new Response(
          serverResponseJson(INVALID_REQUEST_RPC_ID, {
            ok: false,
            error: { code: "bad-request", message: "invalid client-request message", details: { issues: [] } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method !== endpoint) {
        return new Response(
          serverResponseJson(rpcId, {
            ok: false,
            error: {
              code: "bad-request",
              message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return new Response(serverResponseJson(rpcId, result), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      } catch (err) {
        log.error?.("dsh-pocket: rpc %s failed | RPC \u5931\u8D25: %s", endpoint, err?.message ?? err);
        return new Response(`handler failure: ${String(err)}`, { status: 500 });
      }
    }
  };
}
async function pocketHttpBridge(req, res, fetchHandler, maxBodyBytes) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const declaredLen = req.headers["content-length"];
  if (declaredLen !== void 0 && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url}`;
  const init = {
    method: req.method ?? "GET",
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => typeof v === "string")
    ),
    signal: abort.signal
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const request = new Request(url, init);
  const response = await fetchHandler.fetch(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}
function mountPocketWebRoute(ctx, { channel, handler, log }) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== "function") return null;
  const connection = ctx?.connection;
  const fetchHandler = pocketFetchHandler(channel, handler, log);
  const route = {
    kind: "prefix",
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === "function") {
        try {
          rejection = connection.requestRejection(req);
        } catch {
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== void 0) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
      const reqEndpoint = endpointFromPath(channel, (req.url ?? "").split("?")[0]);
      const bodyMax = reqEndpoint === POCKET_ENDPOINTS.fsSaveUpload ? POCKET_RPC_UPLOAD_MAX : POCKET_RPC_BODY_MAX;
      await pocketHttpBridge(req, res, fetchHandler, bodyMax);
    }
  };
  const registered = webServer.register(route);
  const cleanup = typeof registered === "function" ? () => {
    try {
      registered();
    } catch {
    }
  } : registered && typeof registered.then === "function" ? /* @__PURE__ */ (() => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      try {
        const d = await registered;
        if (typeof d === "function") d();
      } catch {
      }
    };
  })() : () => {
  };
  return cleanup;
}
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  if (code === "cancelled") return { ok: false, error: { code: "cancelled", message, details: {} } };
  return { ok: false, error: { code: "bad-request", message, details: { issues: [{ message }] } } };
}
function killHint(port) {
  if (process.platform === "win32") {
    return `netstat -ano | findstr :${port}\uFF08\u627E LISTENING \u7684 PID\uFF09\u2192 taskkill /PID <PID> /F`;
  }
  return `lsof -ti :${port} | xargs kill -9`;
}
function installPocketRpc(ctx, { service, log = console, desktop = false, runUpdate = null, restart = null, restartNotice = null, getToken = null, getLanToken: getLanToken2 = null, refreshLanToken: refreshLanToken2 = null, getLanAuthEnabled = null, setLanAuthEnabled: setLanAuthEnabled2 = null, getLanEnabled = null, setLanEnabled: setLanEnabled2 = null, getLanIpOverride = null, setLanIpOverride: setLanIpOverride2 = null, getPinCustom = null, setCustomPin: setCustomPin2 = null, getTunnelConfig = null, setTunnelConfig = null, resetPocket = null, setSshTunnelEnabled = null, reconnectSshTunnel = null }) {
  const pocketRpcHandler = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail("cancelled", "The request was cancelled.");
    const statusPayload = async () => {
      let notice = null;
      try {
        notice = await restartNotice?.() ?? null;
      } catch {
        notice = null;
      }
      const s = await service.status();
      return ok({
        ...redactStatus(s),
        desktop,
        restartNotice: notice,
        killHint: killHint(s.dshPort ?? 3080),
        accessToken: getToken?.() ?? null,
        lanToken: getLanToken2?.() ?? null,
        lanAuthEnabled: getLanAuthEnabled?.() ?? true,
        lanEnabled: getLanEnabled?.() ?? true,
        publicPinCustom: getPinCustom?.("public") ?? false,
        lanPinCustom: getPinCustom?.("lan") ?? false,
        tunnelConfig: getTunnelConfig?.() ?? { mode: "quick", hostname: "", tokenSet: false }
      });
    };
    try {
      if (endpoint === POCKET_ENDPOINTS.status) {
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.lanTokenRefresh) {
        const fresh = refreshLanToken2?.() ?? null;
        if (!fresh) return fail("bad-request", "\u5C40\u57DF\u7F51\u5BC6\u7801\u5237\u65B0\u4E0D\u53EF\u7528 | LAN PIN refresh unavailable");
        return ok({ lanToken: fresh });
      }
      if (endpoint === POCKET_ENDPOINTS.lanAuthSetEnabled) {
        const enabled = setLanAuthEnabled2?.(payload?.on === true);
        if (enabled === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u5BC6\u7801\u5F00\u5173\u4E0D\u53EF\u7528 | LAN PIN switch unavailable");
        return ok({ lanAuthEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetEnabled) {
        const enabled = setLanEnabled2?.(payload?.on === true);
        if (enabled === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u8BBF\u95EE\u5F00\u5173\u4E0D\u53EF\u7528 | LAN access switch unavailable");
        return ok({ lanEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetOverride) {
        try {
          const ip = setLanIpOverride2?.(payload?.ip ?? "");
          if (ip === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u5730\u5740\u8BBE\u7F6E\u4E0D\u53EF\u7528 | LAN address setting unavailable");
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pinSetCustom) {
        const which = payload?.which === "public" || payload?.which === "lan" ? payload.which : null;
        if (!which) return fail("bad-request", "\u672A\u77E5\u5BC6\u7801\u7C7B\u578B | unknown PIN kind");
        try {
          const pin = setCustomPin2?.(which, payload?.value);
          if (pin === void 0) return fail("bad-request", "\u81EA\u5B9A\u4E49\u5BC6\u7801\u4E0D\u53EF\u7528 | custom PIN unavailable");
          return ok({ which, pin, custom: true });
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelSetConfig) {
        if (!setTunnelConfig) return fail("bad-request", "\u96A7\u9053\u914D\u7F6E\u4E0D\u53EF\u7528 | tunnel config unavailable");
        try {
          setTunnelConfig({ mode: payload?.mode, hostname: payload?.hostname, token: payload?.token });
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pocketReset) {
        if (payload?.confirm !== true) {
          return fail("bad-request", "\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\u9700\u8981\u786E\u8BA4 | factory reset requires confirmation");
        }
        if (!resetPocket) return fail("bad-request", "\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\u4E0D\u53EF\u7528 | factory reset unavailable");
        try {
          service.stopTunnel();
          resetPocket();
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStart) {
        if (payload?.disclaimer !== true) {
          return fail("bad-request", "\u5F00\u542F\u516C\u7F51\u524D\u8BF7\u5148\u9605\u8BFB\u5E76\u52FE\u9009\u5B89\u5168\u514D\u8D23\u58F0\u660E | please accept the security disclaimer before enabling public access");
        }
        await service.startTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStop) {
        service.stopTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.sshTunnelSetEnabled) {
        if (!setSshTunnelEnabled) return fail("bad-request", "\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u4E0D\u53EF\u7528 | fixed tunnel unavailable");
        try {
          setSshTunnelEnabled(payload?.on === true);
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.sshTunnelReconnect) {
        if (!reconnectSshTunnel) return fail("bad-request", "\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u4E0D\u53EF\u7528 | fixed tunnel unavailable");
        try {
          const p = reconnectSshTunnel();
          if (p && typeof p.catch === "function") p.catch((err) => log.warn?.("dsh-pocket: fixed tunnel reconnect failed | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u91CD\u8FDE\u5931\u8D25: %s", err?.message ?? err));
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.version) {
        return ok({ current: runUpdate?.currentVersion?.() ?? null, loaded: runUpdate?.loadedVersion?.() ?? null });
      }
      if (endpoint === POCKET_ENDPOINTS.fileRead) {
        const raw = String(payload?.path ?? "").trim();
        if (!raw) return fail("bad-request", "\u7F3A\u5C11\u6587\u4EF6\u8DEF\u5F84 | missing path");
        let abs;
        try {
          if (/^~[/\\]?/.test(raw)) {
            abs = path2.resolve(os2.homedir(), raw.replace(/^~[/\\]?/, ""));
          } else if (path2.isAbsolute(raw)) {
            abs = path2.resolve(raw);
          } else {
            const base = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
            abs = path2.resolve(base, raw);
          }
        } catch {
          return fail("bad-request", "\u8DEF\u5F84\u975E\u6CD5 | invalid path");
        }
        let stat3;
        try {
          stat3 = await fs2.stat(abs);
        } catch {
          return fail("bad-request", `\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${abs} | file not found`);
        }
        if (stat3.isDirectory()) return fail("bad-request", "\u8FD9\u662F\u76EE\u5F55\uFF0C\u4E0D\u662F\u6587\u4EF6 | it is a directory");
        if (stat3.size > FILE_READ_MAX) {
          return fail("bad-request", `\u6587\u4EF6\u8FC7\u5927\uFF08${(stat3.size / 1024 / 1024).toFixed(1)} MB\uFF09\uFF0C\u65E0\u6CD5\u590D\u5236 | file too large`);
        }
        let buf;
        try {
          buf = await fs2.readFile(abs);
        } catch (err) {
          return fail("bad-request", `\u8BFB\u53D6\u5931\u8D25\uFF1A${err?.message ?? String(err)} | read failed`);
        }
        if (buf.subarray(0, 8192).includes(0)) {
          return fail("bad-request", "\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u590D\u5236\u6587\u672C | binary file");
        }
        return ok({ content: buf.toString("utf8"), path: abs, size: stat3.size });
      }
      if (endpoint === POCKET_ENDPOINTS.fsList) {
        try {
          const result = await listFs(payload?.path, {
            includeFiles: payload?.includeFiles === true,
            cwd: typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : void 0
          });
          return ok(result);
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.fsSaveUpload) {
        try {
          const saved = await saveUpload({ name: payload?.name, data: payload?.data });
          return ok({ ...saved, uploadsDir: uploadsDir() });
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.update) {
        if (desktop) return fail("bad-request", "\u684C\u9762\u7248\u66F4\u65B0\u7531 DSH Desktop \u7BA1\u7406\uFF0C\u5DF2\u5728\u6B64\u73AF\u5883\u505C\u7528 | updates are managed by DSH Desktop here");
        if (!runUpdate) return fail("bad-request", "\u66F4\u65B0\u4E0D\u53EF\u7528 | update unavailable");
        const result = await runUpdate.perform(payload?.profile ?? "web");
        if (result?.ok && restart) {
          const rr = restart();
          result.autoRestart = rr?.helperPid != null;
        }
        return ok(result);
      }
      if (endpoint === POCKET_ENDPOINTS.restart) {
        if (desktop) return fail("bad-request", "\u684C\u9762\u7248\u91CD\u542F\u7531 DSH Desktop \u7BA1\u7406\uFF0C\u5DF2\u5728\u6B64\u73AF\u5883\u505C\u7528 | restart is managed by DSH Desktop here");
        if (!restart) return fail("bad-request", "\u91CD\u542F\u4E0D\u53EF\u7528 | restart unavailable");
        const result = restart();
        if (!result || result.helperPid == null) {
          return fail("bad-request", `\u91CD\u542F\u5931\u8D25\uFF1A${result?.error ?? "\u672A\u77E5"} | restart failed`);
        }
        const dshPort = service.dshPort ?? 3080;
        return ok({ ...result, hint: `\u91CD\u542F\u540E\u8FDB\u7A0B\u5728\u540E\u53F0\u8FD0\u884C\uFF1B\u5982\u9700\u505C\u6B62\uFF1A${killHint(dshPort)}` });
      }
      return fail("bad-request", `Unknown endpoint: ${endpoint}`);
    } catch (err) {
      log.error?.("dsh-pocket: rpc %s failed | RPC \u5931\u8D25: %s", endpoint, err?.message ?? err);
      return fail("bad-request", err?.message ?? String(err));
    }
  };
  const directMount = mountPocketWebRoute(ctx, { channel: POCKET_RPC_CHANNEL, handler: pocketRpcHandler, log });
  if (directMount) return directMount;
  if (!ctx?.connection?.rpc?.handle) {
    log.warn?.("dsh-pocket: DSH Host Connection RPC unavailable \u2014 settings tab disabled | \u65E0 Connection RPC\uFF0C\u8BBE\u7F6E\u9875\u4E0D\u53EF\u7528");
    return () => {
    };
  }
  return ctx.connection.rpc.handle(POCKET_RPC_CHANNEL, pocketRpcHandler, { authority: "loopback" });
}

// src/pocket-host/restart.js
import { spawn as spawn3 } from "node:child_process";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
function dshPortFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      const n = Number(args[i + 1]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    } else if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }
  return 3080;
}
function restartLaunch() {
  if (process.versions.electron) {
    return {
      file: process.argv[0],
      // GUI exe
      args: [],
      cwd: process.cwd()
    };
  }
  return {
    file: process.argv[0],
    // node
    args: [...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    // [flags] <bin.js> + web [flags]
    cwd: process.cwd()
  };
}
function helperCode(launch, logOut, logErr, port) {
  const spawn6 = "const { spawn } = require('node:child_process')";
  const fs3 = "const fs = require('node:fs')";
  const net = "const net = require('node:net')";
  const file = `const file = ${JSON.stringify(launch.file)}`;
  const args = `const args = ${JSON.stringify(launch.args)}`;
  const cwd = `const cwd = ${JSON.stringify(launch.cwd)}`;
  const o = `const logOut = ${JSON.stringify(logOut)}`;
  const e = `const logErr = ${JSON.stringify(logErr)}`;
  const env = [
    "const childEnv = { ...process.env }",
    "delete childEnv.ELECTRON_RUN_AS_NODE",
    "delete childEnv.ELECTRON_NO_ATTACH_CONSOLE"
  ].join("\n");
  const body = [
    "function portFree(p, cb) {",
    '  const s = net.connect(p, "127.0.0.1")',
    '  s.once("connect", () => { s.destroy(); cb(false) })',
    // 还能连上 = 端口仍被占用
    '  s.once("error", () => cb(true))',
    // 连接被拒 = 已释放
    "}",
    "function waitPort(p, tries, cb) {",
    "  portFree(p, (free) => {",
    "    if (free || tries <= 0) cb(free)",
    "    else setTimeout(() => waitPort(p, tries - 1, cb), 200)",
    "  })",
    "}",
    `waitPort(${port}, 100, (free) => {`,
    // 最多 100×200ms = 20s；超时也照常拉起（宁可试拉、日志留痕，也不让 dsh 起不来）
    "  setTimeout(() => {",
    "    try {",
    '      const out = fs.openSync(logOut, "a")',
    '      const err = fs.openSync(logErr, "a")',
    '      const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: childEnv })',
    "      child.unref()",
    "    } catch (ex) {",
    '      try { fs.appendFileSync(logErr, "restart helper failed: " + (ex && ex.message) + "\\n") } catch {}',
    "    }",
    "  }, 300)",
    "})"
  ].join("\n");
  return [spawn6, fs3, net, file, args, cwd, o, e, env, body].join("\n");
}
function restartHost({ handoffMs = 1500, internals = {} } = {}) {
  const spawnFn = internals.spawn ?? spawn3;
  const killFn = internals.kill ?? ((pid) => process.kill(pid, "SIGTERM"));
  const launch = restartLaunch();
  const port = dshPortFromArgs(launch.args);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logOut = join4(tmpdir(), `dsh-pocket-restart-${stamp}.out.log`);
  const logErr = join4(tmpdir(), `dsh-pocket-restart-${stamp}.err.log`);
  let helperPid = null;
  try {
    const helper = spawnFn(process.execPath, ["-e", helperCode(launch, logOut, logErr, port)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env
    });
    helper.unref?.();
    helper.on?.("error", () => {
    });
    helperPid = helper.pid ?? null;
    setTimeout(() => {
      try {
        killFn(process.pid);
      } catch {
      }
    }, 500);
  } catch (err) {
    return { helperPid: null, logOut, logErr, error: err?.message ?? String(err) };
  }
  return { helperPid, logOut, logErr };
}

// src/pocket-host/settings.mjs
import { readFileSync as readFileSync3, writeFileSync, mkdirSync as mkdirSync2, rmSync } from "node:fs";
import { join as join5, dirname as dirname5 } from "node:path";
import { homedir as homedir4 } from "node:os";
import { randomBytes } from "node:crypto";
var settingsRel = join5("dsh-pocket", "settings.json");
function settingsPath() {
  return join5(process.env.DSH_HOME ?? join5(homedir4(), ".dsh"), settingsRel);
}
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync3(settingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
  }
  return {};
}
function writeSettings(s) {
  try {
    mkdirSync2(dirname5(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 384 });
  } catch {
  }
  return s;
}
function lanEnabled() {
  return readSettings().lanEnabled !== false;
}
function setLanEnabled(on) {
  const s = readSettings();
  s.lanEnabled = !!on;
  writeSettings(s);
  return s.lanEnabled;
}
function lanAuthEnabled() {
  return readSettings().lanAuthEnabled !== false;
}
function setLanAuthEnabled(on) {
  const s = readSettings();
  s.lanAuthEnabled = !!on;
  writeSettings(s);
  return s.lanAuthEnabled;
}
function lanIpOverride() {
  return readSettings().lanIpOverride ?? "";
}
function setLanIpOverride(value) {
  const ip = String(value ?? "").trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error("\u5C40\u57DF\u7F51\u5730\u5740\u5FC5\u987B\u662F IPv4 \u5730\u5740 | LAN address must be an IPv4 address");
  }
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
  return ip;
}
var PIN_CUSTOM_KEYS = { public: "publicPinCustom", lan: "lanPinCustom" };
function pinCustom(which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings()[key] === true;
}
function setPinCustom(which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  const s = readSettings();
  s[key] = !!on;
  writeSettings(s);
  return !!on;
}
function resetSettings() {
  try {
    rmSync(settingsPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
function tunnelMode() {
  return readSettings().tunnelMode === "named" ? "named" : "quick";
}
function setTunnelMode(mode) {
  if (mode !== "quick" && mode !== "named") {
    throw new Error("\u96A7\u9053\u6A21\u5F0F\u5FC5\u987B\u662F quick \u6216 named | tunnel mode must be quick or named");
  }
  const s = readSettings();
  if (mode === "quick") delete s.tunnelMode;
  else s.tunnelMode = mode;
  writeSettings(s);
  return mode;
}
function tunnelToken() {
  const v = readSettings().tunnelToken;
  return typeof v === "string" ? v : "";
}
function setTunnelToken(value) {
  const v = String(value ?? "").trim();
  if (v) {
    if (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v)) {
      throw new Error("Tunnel Token \u683C\u5F0F\u4E0D\u5BF9\uFF08\u5E94\u4E3A Cloudflare \u540E\u53F0\u590D\u5236\u7684\u5B8C\u6574 Token\uFF09 | invalid tunnel token");
    }
  }
  const s = readSettings();
  if (v) s.tunnelToken = v;
  else delete s.tunnelToken;
  writeSettings(s);
  return v;
}
function tunnelHostname() {
  const v = readSettings().tunnelHostname;
  return typeof v === "string" ? v : "";
}
function setTunnelHostname(value) {
  let v = String(value ?? "").trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#\s]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (v) {
    const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (IS_IPV4.test(v) || !v.includes(".") || !HOSTNAME_RE.test(v)) {
      throw new Error("\u56FA\u5B9A\u57DF\u540D\u683C\u5F0F\u4E0D\u5BF9\uFF08\u5982 pocket.example.com\uFF09 | invalid tunnel hostname");
    }
  }
  const s = readSettings();
  if (v) s.tunnelHostname = v;
  else delete s.tunnelHostname;
  writeSettings(s);
  return v;
}
function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}
function cloudflaredPath() {
  return readSettings().cloudflaredPath ?? "";
}
function sshTunnelConfig() {
  return normalizeSshTunnelConfig(readSettings().sshTunnel);
}
function setSshTunnelConfig(patch = {}) {
  const current = sshTunnelConfig();
  const merged = { ...current, ...patch && typeof patch === "object" ? patch : {} };
  const host = String(merged.host ?? "").trim();
  if (host) {
    const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
    if (!isValidIpv4(host) && !HOST_RE.test(host)) {
      throw new Error("\u516C\u7F51\u4E3B\u673A\u5FC5\u987B\u662F IPv4 \u6216\u57DF\u540D | tunnel host must be an IPv4 or a hostname");
    }
  }
  const next = normalizeSshTunnelConfig(merged);
  const s = readSettings();
  s.sshTunnel = next;
  writeSettings(s);
  return next;
}

// src/pocket-host/index.js
var name = "dsh-pocket";
var pkgPath = fileURLToPath2(new URL("../../package.json", import.meta.url));
function currentVersion() {
  try {
    return JSON.parse(readFileSync4(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
var loadedVersion = currentVersion();
var PIN_RE = /^[a-zA-Z0-9]{8}$/;
function writePinToFile(p, fresh) {
  try {
    mkdirSync3(dirname6(p), { recursive: true });
    writeFileSync2(p, fresh, { mode: 384 });
  } catch {
  }
  return fresh;
}
function readPin(p) {
  try {
    const existing = readFileSync4(p, "utf8").trim();
    if (PIN_RE.test(existing)) return existing;
  } catch {
  }
  return null;
}
function newPin() {
  return String(randomInt(1e7, 1e8));
}
var tokenRel = join6("dsh-pocket", "token");
function tokenPath() {
  return join6(process.env.DSH_HOME ?? join6(homedir5(), ".dsh"), tokenRel);
}
function getAccessToken() {
  return readPin(tokenPath()) ?? writePinToFile(tokenPath(), newPin());
}
function rotateAccessToken() {
  if (pinCustom("public")) return getAccessToken();
  return writePinToFile(tokenPath(), newPin());
}
var lanTokenRel = join6("dsh-pocket", "token-lan");
function lanTokenPath() {
  return join6(process.env.DSH_HOME ?? join6(homedir5(), ".dsh"), lanTokenRel);
}
function getLanToken() {
  return readPin(lanTokenPath()) ?? writePinToFile(lanTokenPath(), newPin());
}
function refreshLanToken() {
  setPinCustom("lan", false);
  return writePinToFile(lanTokenPath(), newPin());
}
function tokenForHost(host) {
  if (isLanOverrideHost(host)) return getLanToken();
  return classifyHost(host) === "public" ? getAccessToken() : getLanToken();
}
function hostNameOnly(host) {
  let name3 = String(host ?? "").trim().toLowerCase();
  if (name3.startsWith("[")) {
    const end = name3.indexOf("]");
    if (end >= 0) name3 = name3.slice(1, end);
  } else {
    name3 = name3.replace(/:\d+$/, "");
  }
  return name3;
}
function isLanOverrideHost(host) {
  const override = lanIpOverride().trim().toLowerCase();
  return override.length > 0 && hostNameOnly(host) === override;
}
function setCustomPin(which, value) {
  const v = String(value ?? "").trim();
  if (!PIN_RE.test(v)) throw new Error("\u5BC6\u7801\u5FC5\u987B\u662F 8 \u4F4D\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57 | PIN must be exactly 8 characters (letters and digits only)");
  if (which === "public") {
    writePinToFile(tokenPath(), v);
    setPinCustom("public", true);
    return v;
  }
  if (which === "lan") {
    writePinToFile(lanTokenPath(), v);
    setPinCustom("lan", true);
    return v;
  }
  throw new Error("\u672A\u77E5\u5BC6\u7801\u7C7B\u578B | unknown PIN kind");
}
function resetPocketState() {
  resetSettings();
  writePinToFile(tokenPath(), newPin());
  writePinToFile(lanTokenPath(), newPin());
  return { accessToken: getAccessToken(), lanToken: getLanToken() };
}
var restartNoticeRel = join6("dsh-pocket", "restarted.json");
function restartNoticePath() {
  return join6(process.env.DSH_HOME ?? join6(homedir5(), ".dsh"), restartNoticeRel);
}
async function readRestartNotice() {
  try {
    const raw = JSON.parse(await readFile3(restartNoticePath(), "utf8"));
    if (!raw?.at) return null;
    if (Date.now() - raw.at > 30 * 60 * 1e3) return null;
    return raw;
  } catch {
    return null;
  }
}
function writeRestartNotice() {
  return mkdir3(dirname6(restartNoticePath()), { recursive: true }).then(() => writeFile2(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), "utf8"));
}
async function consumeRestartNotice() {
  const notice = await readRestartNotice();
  if (notice) {
    await rm3(restartNoticePath(), { force: true }).catch(() => {
    });
  }
  return notice;
}
function pocketRestart(service) {
  const result = restartHost();
  if (!result || result.helperPid == null) return result;
  try {
    service?.stopTunnel({ keepAutoMarker: true });
  } catch {
  }
  writeRestartNotice().catch(() => {
  });
  return result;
}
function performUpdate(profile, { timeoutMs = 18e4 } = {}) {
  return new Promise((resolve) => {
    const child = spawn4("dsh", ["plugin", "--profile", profile, "update", "dsh-pocket", "--latest", "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上裸 spawn('dsh') 解析到无扩展名 POSIX shim → ENOENT；
      // Node 22+ 直接 spawn .cmd 会 EINVAL（CVE-2024-27980），必须走 shell（PR #54）
      shell: process.platform === "win32",
      // 宿主是 GUI 进程：不隐藏就会弹一个黑窗口出来（用户明确不要）
      windowsHide: true
    });
    let out = "";
    const onData = (c) => {
      out += String(c);
      if (out.length > 4e3) out = out.slice(-4e3);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-800) });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}
function apply2(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const dshPort = internals.dshPort ?? ctx.webServer?.port;
  if (!dshPort) {
    logger.error("dsh-pocket: webServer port unavailable \u2014 cannot start proxy | \u62FF\u4E0D\u5230 dsh web \u7AEF\u53E3\uFF0C\u65E0\u6CD5\u542F\u52A8\u4EE3\u7406");
    return () => {
    };
  }
  const pocketHome = (() => {
    const candidates = [
      internals.home,
      (() => {
        try {
          return ctx.get?.("profileContext")?.home;
        } catch {
          return void 0;
        }
      })(),
      process.env.DSH_HOME,
      join6(homedir5(), ".dsh")
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return join6(homedir5(), ".dsh");
  })();
  logger.info("dsh-pocket: home = %s | \u914D\u7F6E\u76EE\u5F55", pocketHome);
  const cfPath = cloudflaredPath();
  if (cfPath) {
    process.env.DSH_POCKET_CLOUDFLARED = cfPath;
    logger.info(`dsh-pocket: using custom cloudflared at ${cfPath} (skipping auto-download) | \u4F7F\u7528\u81EA\u5B9A\u4E49 cloudflared \u8DEF\u5F84\uFF08\u8DF3\u8FC7\u81EA\u52A8\u4E0B\u8F7D\uFF09`);
  }
  const isDesktop = internals.isDesktop !== void 0 ? internals.isDesktop === true : !!process.versions.electron || ctx.get?.("desktopProfiles") !== void 0 || ctx.get?.("desktopPnpm") !== void 0;
  if (isDesktop) {
    logger.info("dsh-pocket: DSH Desktop detected \u2014 update/restart disabled here | \u68C0\u6D4B\u5230\u684C\u9762\u7AEF\u73AF\u5883\uFF0C\u66F4\u65B0/\u91CD\u542F\u5DF2\u5173\u95ED");
  }
  const desktopAdvanced = isDesktop && (() => {
    try {
      const raw = readFileSync4(join6(process.env.DSH_HOME ?? join6(homedir5(), ".dsh"), "settings.yaml"), "utf8");
      return /dsh-plugin-desktop\s*:\s*[\s\S]{0,300}?mode\s*:\s*advanced/i.test(raw);
    } catch {
      return false;
    }
  })();
  if (desktopAdvanced) {
    logger.warn("dsh-pocket: DSH Desktop advanced mode \u2014 phone access unsupported, injecting notice | \u684C\u9762\u7AEF advanced \u6A21\u5F0F\uFF1A\u624B\u673A\u8BBF\u95EE\u6682\u4E0D\u652F\u6301\uFF0C\u5DF2\u6CE8\u5165\u63D0\u793A");
  }
  const service = internals.service ?? createPocketService({
    dshPort,
    // 端口（issue #70）：插件模式优先级 settings.proxyPort > cordis patch config.port > 3081。
    // 3081 被占时 createPocketService 内部 EADDRINUSE 抛错，按 DSH 插件启动失败处理（用户改端口重启即可）。
    port: internals.port ?? config.port ?? (proxyPort() || 3081),
    home: pocketHome,
    internals,
    getLanIpOverride: () => lanIpOverride(),
    getLanEnabled: () => lanEnabled(),
    // 桌面端**不再**注入 dsh-desktop-* 标记（issue #76）：
    //   - 旧版 dsh-plugin-desktop 缺 mode/platform 会抛错，当初正是为此加了补丁（issue #3/#4）；
    //   - 但 2.0.3 起，mode 与 platform **同时缺失**时 parseDesktopClientEnvironment 直接返回
    //     undefined（视作非桌面外壳，跳过全部桌面逻辑），正是手机页需要的效果；
    //   - 反之只要 URL 上出现任一 dsh-desktop-* 标记，客户端就会强制校验整组
    //     （material + semver version + mica），只补两个必然抛 "invalid or missing
    //     dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
    //   - 更糟的是 decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
    //     普通浏览器判为 denied（403），刷新后直接打不开。
    // 结论：手机/浏览器访问一律不带这些标记，advanced 模式另加警告覆盖层（issue #19）。
    injectHtml: isDesktop ? DEFAULT_INJECT + (desktopAdvanced ? advancedNoticeScript() : "") : void 0,
    // 访问密码（issue #13 + #18 + #24 + #33 + #66）：公网永远要密码（默认每次开启变新，
    // 用户自定义后不再轮换）；局域网按开关（默认开启；关闭后局域网扫码直连）。
    // 公网的判定是 fail closed：除了 loopback/私网 Host，一切陌生域名（含自建
    // 命名隧道的固定域名）都按公网处理、强制公网密码。
    auth: {
      // sessionKey：进程级随机密钥——登录 cookie 绑定它（会话保持，issue #33）：
      // dsh web 重启/更新后 sessionKey 变化 → 手机需重新输入
      sessionKey: randomBytes2(16).toString("hex"),
      getToken: (host) => tokenForHost(host),
      isProtected: (host) => {
        if (isLanOverrideHost(host)) return lanAuthEnabled();
        return classifyHost(host) === "public" ? true : lanAuthEnabled();
      }
    },
    // dsh web 浏览器会话启动 token（issue #77）：新版 dsh（>= 0.1.2-alpha.1）要求根路径
    // 带一次 `?token=` 换 cookie，否则 /api 与 WebSocket 全 401。token 每次进程启动都变，
    // 所以每次请求实时从 connection 服务取；老版本没有这个方法 → 返回空，行为不变。
    launchToken: () => {
      try {
        const fn = ctx.connection?.authenticatedUrl;
        if (typeof fn !== "function") return "";
        const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
        return url.searchParams.get("token") ?? "";
      } catch {
        return "";
      }
    },
    // 隧道模式（issue #66）：'quick'（默认，随机 trycloudflare.com）| 'named'（固定域名）
    getTunnelConfig: () => ({ mode: tunnelMode(), token: tunnelToken(), hostname: tunnelHostname() }),
    // 固定公网地址（SSH 反向隧道，2026-10-18）：代理就绪后由 service 自动拉起，
    // 每次启动/探活都重读 settings，零窗口、断线自动重连。
    getSshTunnelConfig: () => sshTunnelConfig(),
    // 让 service 的日志走宿主 logger（否则隧道排障信息只进 stdout，桌面端看不到）
    log: logger,
    // 隧道就绪回调：快速模式每次开启轮换 8 位密码（旧链接作废）；命名模式地址固定，
    // 不自动轮换（重启后密码不变，用户可用「自定义密码」主动更换）。
    onTunnelReady: (mode) => {
      if (mode === "named") {
        logger.info("dsh-pocket: named tunnel ready \u2014 PIN not rotated | \u547D\u540D\u96A7\u9053\u5C31\u7EEA\uFF08\u516C\u7F51\u5BC6\u7801\u4E0D\u81EA\u52A8\u8F6E\u6362\uFF09");
        return getAccessToken();
      }
      const fresh = rotateAccessToken();
      logger.info("dsh-pocket: public access PIN refreshed | \u516C\u7F51\u8BBF\u95EE\u5BC6\u7801\u5DF2\u66F4\u65B0\uFF08\u81EA\u5B9A\u4E49\u5BC6\u7801\u4E0D\u53D7\u5F71\u54CD\uFF09");
      return fresh;
    }
  });
  const disposers = [];
  const disposeRpc = installPocketRpc(ctx, {
    service,
    desktop: isDesktop,
    getToken: () => getAccessToken(),
    getLanToken: () => getLanToken(),
    refreshLanToken: () => refreshLanToken(),
    getLanAuthEnabled: () => lanAuthEnabled(),
    setLanAuthEnabled: (on) => setLanAuthEnabled(on),
    getLanEnabled: () => lanEnabled(),
    setLanEnabled: (on) => setLanEnabled(on),
    getLanIpOverride: () => lanIpOverride(),
    setLanIpOverride: (ip) => setLanIpOverride(ip),
    getPinCustom: (which) => pinCustom(which),
    setCustomPin: (which, value) => setCustomPin(which, value),
    // 命名隧道配置（issue #66）：RPC 只回显脱敏视图（token 只写不读）
    getTunnelConfig: () => ({ mode: tunnelMode(), hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 }),
    // 恢复出厂设置：清空设置文件 + 重设随机密码（RPC 层已先停掉公网隧道）
    resetPocket: () => resetPocketState(),
    setTunnelConfig: ({ mode, hostname, token } = {}) => {
      const m = mode === void 0 ? tunnelMode() : mode;
      if (m !== "quick" && m !== "named") throw new Error("\u672A\u77E5\u96A7\u9053\u6A21\u5F0F | unknown tunnel mode");
      setTunnelMode(m);
      if (hostname !== void 0) setTunnelHostname(hostname);
      if (token !== void 0) setTunnelToken(token);
      return { mode: tunnelMode(), hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 };
    },
    runUpdate: internals.runUpdate ?? { currentVersion, perform: performUpdate, loadedVersion: () => loadedVersion },
    restart: internals.restart ?? (() => pocketRestart(service)),
    restartNotice: internals.restartNotice ?? consumeRestartNotice,
    // 固定公网地址开关：持久化到 settings.json + 立即生效（开启→按最新配置重启守护）
    setSshTunnelEnabled: (on) => {
      const cfg = setSshTunnelConfig({ enabled: on === true });
      if (cfg.enabled) void service.restartFixedTunnel?.().catch(() => {
      });
      else service.stopFixedTunnel?.();
      return cfg;
    },
    // 立即重连：走 restart()——先探活收养外部健康隧道，再清本机残留 + 远端旧占用，最后新建；
    // 同时重置退避与「连续自动清理」计数（用户主动点 = 给一轮新的自愈预算）。
    reconnectSshTunnel: () => service.restartFixedTunnel?.() ?? Promise.resolve(),
    log: logger
  });
  disposers.push(disposeRpc);
  void service.startProxy().then((proxy) => {
    logger.info("dsh-pocket: proxy ready on :%d | \u5C40\u57DF\u7F51\u4EE3\u7406\u5DF2\u5C31\u7EEA", proxy.port);
    void service.restoreTunnelIfNeeded?.().catch(() => {
    });
  }).catch((err) => {
    logger.error("dsh-pocket: proxy start failed | \u4EE3\u7406\u542F\u52A8\u5931\u8D25: %s", err?.message ?? err);
  });
  ctx.effect(() => async () => {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
      }
    }
    await service.dispose();
  }, "dsh-pocket: stop proxy and tunnel");
}

// src/tuoguan-host.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync5, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname7, join as join7 } from "node:path";
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
    return normalizeState(JSON.parse(readFileSync5(file, "utf8")));
  } catch {
    return { off: {}, on: {}, defaultOn: true, revision: 0, updatedAt: "" };
  }
}
function writeStateSync(file, state) {
  const payload = `${JSON.stringify(state, void 0, 2)}
`;
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync4(dirname7(file), { recursive: true });
  writeFileSync3(temporary, payload, "utf8");
  renameSync2(temporary, file);
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
  const path3 = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
    if (path3 === STATE_ROUTE && method === "GET") {
      sendJson(res, 200, await store.read());
      return;
    }
    if (path3 === STATE_ROUTE && method === "POST") {
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
    if (path3 === STATE_ROUTE) {
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
function apply3(ctx) {
  const directory = profileDirectory(ctx);
  const store = new TuoguanStore(join7(directory, STATE_FILENAME));
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
import { mkdir as mkdir4, readFile as readFile4, rename as rename2, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname8, join as join8 } from "node:path";
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
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== "function") return;
  const file = join8(profileDir(ctx), STATE_FILENAME2);
  let cached = null;
  let loaded = false;
  let chain = Promise.resolve();
  const readState = async () => {
    if (loaded) return cached;
    try {
      cached = normalize(JSON.parse(await readFile4(file, "utf8")));
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
      await mkdir4(dirname8(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile3(tmp, payload, "utf8");
      await rename2(tmp, file);
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
      const path3 = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path3 !== STATE_ROUTE2) {
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
}

// src/desktop-ball.ts
import { spawn as spawn5 } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync5, openSync, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join9 } from "node:path";
import { randomBytes as randomBytes3 } from "node:crypto";
import { createServer as createServer2 } from "node:net";
function dshHome2() {
  return process.env.DSH_HOME || join9(homedir6(), ".dsh");
}
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
  return dshHome2();
}
function ballProfileDir(ctx) {
  return join9(profileDir2(ctx), "dsh-assistant-ball");
}
function findElectron() {
  const candidates = [
    join9(dshHome2(), "dsh-orb", "electron-runtime", "electron.exe"),
    join9(dshHome2(), "dsh-assistant", "electron", "electron.exe"),
    process.env.DSH_ASSISTANT_ELECTRON || ""
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync3(p)) return p;
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
  const dir = join9(profileDir2(ctx), "dsh-assistant-ball");
  try {
    mkdirSync5(dir, { recursive: true });
    writeFileSync4(join9(dir, "package.json"), JSON.stringify({ name: "dsh-assistant-ball", version: "1.0.0", main: "main.js" }), "utf8");
    writeFileSync4(join9(dir, "main.js"), HELPER_MAIN, "utf8");
    const avatar = String(opts.avatar ?? "").trim();
    const safeAvatar = avatar.startsWith("data:image/") ? avatar.replace(/"/g, "&quot;") : "";
    const avatarScript = safeAvatar ? `<script>document.getElementById('b').innerHTML=${JSON.stringify(`<img src="${safeAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none" alt="">`)}</script>` : "";
    writeFileSync4(join9(dir, "index.html"), BALL_HTML.replace("</body>", `${avatarScript}</body>`), "utf8");
  } catch (err) {
    try {
      console.error("[dsh-assistant] \u5199\u60AC\u6D6E\u7403 helper \u5931\u8D25\uFF1A", err);
    } catch {
    }
    return null;
  }
  const token = randomBytes3(16).toString("hex");
  let pendingClick = false;
  const clickListeners = /* @__PURE__ */ new Set();
  let child = null;
  const authSockets = /* @__PURE__ */ new Set();
  const server = createServer2((sock) => {
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
      logFd = openSync(join9(dir, "helper.log"), "a");
    } catch {
    }
    child = spawn5(exe, [dir, "--port", String(port), "--token", token], {
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
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync6, readFileSync as readFileSync6, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as joinPathNode } from "node:path";
var FOCUS_DIAG_LOG = joinPathNode(homedir7(), ".dsh", "dsh-assistant-focus.log");
function appendFocusDiag(raw) {
  const text = String(raw ?? "").slice(0, 8e3);
  if (!text) return;
  try {
    if (statSync2(FOCUS_DIAG_LOG).size > 512 * 1024) writeFileSync5(FOCUS_DIAG_LOG, "");
  } catch {
  }
  appendFileSync2(FOCUS_DIAG_LOG, text.replace(/\s+/g, " ") + "\n", "utf8");
}
var name2 = "dsh-assistant";
var inject = ["webServer", "sessions", "connection"];
function apply4(ctx, config = {}) {
  const disposers = [];
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
    const dispose = apply2?.(ctx, config, {});
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("pocket half failed: %s", String(err));
    } catch {
    }
    throw err;
  }
  try {
    const dispose = apply3?.(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("tuoguan half failed: %s", String(err));
    } catch {
    }
  }
  try {
    registerAssistantState(ctx);
  } catch (err) {
    try {
      ctx.logger?.("dsh-assistant")?.error?.("state store failed: %s", String(err));
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
  const sendClick = (res, open2) => {
    if (res?.destroyed || res?.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ open: open2, longPoll: true }));
  };
  const finishClickWaiter = (waiter, open2, respond = true) => {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    clickWaiters.delete(waiter);
    if (respond) {
      try {
        sendClick(waiter.res, open2);
      } catch {
      }
    }
  };
  const takeOpenClick = () => {
    let open2 = ballHandle ? ballHandle.takeClick() === true : false;
    if (pendingOpenConsole) {
      pendingOpenConsole = false;
      open2 = true;
    }
    return open2;
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
      const parsed = JSON.parse(readFileSync6(ballStateFile, "utf8"));
      if (parsed && typeof parsed.enabled === "boolean") enabled = parsed.enabled;
    } catch {
    }
    try {
      avatar = readFileSync6(ballAvatarFile, "utf8");
    } catch {
    }
    return { enabled, avatar };
  };
  const ballState = readBallState();
  const saveBallState = () => {
    try {
      if (ballStateFile) {
        mkdirSync6(ballDir, { recursive: true });
        writeFileSync5(ballStateFile, JSON.stringify({ enabled: ballState.enabled }), "utf8");
      }
      if (ballAvatarFile) {
        if (ballState.avatar) writeFileSync5(ballAvatarFile, ballState.avatar, "utf8");
        else rmSync2(ballAvatarFile, { force: true });
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
    ctx.webServer?.register?.({
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
    ctx.webServer?.register?.({
      kind: "exact",
      path: "/api/assistant/ball-avatar",
      handler: (req, res) => {
        if (String(req.method ?? "GET").toUpperCase() !== "POST") {
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
    ctx.webServer?.register?.({
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
    ctx.webServer?.register?.({
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
    ctx.webServer?.register?.({
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
  apply4 as apply,
  inject,
  name2 as name
};
