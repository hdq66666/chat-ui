import { randomUUID } from "$lib/utils/randomUuid";

/**
 * Hand-off to the gpt-anime-denoise web page (PUBLIC_ANIME_DENOISE_URL), which runs on another origin and
 * removes the fish-scale texture GPT image models leave in anime-style pictures.
 *
 * The page opens in one named window that is reused, so images queue up there instead of reloading it.
 * Conversation images need the chat-ui session cookie, so we fetch the bytes here, then ping the page until it
 * answers "ready" and post them; the page only listens to the chat-ui origins it was configured with.
 */
export const DENOISE_WINDOW = "chatui-anime-denoise";
export const DENOISE_PING_MS = 300;
export const DENOISE_RESEND_MS = 2_000;
export const DENOISE_TIMEOUT_MS = 20_000;

export interface DenoiseImage {
	name: string;
	/** A conversation file URL (same origin) or a data: URL */
	src: string;
}

export interface DenoisePayload {
	name: string;
	mime: string;
	buffer: ArrayBuffer;
}

/** The part of a Window the hand-off uses (a cross-origin window only allows these). */
export interface DenoiseWindow {
	closed: boolean;
	postMessage(message: unknown, targetOrigin: string): void;
}

/** Where messages from the page arrive (the opener's window). */
export interface MessageHost {
	addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
	removeEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}

/** The configured tool URL as an absolute http(s) URL, or null when it is unset or unusable. */
export function denoiseTarget(url: string | undefined, base: string): URL | null {
	if (!url) return null;
	try {
		const target = new URL(url, base);
		return target.protocol === "http:" || target.protocol === "https:" ? target : null;
	} catch {
		return null;
	}
}

/**
 * Open the tool, or bring its window forward without reloading it (a reload would drop its queue).
 * Must run synchronously inside the click handler, or the browser blocks the window.
 */
export function openDenoiseWindow(
	target: URL,
	open: (url: string, name: string) => Window | null = (url, name) => window.open(url, name)
): Window | null {
	const w = open("", DENOISE_WINDOW);
	if (!w) return null;
	let blank = false;
	try {
		blank = w.location.href === "about:blank";
	} catch {
		// cross-origin: the tool is already loaded in that window
	}
	if (blank) w.location.href = target.href;
	w.focus();
	return w;
}

/** Ping the page until it is ready, post the image, and resolve once the page confirms it got it. */
export function postImageToDenoise(
	w: DenoiseWindow,
	origin: string,
	image: DenoisePayload,
	host: MessageHost,
	id: string = randomUUID() // crypto.randomUUID alone is missing on plain-http pages
): Promise<void> {
	return new Promise((resolve, reject) => {
		let lastSent = 0;
		const finish = (err?: Error) => {
			clearInterval(timer);
			clearTimeout(deadline);
			host.removeEventListener("message", onMessage);
			if (err) reject(err);
			else resolve();
		};
		const post = (message: unknown) => {
			try {
				// targetOrigin makes the browser drop it while the window still shows about:blank or another site
				w.postMessage(message, origin);
			} catch {
				// window navigating; the next ping retries
			}
		};
		const ping = () => {
			if (w.closed) return finish(new Error("The denoise window was closed."));
			post({ type: "anime-denoise:ping" });
		};
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== origin || e.source !== (w as unknown)) return;
			const data = e.data as { type?: string; id?: string } | null;
			if (data?.type === "anime-denoise:ready" && Date.now() - lastSent >= DENOISE_RESEND_MS) {
				lastSent = Date.now();
				post({ type: "anime-denoise:image", id, ...image });
			} else if (data?.type === "anime-denoise:received" && data.id === id) {
				finish();
			}
		};
		host.addEventListener("message", onMessage);
		const timer = setInterval(ping, DENOISE_PING_MS);
		const deadline = setTimeout(
			() => finish(new Error("The denoise page did not answer. Is the denoise service running?")),
			DENOISE_TIMEOUT_MS
		);
		ping();
	});
}

/** Open the tool from a click; with an image, fetch it and hand it over. Rejects with a readable error. */
export async function openAnimeDenoise(
	url: string | undefined,
	image?: DenoiseImage
): Promise<void> {
	const target = denoiseTarget(url, window.location.href);
	if (!target) throw new Error("The denoise tool is not configured.");
	const w = openDenoiseWindow(target);
	if (!w) throw new Error("The browser blocked the denoise window. Allow pop-ups for this site.");
	if (!image) return;
	const res = await fetch(image.src);
	if (!res.ok) throw new Error("Could not load that image for denoising.");
	const blob = await res.blob();
	await postImageToDenoise(
		w,
		target.origin,
		{
			name: image.name,
			mime: blob.type || "image/png",
			buffer: await blob.arrayBuffer(),
		},
		window
	);
}
