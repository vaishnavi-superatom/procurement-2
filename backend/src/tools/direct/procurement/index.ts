/**
 * Procurement project config: direct tools over the procurement source (the
 * Neon database the PR and RFQ screens query).
 *
 * Exports exactly the two things ../index.ts needs (see ../README.md):
 *   - `sourceId`    — the source instance these tools query
 *   - `createTools` — the tools, built on that source's `execute`
 */

import type { SourceTool } from '../../../sources/core/types';
import type { ExecuteFn } from '../index';
import { createRfqRecommendationTools } from './rfq-recommendation';

/**
 * The source instance id these tools run against (resolved in ../index.ts).
 * Same id as PROCUREMENT_SOURCE_ID in services/procurement-source.ts — written
 * out rather than imported, because importing it makes a cycle back through the
 * source manager that the tool loader is loaded from.
 */
export const sourceId = 'postgres-0fc80d2496ff';

/** Aggregate every tool factory in this project into one SourceTool[]. */
export function createTools(execute: ExecuteFn): SourceTool[] {
    return [
        ...createRfqRecommendationTools(execute),
    ];
}
