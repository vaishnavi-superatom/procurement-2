# Alert-Based Report Delivery System

## Design Document — Configurable Metric Alerts with Email Notifications

---

## 1. Problem Statement

Each project has one or more **data sources** (Postgres, MSSQL, MySQL, Excel, CSV, REST API, GraphQL) with pre-created dashboards and reports. We need a system where **reports are automatically emailed** when:

1. **Threshold Breach** — A metric goes outside a user-defined permissible range (e.g., inventory drops below 100 units or exceeds 10,000 units)
2. **Statistical Deviation** — A metric deviates beyond a configured number of standard deviations from a base value (e.g., daily order count is 3 standard deviations away from the 30-day average)

Users must be able to **configure these alert conditions** themselves from the Reports section in the admin UI. Users are typically **business people** — they should not need to write SQL or know which source holds their data.

---

## 2. What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| Reports CRUD (backend) | Done | `backend/src/collections/reports.ts` |
| Reports DB schema (Drizzle) | Done | `database/postgres/drizzle/schema.ts` |
| Reports DB service | Done | `database/postgres/src/project-data-db/reports.ts` |
| Report Detail page | Done | `sa-platform-ui/src/pages/reports/ReportDetail.tsx` |
| Report Scheduling UI | Done | `sa-platform-ui/src/components/reports/ScheduleReportDialog.tsx` |
| Report Sharing UI | Done | `sa-platform-ui/src/components/reports/ShareReportDialog.tsx` |
| Schedule config (frequency, time, timezone, recipients, format) | Done | `sa-platform-ui/src/types/report.ts` |
| Dashboard widgets with DSL | Done | DSLRenderer from `@superatomai/renderer-react` |
| Report Store (MobX) | Done | `sa-platform-ui/src/store/ReportStore.ts` |
| Report localStorage cache | Done | `sa-platform-ui/src/utils/storage/reportStorage.ts` |
| Data sources (postgres, mssql, mysql, excel, csv, rest_api, graphql) | Done | `backend/src/sources/` plugin architecture |
| Project sources DB | Done | `project_sources` table with FK to `project_details` |
| Multi-agent query system | Done | `sdk-nodejs/src/userResponse/agents/` |
| Source routing (MainAgent) | Done | `sdk-nodejs/src/userResponse/agents/main-agent.ts` |
| Source query generation (SourceAgent) | Done | `sdk-nodejs/src/userResponse/agents/source-agent.ts` |
| Source summaries builder | Done | `sdk-nodejs/src/userResponse/agents/agent-prompt-builder.ts` |
| Email sending | Mock only | `backend/src/tools/mail/getMockMails.ts` |
| Alert conditions | Not built | — |
| Metric monitoring | Not built | — |
| Alert scheduler | Not built | — |

---

## 3. System Design

### 3.1 Core Concept: Natural Language Metrics

Users describe their metric in **plain English** instead of writing SQL. The existing multi-agent system handles the rest:

```
USER WRITES:                        SYSTEM DOES:
"Total inventory in East            1. Source routing → finds the right source
 warehouse"                         2. Source agent → generates the query
                                    3. Executes → returns numeric value
                                    4. Caches the generated query for reuse
```

This approach:
- Works for **all 7 source types** (postgres, mssql, mysql, excel, csv, rest_api, graphql)
- Requires **no SQL knowledge** from business users
- Reuses the **existing multi-agent system** — no new AI infrastructure
- Is **deterministic at runtime** — the LLM is only used once during setup, the generated query is cached

### 3.2 High-Level Flow

```
┌───────────────────────────────────────────────────────────────────┐
│                        ADMIN UI (sa-platform-ui)                  │
│                                                                   │
│  Report Detail Page (right sidebar)                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Tabs: [Settings] [Chat] [Alerts ●]  ← New tab             │  │
│  │                                                               │  │
│  │  Alert Config Dialog                                          │  │
│  │  ┌───────────────────────────────────────────────────────┐  │  │
│  │  │  Metric: "Total inventory in East warehouse"          │  │  │
│  │  │                                                       │  │  │
│  │  │  [Test Metric]                                        │  │  │
│  │  │  Detected Source: Warehouse DB (Postgres)  [Change ▼] │  │  │
│  │  │  Generated Query: SELECT SUM(quantity)...  [visible]  │  │  │
│  │  │  Result: 4,720                                        │  │  │
│  │  │                                                       │  │  │
│  │  │  Condition: Outside range [100 — 10,000]              │  │  │
│  │  │  Check Every: 1 hour                                  │  │  │
│  │  │  Recipients: john@co.com, sarah@co.com                │  │  │
│  │  └───────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────┬───────────────────────────────────────────┘
                        │ Save alert config via collection API
                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                          BACKEND                                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ALERT SETUP (one-time, on Save/Test)                       │ │
│  │  1. MainAgent source routing → picks sourceId               │ │
│  │  2. SourceAgent generates query for that source             │ │
│  │  3. Execute query → return value to user                    │ │
│  │  4. Store: sourceId + generatedQuery + metricDescription    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────────┐ │
│  │  Scheduler  │───→│ Alert Engine │───→│   Email Service      │ │
│  │  (Interval) │    │              │    │   (Resend / SMTP)    │ │
│  │             │    │  1. Run      │    │                      │ │
│  │  Checks     │    │    CACHED    │    │  Sends report with   │ │
│  │  every N    │    │    query     │    │  alert details to    │ │
│  │  minutes    │    │  2. Get value│    │  configured emails   │ │
│  │             │    │  3. Evaluate │    │                      │ │
│  └─────────────┘    │  4. Trigger? │    └──────────────────────┘ │
│                     └──────┬───────┘                              │
│                            │ Run cached query                    │
│                     ┌──────▼───────┐                              │
│                     │  Project     │                              │
│                     │  Sources     │                              │
│                     │  (Any type)  │                              │
│                     └──────────────┘                              │
└───────────────────────────────────────────────────────────────────┘
```

### 3.3 Alert Setup Flow (One-Time, Uses LLM)

