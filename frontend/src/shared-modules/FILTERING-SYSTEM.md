# Dashboard Filtering System

This document explains how the filtering system works for dashboard components, including frontend implementation and LLM prompt configuration.

## Overview

The filtering system allows users to filter dashboard data using a dropdown. When a user selects a filter option, all visualization components in the same dashboard automatically re-fetch their data with the new filter parameters.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MultiComponentContainer                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Header Row                                                  │ │
│  │  ┌─────────────────┐                                        │ │
│  │  │ FilterDropdown  │  ← User selects filter option          │ │
│  │  └────────┬────────┘                                        │ │
│  └───────────┼──────────────────────────────────────────────────┘ │
│              │                                                    │
│              │  Window Event: {uiBlockId}_FILTER or GLOBAL_FILTER │
│              │  Payload: { params: { startDate, endDate }, ... }  │
│              ▼                                                    │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Visualization Components (listening for filter events)    │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐      │   │
│  │  │ KPICard │  │BarChart │  │LineChart│  │DataTable │      │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘      │   │
│  │       │            │            │            │             │   │
│  │       └────────────┴────────────┴────────────┘             │   │
│  │                         │                                   │   │
│  │                         ▼                                   │   │
│  │              Re-fetch with merged params                    │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### 1. UI Block Scoping with Global Fallback

Each dashboard has a unique `uiBlockId` (from `SA_RUNTIME`). Filter events are scoped to this ID with a global fallback:

```typescript
const eventName = SA_RUNTIME?.uiBlockId
  ? `${SA_RUNTIME.uiBlockId}_FILTER`
  : 'GLOBAL_FILTER';
```

- **Scoped events**: `{uiBlockId}_FILTER` - Only components in the same UI block receive the event
- **Global fallback**: `GLOBAL_FILTER` - Used when no uiBlockId is available
- This allows multiple dashboards on the same page without interference

### 2. Query Format

All visualization components use the object query format with parameterized placeholders:

```typescript
interface QueryConfig {
  sql: string;                    // SQL with $paramName placeholders
  params?: Record<string, any>;   // Default parameter values
}
```

**Example:**
```json
{
  "query": {
    "sql": "SELECT category, SUM(amount) as total FROM orders WHERE order_date >= $startDate AND order_date <= $endDate GROUP BY category LIMIT 20",
    "params": {
      "startDate": "2025-10-01",
      "endDate": "2025-10-31"
    }
  }
}
```

### 3. FilterDropdown Structure

```typescript
interface FilterOption {
  label: string;                  // Display text: "This Month"
  value: string;                  // Unique ID: "current_month"
  params: Record<string, any>;    // Values to broadcast: { startDate, endDate }
  isDefault?: boolean;            // Is this the default selection?
}
```

**Example FilterDropdown props:**
```json
{
  "title": "Time Period",
  "defaultValue": "current_month",
  "filters": [
    {
      "label": "This Month",
      "value": "current_month",
      "params": { "startDate": "2025-12-01", "endDate": "2025-12-31" },
      "isDefault": true
    },
    {
      "label": "Last Month",
      "value": "last_month",
      "params": { "startDate": "2025-11-01", "endDate": "2025-11-30" }
    },
    {
      "label": "Last 3 Months",
      "value": "last_quarter",
      "params": { "startDate": "2025-10-01", "endDate": "2025-12-31" }
    }
  ]
}
```

---

## Data Flow

### Initial Load

1. MultiComponentContainer renders all components
2. FilterDropdown broadcasts initial filter params (with `isInitial: true`)
3. Other components receive event but skip re-fetch if they already have data

### User Changes Filter

1. User selects "Last Month" from FilterDropdown
2. FilterDropdown dispatches window event:
   ```javascript
   window.dispatchEvent(new CustomEvent(eventName, {
     detail: {
       params: { startDate: "2025-11-01", endDate: "2025-11-30" },
       filterValue: "last_month",
       isInitial: false
     }
   }));
   ```
