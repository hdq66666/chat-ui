import { describe, expect, it } from "vitest";
import { needsHeifDecoder } from "./images";
import { resolveFileMime } from "$lib/utils/mime";

/** 造一个 ISO-BMFF 头：4 字节 box 长度 + "ftyp" + 4 字节 major brand。 */
function ftyp(brand: string): Buffer {
	const head = Buffer.alloc(12);
	head.writeUInt32BE(12, 0);
	head.write("ftyp", 4, "latin1");
	head.write(brand, 8, "latin1");
	return head;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0]);

describe("needsHeifDecoder", () => {
	it("routes unambiguously HEVC brands to libheif whatever the mime says", () => {
		for (const brand of ["heic", "heix", "hevc", "hevx"]) {
			expect(needsHeifDecoder(ftyp(brand), "application/octet-stream")).toBe(true);
		}
	});

	it("routes a declared HEIC with a generic HEIF brand", () => {
		expect(needsHeifDecoder(ftyp("mif1"), "image/heic")).toBe(true);
		expect(needsHeifDecoder(ftyp("msf1"), "image/heif")).toBe(true);
	});

	it("leaves AVIF to sharp, which decodes it natively", () => {
		// AVIF 自己的 brand，以及借用通用 brand 但 mime 已声明是 AVIF 的情况
		expect(needsHeifDecoder(ftyp("avif"), "image/avif")).toBe(false);
		expect(needsHeifDecoder(ftyp("mif1"), "image/avif")).toBe(false);
	});

	it("leaves ordinary images alone", () => {
		expect(needsHeifDecoder(JPEG, "image/jpeg")).toBe(false);
		expect(needsHeifDecoder(Buffer.alloc(0), "image/png")).toBe(false);
		expect(needsHeifDecoder(Buffer.alloc(4), "image/heic")).toBe(true);
	});
});

describe("resolveFileMime", () => {
	it("keeps a usable type from the browser", () => {
		expect(resolveFileMime("IMG_0001.heic", "image/heic")).toBe("image/heic");
	});

	it("falls back to the extension when the browser gives nothing usable", () => {
		// 这正是 HEIC 的常见情况：部分浏览器给空串或 octet-stream
		expect(resolveFileMime("IMG_0001.HEIC", "")).toBe("image/heic");
		expect(resolveFileMime("IMG_0001.heic", "application/octet-stream")).toBe("image/heic");
		expect(resolveFileMime("clip.mp4", undefined)).toBe("video/mp4");
	});

	it("does not invent a type it cannot know", () => {
		expect(resolveFileMime("mystery", "")).toBe("");
	});
});
