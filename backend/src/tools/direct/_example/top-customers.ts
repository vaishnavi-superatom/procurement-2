/**
 * EXAMPLE direct tool — generic, client-agnostic reference.
 *
 * This file shows the shape of a single direct tool. It is NOT registered
 * (see ../index.ts → PROJECT_CONFIGS) so it is never sent to the LLM. Copy this
 * pattern into a real `direct/{project}/` folder to build your own.
 *
 * A "direct tool" is a pre-built function the MainAgent calls DIRECTLY with the
 * params the LLM fills in — there is no SourceAgent and no LLM-generated SQL.
 * You own the SQL (or any other logic) inside `fn`. Use this when the query is
 * fixed business logic you don't want the LLM to (re)write each time.
 *
 * See ../README.md for how `params` becomes the tool's JSON schema and exactly
 * what the LLM receives.
 */

import type { SourceTool } from '../../../sources/core/types';
import type { ExecuteFn } from '../index';

/**
 * Factory: receives the bound source instance's `execute` (resolved by sourceId
 * in index.ts) and returns the tool definitions for this file. Splitting tools
 * across files (one factory each) keeps large projects navigable.
 */
export function createTopCustomersTools(execute: ExecuteFn): SourceTool[] {
    return [
        {
            // `id` is what the LLM calls the tool by (becomes the tool's `name`
            // in the schema sent to the model). Keep it short and kebab-case.
            id: 'get-top-customers',

            // Human label — shown in logs and streamed status ("Running ...").
            name: 'Get Top Customers',

            // REQUIRED so the MainAgent routes this directly instead of through
            // the SQL-generating SourceAgent.
            toolType: 'direct',

            // The description is the ONLY thing the LLM uses to decide WHEN to
            // call this tool. Be specific. The USE FOR / DO NOT USE FOR pattern
            // steers the model away from misusing it (e.g. for charts it can't
            // feed). This text is sent verbatim as the tool's schema description.
            description:
                'Get the top customers ranked by total revenue for an optional period. ' +
                'USE FOR: KPI cards (totalRevenue), ranked tables, and bar charts of customer revenue. ' +
                'DO NOT USE FOR: per-product breakdowns or time-series — use a SQL source query for those.',

            // Each entry becomes one property in the tool's JSON input schema.
            // The VALUE string drives the generated schema (see ../README.md):
            //   - leading word `string|number|integer|boolean|array|object` → JSON type (default string)
            //   - the word "optional" anywhere → the param is NOT required
            //   - the whole string is used as the param's description for the LLM
            params: {
                limit: 'integer - how many customers to return (e.g. 10). Defaults to 10 if omitted.',
                startDate: 'string (optional) - ISO date lower bound, e.g. "2024-01-01"',
                endDate: 'string (optional) - ISO date upper bound, e.g. "2024-12-31"',
            },

            // `fn` runs when the LLM calls the tool. `input` holds exactly the
            // params above (already validated against the schema). You own the
            // SQL — `execute` runs it against THIS tool's bound source instance.
            fn: async (input: { limit?: number; startDate?: string; endDate?: string }) => {
                const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 10;

                // Parameterized query — never string-concat user/LLM input into SQL.
                const where: string[] = [];
                const params: Record<string, any> = { limit };
                if (input.startDate) { where.push('order_date >= @startDate'); params.startDate = input.startDate; }
                if (input.endDate) { where.push('order_date <= @endDate'); params.endDate = input.endDate; }
                const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

                const result = await execute({
                    sql: `
                        SELECT TOP (@limit)
                               customer_name        AS customerName,
                               SUM(order_total)     AS totalRevenue,
                               COUNT(*)             AS orderCount
                        FROM   orders
                        ${whereSql}
                        GROUP BY customer_name
                        ORDER BY totalRevenue DESC
                    `,
                    params,
                });

                // Normalize whatever the source returns into a plain row array.
                const rows: any[] = Array.isArray(result) ? result : (result?.data ?? result?.rows ?? []);

                // Return shape the MainAgent understands (see handleDirectTool):
                //   - `data`: the row array rendered into tables/charts
                //   - top-level scalars (totalItems/count, KPIs): surfaced for KPI cards
                //   - return `{ error: '...' }` to signal a handled failure
                return {
                    data: rows,
                    count: rows.length,
                    totalRevenue: rows.reduce((sum, r) => sum + (Number(r.totalRevenue) || 0), 0),
                };
            },

            // Optional but recommended: documents the result fields so the
            // component generator picks correct chart axes / KPI fields.
            outputSchema: {
                description: 'Top customers by revenue, plus a totalRevenue KPI across the returned set.',
                fields: [
                    { name: 'totalRevenue', type: 'number', description: 'Sum of revenue across returned customers (KPI)' },
                    { name: 'customerName', type: 'string', description: 'Customer name' },
                    { name: 'orderCount', type: 'number', description: 'Number of orders in the period' },
                ],
            },
        },
    ];
}
