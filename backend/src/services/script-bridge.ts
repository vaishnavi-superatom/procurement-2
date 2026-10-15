import http from 'http';
import { getAllTools } from '../tools';
import { getSourceProxy, SourceUnavailableError } from './source-proxy';
import { url } from 'inspector/promises';
import { on } from 'process';
import https from 'https';
import { createHash } from 'crypto';
import { resolveContextToken, withCapturedContext, type RequestContext } from '@superatomai/sdk-node';
import { resolveEntities } from '../../../database/postgres/src/project-data-db/entity-search';
import { getConceptCatalog } from '../../../database/postgres/src/project-data-db/concepts';
import { getAllKbNodes, getKbNode, searchKbNodes } from '../../../database/postgres/src/project-data-db/kb-nodes';
import { handleAgentToolRequest } from './agent-tools';

// /query and /run-tool remain — the sandboxed "scripts flow" child process
// (sdk-nodejs/src/userResponse/scripts/script-bootstrap.ts) genuinely needs
// them, since it runs in a separate OS process and can't reach
// sdk.getTools()/sdk.callCollection() in-process the way the dashboard agent
// now does. /components, /kb-search, and /get-dashboard were Pi-specific —
// removed now that dashboard-agent uses native tools (see
// sdk-nodejs/src/dashboardAgent/tools.ts) instead of shelling out to curl.

let server: http.Server | null = null;

// ============================================
// Query cache — avoids re-running an identical query against the live source
// ============================================
//
// Lives HERE, not in script-bootstrap.ts (the child process `ctx.query` runs
// in): every execute_script ATTEMPT spawns a brand-new subprocess (see
// script-runner.ts), so an in-process cache there would be empty every single
// time — it would never hit. This bridge server, by contrast, is the one
// persistent process every script/every attempt/every user funnels through
// for the whole backend's lifetime, so it's the only place a cache can
// actually help.
//
// Keyed on the exact (toolId, sql, limit) — scripts interpolate every value
// directly into the SQL string (no placeholders, see body-contract.md), so
// identical text IS an identical request. Any real change (a different date
// range, a fixed JOIN, an added column) produces a different string, hence a
// different key, hence a guaranteed miss — no explicit invalidation needed.
// The one accepted trade-off, same as the existing sdk-nodejs QueryCache used
// elsewhere in this app: up to QUERY_CACHE_TTL_MS of staleness on a genuinely
// repeated identical query.
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches sdk-nodejs's QueryCache default
const QUERY_CACHE_MAX_SIZE = 500;

interface QueryCacheEntry {
    body: any;
    cachedAt: number;
}

const queryCache = new Map<string, QueryCacheEntry>();

/**
 * Cache key, including the caller's POLICY SCOPE.
 *
 * Without the scope this cache is an authorization bypass: the key is computed
 * on the SQL the script wrote, but policy predicates are injected LATER, inside
 * execute(). So two users running the same script produce the same key while
 * the cached ROWS are whatever the first caller's policy allowed — user B gets
 * served user A's filtered data for the rest of the TTL, and the rewriter never
 * gets consulted at all.
 *
 * Keyed on the scope rather than on the user id on purpose: two users with
 * identical policies SHOULD share an entry, and keying on identity throws that
 * away for nothing. With no policies (everyone, today) the scope is a constant,
 * so cache behaviour is unchanged.
 */
export function scopeKey(ctx: RequestContext | undefined): string {
    if (!ctx) return 'anon';
    if (ctx.principal.kind === 'system') return `sys:${ctx.principal.reason}`;
    const policies = ctx.policies ?? [];
    if (policies.length === 0) return 'unpoliced';
    return createHash('sha256').update(JSON.stringify(policies)).digest('base64url').slice(0, 16);
}

export function queryCacheKey(toolId: string, sql: string, limit: number | undefined, scope: string): string {
    return `${scope}::${toolId}::${limit ?? ''}::${sql}`;
}

function getCachedQuery(key: string): any | undefined {
    const entry = queryCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > QUERY_CACHE_TTL_MS) {
        queryCache.delete(key);
        return undefined;
    }
    // Bubble to the back (most-recently-used) via delete+re-set, so eviction
    // below drops the oldest UNUSED entry, not just the oldest inserted one.
    queryCache.delete(key);
    queryCache.set(key, entry);
    return entry.body;
}

