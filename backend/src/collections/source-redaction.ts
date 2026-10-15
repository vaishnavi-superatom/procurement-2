/**
 * Source credential redaction for the `project-sources` collection.
 *
 * Rows in `project_sources` carry live connection `config` — host, user and
 * plaintext password — plus local upload paths and object-storage keys. The
 * collection is served over the SDK's DATA_REQ bus, so anything returned here
 * reaches a browser. Credentials must never make that trip.
 *
 * Redaction lives at this boundary and NOT in getProjectSources(): the source
 * manager calls the same DB function to open real connections, so stripping
 * secrets there would break every data source in the product.
 *
 * Secrets are replaced with a sentinel rather than removed, because the admin
 * edit dialog prefills from what we send and posts the whole config back. If a
 * secret came back as a placeholder and was written verbatim, the real
 * credential would be destroyed — so `restoreSourceSecrets` swaps the sentinel
 * back for the stored value before any write.
 */

import path from 'path';

/** Marks a secret the client was never given. Round-trips on update. */
export const SECRET_SENTINEL = '__SA_SECRET_UNCHANGED__';

/** Mask used inside connection strings, which stay partially readable. */
const CONNECTION_STRING_MASK = ':****@';

/** Matched case-insensitively against key names, as a substring. */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'privatekey',
  'private_key',
  'credential',
  'passphrase',
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Replace the password portion of a connection string, keeping the rest
 * readable so the admin UI can still show which host a source points at.
 */
function maskConnectionString(value: string): string {
  return value.replace(/:[^:@/]+@/, CONNECTION_STRING_MASK);
}

/** True when a value came back from a client still carrying our redaction. */
export function isRedactedValue(value: any): boolean {
  if (typeof value !== 'string') return false;
  return value === SECRET_SENTINEL || value.includes(CONNECTION_STRING_MASK);
}

/**
 * Deep-redact a value on its way to a client. Walks arrays and plain objects,
 * so it covers every operation's return shape — including ones added later —
 * rather than depending on each handler remembering to sanitize.
 */
export function redactSourceSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: any): any {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  // Preserve non-plain objects (Date, Buffer, …) rather than flattening them.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }

  const out: Record<string, any> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      // Preserve absence: a source with no password should not look like it has one.
      out[key] = entry === undefined || entry === null || entry === '' ? entry : SECRET_SENTINEL;
      continue;
    }

    if (key === 'connectionString' && typeof entry === 'string') {
      out[key] = maskConnectionString(entry);
      continue;
    }

    // Internal upload paths disclose server layout; the basename is all the UI shows.
    if ((key === 'filePath' || key === 'localPath') && typeof entry === 'string' && entry) {
      out[key] = path.basename(entry);
      continue;
    }

    out[key] = redact(entry);
  }

  return out;
}

/**
 * Undo redaction before persisting a client-supplied config: any value the
 * client echoed back unchanged is replaced with what is already stored.
 * Without this, saving an unrelated field (e.g. renaming a source) would write
 * the sentinel over a live credential.
 */
export function restoreSourceSecrets(
  incoming: Record<string, any> | undefined,
  stored: Record<string, any> | undefined | null
): Record<string, any> | undefined {
  if (!incoming || typeof incoming !== 'object') return incoming;

  const storedConfig = stored && typeof stored === 'object' ? stored : {};
  const out: Record<string, any> = Array.isArray(incoming) ? ([] as any) : {};

  for (const [key, value] of Object.entries(incoming)) {
    const storedValue = (storedConfig as Record<string, any>)[key];

    if (isRedactedValue(value)) {
      // Fall back to the client's value only if nothing is stored, so a genuinely
      // new field is not silently dropped.
      out[key] = storedValue !== undefined ? storedValue : value;
      continue;
    }

    if (value && typeof value === 'object') {
      out[key] = restoreSourceSecrets(value, storedValue);
      continue;
    }

    out[key] = value;
  }

  return out;
}
