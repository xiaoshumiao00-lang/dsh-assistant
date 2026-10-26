import { loadPeer } from "../cu-peer.mjs"
const m = await loadPeer("@deepseek-ai/dsh-llm")
export const createUserMessage = m.createUserMessage
export const boundContextSummary = m.boundContextSummary
