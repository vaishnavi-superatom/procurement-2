/**
 * PII Detector
 *
 * Lightweight, offline PII screen for uploaded file sources (Excel/CSV). Runs
 * over the EXTRACTED SCHEMA (column names + the few sample values per column we
 * already pull during schema extraction) — never over the full dataset, so it's
 * cheap regardless of row count.
 *
 * Two signal sources:
 *  1. @redactpii/node (regex, US-centric) for EMAIL / PHONE / SSN / CREDIT_CARD.
 *     NAME is intentionally NOT used for VALUE detection — its greeting-based
 *     heuristic is too noisy for tabular data; we flag names via column-name only.
 *  2. Custom value regexes for PII redactpii (US-centric) misses: India national
 *     IDs (AADHAAR / PAN / GSTIN / INDIA_MOBILE / PASSPORT / VOTER_ID /
 *     DRIVING_LICENCE / IFSC) and BLOOD_GROUP (universal health data). The
 *     national-ID + blood-group patterns are anchored to the whole cell value.
 *
 * Value checks run ONLY on text columns, so numeric financial columns (amounts,
 * IDs that look like a credit card / SSN / phone) don't trigger false positives.
 * Column-name hints are a separate, weaker signal that also catches columns whose
 * sample values happen to be empty/sparse.
 *
 * NOTE: @redactpii/node ships ESM-only while this backend is CommonJS, so the
 * package is loaded via a dynamic import() that TypeScript must NOT down-level to
 * require() (which throws ERR_REQUIRE_ESM). The `new Function(...)` wrapper keeps
 * the import() intact in both ts-node (dev) and compiled (prod) output.
 */

import type { SourceSchema, SchemaField } from './types';

export interface PIIFinding {
  /** Table/sheet name. */
  entity: string;
  /** Column that matched. */
  column: string;
  /** Distinct PII types found for this column (e.g. ["EMAIL", "AADHAAR"]). */
  types: string[];
  /** Strongest evidence: an actual matching value, or just the column name. */
  via: 'value' | 'column-name';
  /** A representative value from the column, for the redaction preview. */
  sample?: string;
  /** The masked form of `sample` — what redaction will produce. */
  sampleRedacted?: string;
}

// redactpii built-in types we trust for VALUE detection (NAME excluded — noisy).
const REDACTPII_VALUE_TYPES = ['EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD'] as const;

