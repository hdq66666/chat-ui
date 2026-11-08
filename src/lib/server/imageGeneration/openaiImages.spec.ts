import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import { CHAIN_EDIT_PREAMBLE, markupFileNameFor, markupTargetNameFor } from "$lib/imageGeneration";
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

	it("sends moderation on edits too (documented for /images/edits)", async () => {
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
		expect((mocks.fetch.mock.calls[0][1].body as FormData).get("moderation")).toBe("low");
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
						{
							type: "hash",
							value: "sha-target",
							mime: "image/png",
							name: markupTargetNameFor("aaaaaaaaaaaa", "vase.png"),
						},
						{
							type: "hash",
							value: "sha-markup",
							mime: "image/png",
							name: markupFileNameFor("aaaaaaaaaaaa"),
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
						{
							type: "hash",
							value: "sha-photo",
							mime: "image/jpeg",
							name: markupTargetNameFor("cccccccccccc", "photo.jpg"),
						},
						{
							type: "hash",
							value: "sha-m",
							mime: "image/png",
							name: markupFileNameFor("cccccccccccc"),
						},
					],
				})
			);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			const [w, h] = await partSize(form.get("image[]"));
			expect([w, h]).toEqual([40, 80]);
			expect(await partSize(form.get("markup"))).toEqual([40, 80, true]);
		});

		it("pairs by tag when names collide and when HEIC was stored as .jpg", async () => {
			const first = await png(64, 48);
			const marked = await png(96, 64);
			serve({ "sha-1": first, "sha-2": marked, "sha-m": await png(48, 32, true) });
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			await collect(
				ctx({
					files: [
						// two pasted screenshots are both called image.png
						{ type: "hash", value: "sha-1", mime: "image/png", name: "image.png" },
						// the marked one: uploaded as mk-<tag>-IMG_1.HEIC, stored as .jpg
						{
							type: "hash",
							value: "sha-2",
							mime: "image/png",
							name: markupTargetNameFor("eeeeeeeeeeee", "IMG_1.jpg"),
						},
						{
							type: "hash",
							value: "sha-m",
							mime: "image/png",
							name: markupFileNameFor("eeeeeeeeeeee"),
						},
					],
				})
			);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			expect(await partSize(form.getAll("image[]")[0])).toEqual([96, 64, false]);
			expect(await partSize(form.get("markup"))).toEqual([96, 64, true]);
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
							name: markupFileNameFor("dddddddddddd"),
						},
					],
				})
			);
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect((updates[0] as { text: string }).text).toContain("找不到标记图层");
		});
	});

	describe("continuing from the previous image", () => {
		async function png(width: number, height: number) {
			return sharp({
				create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } },
			})
				.png()
				.toBuffer();
		}
		function chainCtx(opts: { fresh?: boolean; prevReply?: boolean } = {}) {
			return {
				model: { id: "gpt-image-2.6-flare", imageGeneration: true },
				conv: { _id: new ObjectId() },
				messages: [
					{ from: "system", id: "s", content: "" },
					{ from: "user", id: "u0", content: "draw a room" },
					{
						from: "assistant",
						id: "a0",
						content: "已生成",
						files: [{ type: "hash", value: "sha-out", mime: "image/png", name: "out.png" }],
					},
					...(opts.prevReply === false
						? []
						: [
								{ from: "user", id: "u1", content: "something" },
								{ from: "assistant", id: "a1", content: "生图失败：…" },
							]),
					{
						from: "user",
						id: "u2",
						content: "提高分辨率",
						...(opts.fresh ? { imageFresh: true } : {}),
					},
				],
				abortController: new AbortController(),
				imageSize: "2K",
				imageAspect: "1:1",
			} as unknown as TextGenerationContext;
		}

		it("edits the latest output, keeps its aspect at the chosen tier, and says so", async () => {
			const out = await png(1536, 864);
			mocks.downloadFile.mockImplementation(async (sha: string) => ({
				type: "base64",
				value: out.toString("base64"),
				mime: "image/png",
				name: sha,
			}));
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			const updates = await collect(chainCtx());

			expect(mocks.downloadFile).toHaveBeenCalledWith("sha-out", expect.anything());
			const [url, init] = mocks.fetch.mock.calls[0];
			expect(url).toBe("https://api.openai.com/v1/images/edits");
			const form = init.body as FormData;
			expect(form.getAll("image[]")).toHaveLength(1);
			// 2K tier from the setting, 16:9 from the source image (setting says 1:1)
			expect(form.get("size")).toBe("2048x1152");
			const prompt = String(form.get("prompt"));
			// the failed turn ("something") is left out; the request that made the image is carried
			expect(prompt).toContain("Original request:\ndraw a room");
			expect(prompt).not.toContain("something");
			expect(prompt).toContain("Now apply this edit to image 1:\n提高分辨率");
			const text = (updates[updates.length - 1] as { text: string }).text;
			expect(text).toContain("基于上一张图编辑（1536x864 → 2048x1152）");
			expect(text).toContain("比例沿用上一张图（16:9）");
		});

		it("keeps the old preamble when the previous image has no history to carry", async () => {
			const out = await png(1024, 1024);
			mocks.downloadFile.mockResolvedValue({
				type: "base64",
				value: out.toString("base64"),
				mime: "image/png",
				name: "x",
			});
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			const c = chainCtx({ prevReply: false });
			(c.messages[1] as { content: string }).content = "";
			await collect(c);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			expect(form.get("prompt")).toBe(`${CHAIN_EDIT_PREAMBLE}\n\n提高分辨率`);
		});

		async function serveImages(sizes: Record<string, number>) {
			const files: Record<string, Buffer> = {};
			for (const [sha, w] of Object.entries(sizes)) files[sha] = await png(w, w);
			files.layer = await sharp({
				create: {
					width: 1024,
					height: 1024,
					channels: 4,
					background: { r: 0, g: 0, b: 0, alpha: 0 },
				},
			})
				.png()
				.toBuffer();
			mocks.downloadFile.mockImplementation(async (sha: string) => ({
				type: "base64",
				value: files[sha].toString("base64"),
				mime: "image/png",
				name: sha,
			}));
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
		}
		const hf = (value: string, name: string) => ({ type: "hash", value, mime: "image/png", name });
		async function widths(form: FormData) {
			return Promise.all(
				form
					.getAll("image[]")
					.map(
						async (part) =>
							(await sharp(Buffer.from(await (part as Blob).arrayBuffer())).metadata()).width
					)
			);
		}

		it("keeps the history when a blocked markup edit is followed by a plain message", async () => {
			await serveImages({ char: 512, o1: 1024 });
			await collect({
				model: { id: "gpt-image-2.6-sunburst", imageGeneration: true },
				conv: { _id: new ObjectId() },
				messages: [
					{
						from: "user",
						id: "u0",
						content: "chibi avatar, white background",
						files: [hf("char", "char.png")],
					},
					{ from: "assistant", id: "a0", content: "已编辑", files: [hf("o1", "out.png")] },
					{
						from: "user",
						id: "u1",
						content: "Numbered marks on the markup layer:\n1. 被拦下的标记",
						files: [
							hf("o1", markupTargetNameFor("eeeeeeeeeeee", "out.png")),
							hf("layer", markupFileNameFor("eeeeeeeeeeee")),
						],
					},
					{ from: "assistant", id: "a1", content: "生图失败" },
					{ from: "user", id: "u2", content: "眼睛更生动" },
				],
				abortController: new AbortController(),
				imageSize: "1K",
				imageAspect: "1:1",
			} as unknown as TextGenerationContext);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			// the copy of o1 is edited first, the original upload follows as the source picture
			expect(await widths(form)).toEqual([1024, 512]);
			const prompt = String(form.get("prompt"));
			expect(prompt).toContain("Original request:\nchibi avatar, white background");
			expect(prompt).not.toContain("被拦下的标记");
			expect(prompt).toContain("Now apply this edit to image 1:\n眼睛更生动");
		});

		it("does not call a plain reference 'the original picture' when the original was re-attached", async () => {
			await serveImages({ char: 512, ref: 256, o1: 1024 });
			await collect({
				model: { id: "gpt-image-2.6-sunburst", imageGeneration: true },
				conv: { _id: new ObjectId() },
				messages: [
					{
						from: "user",
						id: "u0",
						content: "像第二张图那样笑",
						files: [hf("char", "char.png"), hf("ref", "ref.png")],
					},
					{ from: "assistant", id: "a0", content: "已编辑", files: [hf("o1", "out.png")] },
					{
						from: "user",
						id: "u1",
						content: "Numbered marks on the markup layer:\n1. 鼻子按原图",
						files: [
							hf("char", "char.png"),
							hf("o1", markupTargetNameFor("ffffffffffff", "out.png")),
							hf("layer", markupFileNameFor("ffffffffffff")),
						],
					},
				],
				abortController: new AbortController(),
				imageSize: "1K",
				imageAspect: "1:1",
			} as unknown as TextGenerationContext);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			expect(await widths(form)).toEqual([1024, 512, 256]); // marked output, re-attached original, ref
			const prompt = String(form.get("prompt"));
			expect(prompt).toContain("Image 2 is attached with the new instruction.");
			expect(prompt).toContain("Image 3 is a reference image from the original request.");
			expect(prompt).not.toContain("original picture the first version was made from");
			expect(prompt).not.toContain("in the same order");
		});

		it("numbers a new attachment before the original uploads in a markup edit", async () => {
			const files: Record<string, Buffer> = {
				char: await png(512, 512),
				o1: await png(1024, 1024),
				hat: await png(300, 300),
				layer: await sharp({
					create: {
						width: 1024,
						height: 1024,
						channels: 4,
						background: { r: 0, g: 0, b: 0, alpha: 0 },
					},
				})
					.png()
					.toBuffer(),
			};
			mocks.downloadFile.mockImplementation(async (sha: string) => ({
				type: "base64",
				value: files[sha].toString("base64"),
				mime: "image/png",
				name: sha,
			}));
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			const h = (value: string, name: string) => ({ type: "hash", value, mime: "image/png", name });
			await collect({
				model: { id: "gpt-image-2.6-sunburst", imageGeneration: true },
				conv: { _id: new ObjectId() },
				messages: [
					{
						from: "user",
						id: "u0",
						content: "chibi avatar, white background",
						files: [h("char", "char.png")],
					},
					{ from: "assistant", id: "a0", content: "已编辑", files: [h("o1", "out.png")] },
					{
						from: "user",
						id: "u1",
						content: "Numbered marks on the markup layer:\n1. 戴上附图的帽子",
						files: [
							h("hat", "hat.png"),
							h("o1", markupTargetNameFor("dddddddddddd", "out.png")),
							h("layer", markupFileNameFor("dddddddddddd")),
						],
					},
				],
				abortController: new AbortController(),
				imageSize: "1K",
				imageAspect: "1:1",
			} as unknown as TextGenerationContext);
			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			const sizes = await Promise.all(
				form
					.getAll("image[]")
					.map(
						async (part) =>
							(await sharp(Buffer.from(await (part as Blob).arrayBuffer())).metadata()).width
					)
			);
			expect(sizes).toEqual([1024, 300, 512]); // marked output, the new hat, the original upload
			const prompt = String(form.get("prompt"));
			expect(prompt).toContain("Image 2 is attached with the new instruction.");
			expect(prompt).toContain("Image 3 is the original picture the first version was made from");
		});

		it("carries the whole history and the original uploads when marking an earlier output", async () => {
			const files: Record<string, Buffer> = {
				char: await png(512, 512),
				ref: await png(256, 256),
				o1: await png(1024, 1024),
				layer: await sharp({
					create: {
						width: 1024,
						height: 1024,
						channels: 4,
						background: { r: 0, g: 0, b: 0, alpha: 0 },
					},
				})
					.png()
					.toBuffer(),
			};
			mocks.downloadFile.mockImplementation(async (sha: string) => ({
				type: "base64",
				value: files[sha].toString("base64"),
				mime: "image/png",
				name: sha,
			}));
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			const h = (value: string, name: string) => ({ type: "hash", value, mime: "image/png", name });
			const c = {
				model: { id: "gpt-image-2.6-sunburst", imageGeneration: true },
				conv: { _id: new ObjectId() },
				messages: [
					{ from: "system", id: "s", content: "" },
					{
						from: "user",
						id: "u0",
						content: "a flag in the left hand, white background",
						files: [h("char", "char.png"), h("ref", "ref.png")],
					},
					{ from: "assistant", id: "a0", content: "已编辑", files: [h("o1", "out.png")] },
					{
						from: "user",
						id: "u1",
						content: "Numbered marks on the markup layer:\n1. 描边太粗",
						files: [
							h("o1", markupTargetNameFor("bbbbbbbbbbbb", "out.png")),
							h("layer", markupFileNameFor("bbbbbbbbbbbb")),
						],
					},
				],
				abortController: new AbortController(),
				imageSize: "1K",
				imageAspect: "1:1",
			} as unknown as TextGenerationContext;
			const updates = await collect(c);

			const form = mocks.fetch.mock.calls[0][1].body as FormData;
			const images = form.getAll("image[]");
			expect(images).toHaveLength(3); // the marked output first, then the two original uploads
			const sizes = await Promise.all(
				images.map(
					async (part) =>
						(await sharp(Buffer.from(await (part as Blob).arrayBuffer())).metadata()).width
				)
			);
			expect(sizes).toEqual([1024, 512, 256]);
			expect(form.get("markup")).not.toBeNull();
			const prompt = String(form.get("prompt"));
			expect(prompt).toContain("Image 2 is the original picture the first version was made from");
			expect(prompt).toContain("Image 3 is a reference image from the original request.");
			expect(prompt).toContain("Original request:\na flag in the left hand, white background");
			expect(prompt).toContain(
				"Now apply this edit to image 1:\nNumbered marks on the markup layer:\n1. 描边太粗"
			);
			const text = (updates[updates.length - 1] as { text: string }).text;
			expect(text).toContain("已带上之前 1 轮的要求和最初的 2 张参考图");
		});

		it("generates from scratch when the user message asks for a new image", async () => {
			mocks.fetch.mockResolvedValue(okResponse({ data: [{ b64_json: PNG_B64 }] }));
			await collect(chainCtx({ fresh: true }));
			expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/generations");
			expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).prompt).toBe("提高分辨率");
			expect(mocks.downloadFile).not.toHaveBeenCalled();
		});
	});

	it("explains a moderation block and where it happened, without retrying", async () => {
		mocks.fetch.mockResolvedValue({
			ok: false,
			status: 400,
			text: async () =>
				JSON.stringify({
					error: {
						message: "Your request was rejected by the safety system.",
						code: "moderation_blocked",
						moderation_details: { moderation_stage: "output" },
					},
				}),
		});
		const updates = await collect(ctx({ content: "cat" }));
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const text = (updates[0] as { text: string }).text;
		expect(text).toContain("拦截发生在生成结果上");
		expect(text).toContain("从零生成时提示词太短");
		expect(text).toContain("OpenAI 原文：Your request was rejected by the safety system.");
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
