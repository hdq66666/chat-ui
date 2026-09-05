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

	/**
	 * 一次拖进来的一批文件里，格式往往是混的（几张截图 + 一份 PDF + 一份
	 * 日志），后面还可能再拖第二批。所以这里既不清空已有的附件，也不因为
	 * 其中一个不合规就把整批丢掉 —— 能收的照收，收不下的一次性说明白。
	 */
	function dropHandle(event: DragEvent) {
		event.preventDefault();
		if (requireAuthUser() || !event.dataTransfer?.items) return;

		const dropped = Array.from(event.dataTransfer.items)
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);

		if (dropped.length === 0) return;

		const accepted: File[] = [];
		const rejected: string[] = [];

		for (const file of dropped) {
			// 用扩展名兜底的类型来判，浏览器给 HEIC 的 type 常常是空的。
			const fileMime = resolveFileMime(file.name, file.type);
			if (!mimeMatchesAllowlist(fileMime, mimeTypes)) {
				rejected.push(`${file.name}（${fileMime || "类型未知"}，不支持的格式）`);
			} else if (file.size > MAX_UPLOAD_BYTES) {
				rejected.push(
					`${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_UPLOAD_MB}MB）`
				);
			} else {
				accepted.push(file);
			}
		}

		if (accepted.length > 0) {
			files = [...files, ...accepted];
		}

		onDrag = false;

		if (rejected.length > 0) {
			setErrorMsg(
				`以下文件未添加：\n${rejected.join("\n")}\n\n` + `允许的格式：${mimeTypes.join(", ")}`
			);
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
