import { logger } from "$lib/server/logger";

/**
 * Tracks active upstream generation requests so they can be cancelled on demand.
 * Multiple controllers can be registered per conversation (for threaded/background runs).
 */
export class AbortRegistry {
	private static instance: AbortRegistry;

	private controllers = new Map<string, Set<AbortController>>();

	/**
	 * Requests that may still write the conversation's whole messages array: a send holds a token
	 * from before it reads the conversation until its stream's last save (a controller leaves
	 * `controllers` as soon as it is aborted, which is earlier). Tokens expire, so a request that
	 * died without releasing cannot block the conversation for good.
	 */
	private runs = new Map<string, Map<symbol, number>>();
	static readonly RUN_TOKEN_TTL_MS = 15 * 60 * 1000;

	public static getInstance(): AbortRegistry {
		if (!AbortRegistry.instance) {
			AbortRegistry.instance = new AbortRegistry();
		}
		return AbortRegistry.instance;
	}

	public register(conversationId: string, controller: AbortController) {
		const key = conversationId.toString();
		let set = this.controllers.get(key);
		if (!set) {
			set = new Set();
			this.controllers.set(key, set);
		}
		set.add(controller);
		controller.signal.addEventListener(
			"abort",
			() => {
				this.unregister(key, controller);
			},
			{ once: true }
		);
	}

	public abort(conversationId: string) {
		const set = this.controllers.get(conversationId);
		if (!set?.size) return;

		logger.debug({ conversationId }, "Aborting active generation via AbortRegistry");
		for (const controller of set) {
			if (!controller.signal.aborted) {
				controller.abort();
			}
		}
		this.controllers.delete(conversationId);
	}

	/** Mark a run that writes this conversation; call the returned function after its last write. */
	public beginRun(conversationId: string): () => void {
		const key = conversationId.toString();
		const token = Symbol(key);
		let runs = this.runs.get(key);
		if (!runs) {
			runs = new Map();
			this.runs.set(key, runs);
		}
		runs.set(token, Date.now());
		return () => {
			const current = this.runs.get(key);
			current?.delete(token);
			if (current?.size === 0) this.runs.delete(key);
		};
	}

	/**
	 * A token for a request that may start a run: hand it over to the run, or release it when the
	 * request ends without one. Releasing twice is harmless.
	 */
	public claimRun(conversationId: string) {
		const release = this.beginRun(conversationId);
		let handedOver = false;
		return {
			/** The run takes the token; it releases it after its last write. */
			handOver: () => {
				handedOver = true;
				return release;
			},
			releaseUnlessHandedOver: () => {
				if (!handedOver) release();
			},
		};
	}

	/**
	 * Whether a request on this pod may still write the conversation. Only tokens count: they
	 * expire, whereas a controller leaked by a failed run would block deletes until a restart.
	 */
	public isBusy(conversationId: string, now = Date.now()): boolean {
		const key = conversationId.toString();
		const runs = this.runs.get(key);
		if (!runs) return false;
		for (const [token, startedAt] of runs) {
			if (now - startedAt > AbortRegistry.RUN_TOKEN_TTL_MS) runs.delete(token);
		}
		if (runs.size === 0) this.runs.delete(key);
		return Boolean(runs.size);
	}

	public unregister(conversationId: string, controller: AbortController) {
		const set = this.controllers.get(conversationId);
		if (!set) return;
		set.delete(controller);
		if (set.size === 0) {
			this.controllers.delete(conversationId);
		}
	}
}
