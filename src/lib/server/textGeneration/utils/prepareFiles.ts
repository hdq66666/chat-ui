import type { MessageFile } from "$lib/types/Message";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";
import type { OpenAI } from "openai";
import { TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";
import { stripThink } from "$lib/utils/stripThink";
import { stripLoneSurrogates } from "./loneSurrogates";
import type { makeImageProcessor } from "$lib/server/endpoints/images";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageToolCallUpdate,
	type MessageToolErrorUpdate,
	type MessageToolResultUpdate,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";
import { isValidJsonObject } from "$lib/server/textGeneration/mcp/toolInvocation";

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Assistant message extended with the reasoning echo field consumed by
 * preserved-thinking backends (e.g. Kimi K2/K3). Providers that don't know the
 * field ignore it.
 */
type AssistantReplayMessage = ChatMessageParam & { reasoning_content?: string };

/** Cap replayed tool outputs so old turns can't flood the context window. */
const MAX_REPLAYED_TOOL_OUTPUT_CHARS = 8000;

/**
 * Cumulative cap on the WHOLE outgoing history, not just the part replay
 * expands. Every message is charged against it — system, user, and plain
 * assistant turns included — because a long conversation that already fills a
 * context window would otherwise still be handed another budget's worth of
 * replay on top and overflow a window it previously fit.
 *
 * Nothing is ever dropped: messages that can't degrade are charged and kept,
 * which can drive the budget negative. All the budget decides is how far back
 * the richer replayed shape extends before turns fall back to the flat
 * {role, content} form the request used before replay existed. Turns are
 * charged newest-first, so recent history keeps its tool calls and reasoning.
 *
 * Not counted: the preprompt and tool schemas, which callers prepend after
 * this function returns — see PROMPT_OVERHEAD_TOKENS.
 *
 * This is only the ceiling. When the model's context window is known it is
 * lowered to fit (see budgetCharsFor), because on a small-context model a flat
 * history that fit could otherwise be expanded into an overflow.
 *
 * Sized for long agentic turns: an ML Assistant turn parks and resumes for
 * half an hour and its tool transcript IS the working state — at the previous
 * 100k ceiling one such turn's floor consumed the whole budget and every
 * turn replayed flat, so the resumed model forgot its own waits, jobs and
 * answered questions. Real windows bound this anyway (budgetCharsFor);
 * the absolute ceiling only protects huge-window models from megabyte
 * requests.
 */
const HISTORY_BUDGET_CHARS = 400_000;

/**
 * Characters assumed per token when converting a context window into a
 * character budget. Deliberately below the usual ~4 for English prose: a low
 * ratio yields a smaller budget, so mis-estimating errs toward sending less
 * rather than toward a request the model rejects outright.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Held back from the context window for the preprompt and tool schemas, which
 * run to thousands of tokens when several MCP servers are selected. The reply
 * is reserved separately, from the model's own configured limit.
 */
const PROMPT_OVERHEAD_TOKENS = 4_000;

/**
 * Reply allowance when the model configures no explicit limit. Models that do
 * configure one are reserved that instead — a model set to emit up to 98k
 * tokens needs 98k held back, and a flat constant would let history plus reply
 * exceed the window even though each fits on its own.
 */
const DEFAULT_OUTPUT_TOKENS = 4_096;

/**
 * How many characters of history this request may spend.
 *
 * With no context length reported (self-hosted backends, or a router that
 * omits it) this is the flat ceiling, i.e. the behaviour before models
 * reported one. Otherwise the window bounds it, so replay can never push a
 * request past what the model accepts. A window smaller than the reserve
 * yields 0: everything degrades to the flat pre-replay shape, which is the
 * most that model could ever have taken anyway.
 */
function budgetCharsFor(contextLengthTokens?: number, maxOutputTokens?: number): number {
	if (!contextLengthTokens || contextLengthTokens <= 0) return HISTORY_BUDGET_CHARS;
	const outputReserve =
		maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_OUTPUT_TOKENS;
	const usableTokens = Math.max(0, contextLengthTokens - outputReserve - PROMPT_OVERHEAD_TOKENS);
	return Math.min(HISTORY_BUDGET_CHARS, usableTokens * CHARS_PER_TOKEN);
}

/**
 * Nominal size charged for one image part instead of its encoded length. A
 * data URL runs to hundreds of thousands of characters while the image costs
 * the model on the order of a thousand tokens, so charging the encoding would
 * let a single attachment flatten every replayable turn behind it.
 */
const IMAGE_COST_CHARS = 4_000;
const IMAGE_COST_PLACEHOLDER = "i".repeat(IMAGE_COST_CHARS);

/** Approximate the context a message (or list of them) occupies. */
function historyCost(value: unknown): number {
	return JSON.stringify(value, (key, inner) =>
		key === "url" && typeof inner === "string" && inner.startsWith("data:")
			? IMAGE_COST_PLACEHOLDER
			: inner
	).length;
}

/**
 * Normalize a persisted update uuid into a provider-safe tool_call_id.
 * Mistral-family chat templates require exactly nine alphanumeric characters,
 * a shape every other provider also accepts; the persisted uuid is only a
 * correlation key, so the id just has to pair calls with results consistently.
 */
function toToolCallId(uuid: string, used: Set<string>): string {
	const alnum = uuid.replace(/[^a-zA-Z0-9]/g, "") || "toolcall0";
	let candidate = (alnum + "0".repeat(9)).slice(0, 9);
	for (let salt = 1; used.has(candidate); salt += 1) {
		const suffix = String(salt);
		candidate = (alnum + "0".repeat(9)).slice(0, 9 - suffix.length) + suffix;
	}
	used.add(candidate);
	return candidate;
}

const isToolCallUpdate = (u: MessageUpdate): u is MessageToolCallUpdate =>
	u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Call;
const isToolResultUpdate = (u: MessageUpdate): u is MessageToolResultUpdate =>
	u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Result;
const isToolErrorUpdate = (u: MessageUpdate): u is MessageToolErrorUpdate =>
	u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Error;

/**
 * Whether a historical message's own producer (its persisted
 * `routerMetadata.model`, set for messages generated through the "omni"
 * router alias) matches the model about to consume the request. A message
 * with no routerMetadata was produced by whatever single model the
 * conversation is pinned to — the common case — and is always treated as
 * same-producer since there is nothing to contradict. Reasoning is
 * conditioned on the producing model's own prior thoughts; attaching one
 * model's reasoning_content to a different model's turn is unverified and
 * skipped rather than risked. Tool call/result replay is protocol-neutral
 * (a `tool` message is just data) and is never gated by this.
 */
function reasoningProducerMatches(
	message: EndpointMessage,
	currentProducerModel?: string
): boolean {
	const producer = message.routerMetadata?.model;
	return !producer || !currentProducerModel || producer === currentProducerModel;
}

/**
 * Split `<think>` blocks out of assistant text, merging them with the
 * separately persisted `message.reasoning` when present. Parts are returned
 * individually so replay can pair round reasoning back to its tool round.
 * Parts are filtered by whether they're non-blank but kept byte-exact
 * otherwise: vendors documenting preserved thinking can require the
 * reasoning payload sent back unmodified, so trimming must only decide
 * whether a part counts as empty, never change what gets echoed.
 */
function splitReasoning(
	content: string,
	storedReasoning?: string
): { visible: string; parts: string[] } {
	const thinkParts: string[] = [];
	const visible = content.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_match, inner: string) => {
		thinkParts.push(inner);
		return "";
	});
	const parts = [storedReasoning ?? "", ...thinkParts].filter((part) => part.trim().length > 0);
	return { visible: visible.trim(), parts };
}

