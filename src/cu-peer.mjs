/**
 * 宿主模块（@deepseek-ai/*）解析器：内嵌的 Computer Use 工具要跟宿主共用同一份
 * dsh-tools / dsh-session 等实例（类与 registry 的身份必须一致），所以不能把官方包
 * 打包进来，必须在运行时从「正在运行的那个 DSH」里加载。
 *
 * 解析顺序：
 *   1. Electron 桌面版：<resources>/app.asar/dsh/node_modules（实测可 resolve + 动态 import）
 *   2. Electron 桌面版：<resources>/app.asar/node_modules
 *   3. 开发/解包布局：<resources>/app/dsh/node_modules
 *   4. 各 profile 的 node_modules（dsh web CLI 场景）
 *   5. 进程 cwd 的 node_modules
 */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function profileNodeModules() {
  const out = []
  try {
    const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      out.push(join(profiles, entry.name, 'node_modules'))
    }
  } catch { /* 没有 profile 目录时忽略 */ }
  return out
}

function bases() {
  const out = []
  const resources = typeof process !== 'undefined' ? process.resourcesPath : ''
  if (resources) {
    out.push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    out.push(join(resources, 'app.asar', 'node_modules'))
    out.push(join(resources, 'app', 'dsh', 'node_modules'))
    out.push(join(resources, 'app', 'node_modules'))
  }
  out.push(...profileNodeModules())
  out.push(join(process.cwd(), 'node_modules'))
  return out
}

const cache = new Map()

/** 同步解析包入口路径（找不到返回 ''）。 */
export function resolvePeer(name) {
  for (const base of bases()) {
    try {
      return createRequire(pathToFileURL(pathResolve(base, '__dsh_probe__.js')).href).resolve(name)
    } catch { /* 换下一个候选 */ }
  }
  return ''
}

/** 加载宿主模块（异步；与宿主共用同一份实例）。 */
export async function loadPeer(name) {
  if (cache.has(name)) return cache.get(name)
  const resolved = resolvePeer(name)
  if (!resolved) {
    throw new Error(`dsh-assistant: 找不到宿主模块 ${name}（Computer Use 工具需要由 DSH 宿主加载）`)
  }
  const mod = await import(pathToFileURL(resolved).href)
  cache.set(name, mod)
  return mod
}
