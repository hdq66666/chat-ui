import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { ObjectId } from "mongodb";
import { v4 } from "uuid";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import type { Message } from "$lib/types/Message";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "./testHelpers";

import { AbortRegistry } from "$lib/server/abortRegistry";
import { DELETE } from "../../../../routes/api/v2/conversations/[id]/message/[messageId]/+server";

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

function callDelete(locals: App.Locals, id: string, messageId: string, scope?: string) {
	const url = new URL(`http://localhost/api/v2/conversations/${id}/message/${messageId}`);
	if (scope) url.searchParams.set("scope", scope);
	return DELETE({ locals, params: { id, messageId }, url } as never);
}

async function statusOf(call: unknown) {
	try {
		await call;
		return 200;
	} catch (e: unknown) {
		return (e as { status: number }).status;
	}
}

/** s - u1 - a1 - u2 - a2 - u3 - a3, with an optional second reply version of u2 */
function linearTree(opts: { retry?: boolean; files?: Record<string, string[]> } = {}) {
	const ids = ["s", "u1", "a1", "u2", "a2", "u3", "a3", ...(opts.retry ? ["a2b"] : [])];
	const id = Object.fromEntries(ids.map((k) => [k, v4()])) as Record<string, string>;
	const parent: Record<string, string | undefined> = {
		s: undefined,
		u1: "s",
		a1: "u1",
		u2: "a1",
		a2: "u2",
		u3: "a2",
		a3: "u3",
		a2b: "u2",
	};
	const messages: Message[] = ids.map((k) => {
		const chain: string[] = [];
		for (let p = parent[k]; p; p = parent[p]) chain.unshift(id[p]);
		return {
			id: id[k],
			from: k === "s" ? "system" : k.startsWith("u") ? "user" : "assistant",
			content: k,
			ancestors: chain,
			children: ids.filter((c) => parent[c] === k).map((c) => id[c]),
			...(opts.files?.[k]
				? {
						files: opts.files[k].map((sha) => ({
							type: "hash" as const,
							value: sha,
							mime: "image/png",
							name: `${sha}.png`,
						})),
					}
				: {}),
		};
	});
	return { id, messages, rootMessageId: id.s };
}

async function storeFile(convId: string, sha: string) {
	const upload = collections.bucket.openUploadStream(`${convId}-${sha}`);
	await new Promise((resolve, reject) => {
		upload.once("finish", resolve);
		upload.once("error", reject);
		upload.end(Buffer.from(sha));
	});
}

async function storedShas(convId: string) {
	const files = await collections.bucket.find({}).toArray();
	return files.map((f) => f.filename.replace(`${convId}-`, "")).sort();
}

/**
 * Build a simple message tree:
 *
 *   root (system)
 *     -> msg1 (user)
 *       -> msg2 (assistant)
 *         -> msg3 (user)
 *     -> unrelated (user) -- sibling branch from root
 */
function buildMessageTree(): {
	messages: Message[];
	rootId: string;
	msg1Id: string;
	msg2Id: string;
	msg3Id: string;
	unrelatedId: string;
} {
	const rootId = v4();
	const msg1Id = v4();
	const msg2Id = v4();
	const msg3Id = v4();
	const unrelatedId = v4();

	const root: Message = {
		id: rootId,
		from: "system",
		content: "System prompt",
		ancestors: [],
		children: [msg1Id, unrelatedId],
	};
	const msg1: Message = {
		id: msg1Id,
		from: "user",
		content: "Hello",
		ancestors: [rootId],
		children: [msg2Id],
	};
	const msg2: Message = {
		id: msg2Id,
		from: "assistant",
		content: "Hi there!",
		ancestors: [rootId, msg1Id],
		children: [msg3Id],
	};
	const msg3: Message = {
		id: msg3Id,
		from: "user",
		content: "How are you?",
		ancestors: [rootId, msg1Id, msg2Id],
		children: [],
	};
	const unrelated: Message = {
		id: unrelatedId,
		from: "user",
		content: "Unrelated branch",
		ancestors: [rootId],
		children: [],
	};

	return {
		messages: [root, msg1, msg2, msg3, unrelated],
		rootId,
		msg1Id,
		msg2Id,
		msg3Id,
		unrelatedId,
	};
}

// `collections` is undefined until the database IIFE resolves.
beforeAll(async () => {
	await ready;
});

