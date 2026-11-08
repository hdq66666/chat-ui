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
