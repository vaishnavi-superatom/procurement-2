import { getSourceManager } from '../sources';
import type { CollectionContext } from './types';

const MAX_TERMS = 300;
const MAX_CHARS = 2000;
const TTL_MS = 30 * 60 * 1000;

/** "dim_branch_location" / "branchLocationId" → "branch location" */
function humanize(raw: string): string {
	return raw
		.replace(/^(dim|fact|tbl|vw)[_\s]/i, '')
		.replace(/[_\-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Speech Collection
 *
 * Supplies the domain vocabulary (entity names, synonyms, column names,
 * sampled values) used to bias voice-input transcription — see
 * docs/SPEECH-TO-TEXT-DESIGN.md §4. The worker that actually calls the STT
 * model has no access to the client's local schema, so the browser fetches
 * this once per session and passes it along with each recording.
 */
export async function registerSpeechCollections({ sdk }: CollectionContext): Promise<void> {
	let cache: { terms: string[]; builtAt: number } | null = null;

	// Ranked domain terms used to bias transcription. Weight favours entity names and
	// synonyms (what users actually say) over raw cell values.
	sdk.addCollection('speech', 'vocabulary', async () => {
		if (cache && Date.now() - cache.builtAt < TTL_MS) return { terms: cache.terms };

		const manager = getSourceManager();
		if (!manager) return { terms: [] };

		const scored = new Map<string, number>();
		const add = (raw: unknown, weight: number) => {
			if (typeof raw !== 'string') return;
			const t = humanize(raw);
			if (t.length < 3 || t.length > 40 || /^\d+$/.test(t)) return;
			scored.set(t, (scored.get(t) || 0) + weight);
		};

		for (const instance of manager.getAllInstances()) {
			const schema = instance.getSchema();
			if (!schema?.entities) continue;
			for (const entity of schema.entities) {
				add(entity.name, 3);
				for (const syn of entity.semantic?.synonyms || []) add(syn, 4);
				for (const field of entity.fields || []) {
					add(field.name, 2);
					for (const v of (field.semantic?.valueVocabulary || []).slice(0, 10)) add(v, 1);
				}
			}
		}

		const terms: string[] = [];
		let chars = 0;
		for (const [term] of [...scored.entries()].sort((a, b) => b[1] - a[1])) {
			if (terms.length >= MAX_TERMS || chars + term.length + 2 > MAX_CHARS) break;
			terms.push(term);
			chars += term.length + 2;
		}

		cache = { terms, builtAt: Date.now() };
		return { terms };
	});
}
