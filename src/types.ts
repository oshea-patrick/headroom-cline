/**
 * Minimal local mirrors of the Cline plugin host interface.
 *
 * The real types live in `@cline/sdk` / `@cline/core`, which are provided by the
 * Cline runtime at install time and are NOT bundled with this plugin. Declaring
 * them locally keeps the plugin dependency-free (apart from `headroom-ai`) and
 * lets the test suite run without the host present. The shapes intentionally
 * match the subset of the host API this plugin relies on.
 */

/** A tool the model can call, as accepted by `api.registerTool`. */
export interface PluginToolDefinition {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	timeoutMs?: number
	retryable?: boolean
	execute: (input: unknown, context?: unknown) => Promise<unknown>
}

/** The subset of the setup API surface this plugin uses. */
export interface PluginSetupApi {
	registerTool: (tool: PluginToolDefinition) => void
}

/** Lifecycle hook handlers (all observational here). */
export interface PluginHooks {
	beforeRun?: (context?: unknown) => void | Promise<void>
	afterRun?: (context?: unknown) => void | Promise<void>
	beforeModel?: (context?: unknown) => void | Promise<void>
	afterModel?: (context?: unknown) => void | Promise<void>
	beforeTool?: (context?: unknown) => void | Promise<void>
	afterTool?: (context?: unknown) => void | Promise<void>
}

/** An `AgentPlugin` as understood by the Cline host. */
export interface AgentPluginLike {
	name: string
	manifest: { capabilities: string[] }
	setup: (api: PluginSetupApi, ctx?: unknown) => void
	hooks?: PluginHooks
}