describe.sequential("DELETE /api/v2/conversations/[id]/message/[messageId]", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("removes target message and its descendants", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		const tree = buildMessageTree();

		const conv = await createTestConversation(locals, {
			messages: tree.messages,
			rootMessageId: tree.rootId,
		});

		// Delete msg1 -> should also remove msg2 and msg3 (descendants)
		const res = await callDelete(locals, conv._id.toString(), tree.msg1Id, "after");

		expect(res.status).toBe(200);
		const data = await parseResponse<{ success: boolean }>(res);
		expect(data.success).toBe(true);

		const updated = await collections.conversations.findOne({ _id: conv._id });
		expect(updated).not.toBeNull();

		const remainingIds = (updated?.messages ?? []).map((m) => m.id);
		// msg1, msg2, msg3 should all be removed
		expect(remainingIds).not.toContain(tree.msg1Id);
		expect(remainingIds).not.toContain(tree.msg2Id);
		expect(remainingIds).not.toContain(tree.msg3Id);
		// root and unrelated should remain
		expect(remainingIds).toContain(tree.rootId);
		expect(remainingIds).toContain(tree.unrelatedId);
	});

	it("cleans up children arrays referencing deleted message", async () => {
		const { locals } = await createTestUser();
		const tree = buildMessageTree();

		const conv = await createTestConversation(locals, {
			messages: tree.messages,
			rootMessageId: tree.rootId,
		});

		// Delete msg1 -> root's children should no longer include msg1Id
		await callDelete(locals, conv._id.toString(), tree.msg1Id, "after");

		const updated = await collections.conversations.findOne({ _id: conv._id });
		const rootMsg = updated?.messages.find((m) => m.id === tree.rootId);
		expect(rootMsg).toBeDefined();
		expect(rootMsg?.children).not.toContain(tree.msg1Id);
		// The unrelated sibling should still be in root's children
		expect(rootMsg?.children).toContain(tree.unrelatedId);
	});

	it("removes a middle turn and keeps what came after it (default scope)", async () => {
		const { locals } = await createTestUser();
		const t = linearTree();
		const conv = await createTestConversation(locals, {
			messages: t.messages,
			rootMessageId: t.rootMessageId,
		});

		const res = await callDelete(locals, conv._id.toString(), t.id.u2);
		const data = await parseResponse<{ removedIds: string[]; fallbackId: string }>(res);
		expect(new Set(data.removedIds)).toEqual(new Set([t.id.u2, t.id.a2]));
		expect(data.fallbackId).toBe(t.id.a1);

		const updated = await collections.conversations.findOne({ _id: conv._id });
		const byId = new Map((updated?.messages ?? []).map((m) => [m.id, m]));
		expect([...byId.keys()]).toEqual([t.id.s, t.id.u1, t.id.a1, t.id.u3, t.id.a3]);
		// the later turn now follows the turn before the deleted one
		expect(byId.get(t.id.a1)?.children).toEqual([t.id.u3]);
		expect(byId.get(t.id.a3)?.ancestors).toEqual([t.id.s, t.id.u1, t.id.a1, t.id.u3]);
		expect(updated?.updatedAt.getTime()).toBeGreaterThan(conv.updatedAt.getTime() - 1);
	});

	it("removes one reply version with scope=reply, and refuses it for an only reply", async () => {
		const { locals } = await createTestUser();
		const t = linearTree({ retry: true });
		const conv = await createTestConversation(locals, {
			messages: t.messages,
			rootMessageId: t.rootMessageId,
		});
		const id = conv._id.toString();

		expect(await statusOf(callDelete(locals, id, t.id.a1, "reply"))).toBe(400);
		await callDelete(locals, id, t.id.a2, "reply");
		const updated = await collections.conversations.findOne({ _id: conv._id });
		const ids = (updated?.messages ?? []).map((m) => m.id);
		// a2 and the branch after it are gone; the other version stays
		expect(ids).toEqual([t.id.s, t.id.u1, t.id.a1, t.id.u2, t.id.a2b]);
		expect(updated?.messages.find((m) => m.id === t.id.u2)?.children).toEqual([t.id.a2b]);
	});

	it("refuses while a reply is generating or waiting, and leaves the conversation alone", async () => {
		const { locals } = await createTestUser();
		const t = linearTree();
		const running = t.messages.map((m) =>
			m.id === t.id.a3
				? ({
						...m,
						updates: [{ type: "turnState", state: "running" }],
					} as unknown as Message)
				: m
		);
		const conv = await createTestConversation(locals, {
			messages: running,
			rootMessageId: t.rootMessageId,
		});
		const id = conv._id.toString();
		expect(await statusOf(callDelete(locals, id, t.id.u2))).toBe(409);

		// a run on this pod that has not saved for the last time yet
		await collections.conversations.updateOne(
			{ _id: conv._id },
			{ $set: { messages: t.messages } }
		);
		const endRun = AbortRegistry.getInstance().beginRun(id);
		try {
			expect(await statusOf(callDelete(locals, id, t.id.u2))).toBe(409);
		} finally {
			endRun();
		}
		const after = await collections.conversations.findOne({ _id: conv._id });
		expect(after?.messages).toHaveLength(7);
		expect(await statusOf(callDelete(locals, id, t.id.u2))).toBe(200);
	});

	it("refuses the system message, unknown scopes, shared ids and old-format conversations", async () => {
		const { locals } = await createTestUser();
		const t = linearTree();
		const conv = await createTestConversation(locals, {
			messages: t.messages,
			rootMessageId: t.rootMessageId,
		});
		const id = conv._id.toString();
		expect(await statusOf(callDelete(locals, id, t.id.s))).toBe(400);
		expect(await statusOf(callDelete(locals, id, t.id.u2, "all"))).toBe(400);
		expect(await statusOf(callDelete(locals, "abcdefg", t.id.u2))).toBe(400);
		const legacy = await createTestConversation(locals, {
			messages: t.messages,
			rootMessageId: undefined,
		});
		expect(await statusOf(callDelete(locals, legacy._id.toString(), t.id.u2))).toBe(400);
		// another user's conversation is not found
		const other = await createTestUser();
		expect(await statusOf(callDelete(other.locals, id, t.id.u2))).toBe(404);
	});

	it("deletes only the files no remaining message uses", async () => {
		const { locals } = await createTestUser();
		// a2 made "out2"; u3 marked that output, so its copy has the same sha; u2 uploaded "photo"
		const t = linearTree({ files: { u2: ["photo"], a2: ["out2"], u3: ["out2", "layer"] } });
		const conv = await createTestConversation(locals, {
			messages: t.messages,
			rootMessageId: t.rootMessageId,
		});
		const id = conv._id.toString();
		for (const sha of ["photo", "out2", "layer"]) await storeFile(id, sha);
		await storeFile(id, "photo"); // uploads are not deduplicated: both copies must go

		await callDelete(locals, id, t.id.u2);
		// photo was only used by the deleted turn; out2 is still used by u3's markup copy
		expect(await storedShas(id)).toEqual(["layer", "out2"]);

		await callDelete(locals, id, t.id.u3);
		expect(await storedShas(id)).toEqual([]);
	});

	it("throws 404 for non-existent message", async () => {
		const { locals } = await createTestUser();
		const tree = buildMessageTree();

		const conv = await createTestConversation(locals, {
			messages: tree.messages,
			rootMessageId: tree.rootId,
		});

		const fakeMessageId = v4();

		try {
			await callDelete(locals, conv._id.toString(), fakeMessageId);
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it("throws 401 for unauthenticated request", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });

		try {
			await callDelete(locals, new ObjectId().toString(), v4());
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(401);
		}
	});

	it("preserves unrelated messages in the tree", async () => {
		const { locals } = await createTestUser();
		const tree = buildMessageTree();

		const conv = await createTestConversation(locals, {
			messages: tree.messages,
			rootMessageId: tree.rootId,
		});

		// Delete msg3 (a prompt without a reply yet) -> only msg3 goes, everything else stays
		const res = await callDelete(locals, conv._id.toString(), tree.msg3Id);

		expect(res.status).toBe(200);

		const updated = await collections.conversations.findOne({ _id: conv._id });
		const remainingIds = (updated?.messages ?? []).map((m) => m.id);

		expect(remainingIds).toHaveLength(4);
		expect(remainingIds).toContain(tree.rootId);
		expect(remainingIds).toContain(tree.msg1Id);
		expect(remainingIds).toContain(tree.msg2Id);
		expect(remainingIds).toContain(tree.unrelatedId);
		expect(remainingIds).not.toContain(tree.msg3Id);

		// msg2's children should no longer include msg3Id
		const msg2 = updated?.messages.find((m) => m.id === tree.msg2Id);
		expect(msg2?.children).not.toContain(tree.msg3Id);
	});
});
