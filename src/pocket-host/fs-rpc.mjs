// 悬浮球「电脑文件」能力的主机端实现（lib/web-rpc.js 的 fs.list / fs.saveUpload 共用）。
//
// 两个入口：
//   listFs(path, { includeFiles }) — 列出电脑上的目录（可选含文件），带面包屑；
//   saveUpload({ name, data })    — 把手机上传的文件落到电脑磁盘，返回绝对路径。
//
// 安全边界与既有 pocket RPC 一致：仅本机 / 隧道经 PIN 可达（web-rpc 层已把关），
// 路径解析规则与 pocket.fileRead 完全对齐（绝对 / ~/ / 相对 cwd）。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 与 lib/tunnel.mjs、lib/settings.mjs 一致的 $DSH_HOME 解析。 */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

/** 悬浮球上传文件的落盘目录（$DSH_HOME/dsh-pocket/uploads）。 */
export function uploadsDir() {
  return path.join(dshHome(), 'dsh-pocket', 'uploads');
}

/**
 * 路径解析（与 web-rpc.js pocket.fileRead 同规则）：
 *   - ~/ 开头：展开 HOME；
 *   - 绝对路径：直接用；
 *   - 相对路径：相对 cwd（缺省 process.cwd()）。
 * @returns {string|null} 绝对路径；非法输入返回 null。
 */
export function resolvePath(raw, cwd) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    if (/^~[/\\]?/.test(s)) return path.resolve(os.homedir(), s.replace(/^~[/\\]?/, ''));
    if (path.isAbsolute(s)) return path.resolve(s);
    return path.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), s);
  } catch {
    return null;
  }
}

/** 列表单层上限（与官方目录浏览器一致：GitHub 1000 条截断）。 */
export const MAX_LIST_ENTRIES = 1000;

let desktopCache = null;

/**
 * 系统「桌面」目录（已知文件夹，**支持被重定向的桌面**——如 D:\xxx\Desktop）。
 * Windows 走 PowerShell 的 [Environment]::GetFolderPath('Desktop')（读注册表
 * User Shell Folders，重定向后依然正确；UTF-8 输出避免中文路径乱码）；
 * 取不到时回退 ~/Desktop。可用环境变量 DSH_POCKET_DESKTOP 覆盖。
 * @returns {Promise<string>} 绝对路径。
 */
export function desktopDir() {
  if (process.env.DSH_POCKET_DESKTOP) return Promise.resolve(process.env.DSH_POCKET_DESKTOP);
  if (desktopCache) return desktopCache;
  const fallback = path.join(os.homedir(), 'Desktop');
  if (process.platform !== 'win32') {
    desktopCache = Promise.resolve(fallback);
    return desktopCache;
  }
  desktopCache = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout ?? '').trim();
        resolve(err || !out ? fallback : out);
      },
    );
  });
  return desktopCache;
}

/**
 * 枚举本机盘符（Windows A–Z 存在的卷；POSIX 固定 ['/']）。
 * @returns {Promise<string[]>} 形如 ['C:\\', 'D:\\']。
 */
export async function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (letter) => {
    try {
      await fs.access(`${letter}:\\`);
      return `${letter}:\\`;
    } catch {
      return null;
    }
  }));
  const drives = found.filter(Boolean);
  return drives.length > 0 ? drives : ['C:\\'];
}

/** 单层目录项名排序比较器（不区分大小写，稳定展示）。 */
function byName(a, b) {
  return a.name.localeCompare(b.name);
}

