import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { sha256 } from "$lib/utils/sha256";
import { fileTypeFromBuffer } from "file-type";
import { collections } from "$lib/server/database";
import { needsHeifDecoder, transcodeHeicToJpeg } from "$lib/server/endpoints/images";

/**
 * 浏览器（Safari 以外）不认 HEIC，<img> 只会渲染成一片空白，消息里那张图
 * 就没有预览。所以存之前先转成 JPEG。
 *
 * 这不损失任何东西：模型那一侧本来就会被 image processor 转成 JPEG 再发，
 * 留着原始 HEIC 只是让每一轮重新跑一遍 6MB 的 wasm 解码。转码保持原分辨率，
 * 要不要缩小仍然由发送时的 image processor 按 maxWidth/maxSizeInMB 决定。
 */
async function toStorableFile(file: File): Promise<File> {
	const buffer = Buffer.from(await file.arrayBuffer());
	if (!needsHeifDecoder(buffer, file.type)) return file;

	const jpeg = await transcodeHeicToJpeg(buffer);
	const name = file.name.replace(/\.(heic|heif|hif)$/i, "") + ".jpg";
	// Buffer 是 Uint8Array 的子类，但它的 ArrayBufferLike 不满足 BlobPart，
	// 所以复制成一个普通的 Uint8Array 再交给 File。
	return new File([new Uint8Array(jpeg)], name, { type: "image/jpeg" });
}

export async function uploadFile(file: File, conv: Conversation): Promise<MessageFile> {
	const stored = await toStorableFile(file);

	const sha = await sha256(await stored.text());
	const buffer = await stored.arrayBuffer();

	// Attempt to detect the mime type of the file, fallback to the uploaded mime
	const mime = await fileTypeFromBuffer(buffer).then((fileType) => fileType?.mime ?? stored.type);

	const upload = collections.bucket.openUploadStream(`${conv._id}-${sha}`, {
		metadata: { conversation: conv._id.toString(), mime },
	});

	upload.write((await stored.arrayBuffer()) as unknown as Buffer);
	upload.end();

	// only return the filename when upload throws a finish event or a 20s time out occurs
	return new Promise((resolve, reject) => {
		upload.once("finish", () =>
			resolve({ type: "hash", value: sha, mime: stored.type, name: stored.name })
		);
		upload.once("error", reject);
		setTimeout(() => reject(new Error("Upload timed out")), 20_000);
	});
}
