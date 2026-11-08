import { Agent, FormData, fetch as undiciFetch } from "undici";
import {
	OUTPUT_FORMATS,
	imageBaseUrl,
	imageOutputFormat as outputFormat,
	imageComplexity,
	imageModeration,
	imageQuality as quality,
	imageTimeoutMs as timeoutMs,
	MIME_BY_FORMAT,
	type OutputFormat,
} from "./config";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { uploadFile } from "$lib/server/files/uploadFile";
import { downloadFile } from "$lib/server/files/downloadFile";
import { makeImageProcessor, needsHeifDecoder } from "$lib/server/endpoints/images";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import {
	IMAGE_STABLE_MAX_PIXELS,
	imageSizeViolation,
	isImageComplexity,
	CHAIN_EDIT_PREAMBLE,
	IMAGE_PROMPT_MAX_CHARS,
	findChainSource,
	formatEditContext,
	lineageTurns,
	traceEditLineage,
	type EditLineage,
	isMarkupFileName,
	nearestImageAspect,
	markupTagOf,
	markupTagOfTarget,
	resolveImageDimensions,
} from "$lib/imageGeneration";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";

/**
 * OpenAI Image API（gpt-image-2.6-sunburst 等）。
 *
 * 这些模型只开放 /v1/images/generations 和 /v1/images/edits，不走 chat completions，
 * 所以单独成一条生成路径：最后一条用户消息的文字是 prompt；带了图片就走 edits
 * （第一张是被编辑的图，其余是参考图），没带就走 generations。结果是 b64_json，
 * 存进 GridFS，再用已有的 File 更新挂到助手消息上，和上传图片走同一条渲染路径。
 */

/** 编辑输入：官方限制首图不超过 16,777,216 像素；3840x3840 约 1475 万。 */
const EDIT_INPUT_MAX_EDGE = 3840;
const EDIT_INPUT_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
const EDIT_INPUT_MAX_IMAGES = 16;
/** 官方：首图和图层各不超过 16,777,216 像素 */
const MARKUP_MAX_PIXELS = 16_777_216;

let dispatcher: Agent | undefined;
let dispatcherTimeout = 0;
/**
 * Node 自带 fetch 等响应头最多 300 秒；大图生成可能更久，所以用自己的 Agent，
 * 等待时长跟 OPENAI_IMAGE_TIMEOUT_MS 一致。
 */
function getDispatcher(ms: number): Agent {
	if (!dispatcher || dispatcherTimeout !== ms) {
		// 超时配置在运行中改了（ConfigManager）：关掉旧连接池再换
		void dispatcher?.close().catch(() => undefined);
		dispatcher = new Agent({ headersTimeout: ms, bodyTimeout: ms, connectTimeout: 30_000 });
		dispatcherTimeout = ms;
	}
	return dispatcher;
}

interface ImagesApiResponse {
	data?: Array<{ b64_json?: string; revised_prompt?: string }>;
	output_format?: string;
	size?: string;
	quality?: string;
	usage?: unknown;
	error?: {
		message?: string;
		code?: string;
		type?: string;
		moderation_details?: { moderation_stage?: string; categories?: unknown };
	};
}

class ImageApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		/** moderation_details.moderation_stage: input | output | unknown */
		readonly stage?: string
	) {
		super(message);
		this.name = "ImageApiError";
	}
}

/** 用户在菜单里选的优先，其次 OPENAI_IMAGE_COMPLEXITY；都没有就不发，用 API 默认（high）。 */
function effectiveComplexity(ctx: TextGenerationContext): string | undefined {
	return isImageComplexity(ctx.imageComplexity) ? ctx.imageComplexity : imageComplexity();
}

type ImageMode = "generate" | "edit" | "chain";

/**
 * 当前消息没附图、也没要求从零生成时，取对话里上一张图作为被编辑的图
 * （规则见 $lib/imageGeneration 的 findChainSource）。
 */
