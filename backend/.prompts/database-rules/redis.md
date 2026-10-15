# Redis - Query Rules

Redis is a **key-value store / cache**, queried here with a **single read command**.
It is NOT a relational database — there is no SQL, no JOIN, no aggregation, and no
schema. You look up data by key, or discover keys with SCAN. Read these rules
before writing a command.

## HOW TO QUERY (put ONE command in the `query` field)

- **If you already have the key (or an identifier that IS the key), read it DIRECTLY — do NOT SCAN.**
  When the user gives an id (e.g. a device uid `e8f60aab68b4`) and the schema shows a key
  family like `{id}` (the whole key is that id), the key **is** that value. Read it directly:
  - hash → `HGETALL e8f60aab68b4`   ← returns the device's fields (this is what "show me device X's data" needs)
  - string → `GET config:chamber:12`
  - list → `LRANGE events:dev1 0 9`
  - set → `SMEMBERS members:org1`
  - sorted set → `ZRANGE leaderboard 0 9 WITHSCORES`
- **SCAN only DISCOVERS key NAMES — it never returns the data inside a key.**
  `SCAN 0 MATCH device:* COUNT 200` gives you a list of key names, nothing else. If you SCAN to
  find a key, you STILL must then read it (`HGETALL`/`GET`) to get its fields. Never answer a
  "show me the values for X" question with a SCAN result — SCAN has no values in it.
- **Do NOT wrap a known key in SCAN wildcards.** `SCAN 0 MATCH *e8f60aab68b4*` is wrong when
  `e8f60aab68b4` is itself the key — use `HGETALL e8f60aab68b4` instead.
- The schema lists **key-pattern families** with `{id}` marking the variable segment. A family
  named just `{id}` means the entire key is a single identifier (e.g. a device uid) — substitute
  the real id and read it directly.

## CRITICAL ERRORS (Command Will Fail or Be Rejected)

- **Read-only only.** Write/admin commands are rejected: `SET, DEL, EXPIRE, HSET, LPUSH, FLUSHALL, CONFIG, EVAL, …`. Never write.
- **Never use `KEYS`** — it blocks the server. Use `SCAN … MATCH …` instead (rejected by the guard anyway).
- **No aggregation / no filtering by value** in plain Redis. There is no `WHERE`, `GROUP BY`, `COUNT(*)`, `SUM`, or `JOIN`. To answer an analytics question, SCAN/GET the relevant keys (as narrowly as possible) and let the calling script compute totals/groupings in JS.
- **One command per call.** Do not chain multiple commands.

## RESULT SHAPES

| Command | Rows returned |
|---------|---------------|
| `GET key` | one row `{ value }` (JSON is parsed automatically) |
| `HGETALL key` | one row = the hash (each field is a column) |
| `MGET k1 k2` | rows `{ key, value }` |
| `LRANGE key a b` | rows `{ index, value }` |
| `SMEMBERS key` | rows `{ member }` |
| `ZRANGE key a b WITHSCORES` | rows `{ member, score }` |
| `SCAN 0 MATCH p COUNT n` | rows `{ key }` (auto-paginated, capped) |
| `TTL key` / `EXISTS key` | one row `{ ttl }` / `{ count }` |

## RediSearch (only if the schema/description says it is available)

If RediSearch is present you may run indexed queries with real filtering:
`FT.SEARCH <index> "@status:{active} @batteryPercentage:[0 20]"` → rows of matching
documents. Do NOT use FT.SEARCH if the tool description says RediSearch is not
available.

## COMMON PITFALLS

1. **KEYS is forbidden** — always `SCAN`.
2. **No value filtering in plain Redis** — you cannot ask Redis for "all devices with battery < 20"; SCAN the keys and filter/aggregate in the script (or use FT.SEARCH if available).
3. **Values may be binary** (serialized) — shown as `<binary>` and not queryable as text.
4. **Keys expire (TTL)** — a key may be absent because it expired; that is normal for a cache.
5. **Match the command to the key's type** (shown per family in the schema): HGETALL for a hash, GET for a string, LRANGE for a list, etc. Using the wrong command for the type errors.
