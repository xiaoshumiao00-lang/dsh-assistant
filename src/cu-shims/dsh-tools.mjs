import { loadPeer } from "../cu-peer.mjs"
const m = await loadPeer("@deepseek-ai/dsh-tools")
export const defineTool = m.defineTool
