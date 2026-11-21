// 悬浮球装配层：注入样式/词典、会话输入框「电脑文件」桥与选择器：
//   shell.overlay         → 悬浮球页 / 电脑文件选择器
//   conversation.input.left → 登记官方附件写入面（不可见）
// 手机抽屉底部不再注册旧「悬浮球」入口，避免误入已停用的旧操作流程。
import { OrbOverlay } from './OrbOverlay.tsx'
import { installBootGuard } from './boot-guard.ts'
import { ORB_CSS } from './orb.css.ts'
import { FOLD_CARD_CSS } from './fold-card.css.ts'
import { SECRETARY_CARD_CSS } from './secretary-cards.css.ts'
import { SecretaryReplyCard } from './SecretaryReplyCard.tsx'
import { SecretaryUserCards } from './SecretaryUserCard.tsx'
import { currentSessionViaBridge } from '../../session-open.ts'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
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
    tag.textContent = `${ORB_CSS}\n${FOLD_CARD_CSS}\n${SECRETARY_CARD_CSS}`
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

  // 秘书回复卡片：每条模型回复渲染成柔和浅色卡片（标题行 + 正文 + 引用块 + meta）。
  // 固定高度/展开折叠与 fold-card.css.ts 共享。只对个人秘书会话渲染。
  ctx.slots.inject('conversation.chat.turnTail', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.turnTail',
        id: 'assistant-secretary-reply-card',
        order: 30,
        locale: NS,
        inject: () => ({ api }),
      },
      SecretaryReplyCard,
    ),
  )

  // 用户卡（2026-11-21 需求）：个人秘书页里真实用户消息做成一张卡（与秘书回复卡同规格、冷蓝主题）。
  // 挂在 shell.overlay（整页常驻，与悬浮球同一层）：卡片用 React portal 挂进宿主那条用户行，
  // 合成通知（系统通知 / [[session:…]] 引用行）由 collect 挡在外面，保持宿主原样。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'assistant-secretary-user-card',
        order: 120,
        locale: NS,
        inject: () => ({}),
      },
      SecretaryUserCards,
    ),
  )

  // 「当前是不是秘书会话」的页面级标记：秘书会话里隐藏原始 markdown 气泡、
  // 只留回复卡片；用轻量轮询跟随主面板选择（宿主 selection 变化不广播）。
  ctx.effect(() => {
    let disposed = false
    const apply = (): void => {
      try {
        const secretary = peekSecretarySessionId()
        const current = currentSessionViaBridge()
        const on = secretary !== '' && current !== '' && current === secretary
        if (document.body.dataset.dshSecretary === (on ? '1' : undefined)) return
        if (on) document.body.dataset.dshSecretary = '1'
        else delete document.body.dataset.dshSecretary
      } catch { /* 标记失败不影响功能 */ }
    }
    apply()
    const timer = window.setInterval(apply, 700)
    const dispose = (): void => { disposed = true; window.clearInterval(timer) }
    void disposed
    return dispose
  }, 'dsh-pocket: secretary session body flag')

}
