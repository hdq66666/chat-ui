import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import { markupFileNameFor } from "$lib/imageGeneration";
import sharp from "sharp";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";

// 1x1 PNG
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const mocks = vi.hoisted(() => ({
	config: {} as Record<string, string>,
	fetch: vi.fn(),
	uploadFile: vi.fn(),
	downloadFile: vi.fn(),
}));

vi.mock("$lib/server/config", () => ({ config: mocks.config }));
vi.mock("$lib/server/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("$lib/server/files/uploadFile", () => ({ uploadFile: mocks.uploadFile }));
vi.mock("$lib/server/files/downloadFile", () => ({ downloadFile: mocks.downloadFile }));
vi.mock("undici", async (importOriginal) => {
	const actual = await importOriginal<typeof import("undici")>();
	return { ...actual, fetch: mocks.fetch };
});

const { generateImage } = await import("./openaiImages");

function ctx(opts: {
	content?: string;
	files?: Array<{ type: "hash"; value: string; mime: string; name: string }>;
	imageSize?: string;
	imageAspect?: string;
}): TextGenerationContext {
	return {
		model: { id: "gpt-image-2.6-sunburst", imageGeneration: true },
		conv: { _id: new ObjectId() },
		messages: [
			{ from: "user", id: "u0", content: "old prompt" },
			{ from: "assistant", id: "a0", content: "old answer" },
			{ from: "user", id: "u1", content: opts.content ?? "a red fox", files: opts.files },
		],
		abortController: new AbortController(),
		imageSize: opts.imageSize,
		imageAspect: opts.imageAspect,
	} as unknown as TextGenerationContext;
}

async function collect(c: TextGenerationContext) {
	const out: MessageUpdate[] = [];
	for await (const u of generateImage(c)) out.push(u);
	return out;
}

function okResponse(body: unknown) {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
	for (const k of Object.keys(mocks.config)) delete mocks.config[k];
	Object.assign(mocks.config, {
		OPENAI_IMAGE_API_KEY: "sk-test",
		OPENAI_IMAGE_BASE_URL: "https://api.openai.com/v1/",
		OPENAI_IMAGE_OUTPUT_FORMAT: "png",
	});
	mocks.fetch.mockReset();
	mocks.uploadFile.mockReset();
	mocks.downloadFile.mockReset();
	mocks.uploadFile.mockImplementation(async (file: File) => ({
		type: "hash",
		value: "sha-out",
		mime: file.type,
		name: file.name,
	}));
});