async function loadChainInput(ctx: TextGenerationContext) {
	let current = ctx.messages.length - 1;
	while (current >= 0 && ctx.messages[current].from !== "user") current--;
	if (current < 0 || ctx.messages[current].imageFresh) return undefined;
	const source = findChainSource(ctx.messages.slice(0, current));
	if (!source) return undefined;
	const raw = await autoOrient(await loadFile(ctx, source.file));
	const processed = await editInputProcessor({ ...raw, name: source.file.name });
	const { width, height } = await sharp(processed.image).metadata();
	if (!width || !height) throw new Error("读不出上一张图的尺寸");
	const ext = processed.mime.split("/")[1] ?? "png";
	return {
		input: { buffer: processed.image, mime: processed.mime, name: `input-0.${ext}` },
		width,
		height,
		messageId: ctx.messages[source.index].id,
		sourceIndex: source.index,
		file: source.file,
	};
}

/** 当前用户消息在 ctx.messages 里的位置。 */
function currentUserIndex(ctx: TextGenerationContext) {
	let i = ctx.messages.length - 1;
	while (i >= 0 && ctx.messages[i].from !== "user") i--;
	return i;
}

/** 标记的是对话里之前生成的图时，返回那条助手消息的位置（标记上传的新图返回 -1）。 */
function markedOutputIndex(ctx: TextGenerationContext) {
	const current = currentUserIndex(ctx);
	const files = ctx.messages[current]?.files ?? [];
	const layer = files.find((f) => isMarkupFileName(f.name));
	const tag = layer ? markupTagOf(layer.name) : undefined;
	const target = tag ? files.find((f) => markupTagOfTarget(f.name) === tag) : undefined;
	if (!target || target.type !== "hash") return -1;
	for (let i = current - 1; i >= 0; i--) {
		const m = ctx.messages[i];
		if (m.from === "assistant" && m.files?.some((f) => f.value === target.value)) return i;
	}
	return -1;
}

/** 起点那轮上传的原图（参考图）最多再带几张：每张 2K 图约 1.5k 输入图像 token */
const CONTEXT_MAX_REFERENCES = 4;

/** 把起点那轮上传的原图作为参考图再发一次（官方：第一张之外的图都是参考）。 */
async function loadLineageReferences(
	ctx: TextGenerationContext,
	lineage: EditLineage<MessageFile>,
	room: number,
	exclude: Set<string>
) {
	const refs: EditInput[] = [];
	const seen = new Set(exclude);
	for (const file of lineage.root?.references ?? []) {
		if (refs.length >= Math.min(room, CONTEXT_MAX_REFERENCES)) break;
		if (seen.has(file.value)) continue;
		seen.add(file.value);
		try {
			const raw = await autoOrient(await loadFile(ctx, file));
			const processed = await editInputProcessor({ ...raw, name: file.name });
			refs.push({ buffer: processed.image, mime: processed.mime, name: file.name });
		} catch (err) {
			// 参考图只是补充：读不出来就不带，不让这一轮失败
			logger.warn({ err: errorDetail(err), name: file.name }, "[image] reference skipped");
		}
	}
	return refs;
}

function lastUserMessage(ctx: TextGenerationContext) {
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		if (ctx.messages[i].from === "user") return ctx.messages[i];
	}
	return undefined;
}

const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

/**
 * 长粘贴（约 4000 字以上）在前端会变成一个 clipboard 附件，聊天模型由
 * preprocessMessages 把它拼到正文前面；生图不走那条路，所以在这里同样拼上。
 */
async function buildPrompt(ctx: TextGenerationContext) {
	const user = lastUserMessage(ctx);
	const files = user?.files ?? [];
	const pasted: string[] = [];
	for (const file of files.filter((f) => f.mime === CLIPBOARD_MIME)) {
		const raw = await loadFile(ctx, file);
		pasted.push(Buffer.from(raw.value, "base64").toString("utf-8"));
	}
	const prompt = [...pasted, user?.content ?? ""]
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	const ignored = files.filter(
		(f) => !f.mime?.startsWith("image/") && f.mime !== CLIPBOARD_MIME
	).length;
	return { prompt, ignored };
}

