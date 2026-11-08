/**
 * 后台 Code 会话的「托管内自动应答」。
 *
 * 这段逻辑原来长在 `vendor/computer-use/code-agent.js` 里，并且**无条件**给每个后台
 * Code 会话 prepend 上 `approval/request` 与 `user-questions/request` 两个应答器：
 * 不管用户有没有关掉托管，都替用户选「首选项 / allowed-once」。取消托管后仍然自动答题
 * 就是从这儿来的。
 *
 * 现在改成先问宿主门控（`src/tuoguan-gate.ts` → `src/tuoguan-host.ts` 用
 * TuoguanStore.read + tuoguanOnForChain + sessionAncestry 判定）：
 *   - 托管关 / 读不到状态 / 拿不到会话链 → `next()`，交回宿主与用户的正常流程；
 *   - 托管开 → 维持原来的默认项（含 plan-review 的 approve）与 `allowed-once`。
 *
 * 危险动作不在这里放行：鹈鹕（tihu）闸挂在 `tools/pre-execute` 上，审批只是其中一环。
 * 这里托管关时让路只会让流程**更严**（回到官方审批卡），不会绕过任何闸。
 */
import { tuoguanGateOn } from './tuoguan-gate.ts'

/** 无选项问题的默认自由文本回答（与 vendor 旧实现同一句）。 */
export const UNATTENDED_CUSTOM_ANSWER = "Stop. Return the short result you already have. Do not expand the task.";

/**
 * Pick answers so a background Code agent never waits for a human.
 * @param questions - the live `ask_user_question` payload.
 * @returns structured answers the tool execute path accepts.
 */
export function autoAnswerQuestions(questions) {
	return { answers: questions.map((question) => {
		if (question.intent?.kind === "plan-review") return {
			id: question.id,
			selected: [question.intent.approve]
		};
		const options = question.options ?? [];
		const recommended = options.find((option) => option.label.includes("(Recommended)"));
		if (recommended !== void 0) return {
			id: question.id,
			selected: [recommended.label]
		};
		if (options[0] !== void 0) return {
			id: question.id,
			selected: question.multiSelect === true ? options.map((option) => option.label) : [options[0].label]
		};
		return {
			id: question.id,
			selected: [],
			custom: UNATTENDED_CUSTOM_ANSWER
		};
	}) };
}

/**
 * 给一个后台 Code 会话挂上自动应答（每个 Agent 一次），是否作答由托管门控决定。
 * @param code - the delegated standard agent.
 * @param attached - agents that already carry the listeners.
 * @param callerId - 派出它的 CU 会话 id：托管按对话开，CU 会话被显式关掉时后台会话也闭嘴。
 */
export function attachUnattendedCodeAgent(code, attached, callerId = "") {
	if (attached.has(code)) return;
	attached.add(code);
	try {
		code.ctx.effect(() => {
			const offApproval = code.ctx.on("approval/request", async (request, next) => {
				if (!(await tuoguanOnFor(request, code, callerId))) return passToHost(next);
				return "allowed-once";
			}, { prepend: true });
			const offQuestions = code.ctx.on("user-questions/request", async (request, next) => {
				if (!(await tuoguanOnFor(request, code, callerId))) return passToHost(next);
				const questions = Array.isArray(request?.questions) ? request.questions : [];
				if (questions.length === 0) return passToHost(next);
				return autoAnswerQuestions(questions);
			}, { prepend: true });
			return () => {
				offApproval();
				offQuestions();
				attached.delete(code);
			};
		});
	} catch {
		attached.delete(code);
	}
}

/** 请求所属会话；拿不到就用 Agent 自己的 id。 */
function sessionIdOf(request, code) {
	const id = request?.agent?.session?.id;
	if (typeof id === "string" && id !== "") return id;
	return typeof code?.id === "string" ? code.id : "";
}

/** 门控：这个会话此刻托管吗（没装门控 / 读不到状态 / 拿不到链 → 不托管）。 */
async function tuoguanOnFor(request, code, callerId) {
	const sessionId = sessionIdOf(request, code);
	if (sessionId === "") return false;
	return await tuoguanGateOn(sessionId, callerId);
}

/** 交回宿主 / 用户的正常流程（官方审批卡、提问卡照旧）。 */
function passToHost(next) {
	return typeof next === "function" ? next() : undefined;
}