```
1. User types metric description: "Total inventory in East warehouse"
2. User clicks [Test Metric] or [Save Alert]
3. Backend receives metricDescription + projectId
4. MainAgent: buildSourceSummaries() for all project sources
5. MainAgent: source routing → matches to "Warehouse DB" (postgres)
   └── Uses the same routing logic as chat queries
6. SourceAgent: generates query for that source
   └── e.g., "SELECT SUM(quantity) as total FROM inventory WHERE warehouse = 'EAST'"
7. Execute query → value = 4720
8. Return to frontend:
   └── { sourceId, sourceName, generatedQuery, resultColumn, value }
9. Frontend shows: detected source, generated query (read-only), result value
10. User can [Change ▼] source manually if auto-detection is wrong
    └── If changed, SourceAgent re-generates query for the new source
11. On Save: store sourceId + generatedQuery + metricDescription + resultColumn
```

### 3.4 Alert Evaluation Flow (Recurring)

```
1. Scheduler tick → alert is due
2. Load alert from DB → get sourceId + generatedQuery + resultColumn
3. Get source instance for sourceId
4. Execute generatedQuery via source.execute()
5. Extract value from resultColumn
6. Evaluate condition (threshold or deviation)
7. If NOT triggered → update tracking, done (no LLM calls)
8. If triggered AND cooldown passed:
   a. Run AI analysis via MainAgent (LLM calls — only on trigger):
      i.   MainAgent.handleQuestion() with alert-context prompt
      ii.  MainAgent internally routes to the right source, runs investigative
           queries via SourceAgent, and produces markdown analysis
      iii. Take agentResponse.text — skip component generation entirely
   b. Send email with: metric details + analysis text + report link
   c. Update tracking fields (lastTriggeredAt, lastValue, status)
```

**LLM calls happen ONLY when an alert triggers** — not on every check. Most checks
result in "not triggered" and cost nothing. When an alert does fire, the MainAgent
call adds ~5-10 seconds and ~$0.01-0.05 per trigger. This is negligible since
alerts trigger infrequently by design.

### 3.5 Alert Analysis Flow (On Trigger Only)

When an alert triggers, the system uses the **existing MainAgent** to investigate *why*. This is the same agent used for chat queries in `agent-user-response.ts`, but we only use its text output — no component generation.

```
How agent-user-response.ts works (for chat):
  1. MainAgent.handleQuestion(userPrompt)     → routes, queries, analyzes
  2. generateAgentComponents(agentResponse)   → generates DSL components
  3. Query security (queryId replacement)     → strips SQL from components

For alert analysis, we ONLY use step 1:
  1. MainAgent.handleQuestion(alertPrompt)    → routes, queries, analyzes
  2. Take agentResponse.text                  → the markdown analysis
  3. SKIP component generation entirely       → not needed for email
```

The flow in detail:

```
AlertAnalyzer.analyze(alert, currentValue, evaluationResult)
│
├── Build alert-context prompt:
│   "Alert 'Low Inventory' triggered on report 'Supply Chain Daily Summary'.
│    Metric: 'Total inventory in East warehouse'
│    Current value: 47, expected range: 100-10,000
│    Source: Warehouse DB (Postgres)
│
│    Investigate why this metric breached the threshold.
│    What are the top contributors? When did the change start?
│    Provide a brief analysis (3-5 bullet points) with actionable insights."
│
├── Call MainAgent.handleQuestion(alertPrompt, apiKey)
│   MainAgent internally does:
│   ├── Builds source summaries (already knows all project sources)
│   ├── Routes to the relevant source(s) via tool calling
│   ├── Dispatches SourceAgent(s) to run investigative queries
│   │   └── SourceAgent generates and executes 2-3 queries
│   │       e.g., "SELECT sku, product_name, quantity FROM inventory
│   │              WHERE warehouse = 'EAST' ORDER BY quantity ASC LIMIT 10"
│   └── Produces final text analysis from the query results
│
├── Extract: agentResponse.text → markdown analysis
│   "Inventory in the East warehouse dropped to 47 units.
│    Key findings:
│    • SKU-4821 (Industrial Bolts) at 0 units — last restocked 45 days ago
│    • SKU-1190 (Steel Plates) dropped from 280 to 12 — bulk order shipped
│    • 3 of 8 product categories at zero stock"
│
└── Return: { analysis: agentResponse.text, success: true }
```

**Why use MainAgent directly instead of calling SourceAgent + separate LLM?**
- MainAgent already handles source routing — it picks the right source(s) automatically
- MainAgent already orchestrates SourceAgent calls and produces the analysis text
- One call instead of two — simpler code, fewer failure points
- Same code path as chat queries — well-tested, consistent behavior
- We just skip `generateAgentComponents()` since email doesn't need DSL components

### 3.5 Data Model

#### Alert Rule (stored in `report_alerts` table)