const editInputProcessor = makeImageProcessor({
	supportedMimeTypes: [...EDIT_INPUT_MIME],
	preferredMimeType: "image/png",
	maxSizeInMB: 25,
	maxWidth: EDIT_INPUT_MAX_EDGE,
	maxHeight: EDIT_INPUT_MAX_EDGE,
});

type EditInput = { buffer: Buffer; mime: string; name: string };

async function loadFile(ctx: TextGenerationContext, file: MessageFile) {
	return file.type === "base64" ? file : await downloadFile(file.value, ctx.conv._id);
}

/**
 * 按 EXIF 方向转正。浏览器画标记时看到的是转正后的图，图层的宽高也是转正后的；
 * 不转正的话图层会和原图对不上。转正后去掉方向标记，格式不变。
 */
async function autoOrient(file: MessageFile): Promise<MessageFile> {
	const buffer = Buffer.from(file.value, "base64");
	if (needsHeifDecoder(buffer, file.mime)) return file;
	const meta = await sharp(buffer).metadata();
	if (!meta.orientation || meta.orientation === 1) return file;
	// JPEG 默认 q80 会再损失一次画质，这里用 95；其他格式保持原格式
	const rotated =
		meta.format === "jpeg"
			? await sharp(buffer).rotate().jpeg({ quality: 95 }).toBuffer()
			: await sharp(buffer).rotate().toBuffer();
	return { ...file, value: rotated.toString("base64") };
}

async function loadEditInputs(ctx: TextGenerationContext) {
	const user = lastUserMessage(ctx);
	const all = (user?.files ?? []).filter((f) => f.mime?.startsWith("image/"));
	// 只认第一个图层；多出来的图层文件不当参考图发
	const markupFile = all.find((f) => isMarkupFileName(f.name));
	let images = all.filter((f) => !isMarkupFileName(f.name));
	if (markupFile) {
		const tag = markupTagOf(markupFile.name);
		const i = tag ? images.findIndex((f) => markupTagOfTarget(f.name) === tag) : -1;
		// 图层必须叠在它画的那张图上；找不到就不发，免得叠到别的图上
		if (i < 0) return { inputs: [], markup: undefined, markupTargetMissing: true, skipped: 0 };
		if (i > 0) images = [images[i], ...images.slice(0, i), ...images.slice(i + 1)];
	}

	const inputs: EditInput[] = [];
	for (const file of images.slice(0, EDIT_INPUT_MAX_IMAGES)) {
		const raw = await autoOrient(await loadFile(ctx, file));
		const processed = await editInputProcessor({ ...raw, name: file.name });
		const ext = processed.mime.split("/")[1] ?? "png";
		inputs.push({
			buffer: processed.image,
			mime: processed.mime,
			name: `input-${inputs.length}.${ext}`,
		});
	}

	// 官方要求图层和第一张图同宽同高：按处理后的第一张图（可能被缩到 3840 边）缩放
	let markup: EditInput | undefined;
	if (markupFile && inputs.length) {
		const { width, height } = await sharp(inputs[0].buffer).metadata();
		if (!width || !height) throw new Error("读不出被编辑图片的尺寸");
		const raw = await loadFile(ctx, markupFile);
		// 和 API 的单图上限一致，防止一张声明超大尺寸的 PNG 解码时吃掉大量内存
		const buffer = await sharp(Buffer.from(raw.value, "base64"), {
			limitInputPixels: MARKUP_MAX_PIXELS,
		})
			.resize(width, height, { fit: "fill" })
			.ensureAlpha()
			.png()
			.toBuffer();
		markup = { buffer, mime: "image/png", name: "markup.png" };
	}

	return {
		inputs,
		markup,
		markupTargetMissing: false,
		skipped: Math.max(0, images.length - EDIT_INPUT_MAX_IMAGES),
	};
}

