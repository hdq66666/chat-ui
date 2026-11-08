import type { Tree, TreeId, TreeNode } from "./tree";

/**
 * Deleting messages from a conversation tree.
 *
 * The unit is a turn: a user message and all of its direct replies (retries included). Removing a
 * single user message would leave replies without a prompt, and removing the only reply would
 * leave a prompt that cannot be retried; both break the user/assistant alternation that chat
 * templates and the image follow-up logic rely on. Scopes:
 *
 * - "turn": remove the turn and keep what came after it. The next user messages (children of the
 *   removed replies) are attached to the turn's parent in its place, so later requests are built
 *   from a history that no longer contains the turn. Same model as Open WebUI's message delete
 *   (removes the message and its direct children, reparents the grandchildren).
 * - "after": remove the turn and everything after it on its branches.
 * - "reply": remove one reply version and the branch that continues from it, when the prompt has
 *   other reply versions (retries) left.
 *
 * Every remaining message keeps its `ancestors` as a root path (removed ids filtered out) and its
 * `children` list without removed ids; the result is checked for consistency before returning.
 */
export type DeleteScope = "turn" | "after" | "reply";

type Node = TreeNode<{ from: string }>;

export class DeleteTurnError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404
	) {
		super(message);
	}
}

export interface TurnDeletionInfo {
	/** The user message of the turn */
	userId: TreeId;
	/** The message the turn hangs from (system root or the previous reply) */
	parentId: TreeId;
	/** Reply versions of the turn */
	replyCount: number;
	/** Messages after the turn (all branches) */
	laterCount: number;
	/** Set when called on a reply that has sibling versions: what "reply" would remove */
	reply?: { id: TreeId; count: number };
}

function byId<T extends Node>(messages: readonly T[]) {
	return new Map(messages.map((m) => [m.id, m]));
}

const parentOf = (m: Node) => m.ancestors?.at(-1);

function descendantsOf<T extends Node>(messages: readonly T[], id: TreeId): T[] {
	return messages.filter((m) => m.ancestors?.includes(id));
}

/** What deleting the turn of `messageId` would involve (for the confirmation dialog). */
export function describeTurnDeletion<T extends Node>(
	conv: Tree<T>,
	messageId: TreeId
): TurnDeletionInfo {
	if (!conv.rootMessageId) {
		throw new DeleteTurnError("Messages of old-format conversations cannot be deleted", 400);
	}
	const map = byId(conv.messages);
	const msg = map.get(messageId);
	if (!msg) throw new DeleteTurnError("Message not found", 404);

	const user = msg.from === "assistant" ? map.get(parentOf(msg) ?? "") : msg;
	if (!user || user.from !== "user") {
		throw new DeleteTurnError("Only user messages and their replies can be deleted", 400);
	}
	const parentId = parentOf(user);
	if (!parentId || !map.has(parentId)) {
		throw new DeleteTurnError("The first message of a conversation cannot be deleted", 400);
	}

	const replies = (user.children ?? []).filter((id) => map.has(id));
	const laterCount = descendantsOf(conv.messages, user.id).length - replies.length;
	const info: TurnDeletionInfo = {
		userId: user.id,
		parentId,
		replyCount: replies.length,
		laterCount,
	};
	if (msg.from === "assistant" && replies.length > 1) {
		info.reply = { id: msg.id, count: 1 + descendantsOf(conv.messages, msg.id).length };
	}
	return info;
}

/**
 * Plan and apply a deletion. Returns the new message list (input untouched), the removed
 * messages, and the message the current branch should fall back to if its leaf was removed.
 */
export function deleteTurn<T extends Node>(
	conv: Tree<T>,
	messageId: TreeId,
	scope: DeleteScope
): { messages: T[]; removed: T[]; fallbackId: TreeId } {
	const info = describeTurnDeletion(conv, messageId);
	const map = byId(conv.messages);
	const user = map.get(info.userId) as T;
	const replies = (user.children ?? []).filter((id) => map.has(id));

	const removed = new Set<TreeId>();
	let replacement: TreeId[] = [];
	let detachFrom = info.parentId;
	let detachId = user.id;
	let fallbackId = info.parentId;

	if (scope === "reply") {
		if (!info.reply) {
			throw new DeleteTurnError("This reply has no other version; delete the turn instead", 400);
		}
		removed.add(info.reply.id);
		for (const m of descendantsOf(conv.messages, info.reply.id)) removed.add(m.id);
		detachFrom = user.id;
		detachId = info.reply.id;
		fallbackId = user.id;
	} else {
		removed.add(user.id);
		for (const id of replies) removed.add(id);
		if (scope === "after") {
			for (const m of descendantsOf(conv.messages, user.id)) removed.add(m.id);
		} else if (scope === "turn") {
			// the next prompts take the turn's place under its parent, in order
			replacement = replies.flatMap((id) => map.get(id)?.children ?? []);
		} else {
			throw new DeleteTurnError("Unknown scope", 400);
		}
	}

	const messages = conv.messages
		.filter((m) => !removed.has(m.id))
		.map((m) => {
			const next = { ...m } as T;
			if (m.ancestors) next.ancestors = m.ancestors.filter((id) => !removed.has(id));
			if (m.children) {
				next.children =
					m.id === detachFrom
						? m.children.flatMap((id) => (id === detachId ? replacement : [id]))
						: [...m.children];
				next.children = next.children.filter((id) => !removed.has(id));
			}
			return next;
		});

	assertConsistent({ rootMessageId: conv.rootMessageId, messages });
	return { messages, removed: conv.messages.filter((m) => removed.has(m.id)), fallbackId };
}

/** Every reference resolves, and parent/child links agree in both directions. */
export function assertConsistent<T extends Node>(conv: Tree<T>) {
	const map = byId(conv.messages);
	if (conv.rootMessageId && !map.has(conv.rootMessageId)) throw new Error("Root message missing");
	for (const m of conv.messages) {
		for (const id of m.ancestors ?? []) {
			if (!map.has(id)) throw new Error(`Message ${m.id} has a missing ancestor ${id}`);
		}
		const parentId = parentOf(m);
		if (parentId && !map.get(parentId)?.children?.includes(m.id)) {
			throw new Error(`Message ${m.id} is not among its parent's children`);
		}
		for (const id of m.children ?? []) {
			const child = map.get(id);
			if (!child) throw new Error(`Message ${m.id} has a missing child ${id}`);
			if (parentOf(child) !== m.id) throw new Error(`Child ${id} does not point back to ${m.id}`);
		}
	}
}
