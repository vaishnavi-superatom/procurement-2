# Semantic Model Structure Specification

> **IMPORTANT FOR CLAUDE CODE**: This is the official reference specification for `semantic-model.json` files.
> When generating a semantic model, you MUST follow this structure exactly.
> The semantic model is a **superset of the schema analysis** (`schema.json`): it keeps every
> structural fact the schema has (exact table/column names, types, stats, sample values, FKs)
> and adds a semantic layer on top (descriptions, business synonyms, join paths, data-driven
> value vocabulary). It is consumed by (1) the platform UI, (2) the schema embeddings, and
> (3) the LLM agents. No metric definitions yet — that is a later phase.

## Hard rules (do not break these)

1. **Exact identifiers.** Every `name` / `fullName` MUST match the live schema **byte-for-byte**.
   The agent writes SQL from these — a renamed/guessed identifier produces a broken query.
2. **Superset, not overlay.** Carry through every field the schema analysis has, then add the
   `semantic` blocks. The runtime uses this file *instead of* the raw schema when present.
3. **Descriptions are semantic, not structural.** Say what the table/column *means in the
   business* and how users refer to it — not "primary key for X".
4. **Synonyms = the words users actually type.** This is the single biggest lever for embedding
   retrieval. Include business/domain terms, abbreviations, and ERP jargon.
5. **Stay grounded in the data.** Value vocabulary and descriptions must be derived from the
   actual rows/sample values, never invented.

## Root structure

```jsonc
{
  "sourceId": "mssql-722b94971107",        // matches project_sources.id (exact)
  "sourceType": "mssql",
  "sourceName": "Microsoft SQL Server Connection",
  "database": "RLogic9SGTPL",
  "schemaFingerprint": "<sha256 of the schema this was built from>",  // drift guard
  "generatedAt": "2026-06-24T00:00:00.000Z",
  "generatedBy": "claude-code",
  "reviewed": false,                       // flip to true after human review
  "domain": "Transport / logistics ERP (R-Logic). Freight bookings, vehicles, vendors (parties), service-network routes, financials.",
  "glossary": [                            // source-level business term -> where it lives
    { "term": "vendor", "meaning": "Transport party that owns/operates a vehicle", "tables": ["trp_mst_transportparty", "com_mst_party"] },
    { "term": "loss",   "meaning": "Negative TotalProfitLoss on a booking/voucher", "tables": ["fin_trn_voucher"] }
  ],
  "entities": [ /* superset of schema entities, see below */ ],
  "relationships": [ /* same shape as schema.relationships */ ]
}
```

## Entity object (superset of `SchemaEntity`)

Carry through `name`, `fullName`, `rowCount`, `primaryKey`, `fields`, then add `semantic`.

```jsonc
{
  "name": "trp_trn_booking",                     // EXACT
  "fullName": "dbo.trp_trn_booking",             // EXACT
  "rowCount": 732041,
  "primaryKey": ["BookingId"],
  "semantic": {
    "summary": "Freight bookings/consignments: each row is one shipment with origin & destination service network, the vehicle used, dates, and payment/booking type.",
    "synonyms": ["consignment", "shipment", "trip", "booking", "order", "load"],
    "embedText": "Freight bookings / consignments / shipments / trips. Origin and destination service network (from/to city), vehicle, vehicle type (capacity in MT/tonnes), document date. Used for route analysis, vendor activity, trip counts.",
    "joins": [                                   // canonical join paths (removes agent rediscovery)
      { "to": "dbo.trp_mst_vehicle",        "on": "VehicleId = VehicleId",                 "purpose": "vehicle + owner (vendor)" },
      { "to": "dbo.com_trn_documentstamp",  "on": "DocumentStampId = DocumentStampId",     "purpose": "DocumentDate lives here, not on booking" }
    ],
    "notes": "Route filters use FromServiceNetworkId / ToServiceNetworkId (NOT city names). DocumentDate is on com_trn_documentstamp via DocumentStampId."
  },
  "fields": [ /* superset of schema fields, see below */ ]
}
```

| `semantic` field | Type | Required | Purpose |
|---|---|---|---|
| `summary` | string | Yes | One/two sentences: what this table means in the business. Shown in UI + agent. |
| `synonyms` | string[] | Yes | Business/domain terms users type. Drives embedding retrieval. |
| `embedText` | string | Yes | **Concise** text that gets embedded (keep < ~300 tokens). summary + synonyms + key value vocab. Do NOT dump the whole table here. |
| `joins` | array | No | Canonical join paths to other tables: `{to, on, purpose}`. `to` = exact `fullName`. |
| `notes` | string | No | Gotchas the agent must know (empty/sentinel columns, where a field really lives, etc.). |

## Field object (superset of `SchemaField`)

Carry through `name`, `type`, `nativeType`, `nullable`, `isPrimaryKey`, `isForeignKey`,
`references`, `statistics`, `sampleValues`, then add `semantic`.

```jsonc
{
  "name": "VehicleTypeId",                       // EXACT
  "type": "NUMBER",
  "nativeType": "int",
  "isForeignKey": true,
  "references": { "entity": "dbo.trp_mst_vehicletype", "field": "VehicleTypeId" },
  "statistics": { "distinct": 248, "cardinality": "low" },
  "semantic": {
    "summary": "Vehicle/truck category. Capacity (e.g. 21 MT, 30 MT) is encoded in the related VehicleTypeName, not in a numeric column.",
    "synonyms": ["truck type", "vehicle category", "capacity class", "21 MT", "30 MT", "tonnage"],
    "valueVocabulary": ["TRUCK - 30 TON", "20 FT CONTAINER 12 TON", "TRUCK TYPE 15-17"],  // representative real values
    "unit": null,
    "notes": "VehicleCapacity numeric column is mostly 0/unreliable; capacity comes from the type name."
  }
}
```

| `semantic` field | Type | Required | Purpose |
|---|---|---|---|
| `summary` | string | Yes | What the column means in business terms. |
| `synonyms` | string[] | No | Alternate names users type for this column/value. |
| `valueVocabulary` | string[] | No | Representative **real** distinct values (esp. for text/category columns) — the literal strings users match against ("30 TON"). Derived from data. |
| `unit` | string\|null | No | Unit of measure if numeric (MT, kg, INR, days). |
| `notes` | string | No | Data-quality gotchas (sentinels, empties, encodings). |

## Generation guidance for Claude Code

1. **Start from the schema** (the exported `schema.json`) — it has names, types, stats,
   sample values, FKs. Never change those facts; only add `semantic` blocks + `glossary`.
2. **Sample the data** where the schema's sample values are insufficient (high-cardinality text
   columns) to build accurate `valueVocabulary` and synonyms.
3. **Infer join paths** from FKs + naming + data, and record them on the "fact" tables
   (`*_trn_*`) pointing at masters (`*_mst_*`).
4. **Keep `embedText` concise** (the embedding model truncates ~384 tokens) — it is *not* the
   full description; it's the retrieval bait: summary + synonyms + a few key values.
5. **Set `reviewed: false`**; a human flips it after checking domain accuracy.
6. **Stamp `schemaFingerprint`** with the fingerprint of the schema you generated from, so the
   runtime can detect when the model is stale.