async function callImagesApi(
	ctx: TextGenerationContext,
	params: {
		prompt: string;
		size: string;
		inputs: EditInput[];
		markup?: EditInput;
	}
): Promise<ImagesApiResponse> {
	const apiKey = config.OPENAI_IMAGE_API_KEY;
	if (!apiKey) throw new ImageApiError("OPENAI_IMAGE_API_KEY 未配置", 500);

	const ms = timeoutMs();
	// 线上是 Node 24；老 Node 没有 AbortSignal.any 时，超时只靠 dispatcher 的 headers/body 超时
	const signal =
		typeof AbortSignal.any === "function"
			? AbortSignal.any([ctx.abortController.signal, AbortSignal.timeout(ms)])
			: ctx.abortController.signal;
	// 可选参数只在配置了合法值时才发，否则用 API 默认值（quality/moderation auto，complexity high）
	const optional: Record<string, string> = {};
	const q = quality();
	if (q) optional.quality = q;
	const complexity = effectiveComplexity(ctx);
	if (complexity) optional.complexity = complexity;
	const moderation = imageModeration();
	if (moderation) optional.moderation = moderation;
	const fmt = outputFormat();
	const edit = params.inputs.length > 0;
	const url = `${imageBaseUrl()}/images/${edit ? "edits" : "generations"}`;

	let body: string | FormData;
	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	if (edit) {
		const form = new FormData();
		form.append("model", ctx.model.id);
		form.append("prompt", params.prompt);
		form.append("size", params.size);
		form.append("n", "1");
		form.append("output_format", fmt);
		for (const [k, v] of Object.entries(optional)) form.append(k, v);
		for (const input of params.inputs) {
			form.append(
				"image[]",
				new Blob([new Uint8Array(input.buffer)], { type: input.mime }),
				input.name
			);
		}
		// 不和 mask 同用（我们从不发 mask）
		if (params.markup) {
			form.append(
				"markup",
				new Blob([new Uint8Array(params.markup.buffer)], { type: params.markup.mime }),
				params.markup.name
			);
		}
		body = form;
	} else {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify({
			model: ctx.model.id,
			prompt: params.prompt,
			size: params.size,
			n: 1,
			output_format: fmt,
			...optional,
		});
	}

	const res = await undiciFetch(url, {
		method: "POST",
		headers,
		body,
		signal,
		dispatcher: getDispatcher(ms),
	});
	const text = await res.text();
	let json: ImagesApiResponse = {};
	try {
		json = JSON.parse(text) as ImagesApiResponse;
	} catch {
		// 非 JSON（网关错误页等），下面按状态码报错
	}
	if (!res.ok) {
		// 整个 error 对象记进日志（不含请求内容和 key），方便查审核拦截的细节
		logger.warn(
			{ status: res.status, error: json.error ?? text.slice(0, 500) },
			"[image] api error"
		);
		const message = json.error?.message || `HTTP ${res.status} ${text.slice(0, 200)}`;
		throw new ImageApiError(
			message,
			res.status,
			json.error?.code,
			json.error?.moderation_details?.moderation_stage
		);
	}
	return json;
}

/** undici 把网络/超时错误包成 "fetch failed"，真正原因在 cause 里 */
function errorDetail(err: unknown): string {
	if (err && typeof err === "object" && "status" in err && "body" in err) {
		// SvelteKit 的 HttpError（如 downloadFile 的 404/403）
		const body = (err as { body?: { message?: string } }).body;
		return `${(err as { status: number }).status} ${body?.message ?? ""}`.trim();
	}
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	if (cause && typeof cause === "object") {
		const c = cause as { message?: string; code?: string };
		return `${err.message}（${[c.code, c.message].filter(Boolean).join(" ")}）`;
	}
	return err.message;
}

function isModerationBlock(err: ImageApiError) {
	return err.code === "moderation_blocked" || /safety system/i.test(err.message);
}