describe("generateImage", () => {
	it("calls /images/generations with the chosen size and stores the result", async () => {
		mocks.fetch.mockResolvedValue(
			okResponse({ data: [{ b64_json: PNG_B64 }], output_format: "png", size: "2048x1152" })
		);
		const updates = await collect(ctx({ imageSize: "2K", imageAspect: "16:9" }));

		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = mocks.fetch.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/images/generations");
		expect(init.headers.Authorization).toBe("Bearer sk-test");
		expect(JSON.parse(init.body)).toEqual({
			model: "gpt-image-2.6-sunburst",
			prompt: "a red fox",
			size: "2048x1152",
			n: 1,
			output_format: "png",
		});

		const stored = mocks.uploadFile.mock.calls[0][0] as File;
		expect(stored.type).toBe("image/png");
		expect(Buffer.from(await stored.arrayBuffer()).toString("base64")).toBe(PNG_B64);

		expect(updates[0]).toEqual({
			type: MessageUpdateType.File,
			name: stored.name,
			sha: "sha-out",
			mime: "image/png",
		});
		const last = updates[updates.length - 1];
		expect(last.type).toBe(MessageUpdateType.FinalAnswer);
		expect((last as { text: string }).text).toContain("2K 16:9");
	});

	it("defaults to 1K square and forwards quality, complexity and moderation when set", async () => {
		Object.assign(mocks.config, {
			OPENAI_IMAGE_QUALITY: "high",
			OPENAI_IMAGE_COMPLEXITY: "medium",
			OPENAI_IMAGE_MODERATION: "low",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		await collect(ctx({}));
		const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
		expect(body.size).toBe("1024x1024");
		expect(body.quality).toBe("high");
		expect(body.complexity).toBe("medium");
		expect(body.moderation).toBe("low");
	});

	it("prefers the user's complexity over OPENAI_IMAGE_COMPLEXITY and notes it", async () => {
		mocks.config.OPENAI_IMAGE_COMPLEXITY = "high";
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		const c = ctx({});
		(c as unknown as { imageComplexity: string }).imageComplexity = "low";
		const updates = await collect(c);
		expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).complexity).toBe("low");
		const last = updates[updates.length - 1] as { text: string };
		expect(last.text).toContain("复杂度 low");
	});

	it("sends complexity on edits too", async () => {
		mocks.downloadFile.mockResolvedValue({
			type: "base64",
			value: PNG_B64,
			mime: "image/png",
			name: "x",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		const c = ctx({ files: [{ type: "hash", value: "sha-a", mime: "image/png", name: "a.png" }] });
		(c as unknown as { imageComplexity: string }).imageComplexity = "medium";
		await collect(c);
		expect((mocks.fetch.mock.calls[0][1].body as FormData).get("complexity")).toBe("medium");
	});

	it("drops unknown optional values instead of sending them", async () => {
		Object.assign(mocks.config, {
			OPENAI_IMAGE_QUALITY: "ultra",
			OPENAI_IMAGE_COMPLEXITY: "max",
			OPENAI_IMAGE_MODERATION: "off",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		await collect(ctx({}));
		const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
		expect(body).not.toHaveProperty("quality");
		expect(body).not.toHaveProperty("complexity");
		expect(body).not.toHaveProperty("moderation");
	});

	it("uses /images/edits with image[] parts when the user attached images", async () => {
		mocks.downloadFile.mockResolvedValue({
			type: "base64",
			value: PNG_B64,
			mime: "image/png",
			name: "x",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		await collect(
			ctx({
				content: "make it blue",
				imageSize: "4K",
				imageAspect: "1:1",
				files: [
					{ type: "hash", value: "sha-a", mime: "image/png", name: "a.png" },
					{ type: "hash", value: "sha-b", mime: "image/png", name: "b.png" },
				],
			})
		);
		const [url, init] = mocks.fetch.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/images/edits");
		const form = init.body as FormData;
		expect(form.get("model")).toBe("gpt-image-2.6-sunburst");
		expect(form.get("prompt")).toBe("make it blue");
		expect(form.get("size")).toBe("2880x2880");
		expect(form.getAll("image[]")).toHaveLength(2);
		expect(init.headers["Content-Type"]).toBeUndefined();
		expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
	});

	it("puts long pasted text (clipboard attachment) in front of the typed prompt", async () => {
		mocks.downloadFile.mockResolvedValue({
			type: "base64",
			value: Buffer.from("a very long pasted scene description").toString("base64"),
			mime: "application/vnd.chatui.clipboard",
			name: "clip",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		const c = ctx({ content: "watercolor style" });
		const user = (c as unknown as { messages: Array<{ files?: unknown[] }> }).messages[2];
		user.files = [
			{ type: "hash", value: "sha-clip", mime: "application/vnd.chatui.clipboard", name: "clip" },
			{ type: "hash", value: "sha-doc", mime: "text/plain", name: "notes.txt" },
		];
		const updates = await collect(c);
		const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
		expect(body.prompt).toBe("a very long pasted scene description\n\nwatercolor style");
		expect((updates[updates.length - 1] as { text: string }).text).toContain(
			"1 个非图片附件未发送"
		);
	});

	it("does not send moderation on edits", async () => {
		mocks.config.OPENAI_IMAGE_MODERATION = "low";
		mocks.downloadFile.mockResolvedValue({
			type: "base64",
			value: PNG_B64,
			mime: "image/png",
			name: "x",
		});
		mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		await collect(
			ctx({ files: [{ type: "hash", value: "sha-a", mime: "image/png", name: "a.png" }] })
		);
		expect((mocks.fetch.mock.calls[0][1].body as FormData).get("moderation")).toBeNull();
	});

	it("shows the cause of a network failure instead of just 'fetch failed'", async () => {
		mocks.fetch.mockRejectedValue(
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			})
		);
		const updates = await collect(ctx({}));
		expect((updates[0] as { text: string }).text).toContain("ECONNREFUSED");
	});

	it("reports a missing attachment readably", async () => {
		mocks.downloadFile.mockRejectedValue({ status: 404, body: { message: "File not found" } });
		const updates = await collect(
			ctx({ files: [{ type: "hash", value: "sha-gone", mime: "image/png", name: "a.png" }] })
		);
		expect((updates[0] as { text: string }).text).toBe("生图失败：404 File not found");
	});

	describe("markup-guided edits", () => {
		async function png(width: number, height: number, alpha = false) {
			return sharp({
				create: {
					width,
					height,
					channels: alpha ? 4 : 3,
					background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 10, g: 20, b: 30 },
				},
			})
				.png()
				.toBuffer();
		}
		function serve(files: Record<string, Buffer>, mime = "image/png") {
			mocks.downloadFile.mockImplementation(async (sha: string) => ({
				type: "base64",
				value: files[sha].toString("base64"),
				mime,
				name: sha,
			}));
		}
		async function partSize(part: FormDataEntryValue | null) {
			const buf = Buffer.from(await (part as Blob).arrayBuffer());
			const meta = await sharp(buf).metadata();
			return [meta.width, meta.height, meta.hasAlpha];
		}

		it("sends the layer as markup, edits the marked image first, and scales the layer to it", async () => {
			const other = await png(64, 48);
			const target = await png(96, 64);
			serve({ "sha-other": other, "sha-target": target, "sha-markup": await png(48, 32, true) });
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));

			const updates = await collect(
				ctx({
					content: "recolor the circled vase",
					files: [
						{ type: "hash", value: "sha-other", mime: "image/png", name: "other.png" },
						{ type: "hash", value: "sha-target", mime: "image/png", name: "vase.png" },
						{
							type: "hash",
							value: "sha-markup",
							mime: "image/png",
							name: markupFileNameFor("vase.png"),
						},
					],
				})
			);

			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			const images = form.getAll("image[]");
			expect(images).toHaveLength(2);
			// the marked image (96x64) goes first even though it was attached second
			expect(await partSize(images[0])).toEqual([96, 64, false]);
			expect(await partSize(images[1])).toEqual([64, 48, false]);
			expect(await partSize(form.get("markup"))).toEqual([96, 64, true]);
			expect(form.get("mask")).toBeNull();
			expect((updates[updates.length - 1] as { text: string }).text).toContain("已按标记编辑");
		});

		it("applies EXIF orientation so the layer lines up with what the browser showed", async () => {
			// stored 80x40 with orientation 6 (rotate 90°): the browser shows 40x80
			const photo = await sharp({
				create: { width: 80, height: 40, channels: 3, background: { r: 200, g: 0, b: 0 } },
			})
				.jpeg()
				.withMetadata({ orientation: 6 })
				.toBuffer();
			mocks.downloadFile.mockImplementation(async (sha: string) =>
				sha === "sha-photo"
					? { type: "base64", value: photo.toString("base64"), mime: "image/jpeg", name: sha }
					: {
							type: "base64",
							value: (await png(40, 80, true)).toString("base64"),
							mime: "image/png",
							name: sha,
						}
			);
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));

			await collect(
				ctx({
					files: [
						{ type: "hash", value: "sha-photo", mime: "image/jpeg", name: "photo.jpg" },
						{
							type: "hash",
							value: "sha-m",
							mime: "image/png",
							name: markupFileNameFor("photo.jpg"),
						},
					],
				})
			);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			const [w, h] = await partSize(form.get("image[]"));
			expect([w, h]).toEqual([40, 80]);
			expect(await partSize(form.get("markup"))).toEqual([40, 80, true]);
		});

		it("refuses a layer whose image is not in the message", async () => {
			serve({ "sha-other": await png(64, 48) });
			const updates = await collect(
				ctx({
					files: [
						{ type: "hash", value: "sha-other", mime: "image/png", name: "other.png" },
						{
							type: "hash",
							value: "sha-m",
							mime: "image/png",
							name: markupFileNameFor("gone.png"),
						},
					],
				})
			);
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect((updates[0] as { text: string }).text).toContain("找不到标记图层");
		});
	});

	it("turns an API error into a readable answer without storing anything", async () => {
		mocks.fetch.mockResolvedValue({
			ok: false,
			status: 400,
			text: async () =>
				JSON.stringify({ error: { message: "blocked", code: "moderation_blocked" } }),
		});
		const updates = await collect(ctx({}));
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(updates).toHaveLength(1);
		expect((updates[0] as { text: string }).text).toContain("安全审核");
	});

	it("does not call the API without a key or without a prompt", async () => {
		delete mocks.config.OPENAI_IMAGE_API_KEY;
		const noKey = await collect(ctx({}));
		expect((noKey[0] as { text: string }).text).toContain("OPENAI_IMAGE_API_KEY");

		mocks.config.OPENAI_IMAGE_API_KEY = "sk-test";
		const noPrompt = await collect(ctx({ content: "   " }));
		expect((noPrompt[0] as { text: string }).text).toContain("描述");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("emits nothing when the user stops the request", async () => {
		const c = ctx({});
		mocks.fetch.mockImplementation(async () => {
			c.abortController.abort();
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		});
		expect(await collect(c)).toEqual([]);
	});
});
