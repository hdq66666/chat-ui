import type { Sharp } from "sharp";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import { z, type util } from "zod";

export interface ImageProcessorOptions<TMimeType extends string = string> {
	supportedMimeTypes: TMimeType[];
	preferredMimeType: TMimeType;
	maxSizeInMB: number;
	maxWidth: number;
	maxHeight: number;
}
export type ImageProcessor<TMimeType extends string = string> = (file: MessageFile) => Promise<{
	image: Buffer;
	mime: TMimeType;
}>;

export function createImageProcessorOptionsValidator<TMimeType extends string = string>(
	defaults: ImageProcessorOptions<TMimeType>
) {
	return z
		.object({
			supportedMimeTypes: z
				.array(
					z.enum<string, [TMimeType, ...TMimeType[]]>([
						defaults.supportedMimeTypes[0],
						...defaults.supportedMimeTypes.slice(1),
					])
				)
				.default(defaults.supportedMimeTypes),
			preferredMimeType: z
				.enum([defaults.supportedMimeTypes[0], ...defaults.supportedMimeTypes.slice(1)])
				.default(defaults.preferredMimeType as util.noUndefined<TMimeType>),
			maxSizeInMB: z.number().positive().default(defaults.maxSizeInMB),
			maxWidth: z.number().int().positive().default(defaults.maxWidth),
			maxHeight: z.number().int().positive().default(defaults.maxHeight),
		})
		.default(defaults);
}

/**
 * iPhone 的默认拍照格式。sharp 预编译包里的 libvips 认得 HEIC 容器，却没有
 * 链接 libde265 —— HEVC 解码器因专利原因被排除在外（那个 .so 里 de265_
 * 符号数是 0），所以 sharp 读 HEIC 会失败。libheif 的 WASM 版把解码器带了
 * 进来，先解成 RGBA，再交回 sharp 走原来的缩放和转码。
 *
 * 只解不编：编 HEVC 才需要授权，所以 HEIC 永远不会出现在输出格式里。
 */
const HEIC_MIMES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];

/** 明确是 HEVC 编码的 ISO-BMFF brand。见 libheif issue #83。 */
const HEVC_BRANDS = ["heic", "heix", "hevc", "hevx"];

/** 通用 HEIF brand —— AVIF 也可能用，所以只在 mime 已声明是 HEIC 时才认。 */
const GENERIC_HEIF_BRANDS = ["mif1", "msf1"];

function heifBrand(buffer: Buffer): string | undefined {
	// ISO-BMFF：4 字节 box 长度、"ftyp"、4 字节 major brand。
	if (buffer.length < 12) return undefined;
	if (buffer.toString("latin1", 4, 8) !== "ftyp") return undefined;
	return buffer.toString("latin1", 8, 12).replace("\0", " ").trim();
}

export function needsHeifDecoder(buffer: Buffer, mime: string): boolean {
	const brand = heifBrand(buffer);
	if (brand && HEVC_BRANDS.includes(brand)) return true;
	if (!HEIC_MIMES.includes(mime.toLowerCase())) return false;
	// mime 说是 HEIC 但 brand 通用或读不出来：也交给 libheif，它会再判一次。
	return !brand || GENERIC_HEIF_BRANDS.includes(brand);
}

async function decodeHeifToSharp(buffer: Buffer): Promise<Sharp> {
	// 动态 import：libheif 的 wasm 有 6MB，只有真收到 HEIC 才值得加载。
	const { default: decodeHeic } = await import("heic-decode");
	const { width, height, data } = await decodeHeic({ buffer });
	return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
		raw: { width, height, channels: 4 },
	});
}

export function makeImageProcessor<TMimeType extends string = string>(
	options: ImageProcessorOptions<TMimeType>
): ImageProcessor<TMimeType> {
	return async (file) => {
		const { supportedMimeTypes, preferredMimeType, maxSizeInMB, maxWidth, maxHeight } = options;
		const { mime, value } = file;

		const buffer = Buffer.from(value, "base64");
		const isHeic = needsHeifDecoder(buffer, mime);
		let sharpInst = isHeic ? await decodeHeifToSharp(buffer) : sharp(buffer);

		const metadata = await sharpInst.metadata();
		if (!metadata) throw Error("Failed to read image metadata");
		const { width, height } = metadata;
		if (width === undefined || height === undefined) throw Error("Failed to read image size");

		const tooLargeInSize = width > maxWidth || height > maxHeight;
		const tooLargeInBytes = buffer.byteLength > maxSizeInMB * 1000 * 1000;

		// HEIC 解出来是裸像素，没有容器可留，必然要重新编码。这里用 image/png
		// 顶替输入类型，只是为了绕开 chooseMimeType 里对 heic 的黑名单 —— 那条
		// 黑名单针对的是「输出」，配合 preferSizeReduction 最终会落到
		// supportedMimeTypes 里最省的那个格式（照片场景就是 jpeg）。
		const outputMime = chooseMimeType(
			supportedMimeTypes,
			preferredMimeType,
			isHeic ? "image/png" : mime,
			{ preferSizeReduction: tooLargeInBytes || isHeic }
		);

		// Resize if necessary
		if (tooLargeInSize || tooLargeInBytes) {
			const size = chooseImageSize({
				mime: outputMime,
				width,
				height,
				maxWidth,
				maxHeight,
				maxSizeInMB,
			});
			if (size.width !== width || size.height !== height) {
				sharpInst = resizeImage(sharpInst, size.width, size.height);
			}
		}

		// Convert format if necessary
		// We always want to convert the image when the file was too large in bytes
		// so we can guarantee that ideal options are used, which are expected when
		// choosing the image size
		if (outputMime !== mime || tooLargeInBytes) {
			sharpInst = convertImage(sharpInst, outputMime);
		}

		const processedImage = await sharpInst.toBuffer();
		return { image: processedImage, mime: outputMime };
	};
}

