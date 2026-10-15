/**
 * The `dashboard-builder` collection — the browser's only way in.
 *
 * Deliberately namespaced apart from the existing `dashboards` / `dashboard-agent`
 * collections, which serve the JSON-DSL flow. Nothing here touches those.
 *
 * Note what is **absent**: there is no operation that accepts SQL. The browser
 * names a resolver and passes parameter values; the server validates them
 * against the resolver's own declared schema and runs it. That is the boundary,
 * and it is structural rather than a matter of the view behaving itself.
 *
 * Rides the generic `DATA_REQ` path rather than new message types. The module
 * arrives in one response instead of chunked — a compiled view is a few KB, and
 * the chunking the multi-megabyte component bundle needs would be machinery
 * with nothing to do here. If a view ever grows enough to want it,
 * `chunkModule()` in compile-view.ts is already written.
 *
 * RESPONSE SHAPE: a handler returns the payload **directly**. The SDK's
 * data-request handler does `data: result`, so whatever is returned here lands
 * as `payload.data` and reaches the browser as-is. Wrapping it in `{ data: … }`
 * — as the older collections do, because their *services* return that shape —
 * double-nests it, and the client then reads `undefined` for every field.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CollectionContext } from './types';
import type { ParamValue } from '../dashboard-builder/contract/types';
import {
	getDashboard,
	listDashboards,
	saveLayout,
	invalidate,
	dashboardDir,
} from '../dashboard-builder/registry';
import { runResolver, ResolverError } from '../dashboard-builder/resolvers';
import { deletePanels } from '../dashboard-builder/delete-panels';
/* Wrapped around this operation, never inside runResolver — see the note on
 * `runResolver` below for why that placement is not a detail. */
import {
	cacheKey,
	read as readCache,
	single,
	revalidate,
	pending,
	clearDashboard as clearDashboardCache,
} from '../dashboard-builder/cache-store';
import { defaultDirFor, isProgramLocation } from '../dashboard-builder/locations';
import { registerDashBridgeRoutes } from '../dashboard-builder/bridge';
import { releaseSession } from '../dashboard-builder/agent/session';
import {
	setRegisteredContract,
	type DashboardComponent,
} from '../dashboard-builder/contract/registered';
import {
	createDashboard,
	deleteDashboard,
	queryDashboards,
	updateDashboard,
} from '../../../database/postgres/src/project-data-db/dashboards';

