import { describe, expect, it } from "vitest";
import { assertConsistent, deleteTurn, describeTurnDeletion, DeleteTurnError } from "./deleteTurn";
import { buildSubtree } from "./buildSubtree";

type M = { id: string; from: string; content: string; ancestors?: string[]; children?: string[] };

/** Build a tree from [id, from, parentId] rows; content = id. */
function tree(rows: Array<[string, string, string?]>) {
	const messages: M[] = rows.map(([id, from]) => ({ id, from, content: id, children: [] }));
	const map = new Map(messages.map((m) => [m.id, m]));
	for (const [id, , parent] of rows) {
		const m = map.get(id) as M;
		if (!parent) {
			m.ancestors = [];
			continue;
		}
		const p = map.get(parent) as M;
		m.ancestors = [...(p.ancestors ?? []), parent];
		p.children?.push(id);
	}
	return { rootMessageId: rows[0][0], messages };
}

const path = (conv: { rootMessageId?: string; messages: M[] }, leaf: string) =>
	buildSubtree(conv, leaf).map((m) => m.id);

// s ─ u1 ─ a1 ─ u2 ─ a2 ─ u3 ─ a3
const linear = () =>
	tree([
		["s", "system"],
		["u1", "user", "s"],
		["a1", "assistant", "u1"],
		["u2", "user", "a1"],
		["a2", "assistant", "u2"],
		["u3", "user", "a2"],
		["a3", "assistant", "u3"],
	]);

describe("deleteTurn", () => {
	it("removes a middle turn and reattaches what came after it", () => {
		const conv = linear();
		const { messages, removed, fallbackId } = deleteTurn(conv, "u2", "turn");
		expect(removed.map((m) => m.id)).toEqual(["u2", "a2"]);
		expect(fallbackId).toBe("a1");
		const after = { rootMessageId: "s", messages };
		// the context of the last reply no longer contains the deleted turn
		expect(path(after, "a3")).toEqual(["s", "u1", "a1", "u3", "a3"]);
		expect(messages.find((m) => m.id === "a1")?.children).toEqual(["u3"]);
		// the input is not modified
		expect(conv.messages).toHaveLength(7);
		expect(conv.messages.find((m) => m.id === "a1")?.children).toEqual(["u2"]);
	});

	it("does the same when started from the reply of the turn", () => {
		const { messages } = deleteTurn(linear(), "a2", "turn");
		expect(messages.map((m) => m.id)).toEqual(["s", "u1", "a1", "u3", "a3"]);
	});

	it("removes the turn and everything after it with scope 'after'", () => {
		const { messages, removed } = deleteTurn(linear(), "u2", "after");
		expect(messages.map((m) => m.id)).toEqual(["s", "u1", "a1"]);
		expect(removed.map((m) => m.id)).toEqual(["u2", "a2", "u3", "a3"]);
		expect(messages.find((m) => m.id === "a1")?.children).toEqual([]);
	});

	it("keeps every retry's continuation, in order, when a turn with retries is removed", () => {
		// u2 has two reply versions, each continued; u2b is an edited version of u2
		const conv = tree([
			["s", "system"],
			["u1", "user", "s"],
			["a1", "assistant", "u1"],
			["u2", "user", "a1"],
			["a2x", "assistant", "u2"],
			["u3x", "user", "a2x"],
			["a2y", "assistant", "u2"],
			["u3y", "user", "a2y"],
			["a3y", "assistant", "u3y"],
			["u2b", "user", "a1"],
			["a2b", "assistant", "u2b"],
		]);
		const { messages } = deleteTurn(conv, "u2", "turn");
		const after = { rootMessageId: "s", messages };
		expect(messages.find((m) => m.id === "a1")?.children).toEqual(["u3x", "u3y", "u2b"]);
		expect(path(after, "a3y")).toEqual(["s", "u1", "a1", "u3y", "a3y"]);
		expect(path(after, "a2b")).toEqual(["s", "u1", "a1", "u2b", "a2b"]);
		expect(() => assertConsistent(after)).not.toThrow();
	});

	it("removes the prompt and every reply version, from whichever version it is started", () => {
		const conv = tree([
			["s", "system"],
			["u1", "user", "s"],
			["a1x", "assistant", "u1"],
			["u2", "user", "a1x"],
			["a1y", "assistant", "u1"],
		]);
		expect(describeTurnDeletion(conv, "a1y").replyCount).toBe(2);
		for (const from of ["u1", "a1x", "a1y"]) {
			const { messages, removed, fallbackId } = deleteTurn(conv, from, "turn");
			expect(removed.map((m) => m.id)).toEqual(["u1", "a1x", "a1y"]);
			// u2 continued from the a1x version; it is kept and moves up to the system message
			expect(messages.map((m) => m.id)).toEqual(["s", "u2"]);
			expect(messages.find((m) => m.id === "u2")?.ancestors).toEqual(["s"]);
			expect(fallbackId).toBe("s");
		}
		expect(() => deleteTurn(conv, "a1x", "reply" as never)).toThrow(DeleteTurnError);
	});

	it("describes what each choice removes", () => {
		expect(describeTurnDeletion(linear(), "a1")).toEqual({
			userId: "u1",
			parentId: "s",
			replyCount: 1,
			laterCount: 4,
		});
		expect(describeTurnDeletion(linear(), "u3").laterCount).toBe(0);
	});

	it("refuses the system message, unknown ids and old-format conversations", () => {
		expect(() => deleteTurn(linear(), "s", "turn")).toThrow(/Only user messages/);
		expect(() => deleteTurn(linear(), "nope", "turn")).toThrow(/not found/);
		const legacy = { rootMessageId: undefined, messages: linear().messages };
		expect(() => deleteTurn(legacy, "u2", "turn")).toThrow(/old-format/);
		const noSystem = tree([
			["u1", "user"],
			["a1", "assistant", "u1"],
		]);
		expect(() => deleteTurn(noSystem, "u1", "turn")).toThrow(/first message/);
	});

	it("rejects an unknown scope", () => {
		expect(() => deleteTurn(linear(), "u2", "everything" as never)).toThrow(/Unknown scope/);
	});

	it("catches broken links", () => {
		const conv = linear();
		(conv.messages[2] as M).children = ["u2", "ghost"];
		expect(() => assertConsistent(conv)).toThrow(/missing child/);
	});
});