3. All visualization components receive the event
4. Each component calls `fetchDataWithParams(params)` or `fetchExternalToolDataWithParams(params)`

---

## Frontend Component Implementation

### Required Pattern for All Visualization Components

Every visualization component must implement the following pattern:

#### 1. Filter State
```typescript
const [filterParams, setFilterParams] = useState<Record<string, any>>({});
```

#### 2. Filter Event Listener (CRITICAL)
```typescript
// Listen for filter events scoped to this uiBlockId
useEffect(() => {
  const eventName = SA_RUNTIME?.uiBlockId
    ? `${SA_RUNTIME.uiBlockId}_FILTER`
    : 'GLOBAL_FILTER';

  const handleFilterChange = (event: CustomEvent) => {
    const { params, isInitial } = event.detail || {};

    console.log(`[ComponentName] Received filter event ${eventName}:`, params);

    if (params && typeof params === 'object') {
      setFilterParams(params);

      // Re-fetch data with new filter params (skip if it's the initial mount event and we already have data)
      if (!isInitial || data.length === 0) {
        if (hasExternalTool) {
          fetchExternalToolDataWithParams(params);
        } else if (!config.data) {
          fetchDataWithParams(params);
        }
      }
    }
  };

  window.addEventListener(eventName, handleFilterChange as EventListener);

  console.log(`[ComponentName] Listening for filter events: ${eventName}`);

  return () => {
    window.removeEventListener(eventName, handleFilterChange as EventListener);
  };
}, [SA_RUNTIME?.uiBlockId, hasExternalTool, config.data]);
```

**Key points:**
- Falls back to `GLOBAL_FILTER` when no `uiBlockId` available
- Re-fetches when `!isInitial || data.length === 0`
- Dependencies include `hasExternalTool` and `config.data`

#### 3. fetchDataWithParams Function (for SQL queries)
```typescript
const fetchDataWithParams = async (filterParams: Record<string, any>) => {
  setLoading(true);
  setError(null);

  try {
    const queryExecutor = (window as any).SA?.QueryExecutor;
    if (!queryExecutor) throw new Error('QueryExecutor not available');

    // Extract SQL and existing params from query
    let sqlString: string;
    let existingParams: Record<string, any> = {};

    if (typeof query === 'object' && query !== null && 'sql' in query) {
      sqlString = query.sql;
      existingParams = query.params || {};
    } else if (typeof query === 'string') {
      try {
        const parsed = JSON.parse(query);
        if (parsed && typeof parsed === 'object' && parsed.sql) {
          sqlString = parsed.sql;
          existingParams = parsed.values || {};
        } else {
          sqlString = query;
        }
      } catch {
        sqlString = query;
      }
    } else {
      sqlString = '';
    }

    // Merge params (filter params take precedence)
    const mergedParams = { ...existingParams, ...filterParams };
    const finalQuery = JSON.stringify({ sql: sqlString, values: mergedParams });

    console.log('[ComponentName] Executing parameterized query:', finalQuery);

    const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });

    if (result && result.length > 0) {
      setData(result);
    } else {
      setData([]);
    }
  } catch (err) {
    console.error('[ComponentName] Error fetching data with params:', err);
    setError(err instanceof Error ? err.message : 'Failed to fetch data');
  } finally {
    setLoading(false);
  }
};
```

#### 4. fetchExternalToolDataWithParams Function (for external tools)
```typescript
const fetchExternalToolDataWithParams = async (params: Record<string, any>) => {
  if (!externalTool) return;

  setLoading(true);
  setError(null);

  try {
    const toolExecutor = (window as any).SA?.ToolExecutor;
    if (!toolExecutor) throw new Error('ToolExecutor not available');

    // Merge filter params with existing tool parameters
    const mergedParameters = {
      ...externalTool.parameters,
      ...params
    };

    console.log(`[ComponentName] Fetching external tool with filter params:`, mergedParameters);

    const result = await toolExecutor.executeTool({
      externalTool: {
        ...externalTool,
        parameters: mergedParameters
      },
      formData: {},
      SA_RUNTIME
    });

    // Extract data from result...
    // (handle various response formats)
  } catch (err) {
    console.error('[ComponentName] Error fetching external tool data with params:', err);
    setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
  } finally {
    setLoading(false);
  }
};
```

