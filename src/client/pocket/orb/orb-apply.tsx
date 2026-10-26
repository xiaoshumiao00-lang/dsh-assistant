// 悬浮球装配层：注入样式/词典，注册悬浮球入口、会话输入框「电脑文件」桥与选择器：
//   sidebar.footer.action → 抽屉底部「悬浮球」入口（OrbEntry）
//   shell.overlay         → 悬浮球页 / 电脑文件选择器
//   conversation.input.left → 登记官方附件写入面（不可见）
import { OrbEntry } from './OrbEntry.tsx'
import { OrbOverlay } from './OrbOverlay.tsx'
import { installBootGuard } from './boot-guard.ts'
import { ORB_CSS } from './orb.css.ts'
import { NS, zh, en, type OrbKey } from './locales.ts'
import { makeOrbApi } from './orb-api.ts'
import { PcFileCommandIcon, PcFileInputBridge, PcFilePickerOverlay, hasPcFileComposer, isPhoneComposerLayout, pcFilePickerStore } from './PcFileAttach.tsx'
import { sessionCwdOf, hoistPcFileMenuItem } from '../../pcFile.ts'

export function orbApply(ctx: any): void {
  const api = makeOrbApi(ctx)

  // 会话详情 ↔ 首页反复跳页的自救（见 boot-guard.ts）：整页 reload 循环时
  // 把主面板退回会话列表，避免无限重载。正常刷新/正常进入详情不受影响。
  installBootGuard(ctx)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pocket: orb locale dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-pocket-orb'
    tag.textContent = ORB_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-pocket: orb styles')

  // 会话输入框「＋ → 电脑文件」：命令只在手机布局出现，桌面端继续用系统选择器。
  // 输入框挂载时把附件写入面登记到模块级表，命令触发后由全屏选择器读取电脑文件并加入附件。
  const tr = (key: OrbKey): string => {
    try { return ctx.locale.bind(NS)(key) } catch { return key }
  }
  const conversationApi = (() => {
    try { return ctx.get?.('conversation') ?? ctx.conversation ?? null } catch { return null }
  })()

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'assistant-pc-file-input',
        order: 30,
        locale: NS,
        inject: (sessionId: string | undefined) => ({ sessionId }),
      },
      PcFileInputBridge,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'assistant-pc-file-picker',
        order: 115,
        locale: NS,
        inject: () => ({ api, conversationApi, sessions: ctx.sessions }),
      },
      PcFilePickerOverlay,
    ),
  )

  try {
    ctx.inject(['commandUi'], (scope: any) => {
      scope.effect(() => {
        const dispose = scope.commandUi.register({
          name: 'file-pc',
          label: () => tr('pcFiles'),
          description: () => tr('pcFileAttachDesc'),
          icon: PcFileCommandIcon,
          available: (session: any) => isPhoneComposerLayout() && hasPcFileComposer(session?.sessionId),
          ui: {
            kind: 'action',
            run: (session: any) => {
              const cwd = (() => {
                try { return sessionCwdOf(ctx.sessions.list.getSnapshot()?.byId?.[session.sessionId]) } catch { return '' }
              })()
              pcFilePickerStore.open(session.sessionId, cwd)
            },
          },
        })
        // 宿主菜单把「添加」分组命令名写死，第三方命令只能落在「指令」末尾。
        // 只包装空查询的候选顺序，把电脑文件提到首行；检索、键盘导航仍按真实数组顺序工作。
        let restore = () => {}
        try {
          const service: any = scope.commandUi
          const original = service.candidates
          if (typeof original === 'function') {
            const wrapped = async function (session: any, req: any) {
              const rows = await original.call(service, session, req)
              return Array.isArray(rows) ? hoistPcFileMenuItem(rows, String(req?.query ?? '')) : rows
            }
            service.candidates = wrapped
            restore = () => {
              if (service.candidates === wrapped) service.candidates = original
            }
          }
        } catch { /* 私有菜单顺序不可写时保持宿主默认顺序，不影响命令本身 */ }
        return () => {
          restore()
          dispose()
        }
      }, 'dsh-assistant: PC file attachment command')
    })
  } catch { /* 旧宿主没有 commandUi：不影响悬浮球/设置页 */ }

  // ⚠️ 不要再往 conversation.input.activity 里注册录音按钮。
  // 2026-10-25 实测：往官方语音插件占用的同名槽位再注册一个条目，会让**官方插件自己的
  // apply() 抛错**，进而导致整个 web boot 中断（日志：「1 entry did not activate」）——
  // 这就是那次客户端起不来的根因。
  //
  // 结论：原生输入框那颗麦克风保留官方实现（它同时负责挂载 remote.speech 服务，
  // 那是悬浮球语音转写所依赖的）；悬浮球里的录音按钮才是我们这套切段+纠错管线。
  // 详见 composer-mic.tsx（已停用，留作将来换方案时参考）。

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'pocket-orb-overlay',
        order: 20,
        locale: NS,
        inject: () => ({ api }),
      },
      OrbOverlay,
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'pocket-orb-entry',
        order: 20,
        locale: NS,
        // layout 服务按"可能不存在"处理：浏览器端某些 composition 没挂它，
        // 裸调会让整个 slot entry 被宿主的边界吞掉（悬浮球直接消失，且没有任何报错）。
        inject: () => ({ toggleSidebar: () => { try { ctx.layout?.toggleSidebar?.() } catch { /* 没给 layout 服务：忽略 */ } } }),
      },
      OrbEntry,
    ),
  )
}
