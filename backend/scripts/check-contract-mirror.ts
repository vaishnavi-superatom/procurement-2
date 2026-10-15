/**
 * Proves the two copies of the contract types are the same file.
 *
 *   pnpm contract:mirror         report any difference
 *   pnpm contract:mirror --fix   copy the canonical body over the mirror
 *
 * ### Why there are two copies at all
 *
 * `ResultMeta`, `ColumnMeta`, `DashboardManifest` and the rest are the shape the
 * backend and the browser agree on. The backend is CommonJS, the frontend is
 * ESM, and they are separate packages that build separately — so there is no
 * shared module to hold this without a publish cycle in the middle of every
 * edit. The frontend's header says as much and names the backend as canonical.
 *
 * ### Why a comment was not enough
 *
 * It said *"MIRROR — do not edit here first"*, and the files still drifted:
 * `DashboardSummary` gained `createdAt`/`updatedAt` on the backend and the
 * frontend copy did not. Nothing failed. A type that exists twice and is
 * checked in neither place will diverge, and the symptom arrives much later as
 * a field that is present on the wire and absent from the type that reads it.
 *
 * This is the same rule as everywhere else here: an instruction is a hope, a
 * check is a guarantee.
 *
 * ### What is compared
 *
 * Everything below each file's opening block comment. The headers differ on
 * purpose — one says "canonical", the other says "mirror" — and that difference
 * is the only one allowed.
 */
import * as fs from 'fs';
import * as path from 'path';

const CANONICAL = path.join(__dirname, '..', 'src', 'dashboard-builder', 'contract', 'types.ts');
const MIRROR = path.join(
	__dirname,
	'..',
	'..',
	'frontend',
	'src',
	'dash-contract',
	'types.ts',
);

/** The file minus its opening block comment, with line endings normalised. */
function body(file: string): { header: string; rest: string } {
	const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
	const end = text.indexOf('*/');
	if (end === -1) throw new Error(`${file} has no opening block comment.`);
	return { header: text.slice(0, end + 2), rest: text.slice(end + 2).trimStart() };
}

function main() {
	const fix = process.argv.includes('--fix');
	const canonical = body(CANONICAL);
	const mirror = body(MIRROR);

	if (canonical.rest === mirror.rest) {
		console.log('ok   contract types match');
		return;
	}

	if (fix) {
		fs.writeFileSync(MIRROR, `${mirror.header}\n\n${canonical.rest}`, 'utf-8');
		console.log(`Wrote the canonical body into ${path.relative(process.cwd(), MIRROR)}`);
		return;
	}

	/* The first differing line is enough to find it — a full diff of a 300-line
	 * type file buries the one line that matters. */
	const a = canonical.rest.split('\n');
	const b = mirror.rest.split('\n');
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;

	console.error('FAIL the two copies of the contract types have drifted.\n');
	console.error(`     first difference at line ${i + 1} below the header:`);
	console.error(`       backend : ${a[i] ?? '(end of file)'}`);
	console.error(`       frontend: ${b[i] ?? '(end of file)'}`);
	console.error('\n     The backend copy is canonical. Run: pnpm contract:mirror --fix');
	process.exit(1);
}

main();
