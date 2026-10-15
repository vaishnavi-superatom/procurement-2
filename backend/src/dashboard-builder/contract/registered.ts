/**
 * The dashboard contract, registered by the browser over `DASH_CONTRACT_RES`.
 *
 * Replaces `dashboard-components.generated.ts` — a committed file someone had to
 * remember to regenerate, generated from frontend *source* while the reader's
 * browser ran a *bundle*. Pushing from the bundle makes those one artifact.
 */

import * as crypto from 'crypto';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/** One prop. A bare string when a line will do. */
export type PropMeta =
	| string
	| {
			description: string;
			importance?: 'required' | 'recommended' | 'optional';
			default?: string | number | boolean;
			caution?: string;
			group?: string;
	  };

export interface DashboardComponent {
	name: string;
	kind: string;
	/** One line. Injected into every prompt. */
	purpose: string;
	/** Fetched on demand by `./component <name>`, never injected. */
	props?: Record<string, PropMeta>;
	useWhen?: string;
	notes?: string;
}

let registered: readonly DashboardComponent[] | null = null;

export class ContractNotRegisteredError extends Error {
	readonly code = 'CONTRACT_NOT_REGISTERED';
	constructor() {
		super(
			'The dashboard components are not loaded yet. They are sent by the browser ' +
				'when the app opens — reload the page and try again.',
		);
	}
}

/** Last write wins: a reconnect resends, and a new bundle must be able to remove a component. */
export function setRegisteredContract(components: readonly DashboardComponent[]): void {
	registered = components;
	version = sha(components.map((c) => c.name).sort().join(','));
	console.log(`  dashboard contract registered: ${components.length} components (${version})`);
}

/**
 * What the contract is, as a value a cache can be keyed on.
 *
 * A compiled view is a function of two things, and only one of them lives in
 * the dashboard's folder. The other is this: the set of names a program is
 * allowed to import, which the browser pushes from whatever bundle it is
 * running. Rebuild the frontend with a new hook and every previously compiled
 * view is a build of a different contract.
 *
 * Leaving it out is not a theoretical risk — it is the bug where a dashboard
 * that compiled an hour ago reports itself invalid, or worse compiles against
 * names the browser no longer has, and stays that way until someone restarts
 * the process. Names only, sorted: a reworded `purpose` changes the prompt, not
 * what a program can compile against.
 */
export const contractVersion = (): string => version;
let version = 'unregistered';

export const isContractRegistered = (): boolean => Boolean(registered?.length);

/**
 * The contract, or a thrown explanation.
 *
 * Never an empty array: "nobody has registered yet" and "there are no
 * components" need different handling, and returning `[]` would quietly build a
 * dashboard that can import nothing.
 */
export function contract(): readonly DashboardComponent[] {
	if (!registered?.length) throw new ContractNotRegisteredError();
	return registered;
}

/** The names a generated program may import. */
export const contractExports = (): readonly string[] => contract().map((c) => c.name);

/** For tests. */
export function clearRegisteredContract(): void {
	registered = null;
}