/** 安全审核拦截：说明拦在哪一步、能怎么办；从不自动重试或改写提示词。 */
function describeModerationBlock(err: ImageApiError, mode: ImageMode): string {
	const lines = ["请求被 OpenAI 安全审核拦截。"];
	if (err.stage === "output") lines.push("拦截发生在生成结果上，结果有随机性，可以直接重试一次。");
	else if (err.stage === "input")
		lines.push("拦截发生在输入上，可以改一下文字描述或换一张图再试。");
	else lines.push("可以调整描述后再试。");
	if (mode === "generate") {
		lines.push(
			"从零生成时提示词太短更容易被误判，描述得具体一些会好些；要改已有的图，请附上图片或用图片上的铅笔按钮。"
		);
	}
	lines.push("", `OpenAI 原文：${err.message}`);
	return lines.join("\n");
}

function describeError(err: unknown, mode: ImageMode = "generate"): string {
	if (err instanceof ImageApiError) {
		if (isModerationBlock(err)) return describeModerationBlock(err, mode);
		if (err.status === 401) return "OpenAI 拒绝了 API key（401），请检查 OPENAI_IMAGE_API_KEY。";
		if (err.status === 429) return `OpenAI 限流或额度不足（429）：${err.message}`;
		return `生图失败（${err.status}）：${err.message}`;
	}
	const detail = errorDetail(err);
	if ((err instanceof Error && err.name === "TimeoutError") || /timeout/i.test(detail)) {
		return "生图超时，请稍后重试或降低尺寸。";
	}
	return `生图失败：${detail}`;
}

function isAbort(ctx: TextGenerationContext, err: unknown) {
	return ctx.abortController.signal.aborted || (err instanceof Error && err.name === "AbortError");
}

