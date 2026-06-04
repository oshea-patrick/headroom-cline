import { describe, expect, it, vi } from "vitest"

import { createHeadroomPlugin, type HeadroomDeps } from "../src/index.js"
import type { AgentPluginLike } from "../src/index.js"
import type { PluginToolDefinition } from "../src/types.js"
import { estimateTokens, findMessagesContainer } from "../src/context.js"
import type { CompressResult, RetrieveResult, SimulationResult } from "headroom-ai"

interface ToolRegistry {
	get(name: string): PluginToolDefinition
	keys(): IterableIterator<string>
}

/** Collects tools registered by a plugin's `setup()` for assertions. */
function collectTools(plugin: AgentPluginLike): ToolRegistry {
	const tools = new Map<string, PluginToolDefinition>()
	plugin.setup({
		registerTool: (tool) => {
			tools.set(tool.name, tool)
		},
	})
	return {
		get(name: string): PluginToolDefinition {
			const found = tools.get(name)
			if (!found) {
				throw new Error(`tool not registered: ${name}`)
			}
			return found
		},
		keys: () => tools.keys(),
	}
}

function makeCompressResult(overrides: Partial<CompressResult> = {}): CompressResult {
	return {
		messages: [{ role: "user", content: "short" }],
		tokensBefore: 1000,
		tokensAfter: 200,
		tokensSaved: 800,
		compressionRatio: 0.2,
		transformsApplied: ["smart_crusher"],
		ccrHashes: ["abc123"],
		compressed: true,
		...overrides,
	}
}

function makeSimulationResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
	return {
		tokensBefore: 1000,
		tokensAfter: 250,
		tokensSaved: 750,
		transforms: ["smart_crusher"],
		estimatedSavings: "75%",
		messagesOptimized: [],
		blockBreakdown: { json: 1 },
		wasteSignals: { duplication: 0.4 },
		stablePrefixHash: "deadbeef",
		cacheAlignmentScore: 0.9,
		...overrides,
	}
}

function makeRetrieveResult(overrides: Partial<RetrieveResult> = {}): RetrieveResult {
	return {
		hash: "abc123",
		originalContent: "the full original tool output",
		originalTokens: 1000,
		originalItemCount: 50,
		compressedItemCount: 10,
		toolName: "list_files",
		retrievalCount: 1,
		...overrides,
	}
}

/** Build a plugin with stubbed Headroom deps, returning the spies too. */
function buildPlugin(deps: Partial<HeadroomDeps> = {}) {
	const compress =
		deps.compress ?? vi.fn<HeadroomDeps["compress"]>(async () => makeCompressResult())
	const simulate =
		deps.simulate ?? vi.fn<HeadroomDeps["simulate"]>(async () => makeSimulationResult())
	const retrieve =
		deps.retrieve ?? vi.fn<HeadroomDeps["retrieve"]>(async () => makeRetrieveResult())
	const plugin = createHeadroomPlugin({ deps: { compress, simulate, retrieve } })
	return { plugin, compress, simulate, retrieve, tools: collectTools(plugin) }
}

describe("createHeadroomPlugin", () => {
	it("declares the expected name, capabilities and hooks", () => {
		const { plugin } = buildPlugin()
		expect(plugin.name).toBe("headroom")
		expect(plugin.manifest.capabilities).toEqual(["tools", "hooks"])
		expect(typeof plugin.hooks?.beforeRun).toBe("function")
		expect(typeof plugin.hooks?.afterRun).toBe("function")
	})

	it("registers all four Headroom tools", () => {
		const { tools } = buildPlugin()
		expect([...tools.keys()].sort()).toEqual([
			"headroom_compress",
			"headroom_retrieve",
			"headroom_simulate",
			"headroom_stats",
		])
	})
})