export async function registerDashboardBuilderCollections({ sdk }: CollectionContext): Promise<void> {
	/**
	 * The agents' bridge endpoints, registered here so this feature's whole
	 * surface — collections for the browser, bridge routes for its agents — is
	 * set up in one place. See `dashboard-builder/bridge.ts`.
	 */
	registerDashBridgeRoutes();

	/**
	 * The browser registers the component contract over `DASH_CONTRACT_RES`, which
	 * the SDK parses and stores. This is the one operation that moves it into
	 * this feature's own store, so nothing here has to know about the SDK.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'registerContract',
		async (params: { components?: DashboardComponent[] }) => {
			const components = params?.components;
			if (!Array.isArray(components) || !components.length) {
				throw new Error('components is required and must be a non-empty array');
			}
			setRegisteredContract(components);
			return { registered: components.length };
		},
	);

	/**
	 * Does this backend support program dashboards at all?
	 *
	 * The platform UI is one build talking to many deployments, and an older SDK
	 * has none of this registered. Asking is how the UI decides whether to offer
	 * the program flow — a dashboard tagged `kind: 'program'` against a backend
	 * that cannot build one is a dashboard nobody can open.
	 *
	 * A collection that is not registered answers "Collection 'dashboard-builder'
	 * not found", so the absence of this operation is itself the answer. It reads
	 * nothing and touches no disk, which is what makes it safe to call on connect.
	 */
	sdk.addCollection('dashboard-builder', 'capabilities', async () => ({
		programs: true,
		/* Questions asked on a dashboard carry it as context, and the chat agent
		 * answers with that dashboard in view. A UI offers chat below a dashboard
		 * only when this is true. */
		dashboardChat: true,
	}));

	/** Catalogue. Cheap — no compiled code in the response. */
	sdk.addCollection('dashboard-builder', 'list', async () => {
		return { dashboards: await listDashboards() };
	});

	/**
	 * Everything the shell needs to render, except the module itself: the
	 * manifest, guard status, resolver declarations and the reader's layout.
	 */
	sdk.addCollection('dashboard-builder', 'get', async (params: { id: string }) => {
		if (!params?.id) throw new Error('id is required');
		/* Metadata for the page chrome. `module` does the full check a moment
		 * later, before any code is handed to a browser — which is where a type
		 * error actually has to stop something. */
		const state = await getDashboard(params.id, { skipTypecheck: true });
		return {
			id: state.id,
			title: state.title,
			description: state.description,
			grants: state.grants,
			valid: state.valid,
			/**
			 * Registered, nothing built yet — and the browser needs to know.
			 *
			 * Without it a brand-new dashboard renders the "does not compile"
			 * branch and finds no violations to list, which reads as a broken
			 * dashboard rather than an empty one. `valid` alone cannot say both.
			 */
			empty: state.empty ?? false,
			violations: state.violations,
			viewVersion: state.viewVersion,
			layoutVersion: state.layoutVersion,
			resolvers: state.resolvers,
			layout: state.layout,
		};
	});

	/**
	 * The compiled view program.
	 *
	 * `version` lets a client skip the transfer when it already holds that build
	 * — the hash was never about HTTP caching, which is why moving delivery onto
	 * the websocket changed nothing about it.
	 */
	sdk.addCollection('dashboard-builder', 'module', async (params: { id: string; version?: string }) => {
		if (!params?.id) throw new Error('id is required');
		const state = await getDashboard(params.id);

		if (!state.valid || !state.view) {
			return {
				id: state.id,
				valid: false,
				/* Nothing built yet is not the same as broken — the canvas renders a
				 * different thing for each, and cannot tell them apart from `valid`. */
				empty: state.empty ?? false,
				violations: state.violations,
				/* No code, on purpose: a dashboard that fails its guard is reported
				 * and never mounted, so a bad generation degrades to an error card
				 * rather than running. */
				code: null,
			};
		}

		if (params.version && params.version === state.view.version) {
			return { id: state.id, valid: true, version: state.view.version, unchanged: true };
		}

		return {
			id: state.id,
			valid: true,
			version: state.view.version,
			bytes: state.view.bytes,
			code: state.view.code,
		};
	});

	/**
	 * Runs one resolver. The only data operation there is.
	 *
	 * The same function the agent calls to verify its SQL and the platform calls
	 * for a headless render — which is what makes verification honest, rather
	 * than a parallel test path that can drift from what a viewer gets.
	 *
	 * ### The cache lives here, and only here
	 *
	 * Wrapped around this operation rather than inside `runResolver`, and that
	 * placement is load-bearing. `runResolver` has two callers: this one, and
	 * `bridge.ts`'s `/dash/run-resolver`, which is the agent verifying its own
	 * SQL. *A dashboard is never the first place a query runs* means the agent
	 * must read rows from an execution that actually happened — hand it a
	 * remembered answer and it builds a panel on numbers it never saw, and
	 * `recordVerified` stamps columns as evidence of a run that did not occur.
	 *
	 * The content hash does not protect that case: the agent re-runs an
	 * **unedited** resolver to check whether yesterday's zero rows are still
	 * zero, and the key matches exactly.
	 *
	 * So the cache belongs to the reader's path. Moving it into the shared
	 * function would look like a tidy-up and would quietly delete the guarantee
	 * the whole system rests on.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'runResolver',
		async (params: {
			id: string;
			resolver: string;
			params?: Record<string, unknown>;
			/** Set by a reader's refresh. Skips the lookup; still writes the result. */
			fresh?: boolean;
			/**
			 * Wait for the recompute that a previous stale answer started.
			 *
			 * Sent by a panel that was handed `meta.revalidating`. It starts
			 * nothing of its own: it either waits on the run already in flight or,
			 * if that has already landed, reads the entry it replaced.
			 */
			awaitRefresh?: boolean;
		}) => {
			if (!params?.id) throw new Error('id is required');
			if (!params?.resolver) throw new Error('resolver is required');

			/* The hottest path there is — every panel, every filter change. It needs
			 * the directory, the grants and the resolver versions; whether the view
			 * typechecks has no bearing on running a query. */
			const state = await getDashboard(params.id, { skipTypecheck: true });

			const key = cacheKey({
				resolver: params.resolver,
				version: state.resolvers.find((r) => r.name === params.resolver)?.version,
				params: (params.params ?? {}) as Record<string, ParamValue>,
				grants: state.manifest.grants.sources,
			});

			const recompute = (fresh: boolean) =>
				runResolver({
					dashboardId: state.id,
					dir: state.dir,
					name: params.resolver,
					params: params.params ?? {},
					grants: state.manifest.grants.sources,
					toolGrants: state.manifest.grants.tools,
					timeoutMs: state.manifest.defaults?.timeoutMs,
					fresh,
					onLog: (line) => console.log(`[dash:${state.id}/${params.resolver}] ${line}`),
				});

			/**
			 * The second half of a stale read: wait for the answer, do not cause one.
			 *
			 * Falls through to the ordinary path when there is nothing in flight,
			 * which is the common case — the recompute finished while the panel was
			 * asking, and the entry it wrote is now fresh.
			 */
			if (params.awaitRefresh) {
				const running = pending(state.id, key);
				if (running) return await running;
			}

			/**
			 * `fresh` skips the read and keeps the write, which makes a refresh a
			 * **global recompute**: the reader who suspected a stale number fixes it
			 * for everyone else looking, rather than getting a private answer while
			 * the rest of the room keeps seeing the old one.
			 */
			if (!params.fresh) {
				const remembered = readCache(state.id, key);
				if (remembered) {
					/**
					 * Stale answers are served, not withheld.
					 *
					 * Within `FRESH_MS` the source is not touched. Past that the
					 * reader still gets these rows immediately and a recompute runs
					 * behind them, because a panel that is instantly right-as-of-
					 * hours-ago beats a panel that spins for nine seconds to say
					 * almost the same thing.
					 *
					 * `revalidating` is what tells the panel to come back for the
					 * result: the recompute replaces the stored entry, so a second
					 * request a moment later returns the new numbers with no work.
					 */
					if (!remembered.stale) return remembered.result;

					revalidate(state.id, key, () => recompute(true));
					return {
						...remembered.result,
						meta: { ...remembered.result.meta, revalidating: true },
					};
				}
			}

			try {
				/* Joins a run already in flight for this key instead of starting a
				 * second one, and writes the answer when it lands. Ten readers
				 * arriving just after an entry expires cost one query, not ten. */
				return await single(state.id, key, () => recompute(Boolean(params.fresh)));
			} catch (err) {
				/* Typed, so a panel can tell "no such resolver" from "your
				 * parameters were wrong" from "the query failed" — three different
				 * problems needing three different responses. */
				const error = err instanceof ResolverError ? err : null;
				throw Object.assign(
					new Error(error?.message ?? (err as Error)?.message ?? String(err)),
					{ code: error?.code ?? 'RESOLVER_FAILED' },
				);
			}
		},
	);

	/**
	 * The reader's arrangement, and the one thing that does rewrite the program.
	 *
	 * Sizes and order write `layout.json` and nothing else — rearranging panels
	 * must not require rewriting generated code. Hidden panels are the exception,
	 * and a deliberate one: hiding is how the editor stages a deletion, so saving
	 * is what carries it out. The panel leaves the view, any resolver nothing
	 * reads any more leaves with it, and the arrangement is written without them.
	 *
	 * Deleted before the arrangement is written, so a failed edit leaves both
	 * files describing the same dashboard. `invalidate` then re-hashes the view,
	 * which is what makes a reader's next load show the shorter program.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'saveLayout',
		async (params: { id: string; layout: unknown }) => {
			if (!params?.id) throw new Error('id is required');

			const body = params.layout as { panels?: Array<{ i?: unknown; hidden?: unknown }> } | undefined;
			const entries = Array.isArray(body?.panels) ? body.panels : [];
			const staged = entries
				.filter((entry) => entry?.hidden && typeof entry.i === 'string' && entry.i)
				.map((entry) => entry.i as string);

			const deleted = deletePanels(params.id, staged);
			console.log(
				`[dashboard-builder] ${params.id}: saveLayout — ${entries.length} entries, ` +
					`staged ${staged.length ? staged.join(', ') : 'nothing'}, ` +
					`removed ${deleted.panels.length ? deleted.panels.join(', ') : 'nothing'}` +
					`${deleted.resolvers.length ? `, resolvers ${deleted.resolvers.join(', ')}` : ''}` +
					`${deleted.missing.length ? `, not in the view: ${deleted.missing.join(', ')}` : ''}`,
			);
			const layout = saveLayout(params.id, {
				...(body ?? {}),
				panels: entries.filter((entry) => !entry?.hidden),
			});
			invalidate(params.id);
			return { ...layout, deleted };
		},
	);

	/**
	 * Registers a new, empty dashboard program.
	 *
	 * The row is the identity; the folder is created by the first build. That
	 * ordering matters — it means you can name a dashboard and start a
	 * conversation about it before any code exists, and the agent's first
	 * `./inventory` correctly reports "exists, no panels yet" rather than
	 * "no such dashboard".
	 *
	 * `dashboardId` comes from the caller, because the platform already mints one
	 * through SA-API for every dashboard and a second source of ids would be a
	 * second thing to reconcile.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'create',
		async (params: {
			dashboardId: string;
			projectId: string;
			name: string;
			description?: string;
			createdBy?: string;
		}) => {
			if (!params?.dashboardId) throw new Error('dashboardId is required');
			if (!params?.projectId) throw new Error('projectId is required');
			if (!params?.name?.trim()) throw new Error('name is required');

			const existing = (await queryDashboards({ filters: { dashboardId: params.dashboardId } })).data;
			if (existing?.length) {
				throw new Error(`A dashboard with id "${params.dashboardId}" already exists.`);
			}

			await createDashboard({
				dashboardId: params.dashboardId,
				projectId: params.projectId,
				name: params.name.trim(),
				description: params.description?.trim(),
				createdBy: params.createdBy,
				/**
				 * A pointer, not a document.
				 *
				 * The JSON-DSL flow stores its whole dashboard in this column; ours
				 * stores where the files are. `kind` is what tells the two apart, and
				 * is what the DSL list filters on so program dashboards do not show up
				 * there pretending to be DSL ones.
				 */
				dashboard: { kind: 'program', dir: defaultDirFor(params.dashboardId) } as never,
			});

			invalidate();
			return { dashboardId: params.dashboardId, dir: defaultDirFor(params.dashboardId) };
		},
	);

	/**
	 * Renames a dashboard, or changes its description.
	 *
	 * The row only. The folder is named after the id and never moves, and the
	 * manifest's title is regenerated from the row on the next publish — so a
	 * rename here is immediately what every list and header shows, and the
	 * program catches up without being rebuilt.
	 *
	 * Deliberately narrow: `name` and `description`, nothing else. `dashboard`
	 * holds the pointer to the files and `published` is decided by publishing, so
	 * neither is something a rename dialog should be able to reach.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'rename',
		async (params: { id: string; name: string; description?: string }) => {
			if (!params?.id) throw new Error('id is required');
			if (!params?.name?.trim()) throw new Error('name is required');

			const [row] = (await queryDashboards({ filters: { dashboardId: params.id } })).data ?? [];
			if (!row) throw new Error(`No dashboard "${params.id}".`);

			await updateDashboard({
				id: (row as { id: number }).id,
				name: params.name.trim(),
				description: params.description?.trim(),
			});

			/* The title a card and a header show comes from the row through
			 * `locations`, which is cached — so it has to be dropped here or the
			 * rename does not appear until something else invalidates it. */
			invalidate();
			return { id: params.id, name: params.name.trim() };
		},
	);

	/**
	 * The conversation a person is having below a dashboard.
	 *
	 * Kept in the row's `dashboard` column beside the pointer to the files, as
	 * `chatThreads: { <userId>: <threadId> }` — one thread per person, since a
	 * dashboard is shared and a thread is not. Only that key is ever written here;
	 * `kind` and `dir` are read back and written unchanged.
	 */
	sdk.addCollection(
		'dashboard-builder',
		'chatThread',
		async (params: { id: string; userId: string }) => {
			if (!params?.id) throw new Error('id is required');
			if (!params?.userId) throw new Error('userId is required');

			const [row] = (await queryDashboards({ filters: { dashboardId: params.id } })).data ?? [];
			const threads = (row as { dashboard?: { chatThreads?: Record<string, string> } } | undefined)?.dashboard
				?.chatThreads;
			return { threadId: threads?.[params.userId] ?? null };
		},
	);

	/** Records — or, with `threadId: null`, forgets — a person's thread on a dashboard. */
	sdk.addCollection(
		'dashboard-builder',
		'setChatThread',
		async (params: { id: string; userId: string; threadId: string | null }) => {
			if (!params?.id) throw new Error('id is required');
			if (!params?.userId) throw new Error('userId is required');

			const [row] = (await queryDashboards({ filters: { dashboardId: params.id } })).data ?? [];
			if (!row) throw new Error(`No dashboard "${params.id}".`);

			const current = ((row as { dashboard?: unknown }).dashboard ?? {}) as Record<string, unknown>;
			/* A DSL dashboard's column is its document; a thread map does not belong in it. */
			if (!isProgramLocation(current)) throw new Error(`"${params.id}" is not a program dashboard.`);

			const chatThreads = { ...((current.chatThreads as Record<string, string> | undefined) ?? {}) };
			if (params.threadId) chatThreads[params.userId] = params.threadId;
			else delete chatThreads[params.userId];

			await updateDashboard({
				id: (row as { id: number }).id,
				dashboard: { ...current, chatThreads } as never,
			});
			return { id: params.id, threadId: params.threadId ?? null };
		},
	);

	/**
	 * Deletes a dashboard program: its row, its files, and its conversation.
	 *
	 * All three, because leaving any one behind is worse than leaving all of
	 * them. An orphan folder reappears in the list (`listDashboardIds` unions
	 * disk and rows, deliberately); an orphan row points at nothing; and an
	 * orphan conversation would be resumed by the next dashboard to reuse the
	 * id, arriving with opinions about a dashboard that no longer exists.
	 *
	 * The SA-API app is **not** deleted here — the caller owns that, the same way
	 * it owns creating it, and the platform's own delete path already does it.
	 */
	sdk.addCollection('dashboard-builder', 'delete', async (params: { id: string }) => {
		if (!params?.id) throw new Error('id is required');

		const removed: string[] = [];

		/**
		 * Memory first, then disk.
		 *
		 * A live session holds an open pi conversation and a workspace record
		 * granting sources, both keyed to a directory this is about to remove.
		 * Deleting the files underneath a running turn leaves it writing into
		 * nothing; leaving the records behind means `/dash/publish` still accepts
		 * that directory as a live session and then fails for the wrong reason.
		 *
		 * The idle sweeper would eventually collect the session — thirty minutes
		 * later — and nothing at all would collect the workspace record. So it is
		 * released here, where the intent is known, rather than left to a timeout
		 * that does not know a dashboard was deleted.
		 */
		releaseSession(params.id);

		/**
		 * And its remembered answers.
		 *
		 * Not a memory concern — the entries would expire within the hour. It is
		 * that dashboard ids come from SA-API, and nothing here guarantees one can
		 * never be reissued. An answer surviving its dashboard is rows from a
		 * deleted dashboard appearing in a new one, which is the sort of thing
		 * nobody would think to look for.
		 */
		clearDashboardCache(params.id);

		const dir = dashboardDir(params.id);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
			removed.push('files');
		}

		const conversation = path.join(process.cwd(), '.dash-builder-runtime', params.id);
		if (fs.existsSync(conversation)) {
			fs.rmSync(conversation, { recursive: true, force: true });
			removed.push('conversation');
		}

		try {
			const rows = (await queryDashboards({ filters: { dashboardId: params.id } })).data ?? [];
			for (const row of rows as { id: number }[]) {
				await deleteDashboard({ id: row.id });
				removed.push('row');
			}
		} catch (err: any) {
			/* The files are already gone, so reporting a total failure would be
			 * wrong — say what was removed and what was not. */
			console.warn(`[dash-builder] could not delete row for ${params.id}: ${err?.message ?? err}`);
		}

		invalidate();
		return { deleted: true, id: params.id, removed };
	});

	/** Forces a rescan. Useful while an agent is writing files. */
	sdk.addCollection('dashboard-builder', 'invalidate', async (params: { id?: string }) => {
		invalidate(params?.id);
		return { ok: true, dir: params?.id ? dashboardDir(params.id) : undefined };
	});

	console.log('✓ dashboard-builder collection registered');
}
