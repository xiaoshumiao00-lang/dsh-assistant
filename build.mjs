/**
 * dsh-assistant 构建：
 *   - lib/index.js    服务端 ESM（cordis 插件：工作台路由 + 手机访问代理）
 *   - lib/client.js   客户端单文件 CJS（window.__ModuleLoader__.load 握手；
 *                     react / @deepseek-ai/* 由宿主模块系统提供，保持 external）
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(here, 'dsh.plugin.json'), 'utf8'))
if (pluginManifest.version !== pkg.version) {
  throw new Error('dsh-assistant build: package.json version (' + pkg.version + ') != dsh.plugin.json version (' + pluginManifest.version + ') — 发版前先统一两处版本号')
}

/**
 * 更新公告由 CHANGELOG.md 生成（P0-4：公告与版本源同处，不再手写常量）。
 * 取当前版本那一节（## [x.y.z] … 到下一个 ## 之前）。
 */
function extractAnnouncement(markdown, version) {
  const lines = String(markdown).split(/\r?\n/)
  const escaped = String(version).replace(/\./g, '\\.')
  const heading = new RegExp(`^##\\s+\\[${escaped}\\]`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

const changelogPath = join(here, 'CHANGELOG.md')
if (!existsSync(changelogPath)) {
  throw new Error('dsh-assistant build: 仓库根目录缺少 CHANGELOG.md —— 控制室的更新公告由它生成')
}
const announcement = extractAnnouncement(readFileSync(changelogPath, 'utf8'), pkg.version)
if (!announcement) {
  throw new Error(`dsh-assistant build: CHANGELOG.md 里没有 "## [${pkg.version}]" 这一节 —— 更新公告必须跟版本源一起维护`)
}

const clientBanner = {
  js: "window.__ModuleLoader__.load({ id: 'dsh-assistant', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
}
const clientFooter = { js: 'return module.exports; } });' }

await build({
  entryPoints: [join(here, 'src/assistant.ts')],
  outfile: 'lib/index.js',
  bundle: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'node',
  define: { __WT_VERSION__: JSON.stringify(pkg.version) },
  format: 'esm',
  target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*', 'ws', 'node-pty', 'qrcode', 'electron', 'koffi'],
  loader: { '.css': 'text', '.html': 'text' }, // 原生皮肤模板以文本嵌入服务端 bundle
})

await build({
  entryPoints: [join(here, 'src/client/assistant.tsx')],
  outfile: 'lib/client.js',
  bundle: true,
  minify: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  loader: { '.css': 'text', '.png': 'dataurl' }, // xterm.css 内联；悬浮球默认头像内联为 data URL
  banner: clientBanner,
  footer: clientFooter,
  // 客户端自报版本（随 package.json version 走，发版即自动一致）；公告正文来自 CHANGELOG.md 当前版本那一节
  define: { __WT_VERSION__: JSON.stringify(pkg.version), __WT_ANNOUNCE__: JSON.stringify(announcement) },
})

// ── 内嵌 Computer Use（源自 dsh-orb 的 MIT 代码，见 vendor/computer-use/LICENSE.dsh-orb）──
// 官方 @deepseek-ai/* 包必须与宿主共用同一份实例（类/工具 registry 的身份），所以
// 用 shim 在运行时从正在运行的 DSH 里加载（Electron 的 app.asar 路径也可解析）。
// koffi / zod 是本包自己的依赖（node_modules 内），保持 external。
const cuAlias = {
  '@deepseek-ai/dsh-attachment': pathResolve(here, 'src/cu-shims/dsh-attachment.mjs'),
  '@deepseek-ai/dsh-brand': pathResolve(here, 'src/cu-shims/dsh-brand.mjs'),
  '@deepseek-ai/dsh-llm': pathResolve(here, 'src/cu-shims/dsh-llm.mjs'),
  '@deepseek-ai/dsh-session': pathResolve(here, 'src/cu-shims/dsh-session.mjs'),
  '@deepseek-ai/dsh-tools': pathResolve(here, 'src/cu-shims/dsh-tools.mjs'),
  '@deepseek-ai/schemastery': pathResolve(here, 'src/cu-shims/schemastery.mjs'),
}
const cuBuilds = [
  ['vendor/computer-use/index.js', 'lib/computer-use.js'],
  ['vendor/computer-use/code-agent.js', 'lib/computer-use-code-agent.js'],
  ['vendor/computer-use/code-agent-registry.js', 'lib/computer-use-code-agent-registry.js'],
]
for (const [entry, outfile] of cuBuilds) {
  await build({
    entryPoints: [join(here, entry)],
    outfile,
    bundle: true,
    sourcemap: 'external',
    logLevel: 'info',
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    alias: cuAlias,
    external: ['node:*', 'koffi', 'zod'],
    define: { __WT_VERSION__: JSON.stringify(pkg.version) },
  })
}
// 控制室预置背景作为独立同源资源按需下载，不内联进首屏 client bundle。
copyFileSync(join(here, 'src/console-sea01.jpg'), join(here, 'lib/console-sea01.jpg'))

// macOS 抓屏 helper 由 backend 用 import.meta.url 相对定位：打包后要跟到 lib/ 下
for (const asset of ['macos-sck-capture', 'libmacos-sck-capture.dylib']) {
  try { copyFileSync(join(here, 'vendor/computer-use', asset), join(here, 'lib', asset)) } catch { /* 平台无关，缺失不阻断 */ }
}

// 手机访问独立构建：先在同层级临时目录生成，内容真正变化才替换正式产物。
// 这样工作台 / 客户端构建不会触碰 pocket 的 mtime，DSH 也就不会重载手机服务。
const pocketBuildDir = mkdtempSync(join(here, '.pocket-build-'))
const pocketOut = join(here, 'lib/pocket.js')
const pocketMap = join(here, 'lib/pocket.js.map')
try {
  await build({
    entryPoints: [join(here, 'src/pocket.ts')],
    outfile: join(pocketBuildDir, 'pocket.js'),
    bundle: true,
    sourcemap: 'external',
    logLevel: 'info',
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    external: ['@deepseek-ai/*', 'node:*', 'ws', 'qrcode'],
  })
  const next = readFileSync(join(pocketBuildDir, 'pocket.js'))
  if (!existsSync(pocketOut) || !readFileSync(pocketOut).equals(next)) {
    copyFileSync(join(pocketBuildDir, 'pocket.js'), pocketOut)
    copyFileSync(join(pocketBuildDir, 'pocket.js.map'), pocketMap)
  }
} finally {
  rmSync(pocketBuildDir, { recursive: true, force: true })
}

console.log('[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js')
