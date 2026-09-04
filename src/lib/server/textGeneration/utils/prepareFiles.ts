import type { MessageFile } from "$lib/types/Message";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";
import type { OpenAI } from "openai";
import { TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
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
					return [{ role: message.from, content: parts }];
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

async function prepareFiles(
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	files: MessageFile[],
	isMultimodal: boolean
): Promise<{
	imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[];
	textContent: string;
}> {
	const imageFiles = files.filter((file) => file.mime.startsWith("image/"));
	const pdfFiles = files.filter((file) => (file.mime || "").toLowerCase() === "application/pdf");
	const textFiles = files.filter((file) => {
		const mime = (file.mime || "").toLowerCase();
		const [fileType, fileSubtype] = mime.split("/");
		return TEXT_MIME_ALLOWLIST.some((allowed) => {
			const [type, subtype] = allowed.toLowerCase().split("/");
			const typeOk = type === "*" || type === fileType;
			const subOk = subtype === "*" || subtype === fileSubtype;
			return typeOk && subOk;
		});
	});

	let imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
	if (isMultimodal && imageFiles.length > 0) {
		const processedFiles = await Promise.all(imageFiles.map(imageProcessor));
		imageParts = processedFiles.map((file) => ({
			type: "image_url" as const,
			image_url: {
				url: `data:${file.mime};base64,${file.image.toString("base64")}`,
				detail: "auto",
			},
		}));
	}

	// PDF：逐页渲染成图，接在用户自己贴的图后面。额度和图片共享
	// （对 vLLM 来说它们都是 image），但另有 PDF 自己的页数上限，
	// 免得一份长文档把用户贴的截图全挤掉。
	const pdfNotes: string[] = [];
	if (isMultimodal && pdfFiles.length > 0) {
		let budget = Math.min(MAX_IMAGES_PER_REQUEST - imageParts.length, MAX_PDF_PAGES_PER_REQUEST);
		for (const file of pdfFiles) {
			const buf = Buffer.from(file.value, "base64");
			const { urls, total, error, timedOut } = await renderPdfPages(buf, budget);
			if (error) {
				pdfNotes.push(`[无法读取 PDF "${file.name}"：${error}]`);
				continue;
			}
			imageParts.push(
				...urls.map((url) => ({
					type: "image_url" as const,
					image_url: { url, detail: "auto" as const },
				}))
			);
			budget -= urls.length;
			if (timedOut) {
				pdfNotes.push(
					`[PDF "${file.name}" 共 ${total} 页，内容过于复杂，渲染超过 ` +
						`${Math.round(PDF_RENDER_TIMEOUT_MS / 1000)} 秒后停止，仅附上前 ${urls.length} 页。]`
				);
			} else {
				pdfNotes.push(
					total > urls.length
						? `[PDF "${file.name}" 共 ${total} 页，因单次请求最多 ${MAX_IMAGES_PER_REQUEST} 张图、` +
								`PDF 最多 ${MAX_PDF_PAGES_PER_REQUEST} 页，仅附上前 ${urls.length} 页。` +
								`需要后面的内容请让用户拆分后重发。]`
						: `[PDF "${file.name}" 共 ${total} 页，已全部作为图片附上。]`
				);
			}
		}
	} else if (!isMultimodal && pdfFiles.length > 0) {
		pdfNotes.push("[当前模型不支持图片输入，无法读取 PDF 附件。]");
	}

	let textContent = "";
	if (textFiles.length > 0) {
		const textParts = await Promise.all(
			textFiles.map(async (file) => {
				const content = Buffer.from(file.value, "base64").toString("utf-8");
				return `<document name="${file.name}" type="${file.mime}">\n${content}\n</document>`;
			})
		);
		textContent = textParts.join("\n\n");
	}

	if (pdfNotes.length > 0) {
		textContent = [textContent, ...pdfNotes].filter(Boolean).join("\n\n");
	}

	return { imageParts, textContent };
}
