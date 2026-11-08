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
import { makeImageProcessor } from "$lib/server/endpoints/images";
import {
	IMAGE_STABLE_MAX_PIXELS,
	imageSizeViolation,
	isImageComplexity,
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
	error?: { message?: string; code?: string; type?: string };
}

class ImageApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string
	) {
		super(message);
		this.name = "ImageApiError";
	}
}

/** 用户在菜单里选的优先，其次 OPENAI_IMAGE_COMPLEXITY；都没有就不发，用 API 默认（high）。 */
function effectiveComplexity(ctx: TextGenerationContext): string | undefined {
	return isImageComplexity(ctx.imageComplexity) ? ctx.imageComplexity : imageComplexity();
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
		const raw = file.type === "base64" ? file : await downloadFile(file.value, ctx.conv._id);
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

async function loadEditInputs(ctx: TextGenerationContext) {
	const user = lastUserMessage(ctx);
	const files = (user?.files ?? []).filter((f) => f.mime?.startsWith("image/"));
	const out: Array<{ buffer: Buffer; mime: string; name: string }> = [];
	for (const file of files.slice(0, EDIT_INPUT_MAX_IMAGES)) {
		const raw = file.type === "base64" ? file : await downloadFile(file.value, ctx.conv._id);
		const processed = await editInputProcessor({ ...raw, name: file.name });
		const ext = processed.mime.split("/")[1] ?? "png";
		out.push({ buffer: processed.image, mime: processed.mime, name: `input-${out.length}.${ext}` });
	}
	return { inputs: out, skipped: Math.max(0, files.length - EDIT_INPUT_MAX_IMAGES) };
}

async function callImagesApi(
	ctx: TextGenerationContext,
	params: {
		prompt: string;
		size: string;
		inputs: Array<{ buffer: Buffer; mime: string; name: string }>;
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
		// moderation 只确认 generations 支持，edits 不发，免得被拒
		for (const [k, v] of Object.entries(optional)) {
			if (k !== "moderation") form.append(k, v);
		}
		for (const input of params.inputs) {
			form.append(
				"image[]",
				new Blob([new Uint8Array(input.buffer)], { type: input.mime }),
				input.name
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
		const message = json.error?.message || `HTTP ${res.status} ${text.slice(0, 200)}`;
		throw new ImageApiError(message, res.status, json.error?.code);
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

function describeError(err: unknown): string {
	if (err instanceof ImageApiError) {
		if (err.code === "moderation_blocked") return `请求被 OpenAI 安全审核拦截：${err.message}`;
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
	const dims = resolveImageDimensions(ctx.imageSize, ctx.imageAspect);
	const violation = imageSizeViolation(dims.width, dims.height);
	if (violation) {
		yield finalAnswer(`尺寸 ${dims.size} 不符合 OpenAI 规则：${violation}`);
		return;
	}

	const startedAt = Date.now();
	try {
		const { prompt, ignored } = await buildPrompt(ctx);
		if (!prompt) {
			yield finalAnswer("请用文字描述要生成或修改的图片。");
			return;
		}
		const { inputs, skipped } = await loadEditInputs(ctx);
		const complexity = effectiveComplexity(ctx);
		const mode = inputs.length ? "edit" : "generate";
		logger.info(
			{ model: ctx.model.id, mode, size: dims.size, complexity, inputs: inputs.length },
			"[image] request"
		);

		const res = await callImagesApi(ctx, { prompt, size: dims.size, inputs });
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
		const notes = [
			`${mode === "edit" ? "已编辑" : "已生成"}：${dims.tier} ${dims.aspect}（${res.size || dims.size}）` +
				`${complexity ? `，复杂度 ${complexity}` : ""}，${seconds} 秒。`,
		];
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
		logger.error({ err: errorDetail(err), model: ctx.model.id }, "[image] failed");
		yield finalAnswer(describeError(err));
	}
}

function finalAnswer(text: string): MessageUpdate {
	return { type: MessageUpdateType.FinalAnswer, text, interrupted: false };
}