### How Parameter Merging Works

```javascript
// For SQL queries:
const mergedParams = { ...existingParams, ...filterParams };
// existingParams = { startDate: '2024-01-01', endDate: '2024-12-31' }
// filterParams   = { startDate: '2025-06-01' }
// mergedParams   = { startDate: '2025-06-01', endDate: '2024-12-31' }
// Filter params OVERRIDE existing params (spread order matters)

// For external tools:
const mergedParameters = { ...externalTool.parameters, ...params };
// Same principle - new filter values override old ones
```

---

## Components with Filter Support

All visualization components now support filtering:

| Component | Filter Support | fetchDataWithParams | fetchExternalToolDataWithParams |
|-----------|---------------|---------------------|--------------------------------|
| DynamicFilterDropdown | Broadcaster | N/A | N/A |
| DynamicBarChart | Listener | ✅ | ✅ |
| DynamicLineChart | Listener | ✅ | ✅ |
| DynamicPieChart | Listener | ✅ | ✅ |
| DynamicScatterChart | Listener | ✅ | ✅ |
| DynamicRadarChart | Listener | ✅ | ✅ |
| DynamicHeatmapChart | Listener | ✅ | ✅ |
| DynamicTreemapChart | Listener | ✅ | ✅ |
| DynamicWaterfallChart | Listener | ✅ | ✅ |
| DynamicCandleStickChart | Listener | ✅ | ✅ |
| DynamicGaugeChart | Listener | ✅ | ✅ |
| DynamicKPICard | Listener | ✅ | ✅ |
| DynamicDataTable | Listener | ✅ | ✅ |

---

## LLM Prompt Configuration

### Overview

The filtering system requires proper LLM configuration to:
1. Generate parameterized queries with `$paramName` placeholders
2. Proactively suggest FilterDropdown components
3. Generate meaningful filter options

### Prompt Changes

#### 1. `backend/.prompts/text-response/system.md`

**Added: Parameterized Query Format Rules**
```markdown
**Query Format - ALWAYS use parameterized queries:**

**CRITICAL: Every literal value in a WHERE/HAVING condition MUST use a $paramName placeholder. NEVER hardcode values directly in SQL.**

- `sql`: Query with `$paramName` placeholders for **every literal value** in WHERE/HAVING conditions
- `params`: Object mapping each placeholder (without $) to its actual value

**Pattern:**
- `WHERE column = 'value'` → `WHERE column = $paramName` + `params: { "paramName": "value" }`
- `WHERE column > 123` → `WHERE column > $paramName` + `params: { "paramName": 123 }`
- `WHERE column LIKE '%text%'` → `WHERE column LIKE $paramName` + `params: { "paramName": "%text%" }`

**What goes in params:** Any value from the user's question (filters, IDs, dates, search terms, thresholds, status values)
**What stays in SQL:** Table names, column names, SQL keywords, aggregate functions
```

**Why:** Ensures all queries use placeholders that can be overridden by filter params.

**Added: FilterDropdown Suggestion Rule**
```markdown
6. **IMPORTANT - FilterDropdown for interactive dashboards**:
   - If the data has dimensions that users would naturally want to filter by (date ranges, time periods, categories, statuses, types, regions, or any grouping column), suggest a `FilterDropdown` component
   - FilterDropdown allows users to dynamically change the view without asking new questions
   - When suggesting FilterDropdown, ensure your queries use `$paramName` placeholders for the filterable values
   - FilterDropdown should be suggested AFTER visualization components
```

