/**
 * 把 `computer_use` 回传工具注册到**后台 Code agent 自己的作用域**里。
 *
 * 只由 code_agent 在新建/继续后台标准会话时调用，所以：
 *   - 普通标准会话、CU 会话、子代理的工具目录完全不变（不多一个工具、不多一段 schema）；
 *   - 工具随 agent 一起卸载（agent.ctx 的作用域层），后台会话结束后不留注册。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { COMPUTER_USE_TOOL, createComputerUseBridgeTool } from './cu-bridge-core.mjs'

const registered = new WeakSet()

/** 给一个后台标准 agent 装上 `computer_use`；重复调用是空操作。 */
export function registerComputerUseBridge(options) {
  const { agent, ctx, parentId, logger } = options
  const scope = agent?.ctx
  if (scope === undefined) return false
  if (registered.has(agent)) return false
  let tools
  try {
    tools = scope.tools
  } catch {
    return false
  }
  if (tools === undefined) {
    try {
      logger?.warn?.(`[dsh-assistant] 后台会话 ${agent.id} 没有 tools 作用域，跳过 ${COMPUTER_USE_TOOL} 注册`)
    } catch {
      /* ignore */
    }
    return false
  }
  registered.add(agent)
  try {
    const definition = createComputerUseBridgeTool({
      defineTool,
      createUserMessage,
      boundContextSummary,
      agent,
      ctx,
      parentId
    })
    tools.register(definition)
    try {
      logger?.debug?.(`[dsh-assistant] ${COMPUTER_USE_TOOL} 已装到后台会话 ${agent.id}`)
    } catch {
      /* 日志失败不影响注册 */
    }
    return true
  } catch (error) {
    registered.delete(agent)
    try {
      logger?.warn?.(`[dsh-assistant] 安装 ${COMPUTER_USE_TOOL} 失败：${String(error?.message ?? error)}`)
    } catch {
      /* ignore */
    }
    return false
  }
}

export { COMPUTER_USE_TOOL }
