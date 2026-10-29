/** 默认背景示例图 2：海岸公路海景（Sea01.jpg 1280×720）。
 *  原始 JPEG 由服务端同源路由按需下发，避免约 246KB Base64 进入 DSH 首屏客户端包。 */
export const WAVE_BG_URL = '/api/assistant/assets/console-sea01.jpg'

/** 仅在首次初始化控制室默认媒体库时读取；字节与旧内联 Base64 完全一致。 */
export async function loadWaveBgBlob(fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const response = await fetchImpl(WAVE_BG_URL, { cache: 'force-cache' })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return new Blob([await response.arrayBuffer()], { type: 'image/jpeg' })
}