describe("headroom_compress", () => {
	it("compresses a messages array and returns savings plus compressed messages", async () => {
		const result = makeCompressResult()
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => result)
		const { tools } = buildPlugin({ compress })

		const input = { messages: [{ role: "user", content: "a very long message ".repeat(50) }] }
		const output = (await tools.get("headroom_compress").execute(input)) as Record<string, unknown>

		expect(compress).toHaveBeenCalledOnce()
		expect(compress.mock.calls[0][0]).toBe(input.messages)
		expect(output.tokensSaved).toBe(800)
		expect(output.savingsPercent).toBe(80)
		expect(output.messages).toEqual(result.messages)
		expect(output).not.toHaveProperty("text")
	})

	it("wraps a raw text blob and returns compressed text", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () =>
			makeCompressResult({ messages: [{ role: "user", content: "tight" }] }),
		)
		const { tools } = buildPlugin({ compress })

		const output = (await tools.get("headroom_compress").execute({ text: "huge log output" })) as Record<
			string,
			unknown
		>

		const sentMessages = compress.mock.calls[0][0] as any[]
		expect(sentMessages).toEqual([{ role: "user", content: "huge log output" }])
		expect(output.text).toBe("tight")
		expect(output).not.toHaveProperty("messages")
	})

	it("forwards model and tokenBudget overrides to Headroom", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => makeCompressResult())
		const { tools } = buildPlugin({ compress })

		await tools.get("headroom_compress").execute({
			text: "data",
			model: "claude-sonnet-4-5",
			tokenBudget: 2000,
		})

		const options = compress.mock.calls[0][1] as Record<string, unknown>
		expect(options.model).toBe("claude-sonnet-4-5")
		expect(options.tokenBudget).toBe(2000)
		expect(options.stack).toBe("plugin_cline")
	})

	it("throws when neither messages nor text is supplied", async () => {
		const { tools } = buildPlugin()
		await expect(tools.get("headroom_compress").execute({})).rejects.toThrow(/messages.*or.*text/i)
	})

	it("throws on an empty messages array", async () => {
		const { tools } = buildPlugin()
		await expect(tools.get("headroom_compress").execute({ messages: [] })).rejects.toThrow()
	})
})

describe("headroom_simulate", () => {
	it("returns a serialisable simulation summary", async () => {
		const simulate = vi.fn<HeadroomDeps["simulate"]>(async () => makeSimulationResult())
		const { tools } = buildPlugin({ simulate })

		const output = (await tools.get("headroom_simulate").execute({ text: "payload" })) as Record<
			string,
			unknown
		>

		expect(simulate).toHaveBeenCalledOnce()
		expect(output.tokensSaved).toBe(750)
		expect(output.estimatedSavings).toBe("75%")
		expect(output.transforms).toEqual(["smart_crusher"])
		expect(output.cacheAlignmentScore).toBe(0.9)
		// Should not leak internal-only fields.
		expect(output).not.toHaveProperty("messagesOptimized")
		expect(output).not.toHaveProperty("stablePrefixHash")
	})
})

describe("headroom_stats", () => {
	it("starts at zero", async () => {
		const { tools } = buildPlugin()
		const snapshot = (await tools.get("headroom_stats").execute({})) as Record<string, number>
		expect(snapshot).toMatchObject({ calls: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, savingsPercent: 0 })
	})

	it("accumulates totals across multiple compressions", async () => {
		const compress = vi
			.fn<HeadroomDeps["compress"]>()
			.mockResolvedValueOnce(makeCompressResult({ tokensBefore: 1000, tokensAfter: 200, tokensSaved: 800 }))
			.mockResolvedValueOnce(makeCompressResult({ tokensBefore: 500, tokensAfter: 300, tokensSaved: 200 }))
		const { tools } = buildPlugin({ compress })

		await tools.get("headroom_compress").execute({ text: "one" })
		await tools.get("headroom_compress").execute({ text: "two" })

		const snapshot = (await tools.get("headroom_stats").execute({})) as Record<string, number>
		expect(snapshot.calls).toBe(2)
		expect(snapshot.tokensBefore).toBe(1500)
		expect(snapshot.tokensAfter).toBe(500)
		expect(snapshot.tokensSaved).toBe(1000)
		// 1000 / 1500 ≈ 67%
		expect(snapshot.savingsPercent).toBe(67)
	})
})

describe("lifecycle hooks", () => {
	it("are observational and never throw", async () => {
		const { plugin } = buildPlugin()
		await expect(Promise.resolve(plugin.hooks?.beforeRun?.())).resolves.not.toThrow()
		await expect(Promise.resolve(plugin.hooks?.afterRun?.())).resolves.not.toThrow()
	})
})