**Why:** Previously, FilterDropdown was only suggested when users explicitly asked for it. This rule makes the LLM proactively suggest filters when data has natural filtering dimensions.

#### 2. `backend/.prompts/match-text-components/system.md`

**Changed: Query Format for Visualization Components**

Before:
```markdown
- For SELECT/visualization queries, use actual values, NOT placeholders
```

After:
```markdown
- For SELECT/visualization queries, ALWAYS use `{ "sql": "...", "params": {...} }` format:
  - SQL should use `$paramName` placeholders instead of hardcoded values
  - Actual values go in `params` object
```

**Why:** Enables filter params to override query values at runtime.

**Changed: FilterDropdown Generation Rules**

Before (restrictive):
```markdown
## FilterDropdown Generation (Dynamic Filtering)

After generating ALL visualization components, evaluate if a FilterDropdown would be useful:

**Add FilterDropdown ONLY when:**
- Components have parameterized queries with filterable dimensions...

**Do NOT add FilterDropdown when:**
- Query params are fixed values from user's specific question
- Only one meaningful filter option exists
- The dashboard is answering a one-time specific question
```

After (auto-detection with REQUIRED):
```markdown
## FilterDropdown Generation (REQUIRED)

**CRITICAL: After generating ALL visualization components, you MUST check if a FilterDropdown is needed.**

**Auto-Detection Rule:**
1. Look at the `params` object in each matched component's query
2. If 2 or more components share the same parameter key with the same value, you MUST generate a FilterDropdown
3. The shared params are the filterable dimensions - generate alternative values for them

**Skip FilterDropdown ONLY when:**
- All components have empty params `{}`
- The param is a unique record ID (e.g., order_id, customer_id)

**Generating filter options:**
1. The first option should match the current params from the components (set `isDefault: true`)
2. Generate 3-5 additional options with alternative values that users would naturally want to explore
3. Use your knowledge of the data domain to suggest meaningful alternatives
```

**Why:** The LLM now auto-detects filterable dimensions by looking at shared params across components. If multiple components have the same param (e.g., `delivery_method: "home_delivery"`), it generates a FilterDropdown with alternatives (e.g., "Click & Collect", "In-Store Purchase").

**Added: FilterDropdown Props Structure with Example**
```markdown
**FilterDropdown props structure:**
- `title`: Label for the dropdown
- `defaultValue`: Value of the initially selected option
- `filters`: Array where each item is a selectable option with:
  - `label`: Display text shown in dropdown
  - `value`: Unique identifier string
  - `params`: Object with values to replace `$paramName` placeholders in other components
  - `isDefault`: Boolean - set true for the default selected option

**Example FilterDropdown props:**
{
  "title": "Time Period",
  "defaultValue": "oct_2025",
  "filters": [
    { "label": "October 2025", "value": "oct_2025", "params": { "month": 10, "year": 2025 }, "isDefault": true },
    { "label": "September 2025", "value": "sep_2025", "params": { "month": 9, "year": 2025 } },
    { "label": "August 2025", "value": "aug_2025", "params": { "month": 8, "year": 2025 } }
  ]
}
```

**Why:** Provides explicit structure with example to prevent LLM from using wrong structure.

---

## Troubleshooting

### Filter dropdown not appearing
- Check if LLM is suggesting FilterDropdown in text-response step
- Verify match-text-components is matching it to actual component
- Check component metadata is being passed to LLM

### Filter dropdown only shows "All Time"
- LLM didn't generate `filters` array with options
- Check prompt configuration

### Query fails with "$paramName" error
- Backend received raw SQL with placeholder instead of parameterized format
- Ensure component uses `{ sql, params }` format
- Check `fetchData` converts to JSON string for backend

### Filter changes don't update components
- Check components are listening for correct event name
- Verify fallback to `GLOBAL_FILTER` is working
- Check `isInitial` flag handling
- Verify `fetchDataWithParams` and `fetchExternalToolDataWithParams` functions exist

