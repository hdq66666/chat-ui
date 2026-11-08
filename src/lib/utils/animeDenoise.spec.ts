import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DENOISE_PING_MS,
	DENOISE_RESEND_MS,
	DENOISE_TIMEOUT_MS,
	DENOISE_WINDOW,
	denoiseTarget,
	openDenoiseWindow,
	postImageToDenoise,
	type DenoiseWindow,
	type MessageHost,
} from "./animeDenoise";

const ORIGIN = "http://denoise.example.test:7865";

/** A tool window: records what chat-ui posts, and can answer like the page does. */
function fakeTool() {
	const posted: { message: Record<string, unknown>; origin: string }[] = [];
	const win: DenoiseWindow = {
		closed: false,
		postMessage: (message, origin) =>
			posted.push({ message: message as Record<string, unknown>, origin }),
	};
	return { win, posted };
}

function fakeHost() {
	const listeners = new Set<(e: MessageEvent) => void>();
	const host: MessageHost = {
		addEventListener: (_t, fn) => listeners.add(fn),
		removeEventListener: (_t, fn) => listeners.delete(fn),
	};
	const emit = (data: unknown, source: unknown, origin = ORIGIN) =>
		listeners.forEach((fn) => fn({ data, source, origin } as MessageEvent));
	return { host, emit, listeners };
}

const image = () => ({
	name: "flare.png",
	mime: "image/png",
	buffer: new Uint8Array([1, 2, 3]).buffer,
});

describe("denoiseTarget", () => {
	it("resolves http(s) URLs and rejects the rest", () => {
		expect(
			denoiseTarget("http://denoise.example.test:7865/", "http://chat.example.test/")?.origin
		).toBe(ORIGIN);
		expect(denoiseTarget("/denoise/", "http://chat.example.test/c/1")?.href).toBe(
			"http://chat.example.test/denoise/"
		);
		expect(denoiseTarget("", "http://x/")).toBeNull();
		expect(denoiseTarget(undefined, "http://x/")).toBeNull();
		expect(denoiseTarget("javascript:alert(1)", "http://x/")).toBeNull();
	});
});

describe("openDenoiseWindow", () => {
	const target = new URL(ORIGIN + "/");

	it("navigates a new blank window to the tool and focuses it", () => {
		const w = { location: { href: "about:blank" }, focus: vi.fn() };
		const open = vi.fn(() => w as unknown as Window);
		expect(openDenoiseWindow(target, open)).toBe(w);
		expect(open).toHaveBeenCalledWith("", DENOISE_WINDOW);
		expect(w.location.href).toBe(target.href);
		expect(w.focus).toHaveBeenCalled();
	});

	it("reuses an already loaded tool window without reloading it", () => {
		const w = {
			get location(): { href: string } {
				throw new DOMException("cross-origin", "SecurityError");
			},
			focus: vi.fn(),
		};
		expect(openDenoiseWindow(target, () => w as unknown as Window)).toBe(w);
		expect(w.focus).toHaveBeenCalled();
	});

	it("returns null when the pop-up is blocked", () => {
		expect(openDenoiseWindow(target, () => null)).toBeNull();
	});
});

describe("postImageToDenoise", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("pings until ready, posts the image once, and resolves on the acknowledgement", async () => {
		const { win, posted } = fakeTool();
		const { host, emit, listeners } = fakeHost();
		const done = postImageToDenoise(win, ORIGIN, image(), host, "job1");

		vi.advanceTimersByTime(DENOISE_PING_MS * 3);
		expect(
			posted.every((p) => p.message.type === "anime-denoise:ping" && p.origin === ORIGIN)
		).toBe(true);
		expect(posted.length).toBe(4);

		emit({ type: "anime-denoise:ready" }, win);
		emit({ type: "anime-denoise:ready" }, win); // a second ping answered before the image arrived
		const sent = posted.filter((p) => p.message.type === "anime-denoise:image");
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({ id: "job1", name: "flare.png", mime: "image/png" });

		emit({ type: "anime-denoise:received", id: "job1" }, win);
		await expect(done).resolves.toBeUndefined();
		expect(listeners.size).toBe(0);
	});

	it("works where crypto.randomUUID is missing (chat-ui served over plain http)", async () => {
		const real = globalThis.crypto;
		vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
		try {
			const { win, posted } = fakeTool();
			const { host, emit } = fakeHost();
			const done = postImageToDenoise(win, ORIGIN, image(), host);
			emit({ type: "anime-denoise:ready" }, win);
			const sent = posted.find((p) => p.message.type === "anime-denoise:image");
			expect(sent?.message.id).toMatch(/^[0-9a-f-]{36}$/);
			emit({ type: "anime-denoise:received", id: sent?.message.id }, win);
			await expect(done).resolves.toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("resends when the acknowledgement does not come", async () => {
		const { win, posted } = fakeTool();
		const { host, emit } = fakeHost();
		const done = postImageToDenoise(win, ORIGIN, image(), host, "job2");
		emit({ type: "anime-denoise:ready" }, win);
		vi.advanceTimersByTime(DENOISE_RESEND_MS);
		emit({ type: "anime-denoise:ready" }, win);
		expect(posted.filter((p) => p.message.type === "anime-denoise:image")).toHaveLength(2);
		emit({ type: "anime-denoise:received", id: "job2" }, win);
		await done;
	});

	it("ignores messages from other windows, origins and jobs", () => {
		const { win, posted } = fakeTool();
		const { host, emit } = fakeHost();
		void postImageToDenoise(win, ORIGIN, image(), host, "job3").catch(() => {});
		emit({ type: "anime-denoise:ready" }, {});
		emit({ type: "anime-denoise:ready" }, win, "http://evil.example");
		expect(posted.some((p) => p.message.type === "anime-denoise:image")).toBe(false);
		emit({ type: "anime-denoise:ready" }, win);
		emit({ type: "anime-denoise:received", id: "other" }, win);
		vi.advanceTimersByTime(DENOISE_PING_MS);
		expect(posted.at(-1)?.message.type).toBe("anime-denoise:ping"); // still waiting
	});

	it("fails when the window is closed or the page never answers", async () => {
		const closed = fakeTool();
		const a = postImageToDenoise(closed.win, ORIGIN, image(), fakeHost().host);
		closed.win.closed = true;
		vi.advanceTimersByTime(DENOISE_PING_MS);
		await expect(a).rejects.toThrow(/closed/);

		const silent = fakeTool();
		const b = postImageToDenoise(silent.win, ORIGIN, image(), fakeHost().host);
		vi.advanceTimersByTime(DENOISE_TIMEOUT_MS);
		await expect(b).rejects.toThrow(/did not answer/);
	});
});
