<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import CarbonCaretDown from "~icons/carbon/caret-down";
	import LucideCheck from "~icons/lucide/check";
	import { useSettingsStore } from "$lib/stores/settings";
	import {
		IMAGE_ASPECTS,
		IMAGE_COMPLEXITIES,
		IMAGE_QUALITIES,
		IMAGE_SIZE_TIERS,
		formatCostMultiplier,
		isImageQuality,
		qualityCostMultiplier,
		resolveImageDimensions,
		sizeCostMultiplier,
		type ImageAspect,
		type ImageComplexity,
		type ImageQuality,
		type ImageSizeTier,
	} from "$lib/imageGeneration";

	interface Props {
		modelId: string;
		/** What Default means on this server (from the model list); falls back to the API defaults */
		defaults?: { quality: string; complexity: string };
	}

	let { modelId, defaults }: Props = $props();

	const settings = useSettingsStore();

	let dims = $derived(
		resolveImageDimensions(
			$settings.imageSizeOverrides?.[modelId],
			$settings.imageAspectOverrides?.[modelId]
		)
	);

	let complexity = $derived($settings.imageComplexityOverrides?.[modelId]);
	let quality = $derived($settings.imageQualityOverrides?.[modelId]);

	/** Shown after size and aspect on the trigger, only for what the user changed from Default. */
	let extras = $derived(
		[quality ? `Q ${quality}` : "", complexity ? `C ${complexity}` : ""].filter(Boolean)
	);

	// Persist immediately so the next message uses the new size (skips the setSettings debounce).
	function setTier(value: ImageSizeTier) {
		settings.instantSet({
			imageSizeOverrides: { ...($settings.imageSizeOverrides ?? {}), [modelId]: value },
		});
	}

	function setAspect(value: ImageAspect) {
		settings.instantSet({
			imageAspectOverrides: { ...($settings.imageAspectOverrides ?? {}), [modelId]: value },
		});
	}

	function setComplexity(value: ImageComplexity | undefined) {
		const next = { ...($settings.imageComplexityOverrides ?? {}) };
		if (value === undefined) delete next[modelId];
		else next[modelId] = value;
		settings.instantSet({ imageComplexityOverrides: next });
	}

	function setQuality(value: ImageQuality | undefined) {
		const next = { ...($settings.imageQualityOverrides ?? {}) };
		if (value === undefined) delete next[modelId];
		else next[modelId] = value;
		settings.instantSet({ imageQualityOverrides: next });
	}

	const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	const levelLabel = (v: string) => (v === "xhigh" ? "XHigh" : capitalize(v));

	// Default sends nothing: the server's OPENAI_IMAGE_QUALITY / _COMPLEXITY, else the API (auto / high)
	let QUALITY_OPTIONS = $derived<{ value: ImageQuality | undefined; label: string }[]>([
		{ value: undefined, label: `Default (${levelLabel(defaults?.quality ?? "auto")})` },
		...IMAGE_QUALITIES.map((q) => ({ value: q, label: levelLabel(q) })),
	]);

	/** The quality the cost estimate uses: the pick, else the server default; auto is estimated as medium. */
	let costQuality = $derived.by((): ImageQuality | undefined => {
		const serverDefault = defaults?.quality;
		return quality ?? (isImageQuality(serverDefault) ? serverDefault : undefined);
	});

	/** Tiers and qualities that cost noticeably more get a warning with the multiplier. */
	const WARN_TIERS: readonly ImageSizeTier[] = ["4K"];
	const WARN_QUALITIES: readonly ImageQuality[] = ["high", "xhigh", "max"];

	// Multipliers follow the official cost calculator, at the size, aspect and quality picked now.
	function tierWarning(tier: ImageSizeTier) {
		if (!WARN_TIERS.includes(tier)) return undefined;
		const m = sizeCostMultiplier(tier, dims.aspect, costQuality);
		return m ? formatCostMultiplier(m) : undefined;
	}

	function qualityWarning(value: ImageQuality | undefined) {
		if (!value || !WARN_QUALITIES.includes(value)) return undefined;
		const m = qualityCostMultiplier(value, dims.tier, dims.aspect);
		return m ? formatCostMultiplier(m) : undefined;
	}

	let COMPLEXITY_OPTIONS = $derived<{ value: ImageComplexity | undefined; label: string }[]>([
		{ value: undefined, label: `Default (${levelLabel(defaults?.complexity ?? "high")})` },
		...IMAGE_COMPLEXITIES.map((c) => ({ value: c, label: levelLabel(c) })),
	]);

	function pixels(tier: ImageSizeTier, aspect: ImageAspect) {
		const d = resolveImageDimensions(tier, aspect);
		return `${d.width}×${d.height}`;
	}

	const itemClass =
		"flex h-8 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10";
	const headingClass = "px-2 pt-1 pb-0.5 text-xs text-gray-500 dark:text-gray-400";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="inline-flex items-center gap-1 hover:underline"
		aria-label="Select image size"
		title="{dims.width}×{dims.height}{quality ? `, quality ${quality}` : ''}{complexity
			? `, complexity ${complexity}`
			: ''}"
	>
		Size: {dims.tier} · {dims.aspect}{extras.length ? ` · ${extras.join(" · ")}` : ""}
		<CarbonCaretDown class="-ml-0.5 text-xxs" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 min-w-56 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
			side="top"
			align="end"
			sideOffset={6}
		>
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading class={headingClass}>Size</DropdownMenu.GroupHeading>
				{#each IMAGE_SIZE_TIERS as tier (tier)}
					<DropdownMenu.Item class={itemClass} closeOnSelect={false} onSelect={() => setTier(tier)}>
						<span>{tier}</span>
						<span class="ml-auto text-xs text-gray-500 tabular-nums dark:text-gray-400">
							{pixels(tier, dims.aspect)}
							{#if tierWarning(tier)}
								<span
									class="ml-1 text-amber-600 dark:text-amber-400"
									title="About {tierWarning(tier)} the cost of 1K at this aspect ratio and quality"
									aria-label="Costs about {tierWarning(tier)} as much as 1K"
									>⚠️ {tierWarning(tier)} vs 1K</span
								>
							{/if}
						</span>
						{#if dims.tier === tier}
							<LucideCheck class="size-4 text-gray-500" />
						{:else}
							<span class="size-4"></span>
						{/if}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
			<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700/60" />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading class={headingClass}>Aspect ratio</DropdownMenu.GroupHeading>
				{#each IMAGE_ASPECTS as aspect (aspect)}
					<DropdownMenu.Item
						class={itemClass}
						closeOnSelect={false}
						onSelect={() => setAspect(aspect)}
					>
						<span>{aspect}</span>
						{#if dims.aspect === aspect}
							<LucideCheck class="size-4 text-gray-500" />
						{:else}
							<span class="size-4"></span>
						{/if}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
			<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700/60" />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading
					class={headingClass}
					title="Rendering quality. Higher is slower and costs more. Default: the server setting, otherwise the API default (auto)."
				>
					Quality
				</DropdownMenu.GroupHeading>
				{#each QUALITY_OPTIONS as opt (opt.label)}
					<DropdownMenu.Item
						class={itemClass}
						closeOnSelect={false}
						onSelect={() => setQuality(opt.value)}
					>
						<span>{opt.label}</span>
						{#if qualityWarning(opt.value)}
							<span
								class="ml-auto text-xs text-amber-600 tabular-nums dark:text-amber-400"
								title="About {qualityWarning(opt.value)} the cost of Low at this size"
								aria-label="Costs about {qualityWarning(opt.value)} as much as Low"
								>⚠️ {qualityWarning(opt.value)} vs Low</span
							>
						{/if}
						{#if quality === opt.value}
							<LucideCheck class="size-4 text-gray-500" />
						{:else}
							<span class="size-4"></span>
						{/if}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
			<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700/60" />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading
					class={headingClass}
					title="How much the model plans before rendering. Lower is faster and changes less. Default: the server setting, otherwise the API default (high)."
				>
					Complexity
				</DropdownMenu.GroupHeading>
				{#each COMPLEXITY_OPTIONS as opt (opt.label)}
					<DropdownMenu.Item
						class={itemClass}
						closeOnSelect={false}
						onSelect={() => setComplexity(opt.value)}
					>
						<span>{opt.label}</span>
						{#if complexity === opt.value}
							<LucideCheck class="size-4 text-gray-500" />
						{:else}
							<span class="size-4"></span>
						{/if}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
