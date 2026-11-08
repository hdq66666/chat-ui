import { describe, expect, it } from "vitest";
import {
	IMAGE_ASPECTS,
	IMAGE_COMPLEXITIES,
	IMAGE_DIMENSIONS,
	IMAGE_MAX_PIXELS,
	IMAGE_SIZE_TIERS,
	imageSizeViolation,
	findChainSource,
	formatMarkupNotes,
	nearestImageAspect,
	isImageComplexity,
	isMarkupFileName,
	markupFileNameFor,
	markupTagOf,
	markupTagOfTarget,
	markupTargetNameFor,
	newMarkupTag,
	resolveImageDimensions,
	traceEditLineage,
	formatEditContext,
	lineageTurns,
	MARKUP_NOTES_HEADER,
	type LineageMessage,
} from "./imageGeneration";

describe("image size tiers", () => {
	it("every tier and aspect satisfies the OpenAI GPT Image 2.6 size rules", () => {
		for (const tier of IMAGE_SIZE_TIERS) {
			for (const aspect of IMAGE_ASPECTS) {
				const [w, h] = IMAGE_DIMENSIONS[tier][aspect];
				expect(imageSizeViolation(w, h), `${tier} ${aspect} ${w}x${h}`).toBeNull();
			}
		}
	});

	it("each aspect entry matches its named ratio within 0.5%", () => {
		for (const tier of IMAGE_SIZE_TIERS) {
			for (const aspect of IMAGE_ASPECTS) {
				const [a, b] = aspect.split(":").map(Number);
				const [w, h] = IMAGE_DIMENSIONS[tier][aspect];
				expect(Math.abs(w / h / (a / b) - 1)).toBeLessThan(0.005);
			}
		}
	});

	it("tiers grow 1K < 2K < 4K for every aspect", () => {
		for (const aspect of IMAGE_ASPECTS) {
			const px = IMAGE_SIZE_TIERS.map(
				(t) => IMAGE_DIMENSIONS[t][aspect][0] * IMAGE_DIMENSIONS[t][aspect][1]
			);
			expect(px[0]).toBeLessThan(px[1]);
			expect(px[1]).toBeLessThan(px[2]);
		}
	});

	it("matches the sizes the OpenAI guide names 2K and 4K", () => {
		expect(IMAGE_DIMENSIONS["2K"]["1:1"]).toEqual([2048, 2048]);
		expect(IMAGE_DIMENSIONS["2K"]["16:9"]).toEqual([2048, 1152]);
		expect(IMAGE_DIMENSIONS["4K"]["9:16"]).toEqual([2160, 3840]);
	});

	it("4K uses the full pixel budget for 16:9 and 1:1", () => {
		expect(IMAGE_DIMENSIONS["4K"]["16:9"]).toEqual([3840, 2160]);
		expect(3840 * 2160).toBe(IMAGE_MAX_PIXELS);
		expect(2880 * 2880).toBe(IMAGE_MAX_PIXELS);
	});

	it("rejects sizes outside the rules", () => {
		expect(imageSizeViolation(4096, 4096)).not.toBeNull();
		expect(imageSizeViolation(1000, 1000)).not.toBeNull(); // not a multiple of 16
		expect(imageSizeViolation(3840, 1024)).not.toBeNull(); // ratio > 3:1
		expect(imageSizeViolation(512, 512)).not.toBeNull(); // too few pixels
	});

	it("recognises only the documented complexity values", () => {
		expect(IMAGE_COMPLEXITIES).toEqual(["low", "medium", "high"]);
		expect(isImageComplexity("medium")).toBe(true);
		expect(isImageComplexity("max")).toBe(false);
		expect(isImageComplexity(undefined)).toBe(false);
	});

	it("pairs a markup layer with its image through a shared tag", () => {
		const tag = newMarkupTag();
		expect(tag).toMatch(/^[0-9a-f]{12}$/);
		const layer = markupFileNameFor(tag);
		expect(isMarkupFileName(layer)).toBe(true);
		expect(markupTagOf(layer)).toBe(tag);
		expect(markupTagOf("photo.png")).toBeUndefined();

		const target = markupTargetNameFor(tag, "IMG_0001.HEIC");
		expect(target).toBe(`mk-${tag}-IMG_0001.HEIC`);
		// the server stores HEIC as .jpg; the tag is a prefix, so it survives
		expect(markupTagOfTarget(target.replace(/\.HEIC$/, ".jpg"))).toBe(tag);
		// marking the same image again replaces the tag instead of stacking it
		expect(markupTargetNameFor("bbbbbbbbbbbb", target)).toBe("mk-bbbbbbbbbbbb-IMG_0001.HEIC");
		expect(markupTagOfTarget("image.png")).toBeUndefined();
	});

	it("formats markup notes numbered like the badges", () => {
		expect(formatMarkupNotes(["make it blue", "  ", "remove\nthis"])).toBe(
			"Numbered marks on the markup layer:\n1. make it blue\n2. remove\n   this"
		);
		expect(formatMarkupNotes([" "])).toBeUndefined();
	});

	describe("findChainSource", () => {
		const img = (name: string) => ({ name, mime: "image/png" });
		it("picks the latest assistant image", () => {
			const prior = [
				{ from: "system" },
				{ from: "user", files: [img("upload.jpg")] },
				{ from: "assistant", files: [img("out-1.png")] },
				{ from: "user" },
				{ from: "assistant", files: [img("out-2.png")] },
			];
			expect(findChainSource(prior)).toEqual({ index: 4, file: img("out-2.png") });
		});
		it("skips replies without an image (errors, aborts)", () => {
			const prior = [
				{ from: "user" },
				{ from: "assistant", files: [img("out-1.png")] },
				{ from: "user" },
				{ from: "assistant" },
			];
			expect(findChainSource(prior)?.file.name).toBe("out-1.png");
		});
		it("prefers the last upload when its turn produced no image", () => {
			const prior = [
				{ from: "user" },
				{ from: "assistant", files: [img("out-1.png")] },
				{ from: "user", files: [img("new-upload.jpg")] },
				{ from: "assistant" },
			];
			expect(findChainSource(prior)?.file.name).toBe("new-upload.jpg");
		});
		it("does not reach back to an older upload shown to a chat model", () => {
			const prior = [
				{ from: "user", files: [img("screenshot.png")] },
				{ from: "assistant" },
				{ from: "user" },
				{ from: "assistant" },
			];
			expect(findChainSource(prior)).toBeUndefined();
		});
		it("never carries a markup layer and ignores non-images", () => {
			const prior = [
				{
					from: "user",
					files: [img("chatui-markup-aaaaaaaaaaaa.png"), { name: "a.txt", mime: "text/plain" }],
				},
				{ from: "assistant" },
			];
			expect(findChainSource(prior)).toBeUndefined();
		});
	});

	it("snaps to the nearest aspect", () => {
		expect(nearestImageAspect(1536, 864)).toBe("16:9");
		expect(nearestImageAspect(1024, 1024)).toBe("1:1");
		expect(nearestImageAspect(600, 400)).toBe("3:2");
		expect(nearestImageAspect(1170, 2532)).toBe("9:16");
	});

	it("falls back to 1K 1:1 for missing or unknown values", () => {
		expect(resolveImageDimensions(undefined, undefined).size).toBe("1024x1024");
		expect(resolveImageDimensions("8K", "7:5").size).toBe("1024x1024");
		expect(resolveImageDimensions("2K", "16:9").size).toBe("2048x1152");
	});
});

