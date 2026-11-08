import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { logger } from "$lib/server/logger";
import { AbortRegistry } from "$lib/server/abortRegistry";
import { ObjectId } from "mongodb";
import type { Message } from "$lib/types/Message";
import { turnStateOf } from "$lib/utils/generationState";
import { deleteTurn, DeleteTurnError, type DeleteScope } from "$lib/utils/tree/deleteTurn";

const SCOPES: readonly DeleteScope[] = ["turn", "after"];

/** A reply that is running, waiting, or parked for input can still write the conversation. */
function hasLiveTurn(messages: Message[]) {
	return messages.some((m) => {
		if (m.from !== "assistant" || m.interrupted === true) return false;
		const state = turnStateOf(m)?.state;
		return state === "running" || state === "waiting" || state === "awaiting_input";
	});
}

/**
 * Turn states every pod writes. A `running` row is only trusted while its run's generation record
 * is still running: the reaper and a crashed or failed run leave the row at `running` but move the
 * generation on, and a stale row must not make the conversation undeletable. Parked turns
 * (`waiting`, `awaiting_input`) count as live; abandoning them is handled elsewhere.
 */
async function hasLiveTurnState(conversationId: ObjectId) {
	const rows = await collections.turnStates
		.find({ conversationId, status: { $in: ["running", "waiting", "awaiting_input"] } })
		.toArray();
	for (const row of rows) {
		if (row.status !== "running") return true;
		const run = await collections.generations.findOne({
			generationId: row.producerId,
			status: "running",
		});
		if (run) return true;
	}
	return false;
}

/** Files only the removed messages referenced. Shares keep their own copies. */
function unreferencedShas(removed: Message[], remaining: Message[]) {
	const shas = (messages: Message[]) =>
		messages.flatMap((m) => (m.files ?? []).filter((f) => f.type === "hash").map((f) => f.value));
	const kept = new Set(shas(remaining));
	return [...new Set(shas(removed))].filter((sha) => !kept.has(sha));
}

/**
 * Delete a turn: a user message and every version of its reply (called on any of them). `?scope=`:
 * - `turn` (default): remove the turn, keep and reattach what came after it
 * - `after`: remove the turn and everything after it
 * See $lib/utils/tree/deleteTurn for the tree rules.
 */
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	const messageId = params.messageId ?? "";
	const scope = (url.searchParams.get("scope") ?? "turn") as DeleteScope;
	if (!SCOPES.includes(scope)) error(400, "Invalid scope");
	if (!ObjectId.isValid(id) || id.length !== 24) error(400, "Invalid conversation ID");
	const convId = new ObjectId(id);

	// The stored document as it is (no legacy conversion, no shared-link lookup)
	const conv = await collections.conversations.findOne({ _id: convId, ...authCondition(locals) });
	if (!conv) error(404, "Conversation not found");

	// A run rewrites the whole messages array when it saves, which would bring deleted messages back.
	// Three signals: a send on this pod (from before its first read to its last save), the turn
	// states every pod writes (before the run's first save), and the states saved in the messages.
	if (
		AbortRegistry.getInstance().isBusy(id) ||
		(await hasLiveTurnState(convId)) ||
		hasLiveTurn(conv.messages)
	) {
		error(409, "A reply is still being generated in this conversation. Delete after it finishes.");
	}

	let result: ReturnType<typeof deleteTurn<Message>>;
	try {
		result = deleteTurn(conv, messageId, scope);
	} catch (err) {
		if (err instanceof DeleteTurnError) error(err.status, err.message);
		logger.error(
			{ err, conversationId: id, messageId, scope },
			"[delete message] inconsistent tree"
		);
		error(500, "Could not delete the message");
	}

	// Compare-and-set on updatedAt: a save that landed after our read wins, and we report a conflict
	const res = await collections.conversations.updateOne(
		{ _id: convId, ...authCondition(locals), updatedAt: conv.updatedAt },
		{ $set: { messages: result.messages, updatedAt: new Date() } }
	);
	if (res.matchedCount === 0) {
		error(409, "The conversation changed while deleting. Reload and try again.");
	}

	// Best effort: a leftover file is harmless and the cleanup script catches it later
	const shas = unreferencedShas(result.removed, result.messages);
	for (const sha of shas) {
		try {
			const files = await collections.bucket.find({ filename: `${id}-${sha}` }).toArray();
			for (const file of files) await collections.bucket.delete(file._id);
		} catch (err) {
			logger.warn({ err, conversationId: id, sha }, "[delete message] file cleanup failed");
		}
	}

	logger.info(
		{
			conversationId: id,
			messageId,
			scope,
			removed: result.removed.length,
			filesRemoved: shas.length,
		},
		"[delete message] done"
	);
	return superjsonResponse({
		success: true,
		removedIds: result.removed.map((m) => m.id),
		fallbackId: result.fallbackId,
	});
};