### Components show stale data
- Ensure `fetchDataWithParams` is being called (not `fetchData`)
- Check filter params are being merged correctly
- Verify dependencies in useEffect are correct

### External tool data not updating with filters
- Ensure `fetchExternalToolDataWithParams` function exists
- Check `mergedParameters` includes both original and filter params
- Verify tool executor is passing merged parameters

---

## Summary of Changes Made

### Frontend Components Updated
All 12 visualization components were updated to:
1. Fall back to `GLOBAL_FILTER` when no `uiBlockId` available
2. Re-fetch when `!isInitial || data.length === 0` (not just `!isInitial`)
3. Add missing `fetchDataWithParams` and `fetchExternalToolDataWithParams` functions (HeatmapChart, TreemapChart, WaterfallChart, CandleStickChart)
4. Update useEffect dependencies to include `hasExternalTool` and `config.data`

### Backend Prompts Updated
1. **text-response/system.md**: Added parameterized query rules and FilterDropdown suggestion rule
2. **match-text-components/system.md**:
   - Added Query Format (CRITICAL) section requiring `{ sql, params }` object format
   - Changed FilterDropdown generation to REQUIRED with auto-detection rule
   - LLM MUST generate FilterDropdown when 2+ components share the same params
   - Added explicit FilterDropdown props structure with example
   - Simplified skip conditions (only empty params or unique ID)

---

## Platform UI Integration (Manual Dashboard Building)

This section describes how to add filtering to manually-built dashboards in the Platform UI application where components are created one-by-one.

### The Challenge

In Platform UI:
- Components are created individually via AI prompts
- Each widget gets a different `uiBlockId` (generated per request)
- Widgets don't share the same event channel
- Filter events won't propagate between widgets

### Solution: Shared Dashboard ID

Use `dashboardId` as `uiBlockId` for all widgets in the same dashboard.

**Change in DashboardDetail.tsx:**
```typescript
// Before:
SA_RUNTIME: {
  uiBlockId: `block-${Date.now()}`,  // ❌ Different for each widget
  threadId: dashboardId
}

// After:
SA_RUNTIME: {
  uiBlockId: dashboardId,  // ✅ Same for all widgets in dashboard
  threadId: dashboardId
}
```

---

### Complete Flow: Adding Filter to Existing Dashboard

#### Phase 1: User Builds Dashboard with Multiple Widgets

```
User Prompt: "Show me delivered orders count"
    ↓
AI generates KPICard:
{
  query: {
    sql: "SELECT COUNT(*) FROM orders WHERE status = 'Delivered'",
    params: {}
  }
}
    ↓
Widget saved with SA_RUNTIME: { uiBlockId: dashboardId }

User Prompt: "Show orders by payment method"
    ↓
AI generates BarChart:
{
  query: {
    sql: "SELECT payment_method, COUNT(*) FROM orders
          WHERE status = 'Delivered' GROUP BY payment_method",
    params: {}
  }
}
    ↓
Widget saved with SA_RUNTIME: { uiBlockId: dashboardId }
```

#### Phase 2: User Requests a Filter

```
User Prompt: "Add a filter for order status"
    ↓
System collects current dashboard DSL:
{
  dashboardId: "da_abc123",
  widgets: [
    { id: "widget-1", type: "KPICard", query: {...} },
    { id: "widget-2", type: "BarChart", query: {...} }
  ]
}
    ↓
Send to LLM: Dashboard DSL + User's filter request
```

#### Phase 3: LLM Analyzes & Generates Filter

**LLM Input:**
- Full dashboard DSL with all widget queries
- User's filter request

**LLM Tasks:**
1. Parse all widget queries
2. Find the filterable dimension (e.g., "status = 'Delivered'" in both queries)
3. Parameterize the queries with `$status`
4. Generate FilterDropdown with status options

