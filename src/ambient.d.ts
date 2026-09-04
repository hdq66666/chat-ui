declare module "*.ttf" {
	const value: ArrayBuffer;
	export default value;
}

// Legacy helpers removed: web search support is deprecated, so we intentionally
// avoid leaking those shapes into the global ambient types.

/**
 * Build flag for ML Assistant mode, inlined by Vite's `define` (see vite.config.ts).
 * Set `ML_ASSISTANT_MODE=true` in the build environment to compile the feature in;
 * with it off the constant folds to `false` and every gate on it is dead code.
 */
declare const __ML_ASSISTANT_MODE__: boolean;

/**
 * libheif-js 只给 index.js 带了类型，wasm-bundle 这个子路径没有。浏览器端只
 * 用到解码器的这几个成员（见 lib/utils/heicPreview.ts），按需声明，不去复制
 * 上游那份 38KB 的 .d.ts。
 */
declare module "libheif-js/wasm-bundle" {
	interface HeifImage {
		get_width(): number;
		get_height(): number;
		display(
			target: { data: Uint8ClampedArray; width: number; height: number },
			done: (out: { data: Uint8ClampedArray } | null) => void
		): void;
		free?(): void;
	}

	interface HeifDecoderCtor {
		new (): { decode(buffer: Uint8Array): HeifImage[] };
	}

	const libheif: { HeifDecoder: HeifDecoderCtor };
	export default libheif;
}
