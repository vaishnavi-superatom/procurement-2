Run these with your shell; they are executables in `tools/`:

    tools/find-entity "<name>"                    what a name/code/number is, its id and the filter to use; --type "<t>" only narrows
    tools/query "<source>" - ['{"p":"v"}'] [--limit N] [--save data/<name>.json] <<'SQL'    read-only SQL on stdin, so its quotes survive the shell;
    SELECT ... WHERE PartyId = @p AND d >= '2026-04-01'           @p comes from the params JSON; up to 5,000 rows; --save also writes the rows to that file
    SQL
    tools/find-schema "<term>" | --table "<t>"    find tables and columns
    tools/get-schema "<table>[.<column>]"         columns, types, keys and joins

- One statement per query, starting with SELECT or WITH. No leading `;`. No DECLARE: use a CTE.
- Allow a wide-window query several minutes to finish.
- Read large saved data files with Python and print only what you need; printing a whole file floods your context.
- If the shell rejects a query command, write the SQL to `sql/<name>.sql` with your file-editing tool and run `tools/query "<source>" --file sql/<name>.sql`.
- Use `python3`, not `python`.
- If a tool fails, report what it printed.
