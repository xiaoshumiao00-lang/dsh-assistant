import { loadPeer } from "../cu-peer.mjs"
const m = await loadPeer("@deepseek-ai/schemastery")
export default m.default ?? m