```
┌─────────────────────────────────────────────────────────────┐
│                      report_alerts                           │
├─────────────────────────────────────────────────────────────┤
│  id              SERIAL PRIMARY KEY                          │
│  alertId         VARCHAR(255) UNIQUE     -- "alert_xxx"      │
│  reportId        VARCHAR(255) NOT NULL   -- links to report  │
│  projectId       VARCHAR(255) NOT NULL                       │
│  name            VARCHAR(255)            -- "Low Inventory"  │
│  enabled         BOOLEAN DEFAULT true                        │
│                                                             │
│  ── METRIC DEFINITION ──                                    │
│  metricDescription TEXT                  -- natural language  │
│                                          -- "total inventory  │
│                                          --  in East warehouse│
│  sourceId        VARCHAR(255)            -- auto-detected or  │
│                                          -- manually selected │
│  generatedQuery  TEXT                    -- cached query from  │
│                                          -- source agent      │
│  resultColumn    VARCHAR(255)            -- column to extract │
│                                                             │
│  ── ALERT CONDITION ──                                      │
│  conditionType   VARCHAR(50)             -- 'threshold' or   │
│                                          -- 'deviation'      │
│  config          JSONB                   -- condition params │
│                                                             │
│  ── SCHEDULE ──                                             │
│  checkInterval   VARCHAR(50)             -- '15m','1h','6h', │
│                                          -- '1d','1w'        │
│  ── NOTIFICATION ──                                         │
│  recipients      JSONB                   -- [email strings]  │
│  emailSubject    VARCHAR(255)            -- custom subject   │
│  cooldownMinutes INTEGER DEFAULT 60      -- min gap between  │
│                                          -- repeated alerts  │
│  ── TRACKING ──                                             │
│  lastCheckedAt   TIMESTAMP                                   │
│  lastTriggeredAt TIMESTAMP                                   │
│  lastValue       DOUBLE PRECISION                            │
│  consecutiveErrors INTEGER DEFAULT 0     -- error counter    │
│  status          VARCHAR(50)             -- 'ok','triggered',│
│                                          -- 'error'          │
│  createdBy       VARCHAR(255)            -- user ID (string) │
│  createdAt       TIMESTAMP DEFAULT NOW()                     │
│  updatedAt       TIMESTAMP DEFAULT NOW()                     │
└─────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- `metricDescription` — the user's natural language input, kept for display and re-generation
- `generatedQuery` — the cached query produced by the source agent during setup. This is what runs on every evaluation, not the natural language description
- `resultColumn` — the column to extract the numeric value from (auto-detected by the source agent)
- `sourceId` — auto-detected via MainAgent source routing, with manual override option
- `consecutiveErrors` — tracks consecutive failures for auto-disable logic
- `createdBy` is `VARCHAR(255)` (not integer — users table was removed in migration 0002)
- `recipients` stores email strings directly (not user IDs)
- `config` is JSONB, same pattern as `report` column in the `reports` table

#### Condition Config (JSONB)

**For Threshold alerts:**
```json
{
  "type": "threshold",
  "operator": "outside_range",
  "min": 100,
  "max": 10000
}
```

Supported operators:
| Operator | Meaning | Fields Used |
|----------|---------|-------------|
| `lt` | Value < threshold | `threshold` |
| `gt` | Value > threshold | `threshold` |
| `lte` | Value <= threshold | `threshold` |
| `gte` | Value >= threshold | `threshold` |
| `outside_range` | Value < min OR value > max | `min`, `max` |
| `inside_range` | min <= value <= max (inverse alert) | `min`, `max` |

**For Standard Deviation alerts:**
```json
{
  "type": "deviation",
  "baseValue": 500,
  "baseSource": "fixed",
  "deviationThreshold": 2.0,
  "direction": "both"
}
```

| Field | Description |
|-------|-------------|
| `baseValue` | Fixed base value to compare against |
| `baseSource` | `"fixed"` in v1 (user provides the base value). `"auto"` planned for v2 |
| `deviationThreshold` | Number of standard deviations (e.g., 2.0 = 2σ) |
| `direction` | `"above"` = only alert if above, `"below"` = only if below, `"both"` = either direction |

**Note:** In v1, deviation only supports `baseSource: "fixed"`. The user provides a known base value and the engine checks if the current metric value deviates beyond the threshold. Auto-calculating mean/stddev from historical data is deferred to v2 (see Section 11.4).

---

## 4. Alert Engine Logic

### 4.1 Threshold Check

```
User configures:
  metric_description = "Total inventory in East warehouse"
  (auto-detected)    → sourceId = "warehouse-db-postgres"
  (auto-generated)   → generatedQuery = "SELECT SUM(quantity) as total
                                          FROM inventory
                                          WHERE warehouse = 'EAST'"
  (auto-detected)    → resultColumn = "total"
  operator           = "outside_range"
  min                = 100
  max                = 10000

Engine runs (every check):
  1. Get source instance for sourceId
  2. Execute generatedQuery via source.execute() → gets value (e.g., 47)
  3. Check: is 47 < 100 OR 47 > 10000?  → YES (47 < 100)
  4. Alert triggered → send email with report
```

### 4.2 Standard Deviation Check (v1 — Fixed Base Only)

```
User configures:
  metric_description   = "Daily order count"
  (auto-detected)      → sourceId = "orders-mssql"
  (auto-generated)     → generatedQuery = "SELECT COUNT(*) as order_count
                                            FROM orders
                                            WHERE order_date = CAST(GETDATE() AS DATE)"
  (auto-detected)      → resultColumn = "order_count"
  baseSource           = "fixed"
  baseValue            = 200         (user provides expected normal value)
  deviationThreshold   = 2.0
  direction            = "both"

Engine runs:
  1. Execute generatedQuery → today's value = 350
  2. deviation = |350 - 200| / 200 = 0.75 (percentage deviation)
  3. Check: 0.75 > 2.0 threshold? → NO
  4. Not triggered
```

### 4.3 Cooldown Logic

To avoid email flooding:

```
1. Alert condition met
2. Check: lastTriggeredAt + cooldownMinutes > now?
   - YES → Skip (already alerted recently)
   - NO  → Send email, update lastTriggeredAt
```

### 4.4 Query Re-Generation

When the user edits a saved alert and changes the `metricDescription`:

```
1. User modifies description: "Total inventory" → "Total inventory by weight"
2. User clicks [Test Metric]
3. Backend: re-runs source routing (may detect same or different source)
4. Backend: SourceAgent generates NEW query for the updated description
5. Frontend: shows new detected source, new query, new result
6. On Save: overwrites generatedQuery + sourceId + resultColumn
```

The cached query is always regenerated when the metric description changes.

---

## 5. Backend Implementation

### 5.1 New Files to Create

```
backend/src/
├── collections/
│   └── report-alerts.ts          # CRUD operations for alert rules
├── services/
│   ├── alert-engine.ts           # Core evaluation logic
│   ├── alert-analyzer.ts         # AI analysis on trigger (SourceAgent + analysis LLM)
│   ├── alert-scheduler.ts        # Interval scheduler for periodic checks
│   ├── alert-metric-resolver.ts  # Source routing + query generation (uses agents)
│   └── email-service.ts          # Real email sending (Resend/SMTP)

database/postgres/
├── drizzle/
│   └── schema.ts                 # Add report_alerts + alert_history tables
├── src/project-data-db/
│   └── report-alerts.ts          # Drizzle ORM CRUD for report_alerts
```

### 5.2 Metric Resolver (`services/alert-metric-resolver.ts`)

This is the bridge between the alert system and the multi-agent system. Used **only during alert setup** (not at runtime).

```
AlertMetricResolver
│
├── resolveMetric(projectId, metricDescription)
│   ├── Load project sources
│   ├── buildSourceSummaries() for all sources
│   ├── MainAgent source routing:
│   │   └── Match metricDescription to best source → sourceId
│   ├── SourceAgent query generation:
│   │   └── Generate query for the matched source → generatedQuery
│   ├── Execute the generated query
│   ├── Auto-detect resultColumn (first numeric column)
│   └── Return:
│       {
│         sourceId,
│         sourceName,
│         sourceType,
│         generatedQuery,
│         resultColumn,
│         currentValue,
│         allColumns      // for manual column selection
│       }
│
├── resolveMetricForSource(sourceId, metricDescription)
│   ├── Same as above but skips source routing
│   ├── Used when user manually selects a source via [Change ▼]
│   └── SourceAgent generates query for the specified source only
│
└── testQuery(sourceId, generatedQuery, resultColumn)
    ├── Execute an already-cached query
    └── Return current value (used by [Test] button on saved alerts)
