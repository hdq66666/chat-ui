import { describe, expect, it } from "vitest";
import { z } from "zod";
import { imageSettingsFields, omitUnsentImageSettings, readImageSettings } from "./settings";

const schema = z.object({ activeModel: z.string().default("m"), ...imageSettingsFields });

describe("image settings in the settings save", () => {
	it("leaves maps the client did not send out of the update", () => {
		// an older tab that does not know imageQualityOverrides yet
		const parsed = schema.parse({ imageSizeOverrides: { flare: "2K" } });
		expect(parsed.imageQualityOverrides).toBeUndefined();
		const update = omitUnsentImageSettings(parsed);
		expect(update).toEqual({ activeModel: "m", imageSizeOverrides: { flare: "2K" } });
		expect("imageQualityOverrides" in update).toBe(false);
	});

	it("drops unknown values instead of rejecting the whole save", () => {
		const parsed = schema.parse({
			imageQualityOverrides: { flare: "max", sunburst: "ultra" },
			imageAspectOverrides: { flare: "7:5" },
		});
		expect(parsed.imageQualityOverrides).toEqual({ flare: "max" });
		expect(parsed.imageAspectOverrides).toEqual({});
	});

	it("still rejects a map that is not an object", () => {
		expect(() => schema.parse({ imageSizeOverrides: "2K" })).toThrow();
	});

	it("reads only known values back, so a bad stored value cannot break later saves", () => {
		expect(
			readImageSettings({
				imageSizeOverrides: { flare: "4K", old: "8K" },
				imageComplexityOverrides: { flare: 3 },
			})
		).toEqual({
			imageSizeOverrides: { flare: "4K" },
			imageAspectOverrides: {},
			imageComplexityOverrides: {},
			imageQualityOverrides: {},
		});
		expect(readImageSettings(null).imageQualityOverrides).toEqual({});
	});
});
