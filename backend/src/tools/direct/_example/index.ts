/**
 * EXAMPLE project config — generic, client-agnostic reference.
 *
 * This is the entry point a project folder exposes. It is intentionally NOT
 * imported into ../index.ts and NOT added to PROJECT_CONFIGS, so it never
 * reaches the LLM. It exists only as a copy-me template.
 *
 * A live project folder must export exactly two things:
 *   - `sourceId`     — the configured source instance these tools query
 *   - `createTools`  — a factory that takes that source's `execute` and returns
 *                      the SourceTool[] to expose
 *
 * To make a folder live (see ../README.md for the full walkthrough):
 *   1. Set `sourceId` to your real source instance id.
 *   2. In ../index.ts:  import * as myProject from './my-project'
 *   3. Add `myProject` to PROJECT_CONFIGS.
 */

import type { SourceTool } from '../../../sources/core/types';
import type { ExecuteFn } from '../index';
import { createTopCustomersTools } from './top-customers';

/** The source instance id these tools run against (resolved in ../index.ts). */
export const sourceId = 'REPLACE_WITH_YOUR_SOURCE_INSTANCE_ID';

/** Aggregate every tool factory in this project into one SourceTool[]. */
export function createTools(execute: ExecuteFn): SourceTool[] {
    return [
        ...createTopCustomersTools(execute),
        // ...spread additional factories here as the project grows.
    ];
}
