// 新建 / 更改项目文件夹的「选择位置」：手机端直接复用会话输入框「电脑文件」附件用的
// PathBrowser（同一条 fs.list 主机 RPC、同一套跨盘切换 + 面包屑 + 桌面快捷方式 + 空目录/截断提示）。
// 工作台不再维护第二套只列子目录、不能跨盘的浏览弹窗。
import { PathBrowser, type FsBrowserApi } from './pocket/orb/PathBrowser.tsx'
import type { OrbKey } from './pocket/orb/locales.ts'

export interface ProjectFolderSheetProps {
  /** 起始目录（不存在时 PathBrowser 自动退到最近的可读上级） */
  startPath: string
  api: FsBrowserApi
  t: (key: OrbKey) => string
  onPick: (path: string) => void
  onClose: () => void
}

export function ProjectFolderSheet({ startPath, api, t, onPick, onClose }: ProjectFolderSheetProps) {
  return (
    // className 供无头（控制室）宿主的可见性/层级白名单识别，与旧浏览弹窗保持同一套规则
    <div className="dsh-wt_folderBrowse" style={{ position: 'fixed', inset: 0, zIndex: 10084, pointerEvents: 'auto' }}>
      <PathBrowser
        key={startPath}
        mode="dir"
        api={api}
        startPath={startPath}
        t={t}
        onPick={() => {}}
        onPickDir={onPick}
        onClose={onClose}
      />
    </div>
  )
}