function setCachedQuery(key: string, body: any): void {
    if (queryCache.size >= QUERY_CACHE_MAX_SIZE && !queryCache.has(key)) {
        const oldestKey = queryCache.keys().next().value;
        if (oldestKey !== undefined) queryCache.delete(oldestKey);
    }
    queryCache.set(key, { body, cachedAt: Date.now() });
}

// ============================================
// Query handles — an agent points at a result instead of retyping its rows
// ============================================
//
// Keyed by the run's context token, so one run can only reach its own results.
// Opt-in per request (`ref: true`): scripts-flow callers carry tokens too and
// never release, so registering for them would only leak.
export interface QueryRef {
    ref: string;
    toolId: string;
    sql: string;
    data: any[];
    /** The real total, not the truncated length. */
    count: number;
    truncated: boolean;
    metadata?: any;
}

const QUERY_REF_TTL_MS = 30 * 60 * 1000; // outlives the longest run; a sweep, not a contract
const queryRefs = new Map<string, { createdAt: number; refs: Map<string, QueryRef> }>();

export function registerQueryRef(token: string | undefined, toolId: string, sql: string, body: any): string | undefined {
    if (!token) return undefined;
    const now = Date.now();
    for (const [k, v] of queryRefs) if (now - v.createdAt > QUERY_REF_TTL_MS) queryRefs.delete(k);

    let run = queryRefs.get(token);
    if (!run) { run = { createdAt: now, refs: new Map() }; queryRefs.set(token, run); }
    const data = Array.isArray(body?.data) ? body.data : [];
    const meta = body?.metadata;
    const entry = { toolId, sql, data, count: meta?.totalCount ?? body?.count ?? data.length, truncated: !!meta?.truncated, metadata: meta };
    // Same SQL twice in one run is one result; keep the latest rows under the first handle.
    for (const r of run.refs.values()) {
        if (r.toolId === toolId && r.sql === sql) { Object.assign(r, entry); return r.ref; }
    }
    const ref = `q${run.refs.size + 1}`;
    run.refs.set(ref, { ref, ...entry });
    return ref;
}

export function getQueryRef(token: string | undefined, ref: string): QueryRef | undefined {
    return token ? queryRefs.get(token)?.refs.get(ref) : undefined;
}

export function releaseQueryRefs(token: string | undefined): void {
    if (token) queryRefs.delete(token);
}

function resolveBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, status: number, body: any) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
}

function findTool(toolId: string) {
    const tools = getAllTools();
    return tools.find(t => t.id === toolId || t.name === toolId) ?? null;
}

/* ------------------------------ route registry ------------------------------ */

/**
 * Endpoints a feature registers for itself.
 *
 * The endpoints below this are the generic ones — raw SQL, tool calls, the
 * catalogues — and they belong to the bridge because every agent uses them.
 * Anything feature-specific should live beside the code it serves and register
 * itself here, the way collections and coding agents already do. Registering
 * the handler and its log summary together keeps a new endpoint from printing
 * `(unknown endpoint)`.
 */
export interface BridgeRoute {
    /** Runs the endpoint. Return the body to send; throw to produce a 500. */
    handle(body: any): Promise<unknown>;
    /**
     * One line for the request log. Deliberately not the whole body — a spec's
     * grounding runs to paragraphs and SQL to hundreds of characters, and this
     * log is how you confirm an agent really made a call rather than said it
     * did.
     */
    summarize?(body: any): string;
}

const routes = new Map<string, BridgeRoute>();

export function registerBridgeRoute(path: string, route: BridgeRoute): void {
    if (routes.has(path)) {
        console.warn(`[ScriptBridge] route ${path} registered twice — the later one wins`);
    }
    routes.set(path, route);
}