/**
 * Rebuild a past assistant turn from its persisted tool updates so follow-up
 * requests see the tool calls and their outputs instead of a flat text
 * summary. Rounds are inferred from update order — a Call update arriving
 * after any Result/Error starts a new round, matching how the live loop emits
 * one batch of calls per completion round. Each call's `tool_call_id` is
 * always the normalized id from toToolCallId, even though the original
 * provider-issued id may also be persisted (see MessageToolCallUpdate):
 * emitting it unconditionally keeps one code path and satisfies every
 * provider's id-shape requirements, including Mistral-family templates.
 */
function replayAssistantTurn(
	message: EndpointMessage,
	includeReasoning: boolean
): AssistantReplayMessage[] {
	const updates = message.updates ?? [];
	const { visible, parts } = splitReasoning(message.content, message.reasoning);
	// `parts` holds every recovered reasoning block across the whole turn, and
	// `remainingVisible` the full visible text: when tools ran, the
	// FinalAnswer handler merges the pre-tool stream into content, so earlier
	// rounds' think blocks and preamble text survive there too, concatenated
	// in chronological order. Rounds whose Call update persisted its own
	// `reasoning`/`content` (written by the live loop since those fields
	// existed) reclaim their piece below; whatever remains belongs to the
	// final answer.
	const remainingParts = [...parts];
	let remainingVisible = visible;
	// null, not an empty-content message, when a turn was interrupted before
	// producing any final text or reasoning (e.g. aborted mid-tool-call): an
	// empty trailing `{role: "assistant", content: ""}` with nothing else
	// attached represents an assistant turn that never happened, and strict
	// providers can reject it outright.
	const buildFinalMessage = (): AssistantReplayMessage | null => {
		const reasoning = remainingParts.join("\n");
		const content = remainingVisible.trim();
		const hasReasoning = includeReasoning && reasoning.length > 0;
		if (content.length === 0 && !hasReasoning) return null;
		return {
			role: "assistant",
			content,
			...(hasReasoning ? { reasoning_content: reasoning } : {}),
		};
	};

	const callUpdates = updates.filter(isToolCallUpdate);
	if (callUpdates.length === 0) {
		const finalMessage = buildFinalMessage();
		return finalMessage ? [finalMessage] : [];
	}

	const outputsByUuid = new Map<string, string>();
	const rounds: MessageToolCallUpdate[][] = [];
	let round: MessageToolCallUpdate[] = [];
	let roundHasOutcome = false;
	for (const update of updates) {
		if (isToolCallUpdate(update)) {
			if (roundHasOutcome && round.length > 0) {
				rounds.push(round);
				round = [];
				roundHasOutcome = false;
			}
			round.push(update);
		} else if (isToolResultUpdate(update)) {
			const result = update.result;
			const firstOutput =
				result.status === ToolResultStatus.Success ? result.outputs[0] : undefined;
			outputsByUuid.set(
				update.uuid,
				result.status === ToolResultStatus.Success
					? typeof firstOutput?.text === "string"
						? firstOutput.text
						: JSON.stringify(firstOutput ?? "")
					: `Error: ${result.message}`
			);
			roundHasOutcome = true;
		} else if (isToolErrorUpdate(update)) {
			outputsByUuid.set(update.uuid, `Error: ${update.message}`);
			roundHasOutcome = true;
		}
	}
	if (round.length > 0) {
		rounds.push(round);
	}

	const usedIds = new Set<string>();
	const idByUuid = new Map(callUpdates.map((u) => [u.uuid, toToolCallId(u.uuid, usedIds)]));

	const replayed: AssistantReplayMessage[] = [];
	for (const callsInRound of rounds) {
		// Reasoning and preamble text persisted on the round's Call update go
		// back on this round's message and are deduped out of the final
		// answer's blocks. Kept byte-exact (trim only tests for emptiness): see
		// splitReasoning for why reasoning fidelity matters; the same
		// unmodified-echo principle is applied to preamble text for symmetry
		// and so the dedup below matches reliably.
		const roundReasoning = includeReasoning
			? (callsInRound.find((u) => u.reasoning?.trim())?.reasoning ?? "")
			: "";
		if (roundReasoning) {
			const exact = remainingParts.indexOf(roundReasoning);
			if (exact !== -1) {
				remainingParts.splice(exact, 1);
			} else if (remainingParts.length > 0 && roundReasoning.includes(remainingParts[0])) {
				// Positional fallback only, never a scan of the whole array: parts
				// are chronologically ordered and rounds are processed oldest-first,
				// so the earliest still-unconsumed part is the only one that can be
				// attributed to this round when exact match fails (e.g. formatting
				// drift). A LATER part merely being a substring of this round's
				// reasoning is coincidence, not evidence it belongs here — removing
				// it would silently delete an unrelated (and possibly the final
				// answer's own) reasoning block.
				remainingParts.splice(0, 1);
			}
		}
		// Visible text streamed before this round's calls (e.g. "Let me check
		// that."): rounds are processed oldest-first, matching the
		// chronological order text was concatenated into `message.content`, so
		// removing a matched prefix keeps the remainder correctly ordered for
		// the final message. Trimmed on both sides (persistence trims too)
		// because `remainingVisible` comes from splitReasoning trim-normalized;
		// visible text has no byte-exactness requirement, unlike reasoning.
		const roundContent = (callsInRound.find((u) => u.content?.trim())?.content ?? "").trim();
		if (roundContent && remainingVisible.startsWith(roundContent)) {
			// Prefix-only, deliberately: rounds consume the visible text in
			// chronological order, so a streamed preamble is always the next
			// prefix. A persisted preamble that is NOT a prefix was never merged
			// into stored content (content arriving in the same delta as the
			// first tool_calls entry is suppressed from the stream), so a deeper
			// indexOf match could only hit identical text belonging to the final
			// answer — removing that would reorder the conversation. The failure
			// mode of not matching is mild duplication, which is safer.
			remainingVisible = remainingVisible.slice(roundContent.length).trimStart();
		}
		// `content` is included only when a preamble was actually persisted
		// (messages recorded before this field existed have none); omitted
		// otherwise since some OpenAI-compatible backends reject empty text
		// next to tool_calls with a 400.
		// Arguments prefer the persisted raw JSON string the model actually
		// sent (argumentsRaw): the sanitized fallback only keeps top-level
		// primitive params (nested values and file payloads are deliberately
		// kept out of storage), so it can under-represent the real call.
		// Legacy updates without argumentsRaw, and any argumentsRaw that
		// somehow isn't valid JSON (toolInvocation.ts already guards this at
		// write time, but a replayed value must never be trusted blindly at
		// its own read boundary — belt and suspenders against a future write
		// path or manipulated data), fall back to the sanitized form.
		replayed.push({
			role: "assistant",
			tool_calls: callsInRound.map((u) => ({
				id: idByUuid.get(u.uuid) ?? u.uuid,
				type: "function" as const,
				function: {
					name: u.call.name,
					arguments:
						u.argumentsRaw && isValidJsonObject(u.argumentsRaw)
							? u.argumentsRaw
							: JSON.stringify(u.call.parameters ?? {}),
				},
			})),
			...(roundContent.trim().length > 0 ? { content: roundContent } : {}),
			...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
		});
		for (const u of callsInRound) {
			// A call with no persisted outcome means the run was aborted
			// mid-execution; say so instead of fabricating an empty success.
			const output = outputsByUuid.has(u.uuid)
				? (outputsByUuid.get(u.uuid) ?? "")
				: "Error: interrupted before a result was recorded";
			replayed.push({
				role: "tool",
				tool_call_id: idByUuid.get(u.uuid) ?? u.uuid,
				content:
					output.length > MAX_REPLAYED_TOOL_OUTPUT_CHARS
						? stripLoneSurrogates(output.slice(0, MAX_REPLAYED_TOOL_OUTPUT_CHARS)) +
							"\n[...truncated]"
						: output,
			});
		}
	}
	const finalMessage = buildFinalMessage();
	if (finalMessage) replayed.push(finalMessage);
	return replayed;
}

