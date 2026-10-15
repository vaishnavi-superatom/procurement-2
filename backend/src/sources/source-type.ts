/**
 * A source tool's engine, from its id.
 *
 * Almost every id opens with its type — `netsuite-…`, `excel-…`, `postgres-…` —
 * and both agents' prompts use that to pick the SQL rules they inject. The
 * cross-source `federation_query` tool has no prefix at all, so splitting on `-`
 * made it name itself, the rules loader did not recognise that, and it answered
 * with its PostgreSQL default: a third dialect in the prompt for an engine that
 * is really DuckDB.
 *
 * Federation runs on DuckDB, and the loader reaches DuckDB's rules through the
 * source types that use that engine — `excel` and `csv`. It has no `duckdb` key
 * of its own, so naming the engine here lands back on the same PostgreSQL
 * default this exists to avoid. The type is what the loader understands.
 *
 * An id that carries no type at all earns no rules.
 */
export function sourceTypeOf(id: string): string {
	if (id.startsWith('federation')) return 'excel';
	// Fabric speaks T-SQL; the loader only knows its rules under `mssql`.
	if (id.startsWith('fabric-')) return 'mssql';
	const [type] = id.split('-');
	return !type || type === id ? '' : type;
}
