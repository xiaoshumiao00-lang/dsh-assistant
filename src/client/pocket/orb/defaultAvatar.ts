// 页内悬浮球默认头像（手机浏览器/普通桌面浏览器显示；Electron 原生球仍由宿主头像管理）。
// 构建时以 data URL 内联，运行时不依赖额外静态资源路由。
import avatar from './assets/orb-avatar.png'

export const DEFAULT_ORB_AVATAR: string = avatar
