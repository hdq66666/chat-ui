<script lang="ts">
	import { requireAuthUser } from "$lib/utils/auth";
	import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";
	import { resolveFileMime } from "$lib/utils/mime";
	import { env as publicEnv } from "$env/dynamic/public";

	// 上传体积上限，和服务端 conversation/[id]/+server.ts 用同一个变量；
	// 只改一边的话，要么前端不让选，要么选了被服务端 413 拦下。
	const MAX_UPLOAD_MB = Number(publicEnv.PUBLIC_MAX_UPLOAD_MB || 10);
	const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
	import CarbonImage from "~icons/carbon/image";

	interface Props {
		// import EosIconsLoading from "~icons/eos-icons/loading";
		files: File[];
		mimeTypes?: string[];
		onDrag?: boolean;
		onDragInner?: boolean;
	}

	let {
		files = $bindable(),
		mimeTypes = [],
		onDrag = $bindable(false),
		onDragInner = $bindable(false),
	}: Props = $props();

	async function dropHandle(event: DragEvent) {
		event.preventDefault();
		if (!requireAuthUser() && event.dataTransfer && event.dataTransfer.items) {
			// Use DataTransferItemList interface to access the file(s)
			if (files.length > 0) {
				files = [];
			}
			if (event.dataTransfer.items[0].kind === "file") {
				for (let i = 0; i < event.dataTransfer.items.length; i++) {
					const file = event.dataTransfer.items[i].getAsFile();

					if (file) {
						// check if the file matches the mimeTypes
						// else abort
						// 用扩展名兜底的类型来判，浏览器给 HEIC 的 type 常常是空的。
						const fileMime = resolveFileMime(file.name, file.type);
						if (!mimeMatchesAllowlist(fileMime, mimeTypes)) {
							setErrorMsg(
								`Some file type not supported. Only allowed: ${mimeTypes.join(
									", "
								)}. Uploaded document is of type ${fileMime || "unknown"}`
							);
							files = [];
							return;
						}

						// if file is bigger than the configured limit, abort
						if (file.size > MAX_UPLOAD_BYTES) {
							setErrorMsg(`Some file is too big. (${MAX_UPLOAD_MB}MB max)`);
							files = [];
							return;
						}

						// add the file to the files array
						files = [...files, file];

						// Tools removed: no settings update for document parser
					}
				}
				onDrag = false;
			}
		}
	}

	function setErrorMsg(errorMsg: string) {
		onDrag = false;
		alert(errorMsg);
	}
</script>

<div
	id="dropzone"
	role="form"
	ondrop={dropHandle}
	ondragenter={() => (onDragInner = true)}
	ondragleave={() => (onDragInner = false)}
	ondragover={(e) => {
		e.preventDefault();
	}}
	class="relative flex h-28 w-full max-w-4xl flex-col items-center justify-center gap-1 rounded-xl border-2 border-dotted {onDragInner
		? 'border-blue-200 bg-blue-600/10! text-blue-600 *:pointer-events-none dark:border-blue-600 dark:bg-blue-600/20 dark:text-blue-600'
		: 'bg-gray-100 text-gray-500 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-400'}"
>
	<CarbonImage class="text-xl" />
	<p>Drop File to add to chat</p>
</div>