/**
 * Prepare chat messages for OpenAI-compatible multimodal payloads.
 * - Processes images via the provided imageProcessor (resize/convert) when multimodal is enabled.
 * - Injects text-file content into the user message text.
 * - Leaves messages untouched when no files or multimodal disabled.
 * - Historical assistant `<think>` blocks are always stripped from outgoing
 *   content, whether or not any reasoning option below is set: raw think
 *   markup must never be replayed as visible text to any model.
 * - With `replayToolHistory`, expands past assistant turns into their
 *   assistant/tool message pairs (from persisted updates) and re-attaches
 *   reasoning as `reasoning_content` instead of inline `<think>` text.
 * - With `attachReasoning`, only the reasoning half: assistant turns stay
 *   flat but carry `reasoning_content`, for tool-less requests where replayed
 *   tool messages would be undefined behavior (no `tools` in the request).
 *   Callers gate it on the model's reasoning capability; with
 *   `replayToolHistory` it defaults to on unless explicitly disabled.
 * - `currentProducerModel` additionally gates reasoning_content per message:
 *   a message routed (via the router alias) to a different model than the
 *   one about to consume this request has its reasoning suppressed, since
 *   reasoning is conditioned on the producing model's own prior thoughts.
 *   Messages with no routerMetadata (the common pinned-model case) are
 *   unaffected. Tool call/result replay is protocol-neutral and always
 *   proceeds regardless of producer.
 */
