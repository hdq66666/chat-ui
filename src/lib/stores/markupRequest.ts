import { writable } from "svelte/store";

/**
 * Markup-guided edits on images already in the conversation (e.g. a generated
 * image in a reply). ChatWindow owns the editor and the composer, so messages
 * post a request here instead of threading callbacks through the tree.
 */
export interface MarkupRequest {
	/** File name the image is attached under */
	name: string;
	/** Same-origin URL (or data URL) the editor loads and the attachment is fetched from */
	src: string;
}

export const markupRequest = writable<MarkupRequest | undefined>(undefined);

/** True while the current model is an image model, i.e. while a markup edit can be sent */
export const markupEditingAvailable = writable(false);

/**
 * One-shot: the next message to an image model generates from scratch instead
 * of editing the previous image. Set by the toggle in ChatWindow, read and
 * cleared by the conversation page when it sends.
 */
export const imageFreshNext = writable(false);
