/**
 * Verify the entity-search data layer against the two failures in
 * backend/docs/ENTITY-SEARCH-DESIGN.md § 1. Seeds a throwaway `_verify_customer`
 * entity with real rows from the client DB, runs the resolver, then cleans up.
 *
 *   pnpm tsx scripts/_verify-entity-search.ts
 *   pnpm tsx scripts/_verify-entity-search.ts --keep       # leave data behind
 *   pnpm tsx scripts/_verify-entity-search.ts --query FDC  # ad-hoc lookup
 */
import { upsertEntityType, indexValues, resolve, resolveMany, stats, deleteEntityType, resolveEntities, getEntityCatalog } from '../src/project-data-db/entity-search';

const ENTITY = '_verify_customer';
const CONCEPT = '_verify_outstanding';
const IDENT = '_verify_invoice';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const qIdx = args.indexOf('--query');
const adHoc = qIdx !== -1 ? args[qIdx + 1] : null;

// Real rows from RLogic9SGTPL — 10430 is the genuine FDC false positive.
const SEED = [
  { instanceId: 10141, value: 'F D C LIMITED',                    valueKind: 'name' as const, attrs: { code: 'C000163' } },
  { instanceId: 10141, value: 'C000163',                          valueKind: 'code' as const, attrs: { code: 'C000163' } },
  { instanceId: 10430, value: 'SHRIRAM VINYL AND CHEMICAL INDUSTRIES   DIVISION OF DCM SHRIRAM LTD', valueKind: 'name' as const, attrs: { code: 'C000453' } },
  { instanceId: 10158, value: 'GLENMARK PHARMACEUTICALS LTD',     valueKind: 'name' as const, attrs: { code: 'C000180' } },
  { instanceId: 17018, value: 'SUMITOMO CHEMICAL INDIA LIMITED',  valueKind: 'name' as const, attrs: { code: 'C000628' } },
  { instanceId: 10091, value: 'CHANDRESH CABLES LTD',             valueKind: 'name' as const, attrs: { code: 'C000113' } },
];

// query -> expected instance id, or null meaning "must not resolve"
const CASES: Array<[string, string | null]> = [
  ['FDC', '10141'], ['fdc limited', '10141'], ['F D C LIMITED', '10141'],
  ['C000163', '10141'], ['f.d.c', '10141'],
  ['glenmark', '10158'], ['GLENMARK PHARMA', '10158'],
  ['sumitomo', '17018'], ['chandresh', '10091'],
  ['NONEXISTENT CORP', null],
];

async function main() {
  await upsertEntityType({ entityType: ENTITY, resolution: {
    table: 'com_mst_party', idColumn: 'PartyId', labelColumn: 'PartyName',
    usedBy: [{ table: 'trp_trn_booking', column: 'BillingPartyId' }],
  }});
  const w = await indexValues({ entityType: ENTITY, values: SEED, replace: true });
  console.log(`seeded: ${w.written} values\n`);

  if (adHoc) {
    const r = await resolve({ query: adHoc, entityType: ENTITY, limit: 10 });
    console.log(JSON.stringify(r, null, 2));
    if (!keep) await deleteEntityType(ENTITY);
    return;
  }

  let failed = 0;
  for (const [q, expected] of CASES) {
    const r = await resolve({ query: q, entityType: ENTITY, limit: 3 });
    const got = r.hits[0]?.instanceId ?? null;
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  "${q}" -> ${got ?? 'unresolved'}${expected !== null && !ok ? ` (want ${expected})` : ''}`);
    for (const h of r.hits) {
      console.log(`        ${h.score.toFixed(2)} ${h.matchType.padEnd(17)} id=${h.instanceId} ${h.displayName.slice(0, 42)}`);
    }
    if (r.ambiguous) console.log(`        ^ ambiguous — caller must disambiguate`);
  }

  const rm = await resolveMany({ mentions: ['FDC limited', 'glenmark', 'NOPE LTD'], entityType: ENTITY, limit: 1 });
  const unresolvedOk = rm.unresolved.length === 1 && rm.unresolved[0] === 'NOPE LTD';
  if (!unresolvedOk) failed++;
  console.log(`\n${unresolvedOk ? 'PASS' : 'FAIL'}  resolveMany reports unresolved: ${JSON.stringify(rm.unresolved)}`);

  // ── Entity map half ──────────────────────────────────────────────────────
  await upsertEntityType({ entityType: CONCEPT, resolution: {
    gloss: 'Unpaid invoice amount owed by a customer',
    synonyms: ['outstanding', 'unpaid invoices', 'debtor balance', 'money owed', 'receivables', 'pending payment'],
    tables: ['trp_trn_transportinvoice', 'fin_trn_voucherledgerbill'],
    formula: 'SUM(fin_trn_voucherledgerbill.Debit) - SUM(fin_trn_voucherledgerbill.Credit)',
  }});
  await upsertEntityType({ entityType: IDENT, resolution: {
    gloss: "The customer's own commercial invoice number",
    synonyms: ['invoice number', 'bill number'],
    table: 'trp_trn_bookinginvoice', column: 'InvoiceNo', indexed: false,
    matchPattern: "REPLACE(REPLACE(REPLACE(UPPER(InvoiceNo),' ',''),'/',''),'-','') LIKE '%'+@squashed+'%'",
  }});

  console.log('\n-- entity map: LLM paraphrases must still land --');
  // 'who hasnt paid' is deliberately absent: zero lexical overlap with any
  // synonym. That case is covered by the catalog in the system prompt, not here.
  for (const [phrase, want] of [
    ['outstanding', CONCEPT], ['receivables', CONCEPT], ['unpaid invoices', CONCEPT],
    ['pending payments', CONCEPT], ['money owed to us', CONCEPT], ['invoice number', IDENT],
  ] as Array<[string, string]>) {
    const r = await resolveEntities({ entityTypes: [phrase] });
    const got = Object.keys(r.entityMap)[0] ?? null;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  concept "${phrase}" -> ${got ?? 'no match'}`);
  }

  // The Case B shape: an unbounded identifier is NOT indexed, so it must come
  // back unresolved WITH the entity map entry that says how to find it.
  const caseB = await resolveEntities({ mentions: [{ text: 'CHL/895/26-27' }], entityTypes: ['invoice number'] });
  const caseBOk = caseB.unresolved.includes('CHL/895/26-27') && !!caseB.entityMap[IDENT]?.matchPattern;
  if (!caseBOk) failed++;
  console.log(`${caseBOk ? 'PASS' : 'FAIL'}  unbounded id unresolved + matchPattern supplied`);

  const cat = (await getEntityCatalog()).data.filter(c => c.entityType.startsWith('_verify'));
  const catOk = cat.length === 3;
  if (!catOk) failed++;
  console.log(`${catOk ? 'PASS' : 'FAIL'}  catalog returns ${cat.length} entity type names`);
  console.log('stats:', JSON.stringify((await stats()).byEntity.find((e: any) => e.entityType === ENTITY)));

  if (!keep) { for (const e of [ENTITY, CONCEPT, IDENT]) await deleteEntityType(e).catch(()=>{}); console.log("\ncleaned up"); }
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