const outputFormats = ["png", "jpeg", "webp", "avif", "tiff", "gif"] as const;
type OutputImgFormat = (typeof outputFormats)[number];
const isOutputFormat = (format: string): format is (typeof outputFormats)[number] =>
	outputFormats.includes(format as OutputImgFormat);

export function convertImage(sharpInst: Sharp, outputMime: string): Sharp {
	const [type, format] = outputMime.split("/");
	if (type !== "image") throw Error(`Requested non-image mime type: ${outputMime}`);
	if (!isOutputFormat(format)) {
		throw Error(`Requested to convert to an unsupported format: ${format}`);
	}

	return sharpInst[format]();
}

// 输出侧的黑名单：编 HEVC 需要专利授权，所以永远不产出 heic/heif。
// 输入侧不再受此限制 —— 见 decodeHeifToSharp，解码走 libheif 的 WASM。
// TODO: consider what to do about animated formats: apng, gif, animated webp, ...
const blocklistedMimes = ["image/heic", "image/heif"];

/** Sorted from largest to smallest */
const mimesBySizeDesc = [
	"image/png",
	"image/tiff",
	"image/gif",
	"image/jpeg",
	"image/webp",
	"image/avif",
];

/**
 * Defaults to preferred format or uses existing mime if supported
 * When preferSizeReduction is true, it will choose the smallest format that is supported
 **/
function chooseMimeType<T extends readonly string[]>(
	supportedMimes: T,
	preferredMime: string,
	mime: string,
	{ preferSizeReduction }: { preferSizeReduction: boolean }
): T[number] {
	if (!supportedMimes.includes(preferredMime)) {
		const supportedMimesStr = supportedMimes.join(", ");
		throw Error(
			`Preferred format "${preferredMime}" not found in supported mimes: ${supportedMimesStr}`
		);
	}

	const [type] = mime.split("/");
	if (type !== "image") throw Error(`Received non-image mime type: ${mime}`);

	if (supportedMimes.includes(mime) && !preferSizeReduction) return mime;

	if (blocklistedMimes.includes(mime)) throw Error(`Received blocklisted mime type: ${mime}`);

	const smallestMime = mimesBySizeDesc.findLast((m) => supportedMimes.includes(m));
	return smallestMime ?? preferredMime;
}

interface ImageSizeOptions {
	mime: string;
	width: number;
	height: number;
	maxWidth: number;
	maxHeight: number;
	maxSizeInMB: number;
}

/** Resizes the image to fit within the specified size in MB by guessing the output size */
export function chooseImageSize({
	mime,
	width,
	height,
	maxWidth,
	maxHeight,
	maxSizeInMB,
}: ImageSizeOptions): { width: number; height: number } {
	const biggestDiscrepency = Math.max(1, width / maxWidth, height / maxHeight);

	let selectedWidth = Math.ceil(width / biggestDiscrepency);
	let selectedHeight = Math.ceil(height / biggestDiscrepency);

	do {
		const estimatedSize = estimateImageSizeInBytes(mime, selectedWidth, selectedHeight);
		if (estimatedSize < maxSizeInMB * 1024 * 1024) {
			return { width: selectedWidth, height: selectedHeight };
		}
		selectedWidth = Math.floor(selectedWidth / 1.1);
		selectedHeight = Math.floor(selectedHeight / 1.1);
	} while (selectedWidth > 1 && selectedHeight > 1);

	throw Error(`Failed to resize image to fit within ${maxSizeInMB}MB`);
}

const mimeToCompressionRatio: Record<string, number> = {
	"image/png": 1 / 2,
	"image/jpeg": 1 / 10,
	"image/webp": 1 / 4,
	"image/avif": 1 / 5,
	"image/tiff": 1,
	"image/gif": 1 / 5,
};

/**
 * Guesses the side of an image in MB based on its format and dimensions
 * Should guess the worst case
 **/
function estimateImageSizeInBytes(mime: string, width: number, height: number): number {
	const compressionRatio = mimeToCompressionRatio[mime];
	if (!compressionRatio) throw Error(`Unsupported image format: ${mime}`);

	const bitsPerPixel = 32; // Assuming 32-bit color depth for 8-bit R G B A
	const bytesPerPixel = bitsPerPixel / 8;
	const uncompressedSize = width * height * bytesPerPixel;

	return uncompressedSize * compressionRatio;
}

export function resizeImage(sharpInst: Sharp, maxWidth: number, maxHeight: number): Sharp {
	return sharpInst.resize({ width: maxWidth, height: maxHeight, fit: "inside" });
}
