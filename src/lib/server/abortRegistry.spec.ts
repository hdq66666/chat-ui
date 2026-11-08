import { describe, expect, it } from "vitest";
import { AbortRegistry } from "./abortRegistry";

describe("AbortRegistry run tokens", () => {
	it("is busy from claim to release, and a handed-over token is released by the run", () => {
		const registry = new (AbortRegistry as unknown as { new (): AbortRegistry })();
		const claim = registry.claimRun("c1");
		expect(registry.isBusy("c1")).toBe(true);
		claim.releaseUnlessHandedOver();
		expect(registry.isBusy("c1")).toBe(false);

		const second = registry.claimRun("c1");
		const endRun = second.handOver();
		second.releaseUnlessHandedOver(); // the request returned; the run still holds it
		expect(registry.isBusy("c1")).toBe(true);
		endRun();
		endRun(); // releasing twice is harmless
		expect(registry.isBusy("c1")).toBe(false);
	});

	it("does not count a leaked controller, and expires forgotten tokens", () => {
		const registry = new (AbortRegistry as unknown as { new (): AbortRegistry })();
		registry.register("c2", new AbortController()); // a run that failed before unregistering
		expect(registry.isBusy("c2")).toBe(false);

		registry.beginRun("c3");
		expect(registry.isBusy("c3")).toBe(true);
		expect(registry.isBusy("c3", Date.now() + AbortRegistry.RUN_TOKEN_TTL_MS + 1)).toBe(false);
		expect(registry.isBusy("c3")).toBe(false); // the expired token was dropped
	});
});
