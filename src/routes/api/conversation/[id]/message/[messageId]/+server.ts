// Legacy path, kept for old API clients. It shares the v2 handler so it gets the same rules:
// turn-level deletion, refusal while a reply is generating, compare-and-set, and file cleanup.
export { DELETE } from "../../../../v2/conversations/[id]/message/[messageId]/+server";
