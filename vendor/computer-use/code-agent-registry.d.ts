import { SessionId } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller/types";
//#region src/code-agent-registry.d.ts
/** Cordis service name the orb host polls the bookmarks from. */
declare const CODE_AGENT_REGISTRY = "codeAgentRegistry";
/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
declare const name = "computer-use-code-agent-registry";
/** A finished stretch either delivered its outcome or was cancelled. */
type CodeAgentBookmarkState = 'running' | 'completed' | 'stopped';
/** One background Code session as the ball's bookmark strip shows it. */
interface CodeAgentBookmark {
  readonly sessionId: SessionId;
  readonly callerId: SessionId;
  readonly task: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: CodeAgentBookmarkState;
  readonly outcome?: string;
}
/** Cap on the outcome summary one bookmark carries; the full text lives in the session. */
declare const BOOKMARK_OUTCOME_MAX_CHARS = 200;
interface CodeAgentBookmarkRegistry {
  record(entry: {
    readonly sessionId: SessionId;
    readonly callerId: SessionId;
    readonly task: string;
    readonly cwd: string;
    readonly requestId: SessionRequestId;
    readonly watch?: AbortController;
    readonly agent?: Agent;
  }): void;
  dropCaller(callerId: SessionId): void;
  markStopped(sessionId: SessionId): void;
  list(): readonly CodeAgentBookmark[];
}
declare function sharedCodeAgentRegistry(): CodeAgentBookmarkRegistry;
/**
 * Publish the process-wide registry as an app-level service.
 * Inserted at the top level of the patch (never inside a preset) so the orb
 * host — also top level — can read it across the preset boundary.
 */
declare function apply(ctx: Context): void;
declare function createCodeAgentRegistry(): CodeAgentBookmarkRegistry;
//#endregion
export { BOOKMARK_OUTCOME_MAX_CHARS, CODE_AGENT_REGISTRY, CodeAgentBookmark, CodeAgentBookmarkRegistry, CodeAgentBookmarkState, apply, createCodeAgentRegistry, name, sharedCodeAgentRegistry };