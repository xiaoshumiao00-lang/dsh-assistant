import { readFile } from 'node:fs/promises'

/** 控制室预置背景：只在首次初始化媒体库时由客户端按需请求，不进入首屏 JS。 */
export const CONSOLE_SEA01_ROUTE = '/api/assistant/assets/console-sea01.jpg'
const assetUrl = new URL('./console-sea01.jpg', import.meta.url)
let assetPromise: Promise<Buffer> | null = null

function loadAsset(): Promise<Buffer> {
  if (!assetPromise) {
    assetPromise = readFile(assetUrl).catch((error) => {
      // 安装/热更新期间的短暂读取失败不应永久缓存；下一次请求可自愈。
      assetPromise = null
      throw error
    })
  }
  return assetPromise
}

/** 同源静态资源处理器；缓存的是不可变预置图的原始字节，响应仍走宿主/手机代理的既有认证链。 */
export async function serveConsoleSea01(req: any, res: any): Promise<void> {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  try {
    const body = await loadAsset()
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(body.length),
      'cache-control': 'public, max-age=86400',
    })
    res.end(method === 'HEAD' ? undefined : body)
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'cache-control': 'no-store' })
    res.end()
  }
}