describe("multi-turn edit context", () => {
	const img = (value: string, name = `${value}.png`) => ({ name, mime: "image/png", value });
	const out = (value: string) => img(value, "gpt-image-2.6-sunburst-2048x2048.png");
	const notes = (...n: string[]) =>
		`${MARKUP_NOTES_HEADER}\n${n.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;

	// a typical line: upload two images + request -> output -> markup on that output -> output
	const conversation: LineageMessage[] = [
		{ from: "system", content: "" },
		{
			from: "user",
			content: "make the mascot smile, a flag in its left hand, white background",
			files: [img("char"), img("ref")],
		},
		{ from: "assistant", content: "已编辑", files: [out("o1")] },
		{
			from: "user",
			content: notes("no red cape", "thinner lines"),
			files: [
				img("o1", "mk-aaaaaaaaaaaa-out.png"),
				img("layer1", markupFileNameFor("aaaaaaaaaaaa")),
			],
		},
		{ from: "assistant", content: "已按标记编辑", files: [out("o2")] },
	];

	it("walks back from the edited image to the original request and its uploads", () => {
		const lineage = traceEditLineage(conversation, 4);
		expect(lineage.root?.text).toContain("a flag in its left hand");
		expect(lineage.root?.references.map((f) => f.value)).toEqual(["char", "ref"]);
		expect(lineage.edits).toEqual([
			{
				index: 3,
				text: "Notes for marks drawn on an earlier version:\n1. no red cape\n2. thinner lines",
				markup: true,
			},
		]);
		expect(lineageTurns(lineage)).toBe(2);
	});

	it("skips failed turns and follows plain follow-ups (no attachment) back through the chain", () => {
		const msgs: LineageMessage[] = [
			...conversation,
			{ from: "user", content: "被拦下的那句" },
			{ from: "assistant", content: "生图失败" },
			{ from: "user", content: "眼睛更生动" },
			{ from: "assistant", content: "基于上一张图编辑", files: [out("o3")] },
		];
		const lineage = traceEditLineage(msgs, 8);
		expect(lineage.root?.index).toBe(1);
		expect(lineage.edits.map((e) => e.text)).toEqual([
			"Notes for marks drawn on an earlier version:\n1. no red cape\n2. thinner lines",
			"眼睛更生动",
		]);
	});

	it("starts a new line at a 'new image' turn or a fresh upload", () => {
		const fresh: LineageMessage[] = [
			...conversation,
			{ from: "user", content: "画一只猫", imageFresh: true },
			{ from: "assistant", content: "已生成", files: [out("cat")] },
		];
		expect(traceEditLineage(fresh, 6)).toEqual({
			root: { index: 5, text: "画一只猫", references: [] },
			edits: [],
		});
		const upload: LineageMessage[] = [
			...conversation,
			{ from: "user", content: "把这张图调亮", files: [img("photo")] },
			{ from: "assistant", content: "已编辑", files: [out("bright")] },
		];
		expect(traceEditLineage(upload, 6).edits).toEqual([]);
		expect(traceEditLineage(upload, 6).root?.references.map((f) => f.value)).toEqual(["photo"]);
	});

	it("keeps the root and the latest edits when the history is long", () => {
		const lineage = {
			root: { index: 1, text: "原始需求", references: [] },
			edits: Array.from({ length: 30 }, (_, i) => ({
				index: i,
				text: `第 ${i + 1} 次修改 ${"x".repeat(80)}`,
				markup: false,
			})),
		};
		const prompt = formatEditContext(lineage, "现在这句", { references: 0, maxChars: 1000 }) ?? "";
		expect(prompt).toContain("Original request:\n原始需求");
		expect(prompt).toMatch(/\(\d+ earlier edits omitted\)/);
		expect(prompt).toContain("第 30 次修改");
		expect(prompt).not.toContain("第 1 次修改");
		expect(prompt).toContain("Now apply this edit to image 1:\n现在这句");
	});

	it("names the image roles and returns nothing when there is no history to add", () => {
		const prompt = formatEditContext(traceEditLineage(conversation, 4), "眼睛更生动", {
			references: 2,
		});
		expect(prompt).toContain("Image 1 is the current version");
		expect(prompt).toContain("Images 2-3 are reference images from the original request.");
		expect(prompt?.indexOf("Original request")).toBeLessThan(
			prompt?.indexOf("Edits already made") ?? 0
		);
		expect(prompt).toContain("Later instructions override earlier ones.");
		expect(formatEditContext({ edits: [] }, "x", { references: 0 })).toBeUndefined();
	});
});
