import { compress as headroomCompress, simulate as headroomSimulate, HeadroomClient } from "headroom-ai"
import type {
	CompressOptions,
	CompressResult,
	RetrieveResult,
	RetrieveSearchResult,
	SimulateOptions,
	SimulationResult,
} from "headroom-ai"

import type { AgentPluginLike, PluginSetupApi, PluginToolDefinition } from "./types.js"
import { CompressionStats, summariseSimulation, toPercent } from "./stats.js"
import { estimateTokens, findMessagesContainer } from "./context.js"

/**
 * The Headroom functions the plugin depends on. Injectable so the tools can be
 * unit-tested deterministically without a running Headroom proxy.
 */
export interface HeadroomDeps {
	compress: (messages: any[], options?: CompressOptions) => Promise<CompressResult>
	simulate: (messages: any[], options?: SimulateOptions) => Promise<SimulationResult>
	retrieve: (hash: string, options?: { query?: string }) => Promise<RetrieveResult | RetrieveSearchResult>
}

/** Configuration for {@link createHeadroomPlugin}. */
export interface HeadroomPluginConfig {
	/** Headroom proxy / cloud base URL. Falls back to `HEADROOM_BASE_URL`. */
	baseUrl?: string
	/** Headroom Cloud API key. Falls back to `HEADROOM_API_KEY`. */
	apiKey?: string
	/** Model used for tokenisation. Falls back to `HEADROOM_MODEL`, then `gpt-4o`. */
	model?: string
	/** Default token budget applied to `headroom_compress` when none is given. */
	tokenBudget?: number
	/** Emit lifecycle logs to the console. Defaults to `false`. */
	verbose?: boolean
	/**
	 * Transparently compress oversized context before each model call via the
	 * `beforeModel` hook. Defaults to `false` (opt-in) because it mutates the
	 * outgoing request. When enabled, only contexts above
	 * {@link HeadroomPluginConfig.autoCompactThreshold} are touched, and any
	 * failure is swallowed so a model call is never blocked.
	 */
	autoCompact?: boolean
	/** Estimated-token threshold above which auto-compaction runs. Defaults to 8000. */
	autoCompactThreshold?: number
	/** Override the underlying Headroom functions (primarily for testing). */
	deps?: HeadroomDeps
}

const DEFAULT_MODEL = "gpt-4o"
const STACK_SLUG = "plugin_cline"
const DEFAULT_AUTO_COMPACT_THRESHOLD = 8000

interface CompressToolInput {
	messages?: any[]
	text?: string
	model?: string
	tokenBudget?: number
}

/** Coerce the loosely-typed tool input into messages plus echo metadata. */
function resolveMessages(input: CompressToolInput): { messages: any[]; wasText: boolean } {
	if (Array.isArray(input.messages) && input.messages.length > 0) {
		return { messages: input.messages, wasText: false }
	}
	if (typeof input.text === "string" && input.text.length > 0) {
		return { messages: [{ role: "user", content: input.text }], wasText: true }
	}
	throw new Error("Provide either a non-empty `messages` array or a non-empty `text` string.")
}

/** Pull the first textual content out of a compressed message list. */
function firstText(messages: any[]): string {
	const content = messages[0]?.content
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("")
	}
	return ""
}

/**
 * Build a Headroom-backed Cline plugin.
 *
 * Registers three tools — `headroom_compress`, `headroom_simulate`, and
 * `headroom_stats` — that let the agent shrink large context (tool outputs,
 * logs, RAG chunks, transcripts) before it is sent to the model, and report on
 * the savings. All compression runs locally through the Headroom proxy.
 */