export async function prepareMessagesWithFiles(
	messages: EndpointMessage[],
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	isMultimodal: boolean,
	options?: {
		replayToolHistory?: boolean;
		attachReasoning?: boolean;
		currentProducerModel?: string;
		/**
		 * The consuming model's context window in tokens, when known. Bounds how
		 * much history is sent; omitting it keeps the flat default ceiling.
		 */
		contextLengthTokens?: number;
		/**
		 * The reply allowance this request will ask for (the model's configured
		 * max_tokens). Reserved from the window alongside prompt overhead.
		 */
		maxOutputTokens?: number;
	}
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
	type ReplayCandidate = { replay: AssistantReplayMessage[]; flat: ChatMessageParam };
	const prepared = await Promise.all(
		messages.map(async (message): Promise<ChatMessageParam[] | ReplayCandidate> => {
			if (message.from === "user" && message.files && message.files.length > 0) {
				const { imageParts, textContent } = await prepareFiles(
					imageProcessor,
					message.files,
					isMultimodal
				);

				let messageText = message.content;
				if (textContent.length > 0) {
					messageText = textContent + "\n\n" + message.content;
				}

				if (imageParts.length > 0 && isMultimodal) {
					const parts = [{ type: "text" as const, text: messageText }, ...imageParts];
					// video_url 不在 OpenAI 的 content part 联合类型里，但 vLLM 认。
					return [
						{
							role: message.from,
							content: parts as OpenAI.Chat.Completions.ChatCompletionContentPart[],
						},
					];
				}

				return [{ role: message.from, content: messageText }];
			}
			if (message.from === "assistant") {
				const wantsReasoning =
					(options?.replayToolHistory
						? (options?.attachReasoning ?? true)
						: Boolean(options?.attachReasoning)) &&
					reasoningProducerMatches(message, options?.currentProducerModel);

				if (options?.replayToolHistory) {
					// The budget-fallback `flat` must still strip <think>, not just
					// drop the reasoning_content/tool-replay enrichments: the raw
					// string leaks reasoning as visible content to every model that
					// falls back to it, including ones (e.g. Gemma) whose vendor
					// requires historical thoughts to be stripped regardless of the
					// replay budget.
					const flat: ChatMessageParam = {
						role: "assistant",
						content: stripThink(message.content),
					};
					return {
						replay: replayAssistantTurn(message, wantsReasoning),
						flat,
					};
				}
				const { visible, parts } = splitReasoning(message.content, message.reasoning);
				const reasoning = parts.join("\n");
				if (!wantsReasoning || reasoning.length === 0) {
					// Either nothing to attach, or attachment is disabled/gated:
					// either way `visible` (think-stripped) is the correct shape,
					// never the raw `message.content` — but a turn interrupted
					// before any visible text (or one whose only content was
					// reasoning this call is gated from attaching) must not replay
					// as a phantom `{role: assistant, content: ""}` with nothing
					// else attached; omit it entirely instead.
					return visible.length > 0 ? [{ role: "assistant", content: visible }] : [];
				}
				// Candidate, not a plain array, so the reasoning payload goes
				// through the same newest-first budget as tool replay. The
				// fallback keeps the same stripped `visible` text and just
				// drops reasoning_content, for the same reason as above.
				return {
					replay: [{ role: "assistant", content: visible, reasoning_content: reasoning }],
					flat: { role: "assistant", content: visible },
				};
			}
			return [{ role: message.from, content: message.content }];
		})
	);

	// Spend the replay budget newest-first so recent turns keep their full
	// tool history and older ones degrade to the pre-replay flat shape. The
	// degradation is monotonic: once any turn falls back to flat, every older
	// turn does too, so the model never sees rich history for a stale turn
	// while the turn it is continuing from is plain prose.
	// Two passes, because the budget caps the whole request and the messages that
	// can't degrade aren't all at the newest end. Charging them as they're
	// reached would let a huge older user turn be counted only after every newer
	// turn had already been granted its replay — the total would still overrun.
	//
	// Pass 1 establishes the floor: what this request costs with no enrichment
	// at all, which is also the exact shape it had before replay existed.
	const flatForms: ChatMessageParam[][] = prepared.map((entry) => {
		if (Array.isArray(entry)) return entry;
		// Same phantom-turn guard as the replay and plain branches: an
		// interrupted turn whose stripped content is empty must be omitted,
		// not sent as {role: "assistant", content: ""}.
		const flatContent = typeof entry.flat.content === "string" ? entry.flat.content : "";
		return flatContent.trim().length > 0 ? [entry.flat] : [];
	});
	const floor = flatForms.reduce((total, form) => total + historyCost(form), 0);

	// Pass 2 spends whatever is left on upgrading turns to their replayed shape,
	// paying only the difference over the floor. A history that already exceeds
	// the cap leaves nothing to spend, so every turn keeps its flat form and the
	// request is no larger than it used to be.
	const total = budgetCharsFor(options?.contextLengthTokens, options?.maxOutputTokens);
	const windowBounded = Boolean(options?.contextLengthTokens && options.contextLengthTokens > 0);
	let budget = total - floor;
	const resolved: ChatMessageParam[][] = [...flatForms];
	// The newest replayable turn is the one a continuation resumes INTO: its
	// tool transcript is the run's working state (parked waits, submitted jobs,
	// answered questions), and flattening it decapitates the run — the resumed
	// model literally forgets what it did. Against the SOFT ceiling (no window
	// reported) it is therefore judged against the whole budget, not what the
	// floor left over: history ballast can flatten older turns, never the one
	// being continued, and over-sending against the soft ceiling is survivable.
	// A WINDOW-bounded budget is physics, not policy: replay past it fails the
	// whole request with a provider context error, which is strictly worse than
	// the flat degradation — so there the newest turn must fit beside the flat
	// floor like everything else (walking newest-first, it still claims the
	// budget first).
	let newestCandidate = true;
	const newestLimit = windowBounded ? budget : total;
	for (let i = prepared.length - 1; i >= 0; i -= 1) {
		const entry = prepared[i];
		if (Array.isArray(entry)) continue;
		const upgrade = historyCost(entry.replay) - historyCost(flatForms[i]);
		// Monotonic past the newest turn: the first older turn that doesn't fit
		// stops the walk, so the model never sees rich history for a stale turn
		// while a newer one is plain prose.
		if (newestCandidate ? upgrade > newestLimit : upgrade > budget) break;
		newestCandidate = false;
		budget -= upgrade;
		resolved[i] = entry.replay;
	}
	return resolved.flat();
}

