/**
 * Redis command guard — read-only allowlist for the LLM agent flow.
 *
 * Redis has no SQL to parse; access is a command + args. We allowlist a small
 * set of read commands and reject everything else (writes, admin, and the
 * server-blocking KEYS). This mirrors the intent of sql-guard for the SQL
 * sources: a defense-in-depth backstop against LLM-generated input, NOT a
 * substitute for a scoped ACL user on the Redis side.
 */

import { WriteMode } from '../core/sql-guard';

export class RedisCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisCommandError';
  }
}

// Read-only commands the agent may run. Uppercased, no args.
// SCAN-family included (non-blocking); KEYS deliberately excluded (blocks the server).
const READ_COMMANDS = new Set<string>([
  // strings
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR',
  // hashes
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HRANDFIELD',
  // lists
  'LRANGE', 'LINDEX', 'LLEN', 'LPOS',
  // sets
  'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF',
  // sorted sets
  'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK', 'ZREVRANK', 'ZSCAN',
  // streams
  'XRANGE', 'XREVRANGE', 'XLEN', 'XREAD', 'XINFO',
  // keyspace / metadata (read-only, non-blocking)
  'EXISTS', 'TYPE', 'TTL', 'PTTL', 'SCAN', 'OBJECT', 'MEMORY', 'DBSIZE', 'RANDOMKEY',
  // JSON (RedisJSON) reads
  'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.OBJKEYS', 'JSON.OBJLEN', 'JSON.ARRLEN',
  // Search (RediSearch) reads
  'FT.SEARCH', 'FT.AGGREGATE', 'FT.INFO', 'FT._LIST', 'FT.EXPLAIN',
]);

// Explicitly dangerous even if someone widened the set — never allow.
const FORBIDDEN_COMMANDS = new Set<string>([
  'KEYS',        // O(N), blocks the server — use SCAN
  'FLUSHALL', 'FLUSHDB', 'SWAPDB',
  'CONFIG', 'DEBUG', 'SHUTDOWN', 'MONITOR', 'SLAVEOF', 'REPLICAOF', 'FAILOVER',
  'SCRIPT', 'EVAL', 'EVALSHA', 'FUNCTION', 'FCALL',
  'CLUSTER', 'ACL', 'CLIENT', 'RESET', 'MODULE', 'MIGRATE', 'RESTORE',
]);

/**
 * Parse a Redis command line into [command, ...args], respecting single/double
 * quotes so values containing spaces stay intact.
 */
export function parseRedisCommand(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Throws {@link RedisCommandError} unless `line` is a single allowed read
 * command. Composite commands (e.g. `OBJECT ENCODING`, `FT.SEARCH`) match on the
 * first token; `OBJECT`/`XINFO`/`MEMORY` subcommands are all read-only.
 * `mode` is accepted for symmetry with the SQL guard; only 'read' is supported
 * for Redis today (writes are never issued from the agent flow).
 */
export function assertRedisReadOnly(line: string, mode: WriteMode = 'read', sourceName?: string): string[] {
  const label = sourceName ? ` on "${sourceName}"` : '';
  if (typeof line !== 'string' || line.trim().length === 0) {
    throw new RedisCommandError(`Empty Redis command${label}.`);
  }

  const tokens = parseRedisCommand(line.trim());
  if (tokens.length === 0) {
    throw new RedisCommandError(`No Redis command${label}.`);
  }

  const cmd = tokens[0].toUpperCase();

  if (FORBIDDEN_COMMANDS.has(cmd)) {
    throw new RedisCommandError(`Command "${cmd}" is not permitted${label} (dangerous or server-blocking).`);
  }

  if (mode !== 'read') {
    // No write path is wired for Redis yet — refuse rather than silently allow.
    throw new RedisCommandError(`Only read-only Redis access is supported${label}.`);
  }

  if (!READ_COMMANDS.has(cmd)) {
    throw new RedisCommandError(`Command "${cmd}" is not an allowed read command${label}. Allowed: GET/MGET/HGETALL/LRANGE/SMEMBERS/ZRANGE/SCAN/TYPE/TTL/FT.SEARCH, etc.`);
  }

  return tokens;
}