export function createHeadroomPlugin(config: HeadroomPluginConfig = {}): AgentPluginLike {
	const baseUrl = config.baseUrl ?? process.env.HEADROOM_BASE_URL
	const apiKey = config.apiKey ?? process.env.HEADROOM_API_KEY
	const model = config.model ?? process.env.HEADROOM_MODEL ?? DEFAULT_MODEL
	const defaultTokenBudget = config.tokenBudget
	const verbose = config.verbose ?? false
	const autoCompact = config.autoCompact ?? false
	const autoCompactThreshold = config.autoCompactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD

	const deps: HeadroomDeps =
		config.deps ??
		(() => {
			// A single client instance backs `retrieve` (and could back health
			// checks later). `compress`/`simulate` use the standalone functions so
			// they keep their automatic multi-format detection.
			const client = new HeadroomClient({ baseUrl, apiKey })
			return {
				compress: headroomCompress,
				simulate: headroomSimulate,
				retrieve: (hash, options) => client.retrieve(hash, options),
			}
		})()

	const stats = new CompressionStats()

	const log = (message: string): void => {
		if (verbose) {
			console.log(`[headroom] ${message}`)
		}
	}

	const baseOptions = (overrides: { model?: string; tokenBudget?: number }): CompressOptions => ({
		model: overrides.model ?? model,
		baseUrl,
		apiKey,
		tokenBudget: overrides.tokenBudget ?? defaultTokenBudget,
		stack: STACK_SLUG,
	})

	const compressTool: PluginToolDefinition = {
		name: "headroom_compress",
		description:
			"Compress large context with Headroom before reasoning over it. Accepts either a " +
			"`messages` array (OpenAI chat format) or a raw `text` string — useful for shrinking " +
			"verbose tool outputs, logs, RAG chunks, or transcripts. Returns the compressed content " +
			"in the same shape it was given, plus token savings. Compression is reversible (originals " +
			"are retrievable via Headroom CCR).",
		inputSchema: {
			type: "object",
			properties: {
				messages: {
					type: "array",
					description: "Messages in OpenAI chat format ({ role, content }) to compress.",
					items: { type: "object" },
				},
				text: {
					type: "string",
					description: "A raw text blob to compress. Use instead of `messages` for unstructured content.",
				},
				model: {
					type: "string",
					description: "Model name used for tokenisation. Defaults to the plugin's configured model.",
				},
				tokenBudget: {
					type: "number",
					description: "Optional target token budget — compress to fit within this limit.",
				},
			},
			additionalProperties: false,
		},
		timeoutMs: 30_000,
		retryable: false,
		async execute(rawInput) {
			const input = (rawInput ?? {}) as CompressToolInput
			const { messages, wasText } = resolveMessages(input)

			const result = await deps.compress(
				messages,
				baseOptions({ model: input.model, tokenBudget: input.tokenBudget }),
			)
			stats.record(result)
			log(
				`compressed ${result.tokensBefore} -> ${result.tokensAfter} tokens ` +
					`(${toPercent(result.compressionRatio === 0 ? 0 : 1 - result.compressionRatio)}% saved)`,
			)

			const summary = {
				compressed: result.compressed,
				tokensBefore: result.tokensBefore,
				tokensAfter: result.tokensAfter,
				tokensSaved: result.tokensSaved,
				compressionRatio: result.compressionRatio,
				savingsPercent: result.tokensBefore > 0 ? toPercent(result.tokensSaved / result.tokensBefore) : 0,
				transformsApplied: result.transformsApplied,
				ccrHashes: result.ccrHashes,
			}

			return wasText
				? { ...summary, text: firstText(result.messages) }
				: { ...summary, messages: result.messages }
		},
	}

	const simulateTool: PluginToolDefinition = {
		name: "headroom_simulate",
		description:
			"Dry-run Headroom compression without modifying anything. Reports how many tokens would " +
			"be saved, which transforms would apply, detected waste signals, and the cache-alignment " +
			"score. Use this to decide whether compressing a payload is worthwhile.",
		inputSchema: {
			type: "object",
			properties: {
				messages: {
					type: "array",
					description: "Messages in OpenAI chat format ({ role, content }) to simulate.",
					items: { type: "object" },
				},
				text: {
					type: "string",
					description: "A raw text blob to simulate compression for.",
				},
				model: {
					type: "string",
					description: "Model name used for tokenisation. Defaults to the plugin's configured model.",
				},
			},
			additionalProperties: false,
		},
		timeoutMs: 30_000,
		retryable: false,
		async execute(rawInput) {
			const input = (rawInput ?? {}) as CompressToolInput
			const { messages } = resolveMessages(input)
			const sim = await deps.simulate(messages, {
				model: input.model ?? model,
				baseUrl,
				apiKey,
			} as SimulateOptions)
			return summariseSimulation(sim)
		},
	}

	const statsTool: PluginToolDefinition = {
		name: "headroom_stats",
		description:
			"Report cumulative Headroom compression savings for the current session: number of " +
			"compress calls, total tokens before/after, total tokens saved, and the aggregate savings " +
			"percentage.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		retryable: false,
		async execute() {
			return stats.snapshot()
		},
	}

	const retrieveTool: PluginToolDefinition = {
		name: "headroom_retrieve",
		description:
			"Retrieve the original, uncompressed content behind a CCR hash returned by " +
			"`headroom_compress` (the `ccrHashes` field). Use this when the compressed summary omits " +
			"a detail you now need. Pass an optional `query` to search within the original content " +
			"instead of returning all of it.",
		inputSchema: {
			type: "object",
			properties: {
				hash: {
					type: "string",
					description: "A CCR hash from a prior headroom_compress result's `ccrHashes`.",
				},
				query: {
					type: "string",
					description: "Optional search query to scope the retrieved original content.",
				},
			},
			required: ["hash"],
			additionalProperties: false,
		},
		timeoutMs: 30_000,
		retryable: false,
		async execute(rawInput) {
			const input = (rawInput ?? {}) as { hash?: string; query?: string }
			if (typeof input.hash !== "string" || input.hash.length === 0) {
				throw new Error("Provide a `hash` from a prior headroom_compress result's `ccrHashes`.")
			}
			return deps.retrieve(input.hash, input.query ? { query: input.query } : undefined)
		},
	}

	/**
	 * Transparently compress oversized model context. Defensive by design: it
	 * locates a `messages` array on the hook context, only acts above the
	 * configured threshold, and never throws — a failure leaves the request
	 * untouched rather than blocking the model call.
	 */
	const autoCompactModel = async (context: unknown): Promise<void> => {
		if (!autoCompact) {
			return
		}
		try {
			const container = findMessagesContainer(context)
			if (!container) {
				log("auto-compact skipped: no messages array on model context")
				return
			}
			const estimated = estimateTokens(container.messages)
			if (estimated < autoCompactThreshold) {
				return
			}
			const result = await deps.compress(
				container.messages,
				baseOptions({ tokenBudget: defaultTokenBudget }),
			)
			if (result.compressed && Array.isArray(result.messages)) {
				container.replace(result.messages)
				stats.record(result)
				log(`auto-compacted model context ${result.tokensBefore} -> ${result.tokensAfter} tokens`)
			}
		} catch (error) {
			log(`auto-compact skipped: ${(error as Error).message}`)
		}
	}

	return {
		name: "headroom",
		manifest: {
			capabilities: ["tools", "hooks"],
		},
		setup(api: PluginSetupApi) {
			api.registerTool(compressTool)
			api.registerTool(simulateTool)
			api.registerTool(statsTool)
			api.registerTool(retrieveTool)
		},
		hooks: {
			beforeRun() {
				log("run started")
			},
			beforeModel(context) {
				return autoCompactModel(context)
			},
			afterRun() {
				const snapshot = stats.snapshot()
				log(
					`run complete — ${snapshot.calls} compressions, ` +
						`${snapshot.tokensSaved} tokens saved (${snapshot.savingsPercent}%)`,
				)
			},
		},
	}
}

/**
 * Default plugin instance configured entirely from the environment
 * (`HEADROOM_BASE_URL`, `HEADROOM_API_KEY`, `HEADROOM_MODEL`). This is what the
 * Cline host loads when installing the plugin via the CLI.
 */
const plugin: AgentPluginLike = createHeadroomPlugin()

export default plugin
export { plugin }
export { CompressionStats } from "./stats.js"
export type { CompressionStatsSnapshot } from "./stats.js"
export type { AgentPluginLike } from "./types.js"