export async function* generateImage(
	ctx: TextGenerationContext
): AsyncGenerator<MessageUpdate, undefined, undefined> {
	let dims = resolveImageDimensions(ctx.imageSize, ctx.imageAspect);
	const violation = imageSizeViolation(dims.width, dims.height);
	if (violation) {
		yield finalAnswer(`尺寸 ${dims.size} 不符合 OpenAI 规则：${violation}`);
		return;
	}

	const startedAt = Date.now();
	let mode: ImageMode = "generate";
	try {
		const { prompt, ignored } = await buildPrompt(ctx);
		if (!prompt) {
			yield finalAnswer("请用文字描述要生成或修改的图片。");
			return;
		}
		const { inputs, markup, markupTargetMissing, skipped } = await loadEditInputs(ctx);
		if (markupTargetMissing) {
			yield finalAnswer("找不到标记图层对应的图片，请把被标记的图片和标记一起发送。");
			return;
		}
		// 没附图：接着改上一张图（除非用户这条选了"从零生成"）。比例沿用那张图，
		// 档位用用户设置的 —— 所以"提高分辨率"配 2K 就会按 2K 重新渲染
		const chain = inputs.length || markup ? undefined : await loadChainInput(ctx);
		let requestPrompt = prompt;
		if (chain) {
			inputs.push(chain.input);
			dims = resolveImageDimensions(ctx.imageSize, nearestImageAspect(chain.width, chain.height));
			requestPrompt = `${CHAIN_EDIT_PREAMBLE}\n\n${prompt}`;
		}
		mode = chain ? "chain" : inputs.length ? "edit" : "generate";

		// 接着改之前生成的图（连续编辑，或标记了之前的输出）：把这张图的来历带上
		const sourceIndex = chain ? chain.sourceIndex : markup ? markedOutputIndex(ctx) : -1;
		let contextTurns = 0;
		let references = 0;
		if (sourceIndex >= 0) {
			const prior = ctx.messages.slice(0, currentUserIndex(ctx));
			const lineage = traceEditLineage(prior, sourceIndex) as EditLineage<MessageFile>;
			const exclude = new Set(
				[chain?.file, ...(lastUserMessage(ctx)?.files ?? [])]
					.filter((f): f is MessageFile => Boolean(f))
					.map((f) => f.value)
			);
			const refs = await loadLineageReferences(
				ctx,
				lineage,
				EDIT_INPUT_MAX_IMAGES - inputs.length,
				exclude
			);
			const withContext = formatEditContext(lineage, prompt, { references: refs.length });
			if (withContext && withContext.length <= IMAGE_PROMPT_MAX_CHARS) {
				requestPrompt = withContext;
				contextTurns = lineageTurns(lineage);
				references = refs.length;
				for (const ref of refs) {
					inputs.push({
						...ref,
						name: `input-${inputs.length}.${ref.mime.split("/")[1] ?? "png"}`,
					});
				}
			}
		}
		const complexity = effectiveComplexity(ctx);
		logger.info(
			{
				model: ctx.model.id,
				mode,
				size: dims.size,
				complexity,
				inputs: inputs.length,
				markup: Boolean(markup),
				contextTurns,
				references,
				promptChars: requestPrompt.length,
				...(chain
					? {
							chainSource: {
								messageId: chain.messageId,
								name: chain.file.name,
								sha: chain.file.type === "hash" ? chain.file.value : undefined,
							},
						}
					: {}),
			},
			"[image] request"
		);

		const res = await callImagesApi(ctx, {
			prompt: requestPrompt,
			size: dims.size,
			inputs,
			markup,
		});
		const b64 = res.data?.[0]?.b64_json;
		if (!b64) throw new Error("响应里没有 b64_json");

		const fmt = (OUTPUT_FORMATS as readonly string[]).includes(res.output_format ?? "")
			? (res.output_format as OutputFormat)
			: outputFormat();
		const mime = MIME_BY_FORMAT[fmt];
		const file = new File(
			[new Uint8Array(Buffer.from(b64, "base64"))],
			`${ctx.model.id}-${res.size || dims.size}.${fmt}`,
			{ type: mime }
		);
		const stored = await uploadFile(file, ctx.conv);
		yield { type: MessageUpdateType.File, name: stored.name, sha: stored.value, mime };

		const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
		logger.info(
			{ model: ctx.model.id, mode, size: res.size || dims.size, seconds, usage: res.usage },
			"[image] done"
		);
		const outSize = res.size || dims.size;
		const verb =
			mode === "chain"
				? `基于上一张图编辑（${chain?.width}x${chain?.height} → ${outSize}）`
				: mode === "edit"
					? markup
						? "已按标记编辑"
						: "已编辑"
					: "已生成";
		const notes = [
			`${verb}：${dims.tier} ${dims.aspect}（${outSize}）` +
				`${complexity ? `，复杂度 ${complexity}` : ""}，${seconds} 秒。`,
		];
		if (chain && dims.aspect !== resolveImageDimensions(ctx.imageSize, ctx.imageAspect).aspect) {
			notes.push(`比例沿用上一张图（${dims.aspect}），不按设置裁切。`);
		}
		if (contextTurns) {
			notes.push(
				`已带上之前 ${contextTurns} 轮的要求${references ? `和最初的 ${references} 张参考图` : ""}。`
			);
		}
		if (dims.width * dims.height > IMAGE_STABLE_MAX_PIXELS) {
			notes.push("超过 2560×1440 的尺寸 OpenAI 标为实验性。");
		}
		if (ignored) notes.push(`有 ${ignored} 个非图片附件未发送（生图模型只接收文字和图片）。`);
		if (skipped)
			notes.push(`附件图片超过 ${EDIT_INPUT_MAX_IMAGES} 张，多出的 ${skipped} 张未发送。`);
		yield finalAnswer(notes.join("\n"));
	} catch (err) {
		// 用户停止：conversation 路由会自己补一条 interrupted 的最终回答
		if (isAbort(ctx, err)) return;
		logger.error({ err: errorDetail(err), model: ctx.model.id, mode }, "[image] failed");
		yield finalAnswer(describeError(err, mode));
	}
}

function finalAnswer(text: string): MessageUpdate {
	return { type: MessageUpdateType.FinalAnswer, text, interrupted: false };
}
