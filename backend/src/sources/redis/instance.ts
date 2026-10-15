/**
 * Redis Source Instance
 *
 * Redis is a schemaless key-value cache, not a database — no query language.
 * This instance:
 *  - "connects" with an ioredis client and verifies with PING
 *  - extracts a best-effort schema by profiling the keyspace: SCAN a bounded
 *    sample of keys, collapse each to a key *pattern* (device:{id}:latest),
 *    group by pattern, and infer each family's Redis type + fields from samples
 *  - executes a single read command per call (GET/HGETALL/LRANGE/SCAN/…, plus
 *    FT.SEARCH when RediSearch is present), gated by a read-only command guard,
 *    and normalizes the reply into rows the rest of the pipeline understands.
 *
 * No aggregation exists in plain Redis; analytics fetch bounded rows (ideally by
 * key) and the scripts-flow layer computes totals/groupings in JS.
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';
import { assertRedisReadOnly, parseRedisCommand } from './command-guard';
import Redis, { Cluster } from 'ioredis';

interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean;
  /** Force cluster mode. Auto-detected for ElastiCache Serverless / cluster endpoints. */
  cluster?: boolean;
  /** Comma-separated key-pattern allowlist to profile/expose. Blank = whole keyspace. */
  scanMatch?: string;
}

// Keyspace profiling bounds.
const SCHEMA_SCAN_LIMIT = 500;   // keys sampled during schema extraction
const SCHEMA_SCAN_COUNT = 200;   // SCAN COUNT hint per iteration
const MAX_PATTERNS = 100;        // distinct key-pattern families to keep
const SAMPLES_PER_PATTERN = 5;   // sample keys inspected per family
// Execution bound — a runaway SCAN can't sweep an unbounded keyspace.
const MAX_SCAN_KEYS = 5000;

export class RedisInstance extends BaseSource {
  private _client: Redis | Cluster | null = null;
  private _hasSearch = false;

  private getConnectionConfig(): RedisConfig {
    return this.config.config as RedisConfig;
  }

  /**
   * Cluster mode? Explicit `cluster` flag wins; otherwise auto-detect from the
   * endpoint — ElastiCache Serverless (`.serverless.`) and cluster configuration
   * endpoints (`clustercfg.`) run in cluster mode and require a cluster client.
   */
  private isCluster(): boolean {
    const cfg = this.getConnectionConfig();
    if (typeof cfg.cluster === 'boolean') return cfg.cluster;
    const target = `${cfg.url || ''} ${cfg.host || ''}`.toLowerCase();
    return target.includes('serverless') || target.includes('clustercfg');
  }

  /** ElastiCache Serverless mandates TLS; also honor an explicit tls flag / rediss:// URL. */
  private useTls(): boolean {
    const cfg = this.getConnectionConfig();
    const target = `${cfg.url || ''} ${cfg.host || ''}`.toLowerCase();
    return !!cfg.tls || target.includes('serverless') || (cfg.url || '').startsWith('rediss://');
  }