```

### 5.3 Alert Engine (`services/alert-engine.ts`)

```
AlertEngine
│
├── evaluateAlert(alert)
│   ├── Get source instance for alert.sourceId
│   ├── Execute alert.generatedQuery via source.execute()
│   ├── Extract value from alert.resultColumn
│   ├── Based on conditionType:
│   │   ├── "threshold" → evaluateThreshold(value, config)
│   │   └── "deviation" → evaluateDeviation(value, config)
│   ├── If triggered AND cooldown passed:
│   │   ├── Run AlertAnalyzer.analyze(alert, value, evaluationResult)
│   │   │   └── Returns markdown analysis (see 5.4)
│   │   ├── Send email via EmailService (metric details + analysis)
│   │   ├── Update lastTriggeredAt, lastValue, status
│   │   ├── Reset consecutiveErrors to 0
│   │   └── Log alert event + analysis to alert_history
│   ├── If NOT triggered:
│   │   ├── Update lastCheckedAt, lastValue, status = 'ok'
│   │   └── Reset consecutiveErrors to 0
│   └── If ERROR:
│       ├── Increment consecutiveErrors
│       ├── Update status = 'error'
│       └── If consecutiveErrors >= 3 → auto-disable alert, log warning
│
├── evaluateThreshold(value, config)
│   ├── lt:            value < config.threshold
│   ├── gt:            value > config.threshold
│   ├── outside_range: value < config.min OR value > config.max
│   └── inside_range:  value >= config.min AND value <= config.max
│
└── evaluateDeviation(value, config)
    ├── base = config.baseValue (v1: fixed only)
    ├── deviation = |value - base| / base
    ├── Check direction:
    │   ├── "above": triggered if value > base AND deviation > threshold
    │   ├── "below": triggered if value < base AND deviation > threshold
    │   └── "both":  triggered if deviation > threshold
    └── Return result
```

The alert engine itself makes no LLM calls — it delegates to AlertAnalyzer only when a trigger occurs.

### 5.4 Alert Analyzer (`services/alert-analyzer.ts`)

Called by the alert engine **only when an alert triggers**. Uses the existing `MainAgent` to investigate *why* the metric breached the threshold and produce a markdown analysis.

```
AlertAnalyzer
│
├── analyze(alert, currentValue, evaluationResult, report)
│   │
│   ├── Build alert-context prompt:
│   │   "Alert '{alert.name}' triggered on report '{report.name}'.
│   │    Metric: '{alert.metricDescription}'
│   │    Current value: {currentValue}
│   │    Condition: {evaluationResult.reason}
│   │
│   │    Investigate why this metric breached the threshold.
│   │    What are the top contributors to this change?
│   │    When did this start? Are there any outliers?
│   │    Provide a brief analysis (3-5 bullet points) with
│   │    specific numbers, names, and dates. Focus on actionable insights."
│   │
│   ├── Create MainAgent with source tools (same setup as agent-user-response.ts)
│   │   └── No streamCallback needed (not streaming to frontend)
│   │
│   ├── Call mainAgent.handleQuestion(alertPrompt, apiKey)
│   │   MainAgent internally:
│   │   ├── Routes to the relevant source(s) via source summaries
│   │   ├── Dispatches SourceAgent(s) to run investigative queries
│   │   └── Produces text analysis from the query results
│   │
│   ├── Extract agentResponse.text → the markdown analysis
│   │   (SKIP generateAgentComponents — not needed for email)
│   │
│   └── Return: { analysis: agentResponse.text, success: true }
│
└── Error handling:
    ├── If MainAgent fails → return { analysis: null, success: false }
    ├── Caller (AlertEngine) sends email without analysis section
    └── Analysis failure should NEVER block the alert email
```

**Key principles:**
- Reuses the exact same `MainAgent` + `SourceAgent` flow from `agent-user-response.ts`
- Only uses `agentResponse.text` — skips `generateAgentComponents()` entirely
- One function call instead of manually orchestrating SourceAgent + separate analysis LLM
- Best-effort: if the MainAgent fails, the email still sends with metric details only

### 5.4 Scheduler (`services/alert-scheduler.ts`)

```
AlertScheduler
│
├── start()
│   └── Set up interval timer (runs every 1 minute)
│
├── tick()  (every minute)
│   ├── Load all enabled alerts from DB
│   ├── For each alert:
│   │   ├── Is it time to check? (based on checkInterval + lastCheckedAt)
│   │   │   ├── "15m" → lastCheckedAt + 15min < now?
│   │   │   ├── "1h"  → lastCheckedAt + 1hr < now?
│   │   │   ├── "6h"  → lastCheckedAt + 6hr < now?
│   │   │   ├── "1d"  → lastCheckedAt + 24hr < now?
│   │   │   └── "1w"  → lastCheckedAt + 7 days < now?
│   │   └── YES → alertEngine.evaluateAlert(alert)
│   └── Log check cycle complete
│
└── stop()
    └── Clear interval timer
```

### 5.6 Email Service (`services/email-service.ts`)

Replace the mock email with a real provider. Recommended: **Resend** (simple API, good free tier).

```
EmailService
│
├── sendAlertEmail(params)
│   ├── recipients: string[] (email addresses from alert config)
│   ├── report: Report (the linked report)
│   ├── alertDetails:
│   │   ├── alertName, metricDescription
│   │   ├── currentValue, threshold/baseValue
│   │   ├── conditionType, triggered reason
│   │   └── timestamp
│   ├── analysis: string | null (markdown from AlertAnalyzer)
│   │
│   └── Send via Resend API:
│       POST https://api.resend.com/emails
│       {
│         from: "alerts@yourdomain.com",
│         to: ["user1@email.com", "user2@email.com"],
│         subject: "[Alert] Low Inventory — East Warehouse",
│         html: "<email template with metric + analysis + report link>"
│       }
│
└── sendScheduledReport(params)
    └── Existing scheduled report delivery (non-alert based)
