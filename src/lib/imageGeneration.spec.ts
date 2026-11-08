import { describe, expect, it } from "vitest";
import {
	IMAGE_ASPECTS,
	IMAGE_COMPLEXITIES,
	IMAGE_QUALITIES,
	isImageQuality,
	imageOutputTokens,
	sizeCostMultiplier,
	qualityCostMultiplier,
	formatCostMultiplier,
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
	resolveImageSource,
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

	it("offers the quality values GPT Image 2.6 accepts", () => {
		// the cost calculator lists all five for 2.6; the API accepts xhigh and max too
		expect(IMAGE_QUALITIES).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(isImageQuality("xhigh")).toBe(true);
		expect(isImageQuality("auto")).toBe(false);
		expect(isImageQuality("ultra")).toBe(false);
		expect(isImageQuality(undefined)).toBe(false);
	});

	it("estimates cost multipliers from the official calculator's token table", () => {
		// every size in the menu has a row
		for (const tier of IMAGE_SIZE_TIERS) {
			for (const aspect of IMAGE_ASPECTS) {
				for (const q of IMAGE_QUALITIES)
					expect(imageOutputTokens(tier, aspect, q)).toBeGreaterThan(0);
			}
		}
		expect(imageOutputTokens("1K", "1:1", "low")).toBe(823);
		expect(imageOutputTokens("4K", "16:9", "max")).toBe(13342);
		// no quality picked (auto) is estimated as medium
		expect(imageOutputTokens("2K", "1:1", undefined)).toBe(2944);
		expect(formatCostMultiplier(sizeCostMultiplier("4K", "1:1", undefined) ?? 0)).toBe("3×");
		expect(formatCostMultiplier(sizeCostMultiplier("4K", "16:9", "medium") ?? 0)).toBe("3×");
		expect(sizeCostMultiplier("1K", "3:2", "high")).toBe(1);
		expect(formatCostMultiplier(qualityCostMultiplier("high", "1K", "1:1") ?? 0)).toBe("2×");
		expect(formatCostMultiplier(qualityCostMultiplier("max", "1K", "1:1") ?? 0)).toBe("9×");
		expect(formatCostMultiplier(qualityCostMultiplier("xhigh", "1K", "1:1") ?? 0)).toBe("4×");
		expect(formatCostMultiplier(0.4)).toBe("1×");
		expect(formatCostMultiplier(2)).toBe("2×");
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
	const marked = (value: string, tag: string) => [
		img(value, `mk-${tag}-out.png`),
		img(`layer-${tag}`, markupFileNameFor(tag)),
	];

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
			files: marked("o1", "aaaaaaaaaaaa"),
		},
		{ from: "assistant", content: "已按标记编辑", files: [out("o2")] },
	];
	const firstMarkup =
		"Notes for marks drawn on an earlier version:\n1. no red cape\n2. thinner lines";

	it("walks back from the edited image to the original request and its uploads", () => {
		const lineage = traceEditLineage(conversation, 4);
		expect(lineage.root?.text).toContain("a flag in its left hand");
		expect(lineage.root?.references.map((f) => f.value)).toEqual(["char", "ref"]);
		expect(lineage.root?.editedFirst).toBe(true);
		expect(lineage.edits).toEqual([{ index: 3, text: firstMarkup, markup: true }]);
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
		expect(lineage.edits.map((e) => e.text)).toEqual([firstMarkup, "眼睛更生动"]);
	});

	it("keeps the line when a markup edit was blocked and the user then just types", () => {
		// mark o2 -> moderation blocks (no image) -> "fix it": the chain source is the unanswered
		// copy of o2 in the user message; it resolves back to the output and the walk goes on
		const msgs: LineageMessage[] = [
			...conversation,
			{ from: "user", content: notes("被拦下的标记"), files: marked("o2", "bbbbbbbbbbbb") },
			{ from: "assistant", content: "生图失败" },
		];
		const source = findChainSource(msgs);
		expect(source?.index).toBe(5);
		const resolved = resolveImageSource(msgs, source?.index ?? -1, source?.file.value);
		expect(resolved).toBe(4);
		const lineage = traceEditLineage(msgs, resolved);
		expect(lineage.root?.index).toBe(1);
		expect(lineage.edits.map((e) => e.text)).toEqual([firstMarkup]);

		// and one turn later the walk passes through the blocked turn without its text
		const later: LineageMessage[] = [
			...msgs,
			{ from: "user", content: "修一下" },
			{ from: "assistant", content: "基于上一张图编辑", files: [out("o3")] },
		];
		const next = traceEditLineage(later, 8);
		expect(next.root?.index).toBe(1);
		expect(next.edits.map((e) => e.text)).toEqual([firstMarkup, "修一下"]);
	});

	it("starts a new line at a 'new image' turn, a fresh upload, or markup on an upload", () => {
		const fresh: LineageMessage[] = [
			...conversation,
			{ from: "user", content: "画一只猫", imageFresh: true },
			{ from: "assistant", content: "已生成", files: [out("cat")] },
		];
		expect(traceEditLineage(fresh, 6)).toEqual({
			root: { index: 5, text: "画一只猫", references: [], editedFirst: false },
			edits: [],
		});
		const upload: LineageMessage[] = [
			...conversation,
			{ from: "user", content: "把这张图调亮", files: [img("photo")] },
			{ from: "assistant", content: "已编辑", files: [out("bright")] },
		];
		expect(traceEditLineage(upload, 6).edits).toEqual([]);
		expect(traceEditLineage(upload, 6).root?.references.map((f) => f.value)).toEqual(["photo"]);
		const markedUpload: LineageMessage[] = [
			{
				from: "user",
				content: notes("换成蓝色"),
				files: [img("hat"), ...marked("photo", "cccccccccccc")],
			},
			{ from: "assistant", content: "已按标记编辑", files: [out("blue")] },
		];
		const root = traceEditLineage(markedUpload, 1).root;
		// the marked upload is the picture that was edited, so it comes first
		expect(root?.references.map((f) => f.value)).toEqual(["photo", "hat"]);
		expect(root?.editedFirst).toBe(true);
		expect(root?.text).toBe("Notes for marks drawn on an earlier version:\n1. 换成蓝色");
	});

	it("keeps the root and the latest edits when the history is long", () => {
		const lineage = {
			root: { index: 1, text: "原始需求", references: [], editedFirst: false },
			edits: Array.from({ length: 30 }, (_, i) => ({
				index: i,
				text: `第 ${i + 1} 次修改 ${"x".repeat(80)}`,
				markup: false,
			})),
		};
		const ctx = formatEditContext(lineage, "现在这句", {
			attachments: 0,
			references: 0,
			maxChars: 1000,
		});
		expect(ctx?.prompt).toContain("Original request:\n原始需求");
		expect(ctx?.prompt).toMatch(/\(\d+ earlier edits omitted\)/);
		expect(ctx?.prompt).toContain("第 30 次修改");
		expect(ctx?.prompt).not.toContain("第 1 次修改");
		expect(ctx?.prompt).toContain("Now apply this edit to image 1:\n现在这句");
		// turns counts only what was actually carried
		expect(ctx?.turns).toBeLessThan(31);
		expect(ctx?.turns).toBe(1 + (ctx?.prompt.match(/第 \d+ 次修改/g)?.length ?? 0));
	});

	it("shortens the latest edit instead of dropping it when it alone is over budget", () => {
		const lineage = {
			root: { index: 1, text: "原始需求", references: [], editedFirst: false },
			edits: [
				{ index: 2, text: "早一点的修改", markup: false },
				{ index: 3, text: `最近的修改 ${"y".repeat(5000)}`, markup: false },
			],
		};
		const ctx = formatEditContext(lineage, "现在这句", {
			attachments: 0,
			references: 0,
			maxChars: 1000,
		});
		expect(ctx?.prompt).toContain("最近的修改");
		expect(ctx?.prompt).toContain("(1 earlier edit omitted)");
		expect(ctx?.prompt).toContain("2. 最近的修改");
		expect(ctx?.turns).toBe(2);
	});

	it("rebuilds the line from what is left after a middle turn is deleted", () => {
		// generate o1 -> markup on o1 makes o2 -> plain follow-up makes o3; then the markup turn
		// (the one that made o2) is deleted with scope "turn", which splices the path like this:
		const spliced: LineageMessage[] = [
			{ from: "system", content: "" },
			{ from: "user", content: "draw a lighthouse", files: [] },
			{ from: "assistant", content: "已生成", files: [out("o1")] },
			{ from: "user", content: "add a red roof" },
			{ from: "assistant", content: "基于上一张图编辑", files: [out("o3")] },
		];
		const lineage = traceEditLineage(spliced, 4);
		// the deleted markup notes are gone; the follow-up now hangs off o1's request
		expect(lineage.root?.text).toBe("draw a lighthouse");
		expect(lineage.edits.map((e) => e.text)).toEqual(["add a red roof"]);
		expect(JSON.stringify(lineage)).not.toContain("Notes for marks");

		// a later markup on an output whose turn was deleted: its copy of that image is the root
		const orphanMarkup: LineageMessage[] = [
			{ from: "system", content: "" },
			{ from: "user", content: "draw a lighthouse" },
			{ from: "assistant", content: "已生成", files: [out("o1")] },
			{ from: "user", content: notes("brighter sky"), files: marked("o2", "dddddddddddd") },
			{ from: "assistant", content: "已按标记编辑", files: [out("o4")] },
		];
		const root = traceEditLineage(orphanMarkup, 4).root;
		expect(root?.index).toBe(3);
		expect(root?.editedFirst).toBe(true);
		expect(root?.references.map((f) => f.value)).toEqual(["o2"]);
	});

	it("names the image roles in the order they are sent", () => {
		const lineage = traceEditLineage(conversation, 4);
		const plain = formatEditContext(lineage, "眼睛更生动", {
			attachments: 0,
			references: 2,
		})?.prompt;
		expect(plain).toContain("Image 1 is the current version");
		expect(plain).toContain("Image 2 is the original picture the first version was made from");
		expect(plain).toContain("Image 3 is a reference image from the original request.");
		expect(plain?.indexOf("Original request")).toBeLessThan(
			plain?.indexOf("Edits already made") ?? 0
		);
		expect(plain).toContain("Later instructions override earlier ones.");

		// a markup turn that also attached a hat: image 2 is the hat, the old uploads come after it
		const extras = formatEditContext(lineage, "加这顶帽子", {
			attachments: 1,
			references: 2,
		})?.prompt;
		expect(extras).toContain("Image 2 is attached with the new instruction.");
		expect(extras).toContain("Image 3 is the original picture the first version was made from");
		expect(extras).toContain("Image 4 is a reference image from the original request.");

		expect(
			formatEditContext({ edits: [] }, "x", { attachments: 0, references: 0 })
		).toBeUndefined();
	});
});