/**
 * 一次请求最多能带几张图。必须和 vLLM 的 --limit-mm-per-prompt
 * image.count 对齐；超了 vLLM 会直接拒掉整个请求。
 */
const MAX_IMAGES_PER_REQUEST = Number(process.env.MAX_IMAGES_PER_REQUEST || 64);

/**
 * 一次请求最多渲染几页 PDF。和 MAX_IMAGES_PER_REQUEST 分开，是因为
 * PDF 会一页一张地吃掉整个额度：不留出余量，用户随手拖进来的一份长
 * 文档就会把他自己贴的截图全部挤掉。两者取较小值作为实际预算。
 */
const MAX_PDF_PAGES_PER_REQUEST = Number(process.env.MAX_PDF_PAGES_PER_REQUEST || 48);

/**
 * 一次请求最多带几个视频。必须和 vLLM 的 --limit-mm-per-prompt
 * video.count 对齐；和图片额度互不相干，超了同样是整个请求被拒。
 */
const MAX_VIDEOS_PER_REQUEST = Number(process.env.MAX_VIDEOS_PER_REQUEST || 1);

/**
 * 单个视频的体积上限。视频是原样透传给 vLLM 的（base64 后约为 4/3），
 * 抽帧和降采样都在服务端做，所以这里限制的是传输和内存，不是 token。
 */
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 50);

/**
 * 只放行 OpenCV 能解的容器。vLLM 用 cv2 解码（decord/PyAV 都没装），
 * 它解不开的格式会在服务端抛错，不如在这里就挡掉并告诉用户。
 */
const VIDEO_MIME_ALLOWLIST = ["video/mp4", "video/webm", "video/quicktime"];

