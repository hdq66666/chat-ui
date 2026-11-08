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
export const MARKUP_NOTES_HEADER = "Numbered marks on the markup layer:";

export function formatMarkupNotes(notes: readonly string[]): string | undefined {
	const cleaned = notes.map((note) => note.trim()).filter(Boolean);
	if (cleaned.length === 0) return undefined;
	return [
		MARKUP_NOTES_HEADER,
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

/**
 * 多轮编辑的上下文。Image API 不记对话（官方多轮靠 Responses API，但 2.6 的标记编辑和
 * complexity 只在 Image API 上），所以每次编辑都把"这张图是怎么来的"重新写进 prompt：
 * 从被编辑的图往回追 —— 它由哪一轮生成，那一轮又改的是哪张图 —— 直到最初的请求。
 *
 * 按文件哈希追：标记编辑的目标图和它对应的助手输出是同一份内容（同一个哈希）。
 * 失败的轮次没有出图，自然不在链上（也就不会把被审核拦下的文字再发一遍）；
 * 分支由调用方传入的当前路径决定。
 */
export interface LineageFile {
	name: string;
	mime: string;
	value?: string;
}

export interface LineageMessage {
	from: string;
	content?: string;
	imageFresh?: boolean;
	files?: LineageFile[];
}

export interface EditLineage<F extends LineageFile = LineageFile> {
	/**
	 * 链的起点：从零生成，或编辑用户上传的图。text 为空表示起点那轮没有可用的文字。
	 * references 是起点那轮上传的图；editedFirst 时第一张是被改成第一版的原图（不是普通参考）。
	 */
	root?: { index: number; text: string; references: F[]; editedFirst: boolean };
	/** 之后每一轮的编辑要求，从早到晚；标记说明已改写成指向"更早的版本" */
	edits: Array<{ index: number; text: string; markup: boolean }>;
}

const isImageFile = (f: LineageFile) => Boolean(f.mime?.startsWith("image/"));

/** 存下来的标记轮次正文里，图层说明的标题指的是那一轮的图层；放进历史时改写。 */
export function rewriteEarlierMarkupNotes(text: string): string {
	return text.replace(MARKUP_NOTES_HEADER, "Notes for marks drawn on an earlier version:").trim();
}

function lastAssistantWith(prior: readonly LineageMessage[], before: number, value: string) {
	for (let i = before - 1; i >= 0; i--) {
		if (prior[i].from === "assistant" && prior[i].files?.some((f) => f.value === value)) return i;
	}
	return -1;
}

/**
 * 被编辑的图所在的消息。图来自一条用户消息时（那一轮失败了，例如标记编辑被审核拦下），
 * 如果它其实是之前某张输出的副本（同一哈希），换成那条助手消息，链就能接着往回追。
 */
export function resolveImageSource(
	prior: readonly LineageMessage[],
	index: number,
	value: string | undefined
): number {
	if (index < 0 || prior[index]?.from === "assistant" || !value) return index;
	const output = lastAssistantWith(prior, index, value);
	return output >= 0 ? output : index;
}

/**
 * `prior`：当前用户消息之前的消息（当前分支）；`sourceIndex`：被编辑的那张图所在的消息
 * （先经过 resolveImageSource）。
 */
export function traceEditLineage<M extends LineageMessage>(
	prior: readonly M[],
	sourceIndex: number
): EditLineage<NonNullable<M["files"]>[number]> {
	type F = NonNullable<M["files"]>[number];
	const edits: EditLineage<F>["edits"] = [];
	let root: EditLineage<F>["root"];
	let at = sourceIndex;
	// 每一步 at 都严格变小，最多走 prior.length 步
	while (at >= 0 && prior[at]?.from === "assistant") {
		let u = at - 1;
		while (u >= 0 && prior[u].from !== "user") u--;
		if (u < 0) break;
		const turn = prior[u];
		const text = (turn.content ?? "").trim();
		const images = (turn.files ?? []).filter(isImageFile) as F[];
		const layer = images.find((f) => isMarkupFileName(f.name));
		const uploads = images.filter((f) => !isMarkupFileName(f.name));

		if (layer) {
			const tag = markupTagOf(layer.name);
			const target = uploads.find((f) => markupTagOfTarget(f.name) === tag);
			const from = target?.value ? lastAssistantWith(prior, u, target.value) : -1;
			if (from >= 0) {
				edits.unshift({ index: u, text: rewriteEarlierMarkupNotes(text), markup: true });
				at = from;
				continue;
			}
			// 标记的是用户上传的图：这一轮就是起点，被标记的那张排第一
			root = {
				index: u,
				text: rewriteEarlierMarkupNotes(text),
				references: target ? [target, ...uploads.filter((f) => f !== target)] : uploads,
				editedFirst: Boolean(target),
			};
			break;
		}
		if (uploads.length) {
			root = { index: u, text, references: uploads, editedFirst: true };
			break;
		}
		if (turn.imageFresh) {
			root = { index: u, text, references: [], editedFirst: false };
			break;
		}
		const source = findChainSource(prior.slice(0, u));
		if (!source) {
			root = { index: u, text, references: [], editedFirst: false };
			break;
		}
		edits.unshift({ index: u, text, markup: false });
		const next = resolveImageSource(prior, source.index, (source.file as LineageFile).value);
		if (prior[next].from !== "assistant") {
			// 接着改的是一张从没出过图的上传：那一轮失败了，它的文字不带（可能正是被拦下的那句）
			root = {
				index: next,
				text: "",
				references: [source.file as F],
				editedFirst: true,
			};
			break;
		}
		at = next;
	}
	return { root, edits: edits.filter((e) => e.text) };
}

/** 官方 prompt 上限 32,000 字符；历史部分留在这个预算里，给当前这句留足空间 */
export const EDIT_CONTEXT_MAX_CHARS = 12_000;
export const IMAGE_PROMPT_MAX_CHARS = 32_000;

const indent = (text: string) => text.replace(/\s*\n\s*/g, "\n   ");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function imageRange(first: number, count: number) {
	return count === 1 ? `Image ${first} is` : `Images ${first}-${first + count - 1} are`;
}

/**
 * 把追到的上下文和这一轮的要求拼成一个 prompt。英文骨架（不猜用户语言，也不会被当成要画的字），
 * 用户原话照抄。历史太长时保留起点和最近的几轮，中间写明省略了几轮。
 *
 * 图的顺序：第 1 张是被编辑的图，接着是这一轮另外附的 `attachments` 张，最后是起点那轮上传的
 * `references` 张。没有可带的历史时返回 undefined，由调用方用原来的写法。
 */
export function formatEditContext(
	lineage: EditLineage,
	current: string,
	opts: {
		attachments: number;
		references: number;
		/** 实际发出的第一张参考图是不是被改成第一版的原图（默认按 lineage 判断） */
		editedFirst?: boolean;
		/** 起点那轮的上传是不是都带上了（默认按数量判断） */
		allReferences?: boolean;
		maxChars?: number;
	}
): { prompt: string; turns: number } | undefined {
	const max = opts.maxChars ?? EDIT_CONTEXT_MAX_CHARS;
	const rootText = clip(lineage.root?.text ?? "", Math.floor(max / 2));
	if (!rootText && lineage.edits.length === 0) return undefined;

	let budget = max - rootText.length;
	const kept: string[] = [];
	let omitted = 0;
	for (let i = lineage.edits.length - 1; i >= 0; i--) {
		let line = indent(lineage.edits[i].text);
		if (line.length + 8 > budget) {
			if (kept.length === 0) {
				// 最近一轮最重要：放不下就截短，不整条丢
				line = clip(line, Math.max(200, budget - 8));
				kept.unshift(line);
				omitted = i;
			} else {
				omitted = i + 1;
			}
			break;
		}
		budget -= line.length + 8;
		kept.unshift(line);
	}

	const roles = [
		"This continues an image-editing conversation. Image 1 is the current version of the picture: " +
			"the result of the requests below.",
	];
	let next = 2;
	if (opts.attachments > 0) {
		roles.push(`${imageRange(next, opts.attachments)} attached with the new instruction.`);
		next += opts.attachments;
	}
	if (opts.references > 0) {
		const editedFirst = opts.editedFirst ?? lineage.root?.editedFirst ?? false;
		if (editedFirst) {
			roles.push(
				`Image ${next} is the original picture the first version was made from; ` +
					"the requested changes have already been applied to image 1, so do not revert to it."
			);
			next += 1;
		}
		const rest = opts.references - (editedFirst ? 1 : 0);
		if (rest > 0) {
			roles.push(
				rest === 1
					? `Image ${next} is a reference image from the original request.`
					: `${imageRange(next, rest)} reference images from the original request.`
			);
		}
		const all = opts.allReferences ?? opts.references === (lineage.root?.references.length ?? 0);
		if (all) {
			roles.push(
				"Where the original request mentions its images, it means these, in the same order."
			);
		}
	}

	const parts = [roles.join(" ")];
	if (rootText) parts.push(`Original request:\n${rootText}`);
	if (kept.length || omitted) {
		const lines = kept.map((line, i) => `${omitted + i + 1}. ${line}`);
		if (omitted) lines.unshift(`(${omitted} earlier edit${omitted > 1 ? "s" : ""} omitted)`);
		parts.push(`Edits already made, in order:\n${lines.join("\n")}`);
	}
	parts.push(`Now apply this edit to image 1:\n${current}`);
	parts.push(
		"Later instructions override earlier ones. Keep every earlier requirement the new instruction " +
			"does not change, and keep everything else unchanged (subject, composition, style, colors)."
	);
	return { prompt: parts.join("\n\n"), turns: (rootText ? 1 : 0) + kept.length };
}
