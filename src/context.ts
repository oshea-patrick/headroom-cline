/**
 * Helpers for reaching into the (host-defined, untyped) `beforeModel` hook
 * context to locate and rewrite the outgoing message list. The exact shape of
 * the context is owned by the Cline host and not part of this plugin's typed
 * surface, so these helpers probe a handful of well-known locations defensively.
 */

/** A located message array plus a way to write a replacement back in place. */
export interface MessagesContainer {
	messages: any[]
	replace: (next: any[]) => void
}

/**
 * Find the outgoing `messages` array on a model-call hook context.
 *
 * Checks the context itself and the common nested holders used by agent
 * runtimes (`request`, `params`, `body`, `input`, `model`). Returns `undefined`
 * when no message array can be found, so callers can no-op safely.
 */
export function findMessagesContainer(context: unknown): MessagesContainer | undefined {
	if (!context || typeof context !== "object") {
		return undefined
	}

	const holders: Array<Record<string, unknown>> = [context as Record<string, unknown>]
	for (const key of ["request", "params", "body", "input", "model"]) {
		const nested = (context as Record<string, unknown>)[key]
		if (nested && typeof nested === "object") {
			holders.push(nested as Record<string, unknown>)
		}
	}

	for (const holder of holders) {
		if (Array.isArray(holder.messages)) {
			return {
				messages: holder.messages as any[],
				replace: (next: any[]) => {
					holder.messages = next
				},
			}
		}
	}

	return undefined
}

/**
 * Roughly estimate the token count of a message list using a 4-chars-per-token
 * heuristic. Intentionally cheap — it only gates whether the (network) compress
 * call is worth attempting, so precision is unnecessary.
 */
export function estimateTokens(messages: any[]): number {
	let chars = 0
	for (const message of messages) {
		const content = message?.content
		if (typeof content === "string") {
			chars += content.length
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part?.text === "string") {
					chars += part.text.length
				}
			}
		}
	}
	return Math.ceil(chars / 4)
}
