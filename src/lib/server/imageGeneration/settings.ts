import { z } from "zod";
import {
	IMAGE_ASPECTS,
	IMAGE_COMPLEXITIES,
	IMAGE_QUALITIES,
	IMAGE_SIZE_TIERS,
} from "$lib/imageGeneration";

/**
 * The per-model image settings (size menu). Saved with the rest of the settings, but more forgiving:
 * - a client that does not send one of these maps (an older tab, before a field existed) leaves the
 *   stored map alone instead of wiping it;
 * - an unknown value is dropped instead of failing the whole save;
 * - reads return only known values, so a bad stored value cannot break later saves.
 */
const IMAGE_SETTING_VALUES = {
	imageSizeOverrides: IMAGE_SIZE_TIERS,
	imageAspectOverrides: IMAGE_ASPECTS,
	imageComplexityOverrides: IMAGE_COMPLEXITIES,
	imageQualityOverrides: IMAGE_QUALITIES,
} as const;

type ImageSettingKey = keyof typeof IMAGE_SETTING_VALUES;
type ImageSettings = {
	[K in ImageSettingKey]: Record<string, (typeof IMAGE_SETTING_VALUES)[K][number]>;
};

function clean<V extends string>(map: unknown, values: readonly V[]): Record<string, V> {
	if (!map || typeof map !== "object" || Array.isArray(map)) return {};
	return Object.fromEntries(
		Object.entries(map).filter(
			(entry): entry is [string, V] =>
				typeof entry[1] === "string" && (values as readonly string[]).includes(entry[1])
		)
	);
}

function field<V extends string>(values: readonly V[]) {
	return z
		.record(z.unknown())
		.optional()
		.transform((map) => (map === undefined ? undefined : clean(map, values)));
}

/** zod fields for the settings POST schemas. */
export const imageSettingsFields = {
	imageSizeOverrides: field(IMAGE_SIZE_TIERS),
	imageAspectOverrides: field(IMAGE_ASPECTS),
	imageComplexityOverrides: field(IMAGE_COMPLEXITIES),
	imageQualityOverrides: field(IMAGE_QUALITIES),
};

/** The stored maps for the settings GET, with unknown values removed. */
export function readImageSettings(
	stored: Partial<Record<ImageSettingKey, unknown>> | null | undefined
) {
	return {
		imageSizeOverrides: clean(stored?.imageSizeOverrides, IMAGE_SIZE_TIERS),
		imageAspectOverrides: clean(stored?.imageAspectOverrides, IMAGE_ASPECTS),
		imageComplexityOverrides: clean(stored?.imageComplexityOverrides, IMAGE_COMPLEXITIES),
		imageQualityOverrides: clean(stored?.imageQualityOverrides, IMAGE_QUALITIES),
	} satisfies ImageSettings;
}

/** Remove the image maps the client did not send, so the $set leaves them as stored. */
export function omitUnsentImageSettings<T extends Partial<Record<ImageSettingKey, unknown>>>(
	settings: T
): T {
	const out = { ...settings };
	for (const key of Object.keys(IMAGE_SETTING_VALUES) as ImageSettingKey[]) {
		if (out[key] === undefined) delete out[key];
	}
	return out;
}
