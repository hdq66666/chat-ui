import { describe, expect, it } from "vitest";
import {
	IMAGE_ASPECTS,
	IMAGE_COMPLEXITIES,
	IMAGE_DIMENSIONS,
	IMAGE_MAX_PIXELS,
	IMAGE_SIZE_TIERS,
	imageSizeViolation,
	isImageComplexity,
	resolveImageDimensions,
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

	it("falls back to 1K 1:1 for missing or unknown values", () => {
		expect(resolveImageDimensions(undefined, undefined).size).toBe("1024x1024");
		expect(resolveImageDimensions("8K", "7:5").size).toBe("1024x1024");
		expect(resolveImageDimensions("2K", "16:9").size).toBe("2048x1152");
	});
});