/** 根到 target 的面包屑（含两端）。 */
function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    const parent = path.dirname(current);
    crumbs.unshift({ name: parent === current ? current : path.basename(current), path: current });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/**
 * 列出电脑上的一个目录。
 * @param {string} [rawPath] 目标路径（空/省略 = 用户 HOME）。
 * @param {{ includeFiles?: boolean, cwd?: string, maxEntries?: number }} [opts]
 *   includeFiles - true 时同时列出文件（悬浮球「电脑文件」选择器）；
 *                  false/缺省只列目录（「项目目录」选择器）。
 * @returns {Promise<{path:string, home:string, desktop:string, drives:string[],
 *   crumbs:Array<{name:string,path:string}>,
 *   entries:Array<{name:string,path:string,kind:'dir'|'file',size:number,mtimeMs:number,hidden:boolean}>,
 *   truncated:boolean}>}
 * @throws 路径非法 / 不可读时抛 Error（消息双语，与 web-rpc 文案风格一致）。
 */
export async function listFs(rawPath, opts = {}) {
  const { includeFiles = false, cwd, maxEntries = MAX_LIST_ENTRIES } = opts;
  const home = os.homedir();
  if (rawPath !== undefined && rawPath !== null && String(rawPath).trim() !== '' && resolvePath(rawPath, cwd) === null) {
    throw new Error(`路径非法：${rawPath} | invalid path`);
  }
  const target = resolvePath(rawPath, home) ?? home;
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取目录：${target}（${err?.message ?? String(err)}） | cannot list directory`);
  }
  const rows = [];
  let truncated = false;
  for (const dirent of dirents) {
    const isDir = dirent.isDirectory();
    if (!isDir && !dirent.isFile()) continue; // 跳过符号链接/设备等，与官方浏览器一致
    if (rows.length >= maxEntries) {
      truncated = true;
      break;
    }
    rows.push({
      name: dirent.name,
      path: path.join(target, dirent.name),
      kind: isDir ? 'dir' : 'file',
      hidden: dirent.name.startsWith('.'),
    });
  }
  rows.sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'dir' ? -1 : 1));
  // 仅目录模式下重算截断（含文件模式上面已截）。
  const entries = [];
  for (const row of rows) {
    if (!includeFiles && row.kind !== 'dir') continue;
    let stat = null;
    try {
      stat = await fs.stat(row.path);
    } catch {
      continue; // 竞态消失的条目静默跳过
    }
    entries.push({ ...row, size: stat.size, mtimeMs: stat.mtimeMs });
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
  }
  const [desktop, drives] = await Promise.all([desktopDir(), listDrives()]);
  return { path: target, home, desktop, drives, crumbs: ancestryCrumbs(target), entries, truncated };
}

/** 上传文件字节上限（与桌面悬浮球一致：25MB）。 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** 取纯文件名（防路径穿越：Windows 设备名一并拒绝）。 */
export function leafName(name) {
  const leaf = path.basename(String(name ?? '').replace(/\\/g, '/')).trim();
  if (!leaf || leaf === '.' || leaf === '..') return null;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(leaf)) return null;
  return leaf;
}

/**
 * 把手机上传的一个文件落到电脑磁盘。
 * @param {{ name: string, data: string }} input - data 为 base64 字节。
 * @returns {Promise<{ path: string, size: number }>} 落盘绝对路径与字节数。
 * @throws 名字非法 / 超限 / 写入失败时抛 Error。
 */
export async function saveUpload(input) {
  const leaf = leafName(input?.name);
  if (!leaf) throw new Error(`文件名非法：${input?.name} | invalid file name`);
  let buf;
  try {
    buf = Buffer.from(String(input?.data ?? ''), 'base64');
  } catch {
    throw new Error('附件数据非法（需 base64） | invalid attachment data');
  }
  if (buf.length === 0) throw new Error('附件为空 | empty attachment');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`附件过大（${(buf.length / 1024 / 1024).toFixed(1)} MB），上限 25 MB | attachment too large`);
  }
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  // 时间戳 + 随机后缀防并发撞名；保留原文件名便于用户识别。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  const target = path.join(dir, `${stamp}-${suffix}-${leaf}`);
  await fs.writeFile(target, buf);
  return { path: target, size: buf.length };
}
