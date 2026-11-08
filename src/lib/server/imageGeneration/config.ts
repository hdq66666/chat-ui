import { config } from "$lib/server/config";

// Image API config only: imported by models.ts, so it must not pull in the database or sharp.

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 600_000;
const QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function imageModelIds(): string[] {
	return (config.OPENAI_IMAGE_MODELS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function imageBaseUrl(): string {
	return (config.OPENAI_IMAGE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function imageTimeoutMs(): number {
	const n = Number.parseInt(config.OPENAI_IMAGE_TIMEOUT_MS || "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function imageQuality(): string | undefined {
	const q = (config.OPENAI_IMAGE_QUALITY || "").trim();
	return (QUALITIES as readonly string[]).includes(q) ? q : undefined;
}

const COMPLEXITIES = ["low", "medium", "high"] as const;
const MODERATIONS = ["auto", "low"] as const;

/** GPT Image 2.6 only. Unset = API default (high). */
export function imageComplexity(): string | undefined {
	const c = (config.OPENAI_IMAGE_COMPLEXITY || "").trim();
	return (COMPLEXITIES as readonly string[]).includes(c) ? c : undefined;
}

/** Unset = API default (auto). */
export function imageModeration(): string | undefined {
	const m = (config.OPENAI_IMAGE_MODERATION || "").trim();
	return (MODERATIONS as readonly string[]).includes(m) ? m : undefined;
}

export function imageOutputFormat(): OutputFormat {
	const f = (config.OPENAI_IMAGE_OUTPUT_FORMAT || "").trim();
	return (OUTPUT_FORMATS as readonly string[]).includes(f) ? (f as OutputFormat) : "png";
}

export const MIME_BY_FORMAT: Record<OutputFormat, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
