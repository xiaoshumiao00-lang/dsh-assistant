/**
 * 「单击悬浮球 → 个人秘书会话」链路的落盘诊断（JSONL 一行一条）。
 *
 * 为什么要有这个：这条链路此前只有 DevTools 里看得到，宿主重启后「单击没反应」时
 * 现场什么都留不下来，只能靠猜。这里把点击意图、解析到的 sessionId、开页结果、
 * 失败原因、重建与兜底都写进 ~/.dsh/dsh-assistant-open.log，出问题直接看日志。
 *
 * 客户端（assistant-entry.ts）POST /api/assistant/open-diag；
 * 宿主（悬浮球意图、外部唤起路由）自己也写同一条日志。超过 512KB 自动清空。
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OPEN_DIAG_LOG = (() => {
  // 测试可以指到临时文件，不让单测往用户的 ~/.dsh 里写
  const override = String((globalThis as any).process?.env?.DSH_ASSISTANT_OPEN_DIAG_LOG ?? '').trim()
  return override !== '' ? override : join(homedir(), '.dsh', 'dsh-assistant-open.log')
})()
const SIZE_LIMIT = 512 * 1024

/** 追加一行诊断。写盘失败不影响任何功能（调用方不看返回值）。 */
export function appendOpenDiag(entry: Record<string, unknown>): void {
  try {
    const text = JSON.stringify({ at: new Date().toISOString(), ...entry }).replace(/\s+/g, ' ').slice(0, 2000)
    try {
      if (statSync(OPEN_DIAG_LOG).size > SIZE_LIMIT) writeFileSync(OPEN_DIAG_LOG, '', 'utf8')
    } catch { /* 文件不存在，正常 */ }
    appendFileSync(OPEN_DIAG_LOG, text + '\n', 'utf8')
  } catch { /* 诊断写盘失败不影响任何功能 */ }
}

/** 读日志尾部（GET /api/assistant/open-diag 用它把诊断送回页面与测试）。 */
export function readOpenDiagTail(lines = 40): string[] {
  try {
    const raw = readFileSync(OPEN_DIAG_LOG, 'utf8').split('\n').filter((line) => line.trim() !== '')
    return raw.slice(-lines)
  } catch {
    return []
  }
}

/** 打开诊断路由（页面 POST，测试/控制台 GET）。 */
export const OPEN_DIAG_PATH = '/api/assistant/open-diag'
const MAX_BODY_BYTES = 8192

function readJsonBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req?.on?.('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES + 1024) chunks.push(Buffer.from(chunk))
    })
    req?.on?.('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : { raw: String(parsed ?? '').slice(0, 500) })
      } catch {
        resolve({ raw: text.slice(0, 500) })
      }
    })
    req?.on?.('error', () => resolve({}))
  })
}

function sendJson(res: any, status: number, payload: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  } catch { /* 已经写过状态码 */ }
  res.end(JSON.stringify(payload))
}

/** 路由处理器（async：单测直接喂假 req/res 验证 GET/POST 两条路；宿主允许 handler 返回 Promise）。 */
export async function handleOpenDiag(req: any, res: any): Promise<void> {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    sendJson(res, 200, { ok: true, lines: readOpenDiagTail() })
    return
  }
  if (method !== 'POST') {
    res.writeHead(405, { allow: 'GET, HEAD, POST' })
    res.end()
    return
  }
  await readJsonBody(req).then((body) => {
    const entry = body && typeof body === 'object' ? body : { raw: String(body ?? '') }
    try { appendOpenDiag({ ...entry, from: 'client' }) } catch { /* 写盘失败不影响响应 */ }
    sendJson(res, 200, { ok: true })
  })
}

/** 注册路由（重复注册由 manageWebRoutes 的包装层去重）。 */
export function registerAssistantOpenDiagRoute(server: any): () => void {
  if (!server || typeof server.register !== 'function') return () => void 0
  const unregister = server.register({ kind: 'exact', path: OPEN_DIAG_PATH, handler: handleOpenDiag })
  return () => { try { if (typeof unregister === 'function') unregister() } catch { /* 已经卸载 */ } }
}
