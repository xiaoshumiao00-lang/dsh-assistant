// 手机首屏只精简桌面原生能力、埋点与开发期 HMR。
// 设置、Skill、自动化任务、记忆系统等用户功能必须保留；过度裁剪会直接删掉侧边栏入口。
// 手机需要完整插件树时，仍可在 URL 加 ?dsh-full-plugins=1 绕过本优化。

export const MOBILE_OMITTABLE_MODULES = Object.freeze([
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-product-analytics',
  '@deepseek-ai/dsh-client-hmr',
])

const BOOT_SCRIPT_RE = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/

// LPT 合包权重（实测 gzip 字节量级）。大包不能集中在同一路，否则其它两路早已完成、
// 最后一路独占慢链路继续下载十几秒。未列出的中小模块按 10KB 估算。
const MODULE_BATCH_WEIGHT = {
  'dsh-assistant': 663_932,
  '@deepseek-ai/dsh-api-remotes': 146_543,
  '@deepseek-ai/dsh-client-ui-conversation': 239_869,
  '@deepseek-ai/dsh-client-ui-plugin-manager': 258_000,
  '@deepseek-ai/dsh-client-ui-chat': 189_809,
  '@deepseek-ai/dsh-cordis-client-runner': 78_041,
  '@deepseek-ai/dsh-client-ui-trajectory': 11_640,
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': 18_000,
  '@deepseek-ai/dsh-client-ui-workspace': 26_078,
  '@deepseek-ai/dsh-client-ui-tool': 13_706,
  '@deepseek-ai/dsh-client-ui-sidebar-right': 12_154,
  '@deepseek-ai/dsh-api-session-controller': 51_123,
  '@deepseek-ai/dsh-client-ui-input-trigger': 64_775,
  '@deepseek-ai/dsh-client-ui-cordis': 54_310,
  '@deepseek-ai/dsh-client-ui-skill': 26_078,
  '@deepseek-ai/dsh-client-shortcuts': 32_780,
  '@deepseek-ai/dsh-client-ui-shortcuts': 20_580,
}
const moduleWeight = (id) => MODULE_BATCH_WEIGHT[id] ?? 10_000
const MOBILE_BATCH_COUNT = 3

/** 从 combo URL 删除指定模块；全部删完时返回 null。同时兼容 HTML 的 &amp;rev=。 */
export function omitFromComboUrl(url, omitted) {
  const query = String(url).indexOf('??')
  if (query < 0) return String(url)
  const raw = String(url)
  const revRaw = raw.indexOf('&rev=', query + 2)
  const revHtml = raw.indexOf('&amp;rev=', query + 2)
  const revAt = revRaw >= 0 ? revRaw : revHtml
  if (revAt < 0) return raw
  const resources = raw.slice(query + 2, revAt).split(',')
  const kept = resources.filter((resource) => {
    const id = resource.endsWith('/client.js') ? resource.slice(0, -'/client.js'.length) : resource
    return !omitted.has(id)
  })
  if (kept.length === 0) return null
  return raw.slice(0, query + 2) + kept.join(',') + raw.slice(revAt)
}

/**
 * 精简 HTML 中的 __DSH_BOOT__ 与 application preload。
 * external 模块引用做闭包保护：若保留模块确实 require 某候选模块，则候选自动恢复。
 */
export function optimizeMobileBoot(html, { omittable = MOBILE_OMITTABLE_MODULES, createBatch = null } = {}) {
  const match = BOOT_SCRIPT_RE.exec(String(html))
  if (!match) return { html: String(html), omitted: [], changed: false }
  let graph
  try { graph = JSON.parse(match[1]) } catch { return { html: String(html), omitted: [], changed: false } }
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) {
    return { html: String(html), omitted: [], changed: false }
  }

  const present = new Set(graph.entries.map((row) => row.id))
  const omitted = new Set([...omittable].filter((id) => present.has(id)))
  // external 是模块加载硬依赖，inject 是 Cordis 服务硬依赖；任一保留条目需要
  // 某候选模块时都必须把它恢复，否则会在 require 或 loader.await() 卡死。
  for (let changed = true; changed;) {
    changed = false
    for (const row of graph.entries) {
      if (omitted.has(row.id)) continue
      for (const dependency of [...(row.external ?? []), ...(row.inject ?? [])]) {
        const id = dependency.endsWith('/client') ? dependency.slice(0, -'/client'.length) : dependency
        if (omitted.delete(id)) changed = true
      }
    }
  }
  if (omitted.size === 0) return { html: String(html), omitted: [], changed: false }

  graph.entries = graph.entries.filter((row) => !omitted.has(row.id))
  // 宿主只发布已登记的 batch URL，改写 combo 会 404。每个保留 entry 都有自己
  // 已存在的单包 fallback URL；用它重建 application batches，协议合法且无需改 Host。
  const bootstrapIds = new Set(graph.batches
    .filter((batch) => batch.phase === 'bootstrap')
    .flatMap((batch) => batch.entries ?? []))
  const applicationEntries = graph.entries.filter((row) => !bootstrapIds.has(row.id))
  let applicationBatches
  if (typeof createBatch === 'function') {
    // LPT 分到 3 路：实测比 6 路更快，避免慢链路在过多连接间调度产生长尾。
    const chunks = Array.from({ length: MOBILE_BATCH_COUNT }, () => ({ rows: [], weight: 0 }))
    const order = new Map(applicationEntries.map((row, index) => [row.id, index]))
    const sorted = [...applicationEntries].sort((a, b) => moduleWeight(b.id) - moduleWeight(a.id))
    for (const row of sorted) {
      const target = chunks.reduce((best, current) => current.weight < best.weight ? current : best, chunks[0])
      target.rows.push(row)
      target.weight += moduleWeight(row.id)
    }
    applicationBatches = chunks.filter((chunk) => chunk.rows.length > 0).map((chunk, index) => {
      const rows = chunk.rows.sort((a, b) => order.get(a.id) - order.get(b.id))
      return {
        phase: 'application',
        entries: rows.map((row) => row.id),
        url: createBatch(rows, index),
        rev: `${graph.rev}.${index}`,
      }
    })
  } else {
    applicationBatches = applicationEntries.map((row) => ({
      phase: 'application', entries: [row.id], url: row.url, rev: row.rev,
    }))
  }
  graph.batches = [
    ...graph.batches.filter((batch) => batch.phase === 'bootstrap'),
    ...applicationBatches,
  ]
  const escapeAttr = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const preloads = graph.batches.filter((batch) => batch.phase === 'application')
    .map((batch) => `<link rel="preload" as="script" href="${escapeAttr(batch.url)}">`).join('')

  const dropOldPreloads = (text) => text.replace(/<link\b[^>]*\brel="preload"[^>]*>/gi, (tag) => {
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1]
    return href?.includes('plugins/??') ? '' : tag
  })
  const out = dropOldPreloads(String(html).slice(0, match.index))
    + preloads
    + `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script>`
    + dropOldPreloads(String(html).slice(match.index + match[0].length))
  return { html: out, omitted: [...omitted], changed: true }
}
