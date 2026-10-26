import { loadPeer } from "../cu-peer.mjs"
const m = await loadPeer("@deepseek-ai/dsh-brand")
export const brandString = m.brandString
