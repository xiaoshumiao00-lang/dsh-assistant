/** 浏览器端下载文本文件（记忆面板与诊断包导出都用得上）。 */
export function downloadText(name: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* 已撤销也无所谓 */ } }, 4000)
  } catch { /* 不是浏览器环境（测试里跑）：调用方该 fallback 到落盘路径 */ }
}
