import { loadPeer } from "../cu-peer.mjs"
const m = await loadPeer("@deepseek-ai/dsh-session")
export const KNOWN_SESSION_EVENT_TYPES = m.KNOWN_SESSION_EVENT_TYPES
export const Session = m.Session
export const SessionId = m.SessionId
