# Direct Tools

A **direct tool** is a pre-built function with hardcoded logic that the
`MainAgent` calls **directly** — there is no `SourceAgent` and no LLM-generated
SQL. The LLM only chooses the tool and fills in its parameters; *you* own what
runs inside `fn`.

Use a direct tool when a query is fixed business logic you don't want the LLM to
re-derive each turn (complex joins, scoring, multi-step computation). For
anything the LLM can reasonably express as SQL against a schema, prefer a normal
**source** tool instead — direct tools are extra code to maintain.

> Looking for a worked example? See [`_example/`](./_example) — a generic,
> unregistered `top-customers` tool you can copy. It is never sent to the LLM.

## The two-file shape of a project

Each project lives in its own folder under `direct/` and exposes exactly two
things from its `index.ts`:

```ts
export const sourceId = 'mssql-xxxxxxxx';            // the source instance to query
export function createTools(execute: ExecuteFn): SourceTool[] { ... }  // the tools
```

A single `SourceTool` looks like this (full type in
`src/sources/core/types.ts`):

```ts
{
  id: 'get-top-customers',     // the LLM calls the tool by THIS id
  name: 'Get Top Customers',   // human label (logs / streamed status)
  toolType: 'direct',          // REQUIRED — routes around the SQL SourceAgent
  description: 'Get the top customers ... USE FOR: ... DO NOT USE FOR: ...',
  params: { limit: 'integer - how many to return', startDate: 'string (optional) - ...' },
  fn: async (input) => ({ data: rows, count: rows.length, totalRevenue }),
  outputSchema: { description: '...', fields: [ ... ] },   // optional, recommended
}
```

## How a direct tool reaches the LLM

1. **Loading.** `tools/index.ts` → `getAllTools()` calls
   `createAllDirectTools(getInstance)` (in `direct/index.ts`). For every entry in
   `PROJECT_CONFIGS` it resolves the source instance by `sourceId`, and calls the
   project's `createTools(instance.execute)`. **`PROJECT_CONFIGS` is the only
   gate** — a tool not listed there is never loaded and never seen by the LLM.
   (If the `sourceId` isn't found, the project is skipped with a warning.)

2. **Schema sent to the model.** In the SDK, `MainAgent.buildDirectToolDefinitions`
   turns each tool into an Anthropic tool definition:
   - `name`  ← `tool.id`
   - `description` ← `tool.description` *(this is what the model uses to decide
     when to call it — make it specific)*
   - `input_schema.properties` ← derived from `params`, one property per entry.

3. **How `params` values map to the JSON schema** (this is the non-obvious part):
   each param's **value string** is parsed —
   - a leading type word `string | number | integer | boolean | array | object`
     sets the JSON type (defaults to `string`);
   - the substring `optional` anywhere makes the param **not required**;
   - the whole value string becomes the parameter's description for the LLM.

   ```ts
   params: {
     limit:     'integer - how many to return',           // → { type:'integer' }, required
     startDate: 'string (optional) - ISO lower bound',    // → { type:'string' },  optional
   }
   ```

4. **Execution.** When the LLM calls the tool, `MainAgent.handleDirectTool` runs
   `tool.fn(input)` with the model-supplied params (no SQL generation) and:
   - reads rows from `result.data` (falls back to `result` itself);
   - treats a returned `{ error: '...' }` as a handled failure;
   - tracks the result + `outputSchema` for the component generator (KPI cards,
     tables, charts).

   So `fn` should return either a row array, or an object like
   `{ data: rows, count, ...kpis }`, or `{ error }`.

## Add your own (checklist)

1. `mkdir direct/my-project/` and add your tool file(s) — each exporting a
   `createXxxTools(execute): SourceTool[]` factory.
2. Add `my-project/index.ts` exporting `sourceId` + `createTools` (aggregate the
   factories).
3. In `direct/index.ts`: `import * as myProject from './my-project'` and push
   `myProject` onto `PROJECT_CONFIGS`.
4. Set `sourceId` to the source instance your tools query.

Tip while authoring: set `SA_DEBUG_LLM_TOOLS=1` on the backend to log the
MainAgent's per-iteration tool loop (which tool the model picked, stop reasons).