```

### 5.7 Collection Operations (`collections/report-alerts.ts`)

Follows the same `sdk.addCollection()` pattern used by `collections/reports.ts`.

| Operation | Description |
|-----------|-------------|
| `create` | Create a new alert rule for a report |
| `getAll` | List all alerts for a project |
| `getByReport` | List alerts for a specific report |
| `getOne` | Get alert by ID |
| `update` | Update alert config/conditions |
| `delete` | Delete an alert rule |
| `enable` | Enable an alert |
| `disable` | Disable an alert (stops checking) |
| `resolveMetric` | Run source routing + query generation for a metric description (setup-time) |
| `testAlert` | Execute the cached query and evaluate condition (does not send email) |
| `getHistory` | Get recent alert trigger history |

---

## 6. Frontend UI Design

### 6.1 Where It Lives

The Report Detail page currently has a right sidebar with **2 tabs**: Settings and Chat. Add a third **"Alerts"** tab.

```
┌─────────────────────────────────────────────────────────┐
│  Report: Supply Chain Daily Summary                      │
│                                                         │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Settings  │  │ Chat     │  │ Alerts ● │  ← New tab  │
│  └───────────┘  └──────────┘  └──────────┘             │
│                                                         │
```

### 6.2 Alerts Tab — List View

```
┌─────────────────────────────────────────────────────────┐
│  Alert Conditions                            [+ Add]    │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Low Inventory Alert                     [On/Off] │  │
│  │  "Total inventory in East warehouse"              │  │
│  │  Source: Warehouse DB (Postgres)                   │  │
│  │  Trigger: Outside range [100 — 10,000]            │  │
│  │  Checks: Every 1 hour | Last: 5 min ago | OK     │  │
│  │                                     [Edit] [Test] │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Order Volume Anomaly                    [On/Off] │  │
│  │  "Daily order count"                              │  │
│  │  Source: Orders System (MSSQL)                    │  │
│  │  Trigger: > 2σ from base (200)                    │  │
│  │  Checks: Every 6 hours | Last: 2 hr ago | ALERT  │  │
│  │                                     [Edit] [Test] │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Shipment Delay Spike                    [On/Off] │  │
│  │  "Average shipping delay in days"                 │  │
│  │  Source: Logistics (MySQL)                        │  │
│  │  Trigger: > 50                                    │  │
│  │  Checks: Daily | Disabled                         │  │
│  │                                     [Edit] [Test] │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 6.3 Alert Configuration Dialog

When user clicks **[+ Add]** or **[Edit]**:

```
┌─────────────────────────────────────────────────────────┐
│  Configure Alert                                    [X] │
│                                                         │
│  Alert Name                                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Low Inventory Alert                               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ── METRIC ──                                           │
│                                                         │
│  What do you want to monitor?                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Total inventory quantity in East warehouse        │  │
│  └───────────────────────────────────────────────────┘  │
│  Describe the metric in plain English. The system       │
│  will find the right data source and generate the       │
│  query automatically.                                   │
│                                                         │
│  [Test Metric]                                          │
│                                                         │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │  Detected Source                                  │  │
│  │  Warehouse DB (Postgres)             [Change ▼]   │  │
│  │                                                   │  │
│  │  Generated Query (read-only)                      │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ SELECT SUM(quantity) as total               │  │  │
│  │  │ FROM inventory                              │  │  │
│  │  │ WHERE warehouse = 'EAST'                    │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  Result Column: total                             │  │
│  │  Current Value: 4,720                             │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│  (This section appears after clicking [Test Metric])    │
│                                                         │
│  ── CONDITION TYPE ──                                   │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────┐         │
│  │ ● Threshold      │  │ ○ Standard Deviation │         │
│  └──────────────────┘  └──────────────────────┘         │
│                                                         │
│  ══════════════════════════════════════════════          │
│  THRESHOLD CONFIGURATION (shown when Threshold selected)│
│  ══════════════════════════════════════════════          │
│                                                         │
│  Condition                                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Outside permissible range            ▼            │  │
│  └───────────────────────────────────────────────────┘  │
│  Options:                                               │
│    • Less than (value < threshold)                      │
│    • Greater than (value > threshold)                   │
│    • Outside permissible range (value < min OR > max)   │
│    • Inside range (alert when within range)             │
│                                                         │
│  Min Value              Max Value                       │
│  ┌──────────────┐       ┌──────────────┐                │
│  │ 100          │       │ 10000        │                │
│  └──────────────┘       └──────────────┘                │
│                                                         │
│  ══════════════════════════════════════════════          │
│  DEVIATION CONFIG (shown when Std Deviation selected)   │
│  ══════════════════════════════════════════════          │
│                                                         │
│  Base Value (expected normal value)                     │
│  ┌──────────────┐                                       │
│  │ 200          │  The value you expect under normal    │
│  └──────────────┘  conditions                           │
│                                                         │
│  Deviation Threshold                                    │
│  ┌──────────────┐                                       │
│  │ 2.0 σ     ▼  │                                       │
│  └──────────────┘                                       │
│  Options: 1.0 / 1.5 / 2.0 / 2.5 / 3.0 σ               │
│                                                         │
│  Alert Direction                                        │
│  ┌──────────────────┐                                   │
│  │ Both directions              ▼                    │  │
│  └──────────────────┘                                   │
│  Options: Above only / Below only / Both directions     │
│                                                         │
│  ── CHECK SCHEDULE ──                                   │
│                                                         │
│  Check Every                                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Every 1 hour                      ▼               │  │
│  └───────────────────────────────────────────────────┘  │
│  Options: Every 15 min / 1 hour / 6 hours / Daily /     │
│           Weekly                                        │
│                                                         │
│  Cooldown (min gap between repeated alerts)             │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 60 minutes                        ▼               │  │
│  └───────────────────────────────────────────────────┘  │
│  Options: 30 min / 1 hour / 4 hours / 12 hours / 24 hr │
│                                                         │
│  ── NOTIFICATION ──                                     │
│                                                         │
│  Recipients (email addresses)                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ john@company.com                            [x]   │  │
│  │ sarah@company.com                           [x]   │  │
│  │ [+ Add recipient]                                 │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Custom Email Subject (optional)                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │ [Alert] Low Inventory — East Warehouse            │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│                              [Cancel]  [Save Alert]     │
└─────────────────────────────────────────────────────────┘
```

### 6.4 Source Override Flow

When user clicks **[Change ▼]** on the detected source:

