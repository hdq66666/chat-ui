/**
 * 浏览器端的 HEIC 缩略图。
 *
 * Safari 以外的浏览器都解不了 HEIC，<img src="data:image/heic;...."> 只会渲染
 * 成一块空白（不是报错，所以连 onerror 都不会触发）。消息发出去之后服务端存的
 * 已经是转码好的 JPEG（见 server/files/uploadFile.ts），所以只有编辑器里这一段
 * 拿到的还是原图 —— 那就在客户端解一次。
 *
 * libheif 的 wasm 包约 1.4MB，调用点用动态 import，只有真的选了 HEIC 才下载。
 * 解不出来就让调用方退回文件卡片，不要给用户一块空白。
 */

/** 缩略图最长边。和模型侧拿到的分辨率一致，放大看也够用。 */
const MAX_EDGE = 1024;

export async function decodeHeicToDataUrl(base64: string, maxEdge = MAX_EDGE): Promise<string> {
	const { default: libheif } = await import("libheif-js/wasm-bundle");

	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

	const images = new libheif.HeifDecoder().decode(bytes);
	const image = images?.[0];
	if (!image) throw new Error("no image in HEIF container");

	const width = image.get_width();
	const height = image.get_height();
	const rgba = new Uint8ClampedArray(width * height * 4);

	try {
		await new Promise<void>((resolve, reject) => {
			image.display({ data: rgba, width, height }, (out: unknown) =>
				out ? resolve() : reject(new Error("HEIF display failed"))
			);
		});
	} finally {
		image.free?.();
	}

	// 全尺寸的 data URL 对一张 12MP 的照片是几十 MB，先缩再编码。
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));

	const full = document.createElement("canvas");
	full.width = width;
	full.height = height;
	const fullCtx = full.getContext("2d");
	if (!fullCtx) throw new Error("no 2d context");
	fullCtx.putImageData(new ImageData(rgba, width, height), 0, 0);

	if (w === width && h === height) return full.toDataURL("image/jpeg", 0.85);

	const thumb = document.createElement("canvas");
	thumb.width = w;
	thumb.height = h;
	const thumbCtx = thumb.getContext("2d");
	if (!thumbCtx) throw new Error("no 2d context");
	thumbCtx.drawImage(full, 0, 0, w, h);
	return thumb.toDataURL("image/jpeg", 0.85);
}