/**
 * vLLM / Qwen 的扩展 content part。OpenAI 的类型里没有 video_url，
 * 所以自己声明一个，出口处再收窄回 OpenAI 的类型。
 */
type VideoContentPart = {
	type: "video_url";
	video_url: { url: string };
};

type MediaContentPart = OpenAI.Chat.Completions.ChatCompletionContentPartImage | VideoContentPart;

/** PDF 渲染倍率，1 = 72dpi。2 时 A4 约 1190x1683，模型可读 6pt 正文。 */
const PDF_RENDER_SCALE = Number(process.env.PDF_RENDER_SCALE || 2);

/**
 * 渲染一份 PDF 的时间上限。矢量内容极密的 PDF 单页就能跑很久
 * （实测 32 万散点/页时 3 页要 449 秒），不设上限等于给每个访客
 * 一个能占住服务端的开关。超时按已渲染的页返回，不整轮失败。
 */
const PDF_RENDER_TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 60000);

/**
 * 把 PDF 每页渲染成 PNG。返回 data URL 数组，最多 limit 页。
 * 渲染失败不抛出 —— 一个坏 PDF 不应该让整轮对话失败，交给调用方在
 * 文本里说明。
 */
async function renderPdfPages(
	buffer: Buffer,
	limit: number
): Promise<{ urls: string[]; total: number; error?: string; timedOut?: boolean }> {
	if (limit <= 0) return { urls: [], total: 0 };
	try {
		const { pdf } = await import("pdf-to-img");
		const deadline = Date.now() + PDF_RENDER_TIMEOUT_MS;
		const doc = await pdf(buffer, { scale: PDF_RENDER_SCALE });
		const urls: string[] = [];
		let timedOut = false;
		for await (const page of doc) {
			if (urls.length >= limit) break;
			urls.push(`data:image/png;base64,${page.toString("base64")}`);
			// 渲染是同步阻塞的，只能在页与页之间收手
			if (Date.now() > deadline) {
				timedOut = true;
				break;
			}
		}
		return { urls, total: doc.length, timedOut };
	} catch (e) {
		return { urls: [], total: 0, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 同时带了图片和 PDF 时，从图片额度里划给 PDF 的保底页数。
 *
 * 图片和 PDF 页在 vLLM 眼里是同一种东西，共用 image.count。先到先得的话，
 * 一次拖进来的几十张截图会把同一条消息里的 PDF 挤成 0 页 —— 而用户既然
 * 两样都附了，就是两样都想让模型看。所以 PDF 在场时给它留一份保底，
 * 图片那边相应压到 MAX_IMAGES_PER_REQUEST - 这个值。
 */
const PDF_RESERVED_IMAGE_SLOTS = Number(process.env.PDF_RESERVED_IMAGE_SLOTS || 16);

/**
 * 单个文本附件内联的字符上限，超出的部分截断并在清单里说明。
 * 上传本身只受 PUBLIC_MAX_UPLOAD_MB 限制（当前 50MB），一份体积合法的
 * 日志足够单独撑爆任何上下文窗口，所以内联这一步必须自己有个上限。
 */
const MAX_TEXT_FILE_CHARS = Number(process.env.MAX_TEXT_FILE_CHARS || 200_000);

/**
 * 一轮里所有文本附件合计的字符上限。和单文件上限分开，是因为十个各自
 * 合规的文件叠起来照样能把 HISTORY_BUDGET_CHARS 吃干净 —— 取的就是那个
 * 数：附件最多占满一整轮历史的额度，不该比这更多。
 */
const MAX_TEXT_TOTAL_CHARS = Number(process.env.MAX_TEXT_TOTAL_CHARS || HISTORY_BUDGET_CHARS);

type AttachmentKind = "image" | "pdf" | "video" | "text" | "unsupported";

function classifyAttachment(file: MessageFile): AttachmentKind {
	const mime = (file.mime || "").toLowerCase();
	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";
	if (VIDEO_MIME_ALLOWLIST.includes(mime)) return "video";
	if (mimeMatchesAllowlist(mime, TEXT_MIME_ALLOWLIST)) return "text";
	return "unsupported";
}

/**
 * 清单里的一条。degraded 标记「没能原样附上」—— 截断、超额、解不开、
 * 模型不支持，都算。它只影响要不要打印清单，不影响内容。
 */
type AttachmentOutcome = { text: string; degraded: boolean };

/** 文件名要塞进 <document name="..."> 和清单里，引号会把标签拆散。 */
const safeName = (name: string) => name.replace(/["<>]/g, "'");

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * 把一条用户消息的全部附件变成模型能吃的东西：图片 / PDF 页 / 视频进
 * content parts，文本内联进 <document>，另外附一份清单。
 *
 * 一条消息里各种格式混着来是常态（截图 + PDF + 一份日志），所以这里的
 * 每一步都按「其余附件照常走」来写：
 *
 * - 额度是分类算的。图片和 PDF 页共用 vLLM 的 image.count，视频走自己的
 *   video.count，文本走字符预算 —— 视频不该占掉 PDF 的页数，反过来也是。
 * - 超额、超时、解码失败都不抛出。一张坏图不该让整轮对话失败，更不该
 *   连带把同一条消息里的 PDF 和日志一起废掉。
 * - 凡是没能原样附上的，都在清单里写清楚。模型不知道被截掉了什么，就会
 *   拿半份文档当全份来回答。
 *
 * content parts 按 图片 → PDF 页 → 视频 分组排列，而不是用户附件的原始
 * 顺序；清单里给每一份都标了它对应第几张图，映射关系由清单负责，模型
 * 不需要靠位置去猜。
 */
async function prepareFiles(
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	files: MessageFile[],
	isMultimodal: boolean
): Promise<{
	imageParts: MediaContentPart[];
	textContent: string;
}> {
	const kinds = files.map(classifyAttachment);
	const outcomes: AttachmentOutcome[] = files.map(() => ({ text: "", degraded: false }));
	const indexesOf = (kind: AttachmentKind) =>
		kinds.flatMap((k, i) => (k === kind ? [i] : [])) as number[];

	const imageIndexes = indexesOf("image");
	const pdfIndexes = indexesOf("pdf");
	const videoIndexes = indexesOf("video");
	const textIndexes = indexesOf("text");

	const imageParts: MediaContentPart[] = [];
	/** 已附上的图片张数。视频也放在 imageParts 里，但不算图片额度。 */
	let imageCount = 0;

	// ── 图片 ────────────────────────────────────────────────────────────
	// 上限是硬的：超过 --limit-mm-per-prompt 的 image.count，vLLM 拒的是
	// 整个请求，不是多出来的那几张。宁可少附几张并说明。
	const imageCap =
		pdfIndexes.length > 0
			? Math.max(1, MAX_IMAGES_PER_REQUEST - PDF_RESERVED_IMAGE_SLOTS)
			: MAX_IMAGES_PER_REQUEST;

	if (!isMultimodal) {
		for (const i of imageIndexes) {
			outcomes[i] = { text: "图片 —— 当前模型不支持图片输入，未附上。", degraded: true };
		}
	} else if (imageIndexes.length > 0) {
		const accepted = imageIndexes.slice(0, imageCap);
		// allSettled：sharp 解不开某一张（坏文件、SVG、少见的编码）会抛，
		// 用 all 的话这一抛就带走了同一条消息里的其他所有附件。
		const processed = await Promise.allSettled(accepted.map((i) => imageProcessor(files[i])));
		processed.forEach((result, n) => {
			const i = accepted[n];
			if (result.status === "rejected") {
				const reason =
					result.reason instanceof Error ? result.reason.message : String(result.reason);
				outcomes[i] = { text: `图片 —— 无法解码：${reason}`, degraded: true };
				return;
			}
			imageParts.push({
				type: "image_url" as const,
				image_url: {
					url: `data:${result.value.mime};base64,${result.value.image.toString("base64")}`,
					detail: "auto" as const,
				},
			});
			imageCount += 1;
			outcomes[i] = { text: `图片，第 ${imageCount} 张图。`, degraded: false };
		});
		for (const i of imageIndexes.slice(imageCap)) {
			outcomes[i] = {
				text:
					`图片 —— 本轮共 ${imageIndexes.length} 张，单次请求最多 ${imageCap} 张` +
					`${pdfIndexes.length > 0 ? `（另有 PDF，已为其预留额度）` : ""}，未附上。`,
				degraded: true,
			};
		}
	}

	// ── PDF ─────────────────────────────────────────────────────────────
	// 逐页渲染成图，接在用户自己贴的图后面，吃的是剩下的图片额度。
	let pdfBudget = Math.min(MAX_IMAGES_PER_REQUEST - imageCount, MAX_PDF_PAGES_PER_REQUEST);
	for (const i of pdfIndexes) {
		const file = files[i];
		if (!isMultimodal) {
			outcomes[i] = { text: "PDF —— 当前模型不支持图片输入，无法读取。", degraded: true };
			continue;
		}
		if (pdfBudget <= 0) {
			outcomes[i] = {
				text:
					`PDF —— 单次请求最多 ${MAX_IMAGES_PER_REQUEST} 张图，额度已被本轮前面的` +
					`附件用尽，一页都没能附上。请分多轮发送。`,
				degraded: true,
			};
			continue;
		}
		const { urls, total, error, timedOut } = await renderPdfPages(
			Buffer.from(file.value, "base64"),
			pdfBudget
		);
		if (error) {
			outcomes[i] = { text: `PDF —— 无法读取：${error}`, degraded: true };
			continue;
		}
		if (urls.length === 0) {
			outcomes[i] = { text: `PDF —— 共 ${total} 页，没有能渲染出来的页面。`, degraded: true };
			continue;
		}
		const firstOrdinal = imageCount + 1;
		imageParts.push(
			...urls.map((url) => ({
				type: "image_url" as const,
				image_url: { url, detail: "auto" as const },
			}))
		);
		imageCount += urls.length;
		pdfBudget -= urls.length;
		const range =
			urls.length === 1 ? `第 ${firstOrdinal} 张图` : `第 ${firstOrdinal}–${imageCount} 张图`;
		if (timedOut) {
			outcomes[i] = {
				text:
					`PDF 共 ${total} 页，内容过于复杂，渲染超过 ` +
					`${Math.round(PDF_RENDER_TIMEOUT_MS / 1000)} 秒后停止，只附上了前 ` +
					`${urls.length} 页（${range}）。`,
				degraded: true,
			};
		} else if (total > urls.length) {
			outcomes[i] = {
				text:
					`PDF 共 ${total} 页，受单次请求 ${MAX_IMAGES_PER_REQUEST} 张图、` +
					`PDF ${MAX_PDF_PAGES_PER_REQUEST} 页的上限所限，只附上了前 ${urls.length} 页` +
					`（${range}）。需要后面的内容请让用户拆分后重发。`,
				degraded: true,
			};
		} else {
			outcomes[i] = {
				text: `PDF 共 ${total} 页，已全部作为图片附上（${range}）。`,
				degraded: false,
			};
		}
	}

	// ── 视频 ────────────────────────────────────────────────────────────
	// 原样透传，抽帧交给 vLLM：服务端按 --media-io-kwargs 的 fps / num_frames
	// 采样，再按模型的像素预算压分辨率。自己抽帧会丢掉时序编码和时间戳。
	// 视频有自己的 video.count 额度，不占图片的。
	let videoSlots = MAX_VIDEOS_PER_REQUEST;
	for (const i of videoIndexes) {
		const file = files[i];
		if (!isMultimodal) {
			outcomes[i] = { text: "视频 —— 当前模型不支持视觉输入，无法读取。", degraded: true };
			continue;
		}
		if (videoSlots <= 0) {
			outcomes[i] = {
				text:
					`视频 —— 本轮共 ${videoIndexes.length} 个，单次请求最多 ` +
					`${MAX_VIDEOS_PER_REQUEST} 个，未附上。请分多轮发送。`,
				degraded: true,
			};
			continue;
		}
		const bytes = Buffer.byteLength(file.value, "base64");
		if (bytes > MAX_VIDEO_MB * 1024 * 1024) {
			outcomes[i] = {
				text: `视频 —— 约 ${mb(bytes)}MB，超过单个视频 ${MAX_VIDEO_MB}MB 的上限，未附上。`,
				degraded: true,
			};
			continue;
		}
		imageParts.push({
			type: "video_url" as const,
			video_url: { url: `data:${file.mime};base64,${file.value}` },
		});
		videoSlots -= 1;
		outcomes[i] = { text: "视频，已附上。", degraded: false };
	}

	// ── 文本 ────────────────────────────────────────────────────────────
	const documents: string[] = [];
	let textBudget = MAX_TEXT_TOTAL_CHARS;
	for (const i of textIndexes) {
		const file = files[i];
		const raw = Buffer.from(file.value, "base64").toString("utf-8");
		const allowance = Math.min(MAX_TEXT_FILE_CHARS, textBudget);
		if (allowance <= 0) {
			outcomes[i] = {
				text:
					`文本 —— 本轮文本附件合计已达 ${MAX_TEXT_TOTAL_CHARS} 字符上限，` +
					`这一份（${raw.length} 字符）未附上。`,
				degraded: true,
			};
			continue;
		}
		const truncated = raw.length > allowance;
		const content = truncated ? raw.slice(0, allowance) : raw;
		textBudget -= content.length;
		documents.push(
			`<document name="${safeName(file.name)}" type="${file.mime}">\n${content}` +
				`${truncated ? "\n[……内容过长，此处截断]" : ""}\n</document>`
		);
		outcomes[i] = truncated
			? {
					text: `文本 —— 原文 ${raw.length} 字符，超出单份 ${allowance} 字符的上限，只内联了开头部分。`,
					degraded: true,
				}
			: { text: "文本，已按原文内联在下方 <document> 里。", degraded: false };
	}

	// ── 其余格式 ────────────────────────────────────────────────────────
	// 静默丢弃是最坏的处理：模型不知道用户附过东西，只会答非所问。
	for (const i of indexesOf("unsupported")) {
		outcomes[i] = {
			text: `${files[i].mime || "未知类型"} —— 暂不支持这种附件，未附上。`,
			degraded: true,
		};
	}

	// ── 清单 ────────────────────────────────────────────────────────────
	// 只有一个附件、而且原样附上了的时候，清单是纯噪音：那张图或那个
	// <document> 本身已经说明了一切。PDF 和视频除外 —— 模型得知道自己
	// 看到的这几张图其实是一份 N 页的文档。
	const needsManifest =
		files.length > 1 ||
		kinds.some((k) => k === "pdf" || k === "video" || k === "unsupported") ||
		outcomes.some((o) => o.degraded);

	const manifest = needsManifest
		? `<attachments>\n` +
			files.map((file, i) => `${i + 1}. ${safeName(file.name)} —— ${outcomes[i].text}`).join("\n") +
			`\n</attachments>`
		: "";

	const textContent = [manifest, ...documents].filter(Boolean).join("\n\n");

	return { imageParts, textContent };
}