```
┌───────────────────────────────────────────────┐
│  Select Source                                │
│                                               │
│  Warehouse DB (Postgres)              ← auto  │
│  Orders System (MSSQL)                        │
│  Logistics Tracker (MySQL)                    │
│  Product Catalog (Excel)                      │
│  Monthly Metrics (CSV)                        │
│  Shipping API (REST API)                      │
│  Inventory API (GraphQL)                      │
└───────────────────────────────────────────────┘
```

After selecting a different source, the system re-runs the SourceAgent for that source with the same `metricDescription`, generating a new query. The user sees the updated generated query and result.

### 6.5 Test Alert Result

When user clicks **[Test]** on a saved alert:

```
┌───────────────────────────────────────────────┐
│  Test Result                                  │
│                                               │
│  Metric:       "Total inventory in East       │
│                 warehouse"                    │
│  Source:        Warehouse DB (Postgres)        │
│  Current Value: 47                            │
│  Condition:     Outside range [100 — 10,000]  │
│  Result:        WOULD TRIGGER                 │
│  Reason:        47 is below minimum (100)     │
│                                               │
│  (No email sent — this is a test only)        │
└───────────────────────────────────────────────┘
```

For deviation:

```
┌───────────────────────────────────────────────┐
│  Test Result                                  │
│                                               │
│  Metric:       "Daily order count"            │
│  Source:        Orders System (MSSQL)          │
│  Current Value: 350                           │
│  Base Value:    200                           │
│  Deviation:     75% (above threshold 200%)    │
│  Result:        NOT TRIGGERED                 │
│  Reason:        Within acceptable range       │
│                                               │
│  (No email sent — this is a test only)        │
└───────────────────────────────────────────────┘
```

---

## 7. Email Content

When an alert triggers, the email contains **three sections**: metric status, AI analysis, and action links.

### 7.1 Email Template

```
Subject: [Alert] Low Inventory — East Warehouse

─────────────────────────────────────────────

  ALERT TRIGGERED

  Report:     Supply Chain Daily Summary
  Alert:      Low Inventory Alert
  Project:    ACME Supply Chain
  Source:     Warehouse DB (Postgres)

─────────────────────────────────────────────

  METRIC

  Monitoring:      "Total inventory in East warehouse"
  Current Value:   47
  Condition:       Must be between 100 and 10,000
  Status:          BELOW MINIMUM (47 < 100)

  Checked At:      Mar 9, 2026 — 14:30 UTC

─────────────────────────────────────────────

  ANALYSIS

  Inventory in the East warehouse dropped to 47 units,
  well below the minimum threshold of 100.

  Key findings:
  • Product SKU-4821 (Industrial Bolts) went to 0 units
    — last restocked 45 days ago
  • Product SKU-1190 (Steel Plates) dropped from 280 to 12
    — large order #ORD-9847 shipped 3 hours ago
  • 3 of 8 product categories are now at zero stock

  The drop is primarily driven by order #ORD-9847
  (bulk shipment of 268 Steel Plates to Customer ABC Corp).

─────────────────────────────────────────────

  [View Full Report →]    [View Dashboard →]

─────────────────────────────────────────────

  You received this because you're subscribed to alerts
  for "Supply Chain Daily Summary" report.

  Manage alert settings → [link]
```

### 7.2 Email Without Analysis (Fallback)

If the AI analysis fails (SourceAgent error, LLM timeout, etc.), the email still sends with the metric section only:

```
Subject: [Alert] Low Inventory — East Warehouse

─────────────────────────────────────────────

  ALERT TRIGGERED
  ...

─────────────────────────────────────────────

  METRIC
  ...
  (same as above)

─────────────────────────────────────────────

  [View Full Report →]    [View Dashboard →]

─────────────────────────────────────────────
```

The analysis is best-effort — its absence should never block the alert email.

### 7.3 What Makes This Valuable

| Email without analysis | Email with analysis |
|------------------------|---------------------|
| "Inventory = 47, below 100" | "Inventory dropped because SKU-4821 hit 0 (not restocked in 45 days) and a bulk order shipped 268 Steel Plates" |
| User must log in to investigate | User can understand and act from the email |
| Sends instantly | Adds ~5-10 seconds for investigation |
| $0 per trigger | ~$0.01-0.05 per trigger |

---

## 8. New Components Summary

### Backend

| File | Purpose |
|------|---------|
| `database/postgres/drizzle/schema.ts` | Add `report_alerts` + `alert_history` tables |
| `database/postgres/src/project-data-db/report-alerts.ts` | Drizzle ORM CRUD operations |
| `backend/src/collections/report-alerts.ts` | Collection API (same pattern as `reports.ts`) |
| `backend/src/services/alert-metric-resolver.ts` | Source routing + query generation via agents (setup-time) |
| `backend/src/services/alert-analyzer.ts` | AI analysis on trigger: SourceAgent queries + analysis LLM call |
| `backend/src/services/alert-engine.ts` | Evaluate threshold and deviation conditions |
| `backend/src/services/alert-scheduler.ts` | Periodic timer that checks due alerts |
| `backend/src/services/email-service.ts` | Real email sending via Resend API |

### Frontend (sa-platform-ui)

| File | Purpose |
|------|---------|
| `components/reports/details/AlertsTab.tsx` | Alert list within report detail sidebar |
| `components/reports/details/AlertConfigDialog.tsx` | Create/edit alert with NL metric input |
| `components/reports/details/AlertTestResult.tsx` | Display test run results |
| `store/ReportAlertStore.ts` | MobX store for alert state |
| `types/report-alert.ts` | TypeScript interfaces for alerts |

### Environment Variables

```env
# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxx
ALERT_FROM_EMAIL=alerts@yourdomain.com

# Alert Engine
ALERT_CHECK_ENABLED=true
ALERT_SCHEDULER_INTERVAL_MS=60000   # how often scheduler ticks (1 min)
```

### New Dependency

```json
{
  "dependencies": {
    "resend": "^4.0.0"
  }
}
```

---

## 9. TypeScript Interfaces

