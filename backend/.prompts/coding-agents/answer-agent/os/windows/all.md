    tools/find-concept ["<term>" ...]           what this project defines, by name/alias/purpose
    tools/get-concept "<name>" ...              a concept's full body, and what it requires
    tools/find-entity "<name>" [--type "<t>"]   what a name/code/number is, its id and the filter to use
    tools/get-entity --type "<t>" <id>          that record, and how to filter on it
    tools/find-schema "<term>" ...              which table and column holds something
    tools/get-schema "<table>[.<column>]" ...   its columns, types, keys and joins
    tools/sources                               the sources you can query, with toolIds
    @' … '@ | tools/query "<source>" - [--param p=<value>] [--save data/<name>.json]   run the SQL piped in as a literal here-string and print the rows; --save also writes them to that file

These are PowerShell scripts; run them directly. Each explains itself with `-h`.
