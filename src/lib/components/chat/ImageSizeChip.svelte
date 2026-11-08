<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import CarbonCaretDown from "~icons/carbon/caret-down";
	import LucideCheck from "~icons/lucide/check";
	import { useSettingsStore } from "$lib/stores/settings";
	import {
		IMAGE_ASPECTS,
		IMAGE_COMPLEXITIES,
		IMAGE_SIZE_TIERS,
		IMAGE_STABLE_MAX_PIXELS,
		resolveImageDimensions,
		type ImageAspect,
		type ImageComplexity,
		type ImageSizeTier,
	} from "$lib/imageGeneration";

	interface Props {
		modelId: string;
	}

	let { modelId }: Props = $props();

	const settings = useSettingsStore();

	let dims = $derived(
		resolveImageDimensions(
			$settings.imageSizeOverrides?.[modelId],
			$settings.imageAspectOverrides?.[modelId]
		)
	);

	let complexity = $derived($settings.imageComplexityOverrides?.[modelId]);

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

	const COMPLEXITY_OPTIONS: { value: ImageComplexity | undefined; label: string }[] = [
		{ value: undefined, label: "Default" },
		...IMAGE_COMPLEXITIES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) })),
	];

	function pixels(tier: ImageSizeTier, aspect: ImageAspect) {
		const d = resolveImageDimensions(tier, aspect);
		return `${d.width}×${d.height}`;
	}

	function experimental(tier: ImageSizeTier, aspect: ImageAspect) {
		const d = resolveImageDimensions(tier, aspect);
		return d.width * d.height > IMAGE_STABLE_MAX_PIXELS;
	}

	const itemClass =
		"flex h-8 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10";
	const headingClass = "px-2 pt-1 pb-0.5 text-xs text-gray-500 dark:text-gray-400";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="inline-flex items-center gap-1 hover:underline"
		aria-label="Select image size"
		title="{dims.width}×{dims.height}{complexity ? `, complexity ${complexity}` : ''}"
	>
		Size: {dims.tier} · {dims.aspect}{complexity ? ` · ${complexity}` : ""}
		<CarbonCaretDown class="-ml-0.5 text-xxs" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 min-w-48 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
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
							{pixels(tier, dims.aspect)}{experimental(tier, dims.aspect) ? " · beta" : ""}
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