```typescript
// ── Alert Rule ──

interface ReportAlert {
  id: number;
  alertId: string;
  reportId: string;
  projectId: string;
  name: string;
  enabled: boolean;

  // Metric (natural language + cached query)
  metricDescription: string;    // "total inventory in East warehouse"
  sourceId: string;             // auto-detected or manually selected
  generatedQuery: string;       // cached query from source agent
  resultColumn: string;         // column to extract value from

  // Condition
  conditionType: 'threshold' | 'deviation';
  config: ThresholdConfig | DeviationConfig;

  // Schedule
  checkInterval: '15m' | '1h' | '6h' | '1d' | '1w';

  // Notification
  recipients: string[];        // email addresses (not user IDs — no users table)
  emailSubject?: string;
  cooldownMinutes: number;

  // Tracking
  lastCheckedAt?: string;
  lastTriggeredAt?: string;
  lastValue?: number;
  consecutiveErrors: number;
  status: 'ok' | 'triggered' | 'error' | 'unchecked';

  createdBy: string;           // varchar(255) — matches reports table convention
  createdAt: string;
  updatedAt: string;
}

// ── Condition Configs ──

interface ThresholdConfig {
  type: 'threshold';
  operator: 'lt' | 'gt' | 'lte' | 'gte' | 'outside_range' | 'inside_range';
  threshold?: number;       // for lt, gt, lte, gte
  min?: number;             // for outside_range, inside_range
  max?: number;             // for outside_range, inside_range
}

interface DeviationConfig {
  type: 'deviation';
  baseSource: 'fixed';         // v1: fixed only. v2: 'auto' with lookback
  baseValue: number;           // expected normal value
  deviationThreshold: number;  // 1.0, 1.5, 2.0, 2.5, 3.0
  direction: 'above' | 'below' | 'both';
}

// ── Metric Resolution Result (returned by AlertMetricResolver) ──

interface MetricResolutionResult {
  sourceId: string;
  sourceName: string;
  sourceType: string;          // 'postgres' | 'mssql' | 'mysql' | 'excel' | etc.
  generatedQuery: string;
  resultColumn: string;
  currentValue: number;
  allColumns: string[];        // all columns in result, for manual selection
}

// ── Evaluation Result ──

interface AlertEvaluationResult {
  triggered: boolean;
  currentValue: number;
  reason: string;
  details: {
    // Threshold
    operator?: string;
    threshold?: number;
    min?: number;
    max?: number;
    // Deviation
    baseValue?: number;
    deviationValue?: number;
    deviationThreshold?: number;
    direction?: string;
  };
  checkedAt: string;
}

// ── Analysis Result (from AlertAnalyzer, only on trigger) ──

interface AlertAnalysisResult {
  analysis: string | null;       // markdown from MainAgent.handleQuestion().text
  success: boolean;              // false if MainAgent failed (email still sends without analysis)
}

// ── Alert History Entry (stored in alert_history table) ──

interface AlertHistoryEntry {
  id: number;
  alertId: string;
  triggeredAt: string;
  value: number;
  reason: string;
  analysis?: string;             // AI analysis markdown (if available)
}
```

---

## 10. Implementation Order

```
Phase 1: Foundation
  ├── Add report_alerts + alert_history tables to Drizzle schema + run migration
  ├── Build report-alerts Drizzle ORM service (same pattern as reports.ts)
  ├── Build alert CRUD collection (report-alerts.ts)
  ├── Build AlertMetricResolver (source routing + query gen via agents)
  ├── Set up Resend email service (replace mock)
  └── Add AlertsTab to ReportDetail sidebar + AlertConfigDialog

Phase 2: Engine
  ├── Build alert evaluation logic (threshold + deviation with fixed base)
  ├── Build scheduler with interval timer
  ├── Build AlertAnalyzer (SourceAgent investigation + analysis LLM call)
  ├── Add test-alert functionality (dry run with cached query)
  ├── Wire resolveMetric endpoint for [Test Metric] button
  ├── Wire source override flow ([Change ▼] re-generates query)
  └── Build alert list view in AlertsTab

Phase 3: Polish
  ├── Email template (HTML) with metric + analysis sections
  ├── Analysis fallback (send email without analysis if AI fails)
  ├── Cooldown logic
  ├── Status indicators in UI (ok / triggered / error)
  ├── consecutiveErrors counter + auto-disable after 3 failures
  └── Query re-generation when metricDescription is edited
```

---

## 11. Known Limitations (v1)

These are accepted trade-offs for the initial release. Each has a planned fix in v2.

### 11.1 In-Process Scheduler is Fragile

The scheduler runs as a `setInterval` inside the backend Node.js process.

- **Server restart = missed checks.** If the backend crashes or restarts, all pending checks are lost until the process comes back up. `lastCheckedAt` helps catch up on restart, but there's a window where alerts are not monitored.
- **Single instance only.** If multiple backend instances run (load balancing), every instance runs the scheduler independently, causing duplicate alert evaluations and duplicate emails.
- **No retry on transient failure.** If a source is temporarily unreachable during a check, the alert gets `status: 'error'` and waits for the next interval with no immediate retry.

**v1 mitigation:** Acceptable for single-instance deployments (current setup). On startup, the scheduler catches up by checking all alerts where `lastCheckedAt + checkInterval < now`.

### 11.2 Recipients as Raw Email Strings

The design stores `recipients: string[]` (email addresses) because there's no `users` table (removed in migration 0002).

- **No delivery validation** — no way to verify an email is real before saving
- **No deduplication** — same email could appear in the list twice
- **No self-service unsubscribe** — a recipient can't opt out without the alert owner editing the config
- **Stale emails** — if someone leaves the company, their email remains in the alert config forever

**v1 mitigation:** Basic email format validation on save. The alert creator is responsible for managing their recipient list manually.

### 11.3 LLM-Generated Query May Not Be Perfect

The source agent generates the query from the metric description. Potential issues:

- **Ambiguous descriptions** — "total sales" could mean revenue, order count, or units sold. The agent picks one interpretation.
- **Wrong source detection** — the MainAgent source routing may pick the wrong source if multiple sources have similar data.
- **Query correctness** — the generated query may have subtle errors (wrong JOINs, missing filters) that return incorrect values.

**v1 mitigation:**
- The generated query is shown to the user during setup — they can see what will run
- [Test Metric] lets the user verify the result before saving
- The user can [Change ▼] the source if auto-detection is wrong
- The cached query is deterministic after setup — same query runs every time, so if the test looked correct, evaluations will be correct
- Power users can request the metric description be very specific: "SUM of quantity column from inventory table where warehouse equals EAST"

### 11.4 Standard Deviation — Auto-Calculate Lookback Not Supported

In v1, deviation alerts only support `baseSource: "fixed"` — the user provides a known base value.

- No automatic mean/stddev calculation from historical data
- The user must know what the "normal" value is
- If the normal value changes over time, the user must manually update `baseValue`

