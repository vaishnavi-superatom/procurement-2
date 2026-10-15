/**
 * The `Program` contract, restated rather than imported.
 *
 * The semantic package is ESM and is reached by dynamic import; this file is
 * part of the ordinary CommonJS build. `Program` is a structural interface —
 * a name, a description, its parameters and a `run` — so a plain object built
 * here satisfies it on the other side of that boundary without either module
 * system having to know about the other.
 *
 * Keep this in step with `dashboard-programs/semantic/lib/src/programs.ts`.
 */

export interface ProgramParam {
	name: string;
	type: string;
	default?: unknown;
	description: string;
}

export interface ProgramContext {
	/** Query params, merged over the dataset's declared program defaults. */
	params: Record<string, unknown>;
	/** Equality and `in` filters on the program's own fields, so it can prune at source. */
	filters: Record<string, unknown>;
}

export interface Program {
	name: string;
	description: string;
	params: ProgramParam[];
	run(ctx: ProgramContext): Promise<{ rows: Record<string, unknown>[]; meta?: Record<string, unknown> }>;
}

const programs: Program[] = [];

export function registerProgram(p: Program): void {
	const at = programs.findIndex((x) => x.name === p.name);
	if (at >= 0) programs[at] = p;
	else programs.push(p);
}

/** Every registered program. Import `./register` first, for its side effects. */
export const registeredPrograms = (): Program[] => [...programs];
