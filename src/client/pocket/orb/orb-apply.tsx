// 悬浮球装配层：注入样式/词典，注册两个 slot：
//   shell.overlay        → 全屏悬浮球页（OrbOverlay，orbStore 开关）
//   sidebar.footer.action → 抽屉底部「悬浮球」入口（OrbEntry）
import { OrbEntry } from './OrbEntry.tsx'
import { OrbOverlay } from './OrbOverlay.tsx'
import { installBootGuard } from './boot-guard.ts'
import { ORB_CSS } from './orb.css.ts'
import { NS, zh, en } from './locales.ts'
import { makeOrbApi } from './orb-api.ts'

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