**v1 mitigation:** Acceptable for initial use cases. Business users typically know their expected baseline ("we normally ship 200 orders/day"). Auto-calculate from historical data is planned for v2.

### 11.5 No Permission Model on Alert CRUD

The existing reports collection does not enforce per-user permissions — any authenticated user can CRUD any report in any project. Alerts inherit this behavior.

- Any user could create alerts on any report in any project
- Any user could view generated queries (potentially revealing business logic)
- Any user could disable or delete another user's alerts

**v1 mitigation:** Filter all alert operations by `projectId`. The platform appears to be single-tenant per deployment, so this is acceptable. Multi-tenant access control deferred to v2.

### 11.6 Schedule Config Lives in localStorage (Existing Issue)

The existing `ReportStore.updateSchedule()` only saves schedule configs to localStorage — it never persists to the backend. This means:

- Schedule configs are **browser-local only** — different browsers/devices don't share them
- The backend has **no access** to schedule configs set from the frontend
- This is an existing issue with the schedule feature, not introduced by alerts

**v1 mitigation:** The alert system avoids this entirely by storing all alert configs in the `report_alerts` Postgres table (server-side). The existing schedule feature's localStorage-only behavior is a separate fix.

### 11.7 Source Availability at Check Time

When the scheduler runs, the target source may be unavailable:

- **Disconnected** — Excel/CSV file sources loaded at startup but connection dropped
- **Unreachable** — external database behind a firewall/VPN that is intermittently down
- **Rate-limited** — REST API or GraphQL sources with rate limits

The alert simply gets `status: 'error'` with no further action.

**v1 mitigation:** `consecutiveErrors` counter on each alert. After 3 consecutive failures, auto-disable the alert and log a warning. Counter resets on next successful evaluation.

### 11.8 No Alert Volume Controls

There's no system-wide limit on how many alerts can exist or how often they fire:

- A user could create hundreds of alerts checking every 15 minutes
- Each check runs a query against a source — high alert volume could overload source databases
- The 1-minute scheduler tick evaluates all due alerts sequentially — a large number could cause drift

**v1 mitigation:** Not addressed in v1. Acceptable at current scale (small number of projects/alerts per deployment).

### 11.9 AI Analysis is Best-Effort

The alert analysis uses `MainAgent.handleQuestion()` on every trigger — the same flow as chat queries but without component generation. Potential issues:

- **LLM latency** — adds 5-10 seconds to the alert-to-email time (MainAgent does source routing + SourceAgent queries + text generation)
- **LLM cost** — ~$0.01-0.05 per trigger (negligible for infrequent alerts, could add up if many alerts trigger simultaneously)
- **Analysis quality** — the MainAgent picks which sources to query and what to investigate. It may miss the real cause or focus on irrelevant data
- **LLM downtime** — if the LLM API is down, the entire analysis fails
- **Source routing** — the MainAgent may route to a different source than the alert's `sourceId` if the prompt is ambiguous

**v1 mitigation:** Analysis failure never blocks the email. If the MainAgent call fails for any reason, the email sends with metric details only — no analysis section. The `AlertAnalysisResult.success` flag tracks whether analysis was included.

### 11.10 Cached Query Staleness

The `generatedQuery` is cached at setup time and never updated automatically.

- If the source schema changes (table renamed, column dropped), the cached query will fail
- The alert gets `status: 'error'` but the user has no automatic notification that the query is stale
- The user must manually edit the alert and re-test to regenerate the query

**v1 mitigation:** The `consecutiveErrors` auto-disable (11.7) will catch this. The user sees the alert status change to 'error' in the UI. Manual re-test regenerates the query.

---

## 12. v2 Improvements Roadmap

Planned improvements after the initial release is stable.

| Area | Improvement | Priority |
|------|-------------|----------|
| **Scheduler** | Replace `setInterval` with a proper job queue (BullMQ + Redis) for reliability, retries, and multi-instance support | High |
| **Scheduler** | Add distributed locking (Redis or Postgres advisory locks) to prevent duplicate evaluations across instances | High |
| **Deviation** | Implement `baseSource: "auto"` — use the source agent to generate a lookback query, calculate mean/stddev from historical data | High |
| **Deviation** | Add `lookbackDays` config (7/14/30/60/90) for auto-calculate mode | Medium |
| **Permissions** | Add project-level access control — only project members can create/view/edit alerts for that project | High |
| **Recipients** | Integrate with an identity provider or user directory for recipient management instead of raw email strings | Medium |
| **Recipients** | Add unsubscribe tokens in email footer — recipients can opt out without needing the alert owner | Medium |
| **Recipients** | Email delivery tracking — bounce detection, delivery confirmation via Resend webhooks | Low |
| **Metric Resolution** | Improve source routing confidence — show a confidence score and suggest alternatives when auto-detection is uncertain | Medium |
| **Metric Resolution** | Allow users to refine the generated query inline (optional SQL editing for power users) | Low |
| **Analysis** | Cache analysis investigation queries per alert — reuse effective queries instead of regenerating each time | Medium |
| **Analysis** | Allow users to customize the analysis prompt (e.g., "always check by region" or "compare to last week") | Low |
| **Analysis** | Include small inline charts/sparklines in the email for visual context | Low |
| **Cached Query** | Auto-detect schema changes and notify alert owner when cached query may be stale | Medium |
| **Cached Query** | Periodic query re-validation — run EXPLAIN on cached queries weekly to detect issues before they fail | Low |
| **Volume Control** | Add per-project alert limits (e.g., max 20 alerts per project) | Medium |
| **Volume Control** | Add global rate limiting on source queries from the alert scheduler | Medium |
| **Volume Control** | Parallelize alert evaluation with concurrency limits instead of sequential processing | Medium |
| **History** | Build alert history UI — timeline view of past triggers with values, reasons, and email delivery status | Medium |
| **History** | Alert analytics — trigger frequency trends, false positive rates | Low |
| **Schedule Feature** | Migrate existing report schedule configs from localStorage to Postgres (fix existing gap) | High |
| **Notifications** | Add Slack/webhook notification channels alongside email | Low |
| **Notifications** | Alert escalation — if alert stays triggered for N hours, escalate to a secondary recipient list | Low |
| **UI** | Alert dashboard — cross-report view of all active alerts and their statuses | Medium |
| **UI** | In-app notifications (bell icon) for triggered alerts, not just email | Medium |

---

*March 2026 — SuperAtom Platform*
