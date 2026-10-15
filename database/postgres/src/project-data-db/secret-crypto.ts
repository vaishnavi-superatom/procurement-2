/**
 * AES-256-GCM encryption for sensitive source-config fields (e.g. a NetSuite
 * private key) stored inside project_sources.config (jsonb). Encrypting only
 * specific dot-path fields — rather than the whole config blob — needs no
 * schema/column change: the jsonb structure is unchanged, individual string
 * values just become opaque ciphertext.
 *
 * Key: SOURCE_SECRET_ENCRYPTION_KEY env var, a base64-encoded 32-byte AES-256 key.
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:v1:';

function getKey(): Buffer {
  const raw = process.env.SOURCE_SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SOURCE_SECRET_ENCRYPTION_KEY is not set — cannot encrypt/decrypt source secrets. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SOURCE_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key).');
  }
  return key;
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) return value; // legacy/plaintext value — pass through
  const key = getKey();
  const raw = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((cur, key) => (cur == null ? cur : cur[key]), obj);
}

function setPath(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Encrypt each dot-path field in `config` that holds a non-empty plaintext string. */
export function encryptConfigFields(config: Record<string, any>, fieldPaths: string[]): Record<string, any> {
  if (!fieldPaths.length) return config;
  const next = JSON.parse(JSON.stringify(config));
  for (const path of fieldPaths) {
    const value = getPath(next, path);
    if (typeof value === 'string' && value.length > 0 && !isEncryptedSecret(value)) {
      setPath(next, path, encryptSecret(value));
    }
  }
  return next;
}

/** Decrypt each dot-path field in `config` that holds our encrypted format. */
export function decryptConfigFields(config: Record<string, any>, fieldPaths: string[]): Record<string, any> {
  if (!fieldPaths.length) return config;
  const next = JSON.parse(JSON.stringify(config));
  for (const path of fieldPaths) {
    const value = getPath(next, path);
    if (isEncryptedSecret(value)) {
      setPath(next, path, decryptSecret(value));
    }
  }
  return next;
}
