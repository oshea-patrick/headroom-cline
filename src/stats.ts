import type { CompressResult, SimulationResult } from "headroom-ai"

/**
 * Running totals for compression performed through this plugin during a session.
 */
export interface CompressionStatsSnapshot {
	/** Number of successful `headroom_compress` calls. */
	calls: number
	/** Total estimated tokens before compression across all calls. */
	tokensBefore: number
	/** Total estimated tokens after compression across all calls. */
	tokensAfter: number
	/** Total tokens saved (tokensBefore - tokensAfter). */
	tokensSaved: number
	/** Aggregate savings as a fraction in the range [0, 1]. */
	savingsRatio: number
	/** Aggregate savings as a whole-number percentage (0-100). */
	savingsPercent: number
}

/**
 * Accumulates compression metrics so the agent can inspect how much Headroom has
 * saved over the course of a session via the `headroom_stats` tool.
 */
export class CompressionStats {
	private calls = 0
	private tokensBefore = 0
	private tokensAfter = 0

	/** Fold a single compression result into the running totals. */
	record(result: Pick<CompressResult, "tokensBefore" | "tokensAfter">): void {
		this.calls += 1
		this.tokensBefore += result.tokensBefore ?? 0
		this.tokensAfter += result.tokensAfter ?? 0
	}

	/** Return an immutable view of the current totals. */
	snapshot(): CompressionStatsSnapshot {
		const tokensSaved = this.tokensBefore - this.tokensAfter
		const savingsRatio = this.tokensBefore > 0 ? tokensSaved / this.tokensBefore : 0
		return {
			calls: this.calls,
			tokensBefore: this.tokensBefore,
			tokensAfter: this.tokensAfter,
			tokensSaved,
			savingsRatio,
			savingsPercent: Math.round(savingsRatio * 100),
		}
	}

	/** Reset all counters back to zero. */
	reset(): void {
		this.calls = 0
		this.tokensBefore = 0
		this.tokensAfter = 0
	}
}

/** Convert a fraction in [0, 1] to a whole-number percentage. */
export function toPercent(ratio: number): number {
	return Math.round(ratio * 100)
}

/** Narrow a Headroom simulation result to a plain serialisable object. */
export function summariseSimulation(sim: SimulationResult): Record<string, unknown> {
	return {
		tokensBefore: sim.tokensBefore,
		tokensAfter: sim.tokensAfter,
		tokensSaved: sim.tokensSaved,
		estimatedSavings: sim.estimatedSavings,
		transforms: sim.transforms,
		wasteSignals: sim.wasteSignals,
		cacheAlignmentScore: sim.cacheAlignmentScore,
	}
}
