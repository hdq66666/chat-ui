<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import type { DeleteScope, TurnDeletionInfo } from "$lib/utils/tree/deleteTurn";

	interface Props {
		info: TurnDeletionInfo;
		/** The user message of the turn, shown so the user knows which turn this is */
		prompt: string;
		/** True when opened from a reply (offers deleting just that reply version) */
		fromReply: boolean;
		busy?: boolean;
		onclose: () => void;
		onconfirm: (scope: DeleteScope) => void;
	}

	let { info, prompt, fromReply, busy = false, onclose, onconfirm }: Props = $props();

	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	let preview = $derived(prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt);
	let turnSize = $derived(
		info.replyCount === 0
			? "your message"
			: info.replyCount === 1
				? "your message and its reply"
				: `your message and its ${info.replyCount} reply versions`
	);

	const buttonClass =
		"flex w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left text-sm disabled:opacity-50";
	const plainClass =
		"border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/60";
	const dangerClass =
		"border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40";
</script>

<Modal onclose={() => !busy && onclose()} width="w-[90dvw] md:w-[480px]">
	<div class="flex w-full flex-col gap-4 p-6">
		<h2 class="text-xl font-semibold text-gray-800 dark:text-gray-200">Delete message</h2>
		<p
			class="line-clamp-3 rounded-lg bg-gray-50 px-3 py-2 text-sm whitespace-pre-wrap text-gray-600 dark:bg-gray-700/50 dark:text-gray-300"
		>
			{preview || "(empty message)"}
		</p>

		<div class="flex flex-col gap-2">
			{#if fromReply && info.reply}
				<button
					type="button"
					class="{buttonClass} {plainClass}"
					disabled={busy}
					onclick={() => onconfirm("reply")}
				>
					<span class="font-medium">Delete this reply version</span>
					<span class="text-xs text-gray-500 dark:text-gray-400">
						The other {plural(info.replyCount - 1, "version")} stay{info.reply.count > 1
							? `; the ${plural(info.reply.count - 1, "message")} continuing from this version are removed too`
							: ""}.
					</span>
				</button>
			{/if}
			<button
				type="button"
				class="{buttonClass} {info.laterCount ? plainClass : dangerClass}"
				disabled={busy}
				onclick={() => onconfirm("turn")}
			>
				<span class="font-medium">Delete this turn</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Removes {turnSize}.{info.laterCount
						? ` The ${plural(info.laterCount, "later message")} stay and continue from the turn before; later replies no longer see this turn.`
						: ""}
				</span>
			</button>
			{#if info.laterCount}
				<button
					type="button"
					class="{buttonClass} {dangerClass}"
					disabled={busy}
					onclick={() => onconfirm("after")}
				>
					<span class="font-medium">Delete this turn and everything after it</span>
					<span class="text-xs opacity-80">
						Also removes the {plural(info.laterCount, "later message")}, on every branch.
					</span>
				</button>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-2">
			<span class="text-xs text-gray-500 dark:text-gray-400">This cannot be undone.</span>
			<button
				type="button"
				class="inline-flex items-center rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
				disabled={busy}
				onclick={onclose}
			>
				Cancel
			</button>
		</div>
	</div>
</Modal>