// Short, human-readable summary per endpoint for the request log above —
// deliberately excludes large fields (full SQL text, whole dashboard JSON)
// so this stays a one-line-per-call log, not a body dump.
function summarizeBridgeRequestBody(url: string | undefined, body: any): string {
    switch (url) {
        case '/query':
            return `toolId=${body?.toolId}, sql=${String(body?.sql ?? '').slice(0, 80)}...`;
        case '/resolve-entities':
            return `mentions=${JSON.stringify((body?.mentions ?? []).slice(0, 5))}` +
                (body?.entityType ? `, entityType=${body.entityType}` : ', unscoped');
        case '/run-tool':
            return `toolId=${body?.toolId}`;
        case '/schema-search':
            return `toolId=${body?.toolId}, keywords=${(body?.keywords ?? []).join(', ')}`;
        case '/concept-catalog':
            return '(no params)';
        case '/knowledge-base':
            return `method=${body?.method ?? 'catalog'}, ids=${(body?.ids ?? []).join(', ')}`;
        default:
            return '(unknown endpoint)';
    }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // Agent tools are GET + query string: a shell script can build that with
    // curl's own encoding, where a JSON body would need quoting inside bash.
    if (await handleAgentToolRequest(req, res)) return;


    if (req.method === 'GET' && req.url?.startsWith('/download')) {
        const fileParam = new URL(req.url, `http://localhost`).searchParams.get('file') || '';
        const cleanPath = fileParam.replace(/\\/g, '/').replace(/^\/+/, '');
        const tmsUrl = 'https://tms.totalgroup.in/RlogicSGTPL/' + cleanPath;
        const filename = cleanPath.split(`/`).pop() || 'download';

        https.get(tmsUrl, (upstream) => {
            res.writeHead(200, {
                'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${filename}"`,
            });
            upstream.pipe(res);
        }).on('error', (err: any) => {
            res.writeHead(502);
            res.end(err.message);
        });
        return;
    }

    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method not allowed' });
    }

    let body: any;
    try {
        body = await resolveBody(req);
    } catch {
        return send(res, 400, { error: 'Invalid request body' });
    }

    // Logs every hit on every endpoint, independent of whatever the agent
    // itself narrates in its own streamed text — that's the only way to
    // actually confirm a call happened (e.g. did it really search the KB)
    // rather than trusting the agent's own self-report.
    const registered = req.url ? routes.get(req.url) : undefined;
    console.log(
        `[ScriptBridge] ${req.url}`,
        registered
            ? (registered.summarize?.(body) ?? '')
            : summarizeBridgeRequestBody(req.url, body),
    );

    // Registered routes first — a feature owning its own endpoint takes
    // precedence over anything hard-coded below.
    if (registered) {
        try {
            // Same as /run-tool: the caller is another OS process, so its identity
            // arrives as a token. Without it a route that queries (the dashboard
            // builder's run-resolver/publish) is refused under enforce.
            const routeCtx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
            return send(res, 200, await withCapturedContext(routeCtx, () => registered.handle(body)));
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /query — execute SQL against a source tool
    if (req.url === '/query') {
        const { toolId, sql, params, limit, ref: wantRef } = body;
        if (!toolId || !sql) return send(res, 400, { error: 'toolId and sql are required' });

        // The script runs in another process, so the async context did not
        // survive the trip. The parent minted a token for it; resolve that back
        // into the context this query should run under. No token means the run
        // had no identity to grant — anonymous, which the data seam handles.
        const token = req.headers['x-sa-context'] as string | undefined;
        const ctx = resolveContextToken(token);
        // The handle rides on the reply only; the cached body stays run-agnostic.
        const reply = (b: any) => {
            const ref = wantRef ? registerQueryRef(token, toolId, sql, b) : undefined;
            return send(res, 200, ref ? { ...b, ref } : b);
        };

        const cacheKey = queryCacheKey(toolId, sql, limit, scopeKey(ctx));
        const cached = getCachedQuery(cacheKey);
        if (cached !== undefined) {
            console.log(`[ScriptBridge] Query cache HIT — toolId=${toolId}`);
            return reply(cached);
        }

        const tool = findTool(toolId);
        if (tool) {
            try {
                const result = await withCapturedContext(ctx, () => tool.fn({ sql, params, limit }));
                // Forward truncation metadata so ctx.query can fail loudly instead of
                // silently handing the script a truncated (wrong) result set.
                const responseBody = { success: true, data: result?.data ?? result, count: result?.count ?? result?.data?.length ?? 0, metadata: result?.metadata };
                setCachedQuery(cacheKey, responseBody);
                return reply(responseBody);
            } catch (err: any) {
                // Never cache a failure — the next attempt (e.g. the LLM's own
                // retry after fixing the SQL) must always go live.
                return send(res, 500, { success: false, error: err?.message ?? String(err) });
            }
        }

        // Not connected locally — route by Data Source ID through the DO, which
        // forwards to whichever proxy owns it. We never specify the proxy.
        const dataSourceId = toolId.endsWith('_query') ? toolId.slice(0, -'_query'.length) : toolId;
        const proxy = getSourceProxy();
        if (!proxy) return send(res, 404, { success: false, error: `Data source '${dataSourceId}' not found locally and no proxy connection is configured` });
        try {
            const remote = await proxy.remoteQuery(dataSourceId, sql, params);
            const responseBody = { success: true, data: remote.data, count: remote.count, remote: true };
            setCachedQuery(cacheKey, responseBody);
            return reply(responseBody);
        } catch (err: any) {
            const status = err instanceof SourceUnavailableError ? 404 : 502;
            return send(res, status, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /run-tool — call a direct tool with structured params
    if (req.url === '/run-tool') {
        const { toolId, params } = body;
        if (!toolId) return send(res, 400, { error: 'toolId is required' });

        // Direct tools are an agent-level concept and are not routed across
        // machines — the cross-machine layer handles data-source queries only.
        const tool = findTool(toolId);
        if (!tool) return send(res, 404, { error: `Tool '${toolId}' not found` });

        try {
            const toolCtx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
            const result = await withCapturedContext(toolCtx, () => tool.fn(params ?? {}));
            return send(res, 200, { success: true, result });
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /resolve-entities — name/code → database id.
    //
    // Exists because the CALLER has to choose the mentions. Handing the raw
    // question to the resolver was measured and is unusable: "last month" fuzzy-
    // matches MONTESHWAR and TARPAULIN - PLASTIC, and an unscoped pass over ~1M
    // indexed values is slow enough to blow a turn. So this is a call, not a
    // preprocessing step — same reason MainAgent has resolve_entities as a tool.
    //
    // Deliberately the same resolveMany() the 'entity-search' collection uses;
    // this endpoint is transport for a caller in another OS process, not a
    // second resolver. Scoping with entityType is much faster than leaving it
    // off, which falls back to every type.
    if (req.url === '/resolve-entities') {
        const { mentions, entityType, limit } = body;
        if (!Array.isArray(mentions) || mentions.length === 0) {
            return send(res, 400, { error: 'mentions must be a non-empty array of strings' });
        }
        // Bounded so one call cannot serialise 50 unscoped scans.
        const capped = mentions.slice(0, 10).map((m: any) => String(m)).filter(m => m.trim() !== '');
        try {
            const ctx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
            // resolveEntities, NOT resolveMany: it additionally runs
            // recognizePatterns() over whatever stayed unresolved, so a vehicle
            // number or PAN — deliberately not indexed, because indexing them
            // mirrors the client database and goes stale — comes back as
            // "not indexed, but it lives HERE" with the SQL to find it. That is
            // the same call MainAgent makes, so both flows behave alike.
            // PERMISSIVE policy, deliberately unlike MainAgent's. The caller is a
            // coding agent: it reads every candidate WITH its entityType and
            // score, and can run its own SQL to settle a tie. So bound the
            // result by COUNT, not by score — a low score is information, not a
            // reason to hide a row. Measured: minScore 0.3 returned only a wrong
            // service network for "Bbubaneshwar" and hid the correct region at
            // 0.237; at 0.05 the region comes back, for 13ms more.
            const result = await withCapturedContext(ctx, () => resolveEntities({
                mentions: capped.map(text => ({ text, ...(entityType ? { entityType } : {}) })),
                limit: Math.min(Number(limit) || 25, 25),
                minScore: 0.05,
                perTypeCap: 5,
            }));
            return send(res, 200, {
                success: true,
                ...result,
                ...(mentions.length > capped.length
                    ? { note: `only the first ${capped.length} mention(s) were resolved` } : {}),
            });
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /schema-search — keyword search over a large source's schema, the
    // same schemaSearchFn every SourceTool carries (see base-source.ts's
    // getTool()) that the SourceAgent uses via its search_schema tool. Local
    // only, not routed across machines like /query.
    if (req.url === '/schema-search') {
        const { toolId, keywords } = body;
        if (!toolId || !Array.isArray(keywords) || !keywords.length) {
            return send(res, 400, { error: 'toolId and a non-empty keywords array are required' });
        }

        const tool = findTool(toolId) as any;
        if (!tool) return send(res, 404, { error: `Tool '${toolId}' not found` });
        if (!tool.schemaSearchFn) {
            return send(res, 400, { error: `'${toolId}' has no schema search — its schema is small enough to already be given in full.` });
        }

        try {
            const result = tool.schemaSearchFn(keywords);
            return send(res, 200, { success: true, result });
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /concept-catalog — every verified concept: name, aliases, and what
    // it is for. No bodies; those come from the `concept` tool's get. Its own
    // endpoint rather than a method on the shared `concept` direct tool, so it
    // stays reachable only by an agent whose workspace has this shim.
    if (req.url === '/concept-catalog') {
        try {
            const result = await getConceptCatalog();
            return send(res, 200, { success: true, result: result.data });
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    // POST /knowledge-base — free-form domain knowledge (gotchas, join paths,
    // table/column meanings), lower priority than the concepts. Its own
    // endpoint rather than a direct tool, because that registry is shared with
    // flows that already get knowledge-base context injected upfront.
    if (req.url === '/knowledge-base') {
        const { method, ids } = body;
        try {
            /* A catalogue, not a search: the corpus is small, a keyword search
             * returns an empty result that reads as "nothing is documented",
             * and the list also surfaces what the agent would never think to
             * ask about. Hand over every title and let the agent choose. */
            if (method === 'catalog' || method === undefined) {
                const result = await getAllKbNodes(500);
                const nodes = result.data.map((n: any) => ({ id: n.id, title: n.title, category: n.category, tags: n.tags, type: n.type }));
                return send(res, 200, { success: true, result: { data: nodes, count: nodes.length } });
            }
            if (method === 'get') {
                if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'ids is required and must be non-empty for method="get"' });

                const nodes: any[] = [];
                const notFound: number[] = [];
                const shape = (n: any) => ({ id: n.id, title: n.title, content: n.content, category: n.category, tags: n.tags, type: n.type });
                for (const id of ids) {
                    try {
                        nodes.push(shape((await getKbNode({ id })).data as any));
                    } catch {
                        notFound.push(id);
                    }
                }

                /* `global` nodes apply whatever the question was, which is
                 * precisely what the agent cannot know to ask for, so they ride
                 * along — named in `autoIncluded` so it can tell what it asked
                 * for from what it was handed. */
                const asked = new Set(nodes.map((n) => n.id));
                const globals = ((await searchKbNodes({ type: 'global', limit: 100 })).data ?? [])
                    .filter((n: any) => !asked.has(n.id))
                    .map(shape);
                nodes.push(...globals);

                return send(res, 200, {
                    success: true,
                    result: {
                        data: nodes,
                        count: nodes.length,
                        ...(globals.length ? { autoIncluded: globals.map((n: any) => n.id) } : {}),
                        ...(notFound.length ? { notFound } : {}),
                    },
                });
            }
            return send(res, 400, { error: `Unknown method '${method}' — must be "catalog" (or omitted) or "get".` });
        } catch (err: any) {
            return send(res, 500, { success: false, error: err?.message ?? String(err) });
        }
    }

    return send(res, 404, { error: 'Unknown endpoint' });
}

/**
 * Start the loopback bridge the script subprocess talks to.
 *
 * Binds an EPHEMERAL port by default (0). This is a private parent→child
 * channel: the only consumer is script-bootstrap.ts, which reads the resolved
 * URL from the inherited `SCRIPT_BRIDGE_URL` env var. Nothing external — no
 * frontend, no setup script, no config — references the port number, so a
 * well-known one buys nothing and costs a lot: every client project on this
 * machine defaults to the same value, so two backends running side by side
 * collided on it.
 *
 * That collision used to be swallowed (warn + resolve), which booted the loser
 * with `SCRIPT_BRIDGE_URL` UNSET — every `ctx.query` in every script then threw
 * "script bridge server is not running" while the process happily stayed
 * connected and kept serving requests. An ephemeral port removes the failure
 * mode entirely rather than making it louder.
 *
 * Set `SCRIPT_BRIDGE_PORT` to pin a fixed port (e.g. for debugging); a bind
 * failure is then fatal, since there is no correct way to continue without it.
 */
export function startScriptBridge(): Promise<void> {
    // 0 → let the OS assign a free port. Explicit override still honoured.
    const requestedPort = parseInt(process.env.SCRIPT_BRIDGE_PORT ?? '0', 10);

    return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);

        server.on('error', (err: any) => {
            // No silent-skip path: starting without a bridge leaves the script
            // flow broken in a way that only surfaces later, per-query.
            if (err.code === 'EADDRINUSE') {
                reject(new Error(
                    `Script bridge could not bind port ${requestedPort} (in use). ` +
                    `Unset SCRIPT_BRIDGE_PORT to use an ephemeral port, or free that port.`,
                ));
            } else {
                reject(err);
            }
        });

        server.listen(requestedPort, '127.0.0.1', () => {
            const addr = server!.address();
            const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
            process.env.SCRIPT_BRIDGE_URL = `http://127.0.0.1:${actualPort}`;
            console.log(`✓ Script bridge server running on http://127.0.0.1:${actualPort}\n`);
            resolve();
        });
    });
}

export function stopScriptBridge(): Promise<void> {
    return new Promise(resolve => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
    });
}