  private get client(): Redis | Cluster {
    if (this._client) return this._client;
    const cfg = this.getConnectionConfig();
    const tls = this.useTls() ? {} : undefined;

    if (this.isCluster()) {
      // Cluster mode (ElastiCache Serverless / cluster config endpoint). The
      // dnsLookup passthrough is required so TLS SNI matches the endpoint cert.
      const host = cfg.host || (cfg.url ? new URL(cfg.url).hostname : '');
      const port = cfg.port || (cfg.url ? Number(new URL(cfg.url).port || 6379) : 6379);
      console.log(`[RedisInstance:${this.getName()}] Cluster mode (tls=${!!tls}) → ${host}:${port}`);
      this._client = new Cluster([{ host, port }], {
        lazyConnect: true,
        dnsLookup: (address, cb) => cb(null, address),
        slotsRefreshTimeout: 3000,
        redisOptions: {
          username: cfg.username || undefined,
          password: cfg.password || undefined,
          ...(tls ? { tls } : {}),
          maxRetriesPerRequest: 2,
        },
      });
    } else if (cfg.url && cfg.url.trim()) {
      this._client = new Redis(cfg.url.trim(), { lazyConnect: true, maxRetriesPerRequest: 2 });
    } else {
      this._client = new Redis({
        host: cfg.host,
        port: cfg.port || 6379,
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        db: cfg.db ?? 0,
        ...(tls ? { tls } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
    }
    return this._client;
  }

  /** Nodes to SCAN: every master shard in cluster mode, else the single client. */
  private getScanNodes(): Array<Redis | Cluster> {
    if (this._client instanceof Cluster) return (this._client as Cluster).nodes('master');
    return [this.client];
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.ping();
      // Detect RediSearch so we can advertise FT.SEARCH in the tool description.
      try {
        const modules = (await this.client.call('MODULE', 'LIST')) as any[];
        this._hasSearch = Array.isArray(modules)
          && modules.some((m: any) => Array.isArray(m) && m.some((v: any) => String(v).toLowerCase() === 'search'));
      } catch {
        this._hasSearch = false;
      }
      this.setConnected(true);
    } catch (error) {
      this.setConnected(false);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this._client?.quit();
    } catch {
      this._client?.disconnect();
    }
    this._client = null;
    this.setConnected(false);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Profile the keyspace into key-pattern families. Uses SCAN (never KEYS) and
   * caps the sample so this stays bounded on a large keyspace.
   */
  async extractSchema(): Promise<SourceSchema> {
    const cfg = this.getConnectionConfig();
    const matches = (cfg.scanMatch && cfg.scanMatch.trim())
      ? cfg.scanMatch.split(',').map(s => s.trim()).filter(Boolean)
      : ['*'];

    console.log(`[RedisInstance:${this.getName()}] Profiling keyspace (patterns: ${matches.join(', ')})...`);

    // Group sampled keys by templated pattern.
    const groups = new Map<string, string[]>();
    for (const match of matches) {
      const keys = await this.scanKeys(match, SCHEMA_SCAN_LIMIT);
      for (const key of keys) {
        const pattern = this.templatizeKey(key);
        if (!groups.has(pattern)) {
          if (groups.size >= MAX_PATTERNS) continue;
          groups.set(pattern, []);
        }
        groups.get(pattern)!.push(key);
      }
    }

    const entities: SchemaEntity[] = [];
    for (const [pattern, keys] of groups) {
      try {
        const entity = await this.profilePattern(pattern, keys);
        if (entity) entities.push(entity);
      } catch (e) {
        console.warn(`[RedisInstance:${this.getName()}] Could not profile "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const schema: SourceSchema = { entities, extractedAt: new Date().toISOString() };
    this.setSchema(schema);
    console.log(`[RedisInstance:${this.getName()}] Extracted schema: ${entities.length} key-pattern families`);
    return schema;
  }

  /**
   * SCAN a MATCH pattern, collecting up to `limit` keys (bounded, non-blocking).
   * In cluster mode SCAN runs per shard, so we iterate every master node.
   */
  private async scanKeys(match: string, limit: number): Promise<string[]> {
    const found: string[] = [];
    for (const node of this.getScanNodes()) {
      let cursor = '0';
      do {
        const [next, batch] = (await node.call('SCAN', cursor, 'MATCH', match, 'COUNT', SCHEMA_SCAN_COUNT)) as [string, string[]];
        cursor = next;
        if (batch?.length) found.push(...batch);
        if (found.length >= limit) return found.slice(0, limit);
      } while (cursor !== '0');
    }
    return found.slice(0, limit);
  }

  /**
   * Collapse a concrete key into a pattern by replacing id-like segments with
   * {id}: device:e8f60aaa4bcc:latest → device:{id}:latest.
   */
  private templatizeKey(key: string): string {
    return key
      .split(':')
      .map(seg => {
        if (/^\d+$/.test(seg)) return '{id}';                              // numeric id
        if (/^[0-9a-f]{6,}$/i.test(seg)) return '{id}';                    // hex id
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}'; // uuid
        return seg;
      })
      .join(':');
  }

  /** Build one entity for a key-pattern family by sampling a few of its keys. */
  private async profilePattern(pattern: string, keys: string[]): Promise<SchemaEntity | null> {
    const sampleKeys = keys.slice(0, SAMPLES_PER_PATTERN);
    if (sampleKeys.length === 0) return null;

    const type = String(await this.client.call('TYPE', sampleKeys[0]));
    const fields: SchemaField[] = [];

    if (type === 'hash') {
      // Union of hash fields across sampled keys, with sample values.
      const acc = new Map<string, any[]>();
      for (const k of sampleKeys) {
        const flat = (await this.client.call('HGETALL', k)) as string[];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const f = flat[i];
          if (!acc.has(f)) acc.set(f, []);
          const arr = acc.get(f)!;
          if (arr.length < 5 && !arr.includes(flat[i + 1])) arr.push(flat[i + 1]);
        }
      }
      for (const [name, samples] of acc) {
        fields.push({ name, type: this.inferType(samples[0]), sampleValues: samples });
      }
    } else if (type === 'string') {
      // If the value is JSON, surface its top-level keys as fields.
      const raw = String(await this.client.call('GET', sampleKeys[0]) ?? '');
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, v] of Object.entries(parsed).slice(0, 50)) {
          fields.push({ name, type: this.inferType(v), sampleValues: [this.displayValue(v)] });
        }
      } else {
        fields.push({ name: 'value', type: 'TEXT', sampleValues: [this.displayValue(raw)] });
      }
    } else if (type === 'list') {
      const members = (await this.client.call('LRANGE', sampleKeys[0], '0', '4')) as string[];
      fields.push({ name: 'value', type: 'TEXT', sampleValues: members.slice(0, 5).map(v => this.displayValue(v)) });
    } else if (type === 'set') {
      const members = (await this.client.call('SRANDMEMBER', sampleKeys[0], '5')) as string[];
      fields.push({ name: 'member', type: 'TEXT', sampleValues: (members || []).slice(0, 5).map(v => this.displayValue(v)) });
    } else if (type === 'zset') {
      const flat = (await this.client.call('ZRANGE', sampleKeys[0], '0', '4', 'WITHSCORES')) as string[];
      const members: string[] = [];
      const scores: string[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) { members.push(flat[i]); scores.push(flat[i + 1]); }
      fields.push({ name: 'member', type: 'TEXT', sampleValues: members.slice(0, 5) });
      fields.push({ name: 'score', type: 'NUMBER', sampleValues: scores.slice(0, 5) });
    } else {
      fields.push({ name: 'value', type: 'TEXT' });
    }

    return {
      name: pattern,
      fullName: pattern,
      description: `Redis ${type}; key pattern ${pattern}`,
      fields,
      rowCount: keys.length, // sampled count for this family (approximate)
    };
  }

  private inferType(value: any): string {
    if (value == null) return 'TEXT';
    if (typeof value === 'number') return 'NUMBER';
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'object') return 'JSON';
    const s = String(value);
    if (/^-?\d+(\.\d+)?$/.test(s)) return 'NUMBER';
    if (s === 'true' || s === 'false') return 'BOOLEAN';
    return 'TEXT';
  }

  /** Render a value for schema samples; flag non-UTF8/binary blobs. */
  private displayValue(v: any): any {
    if (v == null) return null;
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
    const s = String(v);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(s)) return '<binary>';
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  /**
   * Execute a single Redis READ command. The command text arrives in `query`
   * (the SourceAgent's generated-query field); `command`/`sql` are accepted as
   * fallbacks. SCAN-family commands are auto-paginated (bounded) into key rows.
   */
  async execute(params: { query?: string; command?: string; sql?: string }): Promise<QueryResult> {
    const startTime = Date.now();
    const line = params.query || params.command || params.sql || '';

    // Read-only allowlist guard (rejects writes, admin, and blocking KEYS).
    const tokens = assertRedisReadOnly(line, this.getWriteMode(), this.getName());
    const cmd = tokens[0].toUpperCase();
    const args = tokens.slice(1);

    console.log(`[RedisInstance:${this.getName()}] CMD:`, line.substring(0, 120) + (line.length > 120 ? '...' : ''));

    try {
      let data: any[];
      let truncated = false;

      if (cmd === 'SCAN') {
        ({ rows: data, truncated } = await this.runScan(args));
      } else {
        const reply = await this.client.call(cmd, ...args);
        data = this.normalizeReply(cmd, args, reply);
      }

      return {
        data,
        count: data.length,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: data.length,
          ...(truncated ? { truncated: true, note: `Stopped at the ${MAX_SCAN_KEYS}-key scan cap — narrow the MATCH pattern for a complete answer.` } : {}),
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisInstance:${this.getName()}] Command error:`, msg);
      throw new Error(`Redis command failed: ${msg}\nCommand: ${line}`);
    }
  }

  /** Auto-paginate `SCAN [0] MATCH x COUNT n` into { key } rows, bounded. */
  private async runScan(args: string[]): Promise<{ rows: any[]; truncated: boolean }> {
    // Extract MATCH/COUNT from the agent's args; ignore any cursor it passed.
    let match = '*';
    let count = String(SCHEMA_SCAN_COUNT);
    for (let i = 0; i < args.length - 1; i++) {
      const a = args[i].toUpperCase();
      if (a === 'MATCH') match = args[i + 1];
      if (a === 'COUNT') count = args[i + 1];
    }
    const keys: string[] = [];
    let truncated = false;
    // Cluster mode: SCAN each master shard; standalone: the single node.
    outer:
    for (const node of this.getScanNodes()) {
      let cursor = '0';
      do {
        const [next, batch] = (await node.call('SCAN', cursor, 'MATCH', match, 'COUNT', count)) as [string, string[]];
        cursor = next;
        if (batch?.length) keys.push(...batch);
        if (keys.length >= MAX_SCAN_KEYS) { truncated = true; break outer; }
      } while (cursor !== '0');
    }
    return { rows: keys.slice(0, MAX_SCAN_KEYS).map(key => ({ key })), truncated };
  }

  /** Normalize a raw Redis reply into an array of row objects per command shape. */
  private normalizeReply(cmd: string, args: string[], reply: any): any[] {
    switch (cmd) {
      case 'GET':
      case 'GETRANGE':
      case 'SUBSTR':
        return reply == null ? [] : [{ value: this.coerce(reply) }];

      case 'MGET': {
        const vals = (reply as any[]) || [];
        return vals.map((v, i) => ({ key: args[i], value: this.coerce(v) }));
      }

      case 'HGETALL': {
        const flat = (reply as any[]) || [];
        const obj: Record<string, any> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = this.coerce(flat[i + 1]);
        return Object.keys(obj).length ? [obj] : [];
      }

      case 'HMGET': {
        const vals = (reply as any[]) || [];
        // args: key f1 f2 ... → pair fields (args[1..]) with values.
        return vals.map((v, i) => ({ field: args[i + 1], value: this.coerce(v) }));
      }

      case 'LRANGE':
        return ((reply as any[]) || []).map((v, i) => ({ index: i, value: this.coerce(v) }));

      case 'SMEMBERS':
      case 'SRANDMEMBER':
      case 'SINTER':
      case 'SUNION':
      case 'SDIFF':
        return ((reply as any[]) || []).map(v => ({ member: this.coerce(v) }));

      case 'ZRANGE':
      case 'ZREVRANGE':
      case 'ZRANGEBYSCORE': {
        const flat = (reply as any[]) || [];
        const withScores = args.some(a => a.toUpperCase() === 'WITHSCORES');
        if (withScores) {
          const rows: any[] = [];
          for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ member: this.coerce(flat[i]), score: Number(flat[i + 1]) });
          return rows;
        }
        return flat.map(v => ({ member: this.coerce(v) }));
      }

      case 'TYPE':
        return [{ type: this.coerce(reply) }];
      case 'TTL':
      case 'PTTL':
        return [{ ttl: Number(reply) }];
      case 'STRLEN':
      case 'LLEN':
      case 'SCARD':
      case 'ZCARD':
      case 'HLEN':
      case 'DBSIZE':
      case 'EXISTS':
        return [{ count: Number(reply) }];

      case 'FT.SEARCH':
        return this.normalizeFtSearch(reply);

      default: {
        // Generic fallback: array → value rows; scalar → single value row.
        if (Array.isArray(reply)) return reply.map(v => ({ value: this.coerce(v) }));
        return reply == null ? [] : [{ value: this.coerce(reply) }];
      }
    }
  }

  /** FT.SEARCH reply: [total, docId, [f,v,...], docId, [f,v,...], ...] → rows. */
  private normalizeFtSearch(reply: any): any[] {
    if (!Array.isArray(reply)) return [];
    const rows: any[] = [];
    for (let i = 1; i + 1 < reply.length; i += 2) {
      const id = reply[i];
      const flat = (reply[i + 1] as any[]) || [];
      const obj: Record<string, any> = { _id: id };
      for (let j = 0; j + 1 < flat.length; j += 2) obj[flat[j]] = this.coerce(flat[j + 1]);
      rows.push(obj);
    }
    return rows;
  }

  /** Coerce a scalar reply: parse JSON objects, flag binary, keep numbers as numbers. */
  private coerce(v: any): any {
    if (v == null) return null;
    if (Buffer.isBuffer(v)) v = v.toString('utf8');
    const s = String(v);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(s)) return '<binary>';
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.parse(s); } catch { /* keep string */ }
    }
    return s;
  }

  // ============================================
  // Tool Generation
  // ============================================

  protected getToolParams(): Record<string, string> {
    return {
      query: 'A single Redis READ command. Examples: HGETALL device:e8f60aaa4bcc:latest | GET config:chamber:12 | LRANGE events:dev1 0 9 | ZRANGE leaderboard 0 9 WITHSCORES | SCAN 0 MATCH device:* COUNT 200' + (this._hasSearch ? ' | FT.SEARCH idx "@status:{active}"' : ''),
    };
  }

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();
    const schemaInfo = this.formatSchemaForMainAgent();
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();
    const target = cfg.url ? 'Redis' : `Redis ${cfg.host || ''}:${cfg.port || 6379}`;

    return `Query ${this.config.name} (${target}) with a single read command.${sourceContext}${domainHints}

Key-pattern families (each is a group of keys sharing a shape; {id} marks the variable part):
${schemaInfo}

Redis usage and constraints (READ THESE — Redis is a key-value store, NOT a database):
- Provide ONE Redis read command. Look up by exact key when you know it: HGETALL device:<id>:latest, GET <key>.
- Discover keys with SCAN (never KEYS): SCAN 0 MATCH device:* COUNT 200 — the tool auto-paginates and returns matching keys.
- Read by type: hash → HGETALL; string → GET; list → LRANGE key start stop; set → SMEMBERS key; sorted set → ZRANGE key start stop [WITHSCORES].
- NO aggregation, GROUP BY, JOIN, or filtering by value in plain Redis. To answer analytics, SCAN/GET the relevant keys (as narrowly as possible) and let the calling script compute totals/groupings in JS.
${this._hasSearch ? '- RediSearch IS available: you may use FT.SEARCH <index> "<query>" for indexed field queries and filtering.' : '- RediSearch is NOT available on this instance — do not use FT.SEARCH.'}
- Values may be JSON (parsed automatically), plain strings, or binary (shown as <binary>). Keys may expire (TTL), so data can be transient.`;
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    return {
      description: `Rows from ${this.config.name}. Shape depends on the command: a hash returns one row of fields; SCAN returns { key } rows; lists/sets return value/member rows.`,
      fields: [
        { name: 'data', type: 'array', description: 'Array of result rows (shape depends on the Redis command)' },
        { name: 'count', type: 'number', description: 'Number of rows returned' },
      ],
    };
  }
}