**LLM Output:**
```json
{
  "canApplyFilter": true,
  "reason": "Found 'status' column in 2 widget queries",
  "affectedWidgets": ["widget-1", "widget-2"],
  "filterDropdown": {
    "type": "FilterDropdown",
    "props": {
      "title": "Order Status",
      "defaultValue": "delivered",
      "filters": [
        { "label": "Delivered", "value": "delivered",
          "params": { "status": "Delivered" }, "isDefault": true },
        { "label": "Shipped", "value": "shipped",
          "params": { "status": "Shipped" } },
        { "label": "Pending", "value": "pending",
          "params": { "status": "Pending" } }
      ]
    }
  },
  "modifiedWidgets": [
    {
      "id": "widget-1",
      "query": {
        "sql": "SELECT COUNT(*) FROM orders WHERE status = $status",
        "params": { "status": "Delivered" }
      }
    },
    {
      "id": "widget-2",
      "query": {
        "sql": "SELECT payment_method, COUNT(*) FROM orders
                WHERE status = $status GROUP BY payment_method",
        "params": { "status": "Delivered" }
      }
    }
  ]
}
```

#### Phase 4: Apply Changes to Dashboard

```javascript
function applyFilterToDashboard(originalDSL, llmResponse) {
  if (!llmResponse.canApplyFilter) {
    return { success: false, reason: llmResponse.reason };
  }

  // Replace modified widgets
  const updatedWidgets = originalDSL.widgets.map(widget => {
    const modified = llmResponse.modifiedWidgets.find(m => m.id === widget.id);
    if (modified) {
      return { ...widget, query: modified.query };
    }
    return widget;
  });

  // Add FilterDropdown as new widget
  const filterWidget = {
    id: `filter-${Date.now()}`,
    ...llmResponse.filterDropdown,
    SA_RUNTIME: { uiBlockId: originalDSL.dashboardId }
  };

  updatedWidgets.unshift(filterWidget);

  return {
    success: true,
    widgets: updatedWidgets
  };
}
```

#### Phase 5: Dashboard Renders

```
┌─────────────────────────────────────────────────────────────┐
│  Dashboard: da_abc123                                       │
│                                                             │
│  ┌─────────────────────┐                                    │
│  │   FilterDropdown    │  uiBlockId = "da_abc123"           │
│  │   [Delivered ▼]     │                                    │
│  └─────────────────────┘                                    │
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │      KPICard        │  │         BarChart            │  │
│  │    1,234 Orders     │  │   ████ Credit Card          │  │
│  │                     │  │   ███  PayPal               │  │
│  │  uiBlockId =        │  │   ██   Debit Card           │  │
│  │  "da_abc123"        │  │                             │  │
│  └─────────────────────┘  │  uiBlockId = "da_abc123"    │  │
│                           └─────────────────────────────┘  │
│                                                             │
│  All widgets share same uiBlockId ✅                        │
└─────────────────────────────────────────────────────────────┘

On Mount:
- FilterDropdown dispatches initial event to "da_abc123_FILTER"
- KPICard & BarChart listen for "da_abc123_FILTER" events
- All widgets show "Delivered" data
```

#### Phase 6: User Changes Filter

```
User selects "Shipped" from FilterDropdown
    ↓
FilterDropdown dispatches event:

window.dispatchEvent(new CustomEvent("da_abc123_FILTER", {
  detail: {
    params: { status: "Shipped" },
    filterLabel: "Shipped",
    filterValue: "shipped",
    isInitial: false
  }
}));
```

#### Phase 7: Widgets Re-fetch Data

```
┌─────────────────────────────────────────────────────────────┐
│  Event: "da_abc123_FILTER"                                  │
│  Payload: { params: { status: "Shipped" } }                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ↓               ↓               ↓
    ┌───────────┐   ┌───────────┐   ┌───────────┐
    │  KPICard  │   │  BarChart │   │  (others) │
    │  receives │   │  receives │   │  receive  │
    └─────┬─────┘   └─────┬─────┘   └───────────┘
          │               │
          ↓               ↓
    handleFilterChange()  handleFilterChange()
          │               │
          ↓               ↓
    Merge params:         Merge params:
    { status: "Shipped" } { status: "Shipped" }
          │               │
          ↓               ↓
    Execute query         Execute query
    with new params       with new params
          │               │
          ↓               ↓
    Update display        Update chart
    "892 Orders"          (Shipped breakdown)
```

