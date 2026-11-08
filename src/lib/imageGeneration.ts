/**
 * 生图尺寸档位（客户端和服务端共用）。
 *
 * OpenAI GPT Image 2.6 / 2.5 的尺寸规则（Image generation 指南）：
 * 宽高都是 16 的倍数；宽高比在 1:3 到 3:1 之间；单边不超过 3840；
 * 总像素在 655,360 到 8,294,400（4K）之间；超过 2560x1440 的分辨率官方标为实验性。
 *
 * 档位命名跟官方指南的尺寸表一致：1K 是推荐尺寸 1024x1024 / 1536x1024 / 1024x1536；
 * 2K 长边 2048（官方「2K square」2048x2048、「2K landscape」2048x1152）；
 * 4K 是官方「4K landscape/portrait」3840x2160 / 2160x3840。官方没有 4K 正方形，
 * 4096x4096（1677 万像素）超限，所以 4K 的 1:1 用像素上限 2880x2880，3:2 用 3504x2336。
 */

export const IMAGE_SIZE_TIERS = ["1K", "2K", "4K"] as const;
export type ImageSizeTier = (typeof IMAGE_SIZE_TIERS)[number];

export const IMAGE_ASPECTS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

/**
 * GPT Image 2.6 的 complexity：渲染前规划多少。官方默认 high，不另收费；
 * 越高越慢，也更可能改动不该动的地方，局部修改建议用低档。
 */
export const IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export type ImageComplexity = (typeof IMAGE_COMPLEXITIES)[number];

export const DEFAULT_IMAGE_SIZE_TIER: ImageSizeTier = "1K";
export const DEFAULT_IMAGE_ASPECT: ImageAspect = "1:1";

export const IMAGE_DIMENSIONS: Record<ImageSizeTier, Record<ImageAspect, [number, number]>> = {
	"1K": {
		"1:1": [1024, 1024],
		"3:2": [1536, 1024],
		"2:3": [1024, 1536],
		"16:9": [1536, 864],
		"9:16": [864, 1536],
	},
	"2K": {
		"1:1": [2048, 2048],
		"3:2": [2048, 1360],
		"2:3": [1360, 2048],
		"16:9": [2048, 1152],
		"9:16": [1152, 2048],
	},
	"4K": {
		"1:1": [2880, 2880],
		"3:2": [3504, 2336],
		"2:3": [2336, 3504],
		"16:9": [3840, 2160],
		"9:16": [2160, 3840],
	},
};

export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MAX_EDGE = 3840;
/** 官方说超过 2560x1440 的分辨率是实验性的。 */
export const IMAGE_STABLE_MAX_PIXELS = 2560 * 1440;

/** 不满足官方尺寸规则时返回原因，满足时返回 null。 */
export function imageSizeViolation(width: number, height: number): string | null {
	if (width % 16 !== 0 || height % 16 !== 0) return "宽高必须是 16 的倍数";
	if (width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE) return `单边不能超过 ${IMAGE_MAX_EDGE}`;
	const ratio = width / height;
	if (ratio > 3 || ratio < 1 / 3) return "宽高比必须在 1:3 到 3:1 之间";
	const pixels = width * height;
	if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) {
		return `总像素必须在 ${IMAGE_MIN_PIXELS} 到 ${IMAGE_MAX_PIXELS} 之间`;
	}
	return null;
}

export function isImageSizeTier(value: unknown): value is ImageSizeTier {
	return typeof value === "string" && (IMAGE_SIZE_TIERS as readonly string[]).includes(value);
}

export function isImageComplexity(value: unknown): value is ImageComplexity {
	return typeof value === "string" && (IMAGE_COMPLEXITIES as readonly string[]).includes(value);
}

export function isImageAspect(value: unknown): value is ImageAspect {
	return typeof value === "string" && (IMAGE_ASPECTS as readonly string[]).includes(value);
}

export function resolveImageDimensions(
	tier: unknown,
	aspect: unknown
): { tier: ImageSizeTier; aspect: ImageAspect; width: number; height: number; size: string } {
	const t = isImageSizeTier(tier) ? tier : DEFAULT_IMAGE_SIZE_TIER;
	const a = isImageAspect(aspect) ? aspect : DEFAULT_IMAGE_ASPECT;
	const [width, height] = IMAGE_DIMENSIONS[t][a];
	return { tier: t, aspect: a, width, height, size: `${width}x${height}` };
}

/**
 * 标记引导编辑（GPT Image 2.6 的 markup）：在被编辑的图上画圈、箭头、编号，
 * 作为一张同尺寸的透明 PNG 图层随 /images/edits 的 `markup` 字段发送，原图不压平。
 *
 * 前端确认标记时生成一个短标签 tag：被标记的图改名为 `mk-<tag>-<原文件名>`，
 * 图层叫 `chatui-markup-<tag>.png`。服务端按标签配对、把被标记的图排到第一张
 * （API 规定第一张是被编辑的图）。不按原文件名配对：粘贴的截图都叫 image.png、
 * 同尺寸的生成图同名，而 HEIC 存储时会被改成 .jpg —— 标签是前缀，改扩展名不影响。
 */