// Extra value-pattern PII that redactpii (US-centric) does not cover. Mostly
// India-specific national IDs, plus blood group (universal, "special category"
// health data). The national-ID + blood-group patterns are anchored to the WHOLE
// cell (^…$) since in tabular data the cell IS the value — this keeps them from
// false-matching ERP product/order codes that merely contain a similar substring.
const INDIA_DETECTORS: { type: string; re: RegExp }[] = [
  // Aadhaar: 12 digits (first 2-9), optionally space-grouped 4-4-4.
  { type: 'AADHAAR', re: /(?:^|\D)[2-9]\d{3}\s?\d{4}\s?\d{4}(?:\D|$)/ },
  // PAN: 5 letters + 4 digits + 1 letter.
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  // GSTIN: 2-digit state + PAN + entity digit + 'Z' + checksum char.
  { type: 'GSTIN', re: /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/ },
  // Indian mobile: optional +91, leading 6-9, 10 digits total.
  { type: 'INDIA_MOBILE', re: /(?:^|\D)(?:\+?91[-\s]?)?[6-9]\d{9}(?:\D|$)/ },
  // Blood group: the 8 valid groups, with +/-, "+ve/-ve", or positive/negative.
  { type: 'BLOOD_GROUP', re: /^\s*(?:A|B|AB|O)\s?(?:[+-]|\+ve|-ve|pos(?:itive)?|neg(?:ative)?)\s*$/i },
  // Indian passport: 1 letter (excludes Q/X/Z) + 7 digits, first digit non-zero.
  { type: 'PASSPORT', re: /^\s*[A-PR-WY][1-9]\d{6}\s*$/i },
  // Voter ID (EPIC): 3 letters + 7 digits.
  { type: 'VOTER_ID', re: /^\s*[A-Z]{3}\d{7}\s*$/i },
  // Indian driving licence: 2-letter state + 2-digit RTO + 4-digit year + 7 digits.
  { type: 'DRIVING_LICENCE', re: /^\s*[A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}\s?\d{7}\s*$/i },
  // IFSC (bank branch code): 4 letters + '0' + 6 alphanumerics.
  { type: 'IFSC', re: /^\s*[A-Z]{4}0[A-Z0-9]{6}\s*$/i },
  // UPI ID: handle@psp. The psp suffix is a bare word (no dot), which is what
  // distinguishes it from an email address (whose domain always has a dot).
  { type: 'UPI_ID', re: /^\s*[a-z0-9][\w.\-]+@[a-z]{2,}\s*$/i },
  // Indian vehicle registration: 2-letter state + 1-2 digit RTO + 1-3 letter
  // series + 4 digits (e.g. MH01AB1234), optionally separated by space/hyphen.
  { type: 'VEHICLE_REG', re: /^\s*[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\s*$/i },
  // IPv4 address — octet-validated (0-255) so it won't match arbitrary dotted numbers.
  { type: 'IP_ADDRESS', re: /^\s*(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*$/ },
  // MAC address: six : or - separated hex pairs.
  { type: 'MAC_ADDRESS', re: /^\s*(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\s*$/i },
];


// ---------------------------------------------------------------------------
// Lazy ESM load of @redactpii/node (one Redactor per type → exact attribution)
// ---------------------------------------------------------------------------

interface RedactorLike { hasPII(text: string): boolean }
let _redactorsPromise: Promise<Record<string, RedactorLike>> | null = null;

// Keep import() out of TypeScript's CommonJS down-leveling so it stays a real
// dynamic ESM import at runtime.
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

async function getRedactors(): Promise<Record<string, RedactorLike>> {
  if (!_redactorsPromise) {
    _redactorsPromise = (async () => {
      const mod = await esmImport('@redactpii/node');
      const Redactor = mod.Redactor;
      const out: Record<string, RedactorLike> = {};
      for (const t of REDACTPII_VALUE_TYPES) {
        // One redactor per type with only that rule on, so hasPII() attributes
        // the exact type. apiKey:null guarantees it never phones home.
        out[t] = new Redactor({
          apiKey: null,
          rules: { EMAIL: false, PHONE: false, SSN: false, CREDIT_CARD: false, NAME: false, [t]: true },
        });
      }
      return out;
    })().catch((err: unknown) => {
      _redactorsPromise = null; // allow a later retry if the import failed
      throw err;
    });
  }
  return _redactorsPromise;
}

function isTextField(field: SchemaField): boolean {
  const t = String((field as any).type || '').toUpperCase();
  const nt = String((field as any).nativeType || '').toUpperCase();
  return t === 'TEXT' || t === 'STRING' || nt.includes('VARCHAR') || nt.includes('CHAR') || nt.includes('TEXT');
}

/**
 * Scan an extracted schema for likely PII. Returns one finding per flagged
 * column (deduped types). Empty array = nothing detected. Cheap: it only looks
 * at column names + the handful of sample values already on each field.
 */
export async function detectPII(schema: SourceSchema | null | undefined): Promise<PIIFinding[]> {
  if (!schema?.entities?.length) return [];

  const redactors = await getRedactors();
  const findings: PIIFinding[] = [];

  for (const entity of schema.entities) {
    for (const field of entity.fields || []) {
      // Value-based detection only. We deliberately DON'T flag by column name:
      // a name-flagged column (NAME/ADDRESS/DOB) has no per-cell value signal, so
      // the redactor couldn't actually mask it — which made the preview promise a
      // masking that never happened. Only flag columns whose values match a
      // detectable PII pattern, so every flagged column is genuinely redactable.
      if (!isTextField(field)) continue;

      const types = new Set<string>();
      let matchedSample: string | undefined; // first value that actually matched PII

      const samples = (field.sampleValues || [])
        .map((v: any) => String(v ?? ''))
        .filter((s) => s.length > 0);

      for (const s of samples) {
        let matched = false;
        for (const t of REDACTPII_VALUE_TYPES) {
          if (redactors[t].hasPII(s)) { types.add(t); matched = true; }
        }
        for (const d of INDIA_DETECTORS) {
          if (d.re.test(s)) { types.add(d.type); matched = true; }
        }
        if (matched && matchedSample === undefined) matchedSample = s;
      }

      if (types.size > 0) {
        findings.push({
          entity: entity.name,
          column: field.name,
          types: Array.from(types).sort(),
          via: 'value',
          sample: matchedSample,
          sampleRedacted: matchedSample ? maskValue(matchedSample) : undefined,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Value-level redaction (used when the client opts to redact PII before persist)
// ---------------------------------------------------------------------------

/**
 * Full redact: replace EVERY alphanumeric character with '*'. Separators (spaces,
 * dashes, @, dots, etc.) are left in place so the value keeps a recognizable
 * shape, but no original data is readable.
 *   "222-4443-5546"  -> "***-****-****"
 *   "john@gmail.com"  -> "****@*****.***"
 */
export function maskValue(value: string): string {
  return Array.from(value)
    .map((c) => (/[A-Za-z0-9]/.test(c) ? '*' : c))
    .join('');
}

/**
 * Build a synchronous value redactor. Loads the (memoized) redactors once, then
 * returns a function that masks a single cell value IF it contains PII, else
 * returns it unchanged. Detection mirrors detectPII's value pass (redactpii
 * EMAIL/PHONE/SSN/CREDIT_CARD + the India regexes).
 */
export async function buildValueRedactor(): Promise<(value: string) => string> {
  const redactors = await getRedactors();
  return (value: string): string => {
    if (!value) return value;
    let hasPII = false;
    for (const t of REDACTPII_VALUE_TYPES) {
      if (redactors[t].hasPII(value)) { hasPII = true; break; }
    }
    if (!hasPII) {
      for (const d of INDIA_DETECTORS) {
        if (d.re.test(value)) { hasPII = true; break; }
      }
    }
    return hasPII ? maskValue(value) : value;
  };
}
