/** `mobileNav` namespace dictionaries: drawer controls. */
export const NS = 'mobileNav'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'open': '打开目录',
  'close': '收起目录',
  'backdrop': '点击关闭目录',
  'sessionLog': '导出会话日志',
  'files': '文件浏览',
  // 抽屉底部的三态布局快切（与设置页分段控件、右下角布局徽章同一个 key）
  'layout': '布局',
  'layoutAuto': '自动',
  'layoutDrawer': '抽屉',
  'layoutDesktop': '电脑',
  'layoutSwitchHint': '点一下切换：自动 → 抽屉 → 电脑',
  'layoutReloadHint': '已切换：刷新页面后生效',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<MobileNavKey, string> = {
  'open': 'Open directory',
  'close': 'Close directory',
  'backdrop': 'Click to close directory',
  'sessionLog': 'Session log',
  'files': 'Files',
  'layout': 'Layout',
  'layoutAuto': 'Auto',
  'layoutDrawer': 'Drawer',
  'layoutDesktop': 'Desktop',
  'layoutSwitchHint': 'Tap to cycle: Auto → Drawer → Desktop',
  'layoutReloadHint': 'Switched — reload the page to apply',
}

/** Key domain of the `mobileNav` namespace (zh is the source of truth). */
export type MobileNavKey = keyof typeof zh