export const MARKUP_FILE_PREFIX = "chatui-markup-";
const TARGET_PREFIX = /^mk-([a-z0-9]{6,16})-/;

export function newMarkupTag(): string {
	const bytes = new Uint8Array(6);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function markupFileNameFor(tag: string): string {
	return `${MARKUP_FILE_PREFIX}${tag}.png`;
}

export function isMarkupFileName(name: string | undefined): boolean {
	return typeof name === "string" && name.startsWith(MARKUP_FILE_PREFIX);
}

/** 图层的标签；不是图层文件时返回 undefined。 */
export function markupTagOf(layerName: string): string | undefined {
	if (!isMarkupFileName(layerName)) return undefined;
	return layerName.slice(MARKUP_FILE_PREFIX.length).replace(/\.png$/i, "") || undefined;
}

/** 被标记图片的文件名：去掉旧标签再加新标签，重复标记同一张图时不会叠前缀。 */
export function markupTargetNameFor(tag: string, originalName: string): string {
	return `mk-${tag}-${originalName.replace(TARGET_PREFIX, "")}`;
}

/** 这张图的标签（不是被标记的图时返回 undefined）。 */
export function markupTagOfTarget(name: string | undefined): string | undefined {
	return typeof name === "string" ? TARGET_PREFIX.exec(name)?.[1] : undefined;
}

/**
 * 编号批注的文字说明，附在用户的文字后面。编号和图层上的徽标一一对应，
 * 文字不画进图层，免得模型把它当成要画进图里的字。
 */
export function formatMarkupNotes(notes: readonly string[]): string | undefined {
	const cleaned = notes.map((note) => note.trim()).filter(Boolean);
	if (cleaned.length === 0) return undefined;
	return [
		"Numbered marks on the markup layer:",
		...cleaned.map((note, i) => `${i + 1}. ${note.replace(/\s*\n\s*/g, "\n   ")}`),
	].join("\n");
}

/**
 * 连续编辑：当前消息没附图时，接着改对话里最近的一张图（像 ChatGPT 那样）。
 *
 * 只看当前分支（树上从根到当前消息的路径），规则：
 * 1. 上一条用户消息附了图、而它之后没有助手出图（那一轮失败/中断/给的是聊天模型）
 *    —— 用那张附图，这是用户最近明确给出的图；
 * 2. 否则用最近一条带图的助手回复里的图。只有生图模型会给助手消息挂图，
 *    出错和中断的回复没有图，自然被跳过。
 * 标记图层（chatui-markup-*）永远不沿用：它只对同一条消息里的那张图有意义。
 */
export interface ChainCandidateMessage {
	from: string;
	files?: Array<{ name: string; mime: string }>;
}

function firstEditableImage<F extends { name: string; mime: string }>(files: F[] | undefined) {
	return files?.find((f) => f.mime?.startsWith("image/") && !isMarkupFileName(f.name));
}

/** `prior`：当前用户消息之前的消息（不含当前消息）。 */
export function findChainSource<M extends ChainCandidateMessage>(
	prior: readonly M[]
): { index: number; file: NonNullable<M["files"]>[number] } | undefined {
	let lastUser = -1;
	for (let i = prior.length - 1; i >= 0; i--) {
		if (prior[i].from === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser >= 0) {
		const upload = firstEditableImage(prior[lastUser].files);
		const answered = prior
			.slice(lastUser + 1)
			.some((m) => m.from === "assistant" && firstEditableImage(m.files));
		if (upload && !answered) return { index: lastUser, file: upload };
	}
	for (let i = prior.length - 1; i >= 0; i--) {
		if (prior[i].from !== "assistant") continue;
		const file = firstEditableImage(prior[i].files);
		if (file) return { index: i, file };
	}
	return undefined;
}

/** 与 width/height 最接近的档位比例（按对数距离），沿用上一张图的比例时用。 */
export function nearestImageAspect(width: number, height: number): ImageAspect {
	const target = Math.log(width / height);
	let best: ImageAspect = DEFAULT_IMAGE_ASPECT;
	let bestDistance = Infinity;
	for (const aspect of IMAGE_ASPECTS) {
		const [a, b] = aspect.split(":").map(Number);
		const distance = Math.abs(Math.log(a / b) - target);
		if (distance < bestDistance) {
			best = aspect;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * 沿用上一张图时加在用户文字前的说明。英文，和 formatMarkupNotes 一致：
 * 不猜用户语言，也不会被当成要画进图里的字。
 */
export const CHAIN_EDIT_PREAMBLE =
	"Edit the provided image as instructed below. Keep everything not mentioned unchanged (subject, composition, style, colors).";