describe("headroom_retrieve", () => {
	it("retrieves original content by hash", async () => {
		const retrieve = vi.fn<HeadroomDeps["retrieve"]>(async () => makeRetrieveResult())
		const { tools } = buildPlugin({ retrieve })

		const output = (await tools.get("headroom_retrieve").execute({ hash: "abc123" })) as RetrieveResult

		expect(retrieve).toHaveBeenCalledWith("abc123", undefined)
		expect(output.originalContent).toBe("the full original tool output")
	})

	it("forwards an optional query for scoped retrieval", async () => {
		const retrieve = vi.fn<HeadroomDeps["retrieve"]>(async () => makeRetrieveResult())
		const { tools } = buildPlugin({ retrieve })

		await tools.get("headroom_retrieve").execute({ hash: "abc123", query: "error" })

		expect(retrieve).toHaveBeenCalledWith("abc123", { query: "error" })
	})

	it("throws when no hash is supplied", async () => {
		const { tools } = buildPlugin()
		await expect(tools.get("headroom_retrieve").execute({})).rejects.toThrow(/hash/i)
	})
})

describe("beforeModel auto-compaction", () => {
	const bigMessages = () => [{ role: "user", content: "x".repeat(40_000) }]

	function autoPlugin(overrides: Record<string, unknown>, compress: HeadroomDeps["compress"]) {
		return createHeadroomPlugin({
			...overrides,
			deps: {
				compress,
				simulate: vi.fn<HeadroomDeps["simulate"]>(),
				retrieve: vi.fn<HeadroomDeps["retrieve"]>(),
			},
		})
	}

	it("is disabled by default — never compresses", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => makeCompressResult())
		const plugin = autoPlugin({}, compress)
		const context = { messages: bigMessages() }
		await plugin.hooks?.beforeModel?.(context)
		expect(compress).not.toHaveBeenCalled()
	})

	it("compresses and rewrites oversized context when enabled", async () => {
		const compressed = [{ role: "user", content: "tiny" }]
		const compress = vi.fn<HeadroomDeps["compress"]>(async () =>
			makeCompressResult({ messages: compressed, tokensBefore: 10_000, tokensAfter: 500, tokensSaved: 9_500 }),
		)
		const plugin = autoPlugin({ autoCompact: true, autoCompactThreshold: 1_000 }, compress)
		const context = { messages: bigMessages() }
		await plugin.hooks?.beforeModel?.(context)

		expect(compress).toHaveBeenCalledOnce()
		expect(context.messages).toEqual(compressed)
	})

	it("leaves small context untouched", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => makeCompressResult())
		const plugin = autoPlugin({ autoCompact: true, autoCompactThreshold: 100_000 }, compress)
		const original = [{ role: "user", content: "hi" }]
		const context = { messages: original }
		await plugin.hooks?.beforeModel?.(context)

		expect(compress).not.toHaveBeenCalled()
		expect(context.messages).toBe(original)
	})

	it("fails open — a compress error never throws or mutates", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => {
			throw new Error("proxy down")
		})
		const plugin = autoPlugin({ autoCompact: true, autoCompactThreshold: 1_000 }, compress)
		const original = bigMessages()
		const context = { messages: original }
		await expect(plugin.hooks?.beforeModel?.(context)).resolves.not.toThrow()
		expect(context.messages).toBe(original)
	})

	it("no-ops when the context has no messages array", async () => {
		const compress = vi.fn<HeadroomDeps["compress"]>(async () => makeCompressResult())
		const plugin = autoPlugin({ autoCompact: true, autoCompactThreshold: 1 }, compress)
		await expect(plugin.hooks?.beforeModel?.({ foo: "bar" })).resolves.not.toThrow()
		expect(compress).not.toHaveBeenCalled()
	})
})

describe("context helpers", () => {
	it("finds messages nested under common holders", () => {
		const nested = { request: { messages: [{ role: "user", content: "hi" }] } }
		const container = findMessagesContainer(nested)
		expect(container?.messages).toBe(nested.request.messages)
		container?.replace([{ role: "user", content: "bye" }])
		expect(nested.request.messages).toEqual([{ role: "user", content: "bye" }])
	})

	it("returns undefined when no messages array exists", () => {
		expect(findMessagesContainer({ foo: 1 })).toBeUndefined()
		expect(findMessagesContainer(null)).toBeUndefined()
	})

	it("estimates tokens from string and structured content", () => {
		const messages = [
			{ role: "user", content: "a".repeat(40) },
			{ role: "assistant", content: [{ type: "text", text: "b".repeat(40) }] },
		]
		// 80 chars / 4 = 20 tokens
		expect(estimateTokens(messages)).toBe(20)
	})
})
