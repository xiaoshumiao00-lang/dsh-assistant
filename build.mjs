/**
 * dsh-assistant 构建：
 *   - lib/index.js    服务端 ESM（cordis 插件：工作台路由 + 手机访问代理）
 *   - lib/client.js   客户端单文件 CJS（window.__ModuleLoader__.load 握手；
 *                     react / @deepseek-ai/* 由宿主模块系统提供，保持 external）
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(here, 'dsh.plugin.json'), 'utf8'))
if (pluginManifest.version !== pkg.version) {
  throw new Error('dsh-assistant build: package.json version (' + pkg.version + ') != dsh.plugin.json version (' + pluginManifest.version + ') — 发版前先统一两处版本号')
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
  external: ['@deepseek-ai/*', 'node:*', 'ws', 'node-pty', 'qrcode', 'electron'],
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
  // 客户端自报版本（随 package.json version 走，发版即自动一致）
  define: { __WT_VERSION__: JSON.stringify(pkg.version) },
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
// macOS 抓屏 helper 由 backend 用 import.meta.url 相对定位：打包后要跟到 lib/ 下
for (const asset of ['macos-sck-capture', 'libmacos-sck-capture.dylib']) {
  try { copyFileSync(join(here, 'vendor/computer-use', asset), join(here, 'lib', asset)) } catch { /* 平台无关，缺失不阻断 */ }
}

console.log('[dsh-assistant build] done: lib/index.js, lib/client.js, lib/computer-use*.js')