#### Phase 8: Dashboard Updated

```
┌─────────────────────────────────────────────────────────────┐
│  Dashboard: da_abc123                                       │
│                                                             │
│  ┌─────────────────────┐                                    │
│  │   FilterDropdown    │                                    │
│  │   [Shipped ▼]       │  ← User's selection                │
│  └─────────────────────┘                                    │
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │      KPICard        │  │         BarChart            │  │
│  │     892 Orders      │  │   ████ Credit Card          │  │
│  │     (Shipped)       │  │   ███  PayPal               │  │
│  │                     │  │   ██   Debit Card           │  │
│  │     ✓ Updated!      │  │   (for Shipped orders)      │  │
│  └─────────────────────┘  │                             │  │
│                           │   ✓ Updated!                │  │
│                           └─────────────────────────────┘  │
│                                                             │
│  All widgets now show "Shipped" data! 🎉                    │
└─────────────────────────────────────────────────────────────┘
```

---

### LLM Prompt for Filter Generation

```markdown
## Your Task

You are given a dashboard DSL containing multiple visualization widgets.
The user wants to add a filter to this dashboard.

**Input:**
1. Dashboard DSL (JSON with widgets array, each widget has a query)
2. User's filter request (e.g., "Add a filter for order status")

**Your job:**
1. Analyze all widget queries in the DSL
2. Identify which queries can be filtered by the requested dimension
3. For each applicable query:
   - If dimension exists in WHERE clause → parameterize with $paramName
   - If dimension doesn't exist → add WHERE clause with $paramName
4. Generate a FilterDropdown component with meaningful options
5. Return the structured response

**Output Format:**
{
  "canApplyFilter": true/false,
  "reason": "Explanation of why filter can/cannot be applied",
  "affectedWidgets": ["widget-id-1", "widget-id-2"],
  "filterDropdown": {
    "type": "FilterDropdown",
    "props": {
      "title": "Filter title",
      "defaultValue": "default_option_value",
      "filters": [
        { "label": "Display Text", "value": "unique_id",
          "params": { "paramName": "value" }, "isDefault": true },
        { "label": "Option 2", "value": "option_2",
          "params": { "paramName": "value2" } }
      ]
    }
  },
  "modifiedWidgets": [
    {
      "id": "widget-id",
      "query": {
        "sql": "Query with $paramName placeholder",
        "params": { "paramName": "defaultValue" }
      }
    }
  ]
}

**Rules:**
- Only modify queries that contain the filterable dimension
- Use $paramName placeholders (not hardcoded values)
- Generate 3-5 meaningful filter options based on domain knowledge
- First filter option should match current query values (isDefault: true)
- Set canApplyFilter: false if dimension not found in any query
```

---

### Required Code Changes in Platform UI

| File | Change |
|------|--------|
| `DashboardDetail.tsx` | Use `dashboardId` as `uiBlockId` in SA_RUNTIME |
| `parseAndCreateWidget()` | Ensure new widgets get `uiBlockId: dashboardId` |
| `parseAndUpdateWidget()` | Preserve `uiBlockId` when updating widgets |
| New: Filter addition handler | Call LLM with dashboard DSL, apply response |

---

### Edge Cases

| Scenario | LLM Response |
|----------|--------------|
| Dimension not in any query | `canApplyFilter: false, reason: "Column not found"` |
| Dimension in some queries only | Apply to matching queries, list unaffected |
| Query already parameterized | Keep existing params, add new one |
| Complex JOINs | LLM identifies correct table.column |
| No widgets in dashboard | `canApplyFilter: false, reason: "No widgets"` |
