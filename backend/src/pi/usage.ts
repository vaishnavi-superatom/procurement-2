/**
 * What one turn cost, from a pi session's running totals.
 *
 * The session counts for its whole life, so a turn is the difference between a
 * reading taken before the prompt and one taken after. Shared by both embedded
 * agents: the builder logged this from the start, the chat agent did not, and a
 * second copy of the arithmetic is how the two would come to disagree about
 * what a turn cost.
 */

export interface Stats {
	input: number;
	output: number;
	cost: number;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	costUSD: number;
}

/** A session's totals so far. Zeroes when the runtime does not report them. */
export function readStats(session: { getSessionStats?: () => unknown } | undefined): Stats {
	try {
		const stats = session?.getSessionStats?.() as
			| { tokens?: { input?: number; output?: number }; cost?: number }
			| undefined;
		return {
			input: stats?.tokens?.input ?? 0,
			output: stats?.tokens?.output ?? 0,
			cost: stats?.cost ?? 0,
		};
	} catch {
		return { input: 0, output: 0, cost: 0 };
	}
}

/** The difference between two readings — what this turn actually used. */
export function spent(before: Stats, after: Stats): Usage {
	return {
		inputTokens: Math.max(0, after.input - before.input),
		outputTokens: Math.max(0, after.output - before.output),
		costUSD: Math.max(0, after.cost - before.cost),
	};
}

/** Two prompts inside one turn — a repair after a rejected component — as one figure. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		costUSD: a.costUSD + b.costUSD,
	};
}

/** The one-line turn summary both agents print. */
export function usageLine(usage: Usage, latencyMs: number): string {
	return (
		`turn used ${usage.inputTokens} input + ${usage.outputTokens} output tokens, ` +
		`$${usage.costUSD.toFixed(4)}, ${Math.round(latencyMs / 1000)}s`
	);
}
