Your shell is Windows PowerShell. These are PowerShell scripts in `tools/`; run them directly:

    tools/find-entity "<name>"                    what a name/code/number is, its id and the filter to use; --type "<t>" only narrows
    @'
    SELECT ... WHERE PartyId = @p AND d >= '2026-04-01'
    '@ | tools/query "<source>" - [--param p=<value>] [--limit N] [--save data/<name>.json]
                                                  read-only SQL, piped in as a literal here-string so quotes,
                                                  % and $ reach the database untouched; @p comes from --param;
                                                  up to 5,000 rows; --save also writes the rows to that file
    tools/find-schema "<term>" | --table "<t>"    find tables and columns
    tools/get-schema "<table>[.<column>]"         columns, types, keys and joins

- One statement per query, starting with SELECT or WITH. No leading `;`. No DECLARE: use a CTE.
- `@'` ends its line and `'@` starts its own line; nothing else goes on either.
- Read large saved data files with Python and print only what you need; printing a whole file floods your context.
- If PowerShell rejects a query command (e.g. "missing the terminator"), write the SQL to `sql/<name>.sql` with your file-editing tool and run `tools/query "<source>" --file sql/<name>.sql`.
- Allow a wide-window query several minutes to finish.
- {{PYTHON}}
- Write `answer.md` and any `data/*.json` with your file-editing tool, never through PowerShell (`Set-Content`, `Out-File`, `>`, or a pipe): on this machine that turns non-English characters into `?`.
- If a tool fails, report what it printed.
