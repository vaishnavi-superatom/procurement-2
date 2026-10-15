/**
 * Program datasets — the parts of a semantic model that are not a query.
 *
 * Some numbers cannot be a SQL field: a figure that needs a day-level walk
 * across history, or charges deduplicated before they are summed. A model can
 * declare such a dataset as a program and delegate to it, so the definition
 * lives in one place whether it is reached from a dashboard or from a semantic
 * query. Programs take their statement runner from async context (see
 * `../semantic-run.ts`), so one can only reach the source the calling resolver
 * was granted.
 */
/* No programs are registered by default. A deployment adds its own by importing a
 * module that calls `registerProgram` from here. */

export { registeredPrograms } from './registry';
export type { Program, ProgramContext, ProgramParam } from './registry';
