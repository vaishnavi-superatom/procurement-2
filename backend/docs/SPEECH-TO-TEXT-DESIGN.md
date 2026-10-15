# Speech-to-Text (Voice Input) — Implementation Spec

**Status:** Ready to implement. Provider path verified live 2026-07-28 (§2). One open item: vocabulary biasing (§4.3).
**Last updated:** 2026-07-28
**Audience:** the engineer implementing this. §1 for the *why*, §2 for verified provider behavior,
§3–§6 for the components with copy-paste code, §7 build order, §8 verification, §10 out of scope.

Add a microphone button to the chat input. The user speaks a question, it is transcribed to
text, the text lands in the textarea, the user reviews it and presses Enter — from there it is
an ordinary user-prompt request. No streaming, no chunking, no partial results.

**This feature spans three repos.** The doc lives here because `backend/docs` is where our
design specs live, but most of the code does **not** go in this repo:

| Repo | Role |
|---|---|
| `do-websocket/packages/api` (`sa-api` worker) | **Primary.** Holds the API key, calls the STT model |
| `runtime-react` | Mic button, MediaRecorder capture, the upload call |
| `scripts-flow/backend` | **Minor.** One collection supplying domain vocabulary |
| `sdk-nodejs` | **No change.** Deliberately — see §1.2 |

---

## 1. Decision record

### 1.1 Transcription runs in the `sa-api` Cloudflare Worker

Not in the SDK, and not in the websocket worker. Three findings from the code decided this.

**`sa-api` is already a browser-reachable, authenticated HTTP endpoint.** Hono with `cors("*")`
(`packages/api/src/index.ts:23`), JWT `authMiddleware` (`packages/api/src/middleware/auth.ts`),
and a working multipart upload route (`packages/api/src/routes/upload.ts`). The browser half
exists too — `runtime-react/src/services/saApi.ts:1,18` holds `SA_API_BASE_URL` and sends
`Bearer ${localStorage.getItem('sa_auth_token')}`. No new transport plumbing on either side.

**Audio must not go through the websocket relay.** `Broadcaster.webSocketMessage`
(`packages/websocket/src/broadcaster/broadcaster.ts:534`) calls `incrementRequestCount()` then
`JSON.parse` on **every** message, and the Broadcaster is a **per-project singleton** — one
Durable Object shared by every user on that project. Blobs do not belong there.

**The websocket worker cannot authenticate a browser.** `packages/websocket/src/index.ts` sets
`KEY_REQUIRED_TYPES = ['data-agent', 'db-bridge']`; browser types (`runtime`, `admin`) connect
with **no credential at all** — the code comment says they "load from public bundles and cannot
safely hold the secret." A billed endpoint cannot live there.

### 1.2 Why not the SDK

The SDK deploys per-client onto the client's own VM. Speech-to-text is a **Superatom product
capability offered to every client**, not client-specific behavior.

- **Key distribution.** `OPENROUTER_API_KEY` is optional in `setup.sh:1788`. An SDK
  implementation means voice silently does not exist wherever the operator skipped it. In the
  worker it is one `wrangler secret put`, and **every existing and future deployment gets voice
  with no `setup.sh` change**.
- **Metering and kill switch.** One central place to rate-limit and meter.
- **Egress.** Locked-down client VMs may not reach `openrouter.ai`. The worker path only needs
  the browser to reach Cloudflare.

### 1.3 Model: `google/chirp-3` via OpenRouter's transcription endpoint

**A dedicated speech-recognition model, not a chat model.** This matters more than it sounds.

There is no "Gemini speech-to-text model" — Gemini is a family of multimodal *generative*
models, and transcribing with Gemini is a `generateContent` call, structurally the same request
type as chat. That brings LLM failure modes into a job that has none of them: it can answer the
question instead of transcribing it, add preamble, wrap output in quotes, or refuse.

Chirp 3 is Google's dedicated speech model, and OpenRouter serves it through a **separate
transcription API** (`POST /api/v1/audio/transcriptions`) that returns `{text, usage}` — not a
chat completion. Measured behavior backs the choice (§2.2): Chirp returned a clean result
**10/10 times** where the Gemini chat-completions path silently dropped audio in **2 of 17**.

Cost is higher — **$0.016/minute**, so a 30 s question is ~$0.008 against ~$0.0008 for Gemini
Flash, about 10×. In absolute terms this is still nothing: 1,000 voice questions a month is $8.
Correctness and predictability are worth far more than that here.

### 1.4 The transcript is never auto-sent

It fills the textarea; the user presses Enter, and from there it is a normal user-prompt
request. A misheard entity name going straight to the SQL agent produces a confidently wrong
answer against real business data. One review step eliminates the entire class.

---

## 2. Verified provider behavior (probed live 2026-07-28)

Probed through the LLM proxy (`SUPERATOM_LLM_PROXY_URL=https://ai.superatom.ai` →
`/openrouter/audio/transcriptions`) because no direct `sk-or-v1-…` key exists on the dev
machine — only a `sk-prox-…` proxy key. **The production worker calls `openrouter.ai`
directly**; the request/response shape is identical.

### 2.1 Request and response shape

```
POST https://openrouter.ai/api/v1/audio/transcriptions
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json

{ "model": "google/chirp-3",
  "input_audio": { "data": "<raw base64, NOT a data: URI>", "format": "webm" },
  "language": "en",                 // optional, ISO-639-1
  "provider": { "options": { … } }  // optional passthrough, see §4.3
}
```

Response (actual, from a 3-second probe):

```json
{ "text": "", "usage": { "seconds": 3, "cost": 0.0008 } }
```

An OpenAI-style `multipart/form-data` variant also exists (`file`, `model`, `language`,
`temperature`, `response_format`), but **its `prompt` field is accepted and ignored**, and
provider passthrough is expressed in the JSON body. We use the **JSON variant** so §4.3 stays
available. Base64 inflation applies only on the worker→OpenRouter hop; the browser→worker hop
stays multipart.

### 2.2 Reliability — why this endpoint over the chat path

| Path | Audio actually ingested |
|---|---|
| `google/chirp-3` → `/audio/transcriptions` | **10 / 10** |
| `google/gemini-2.5-flash` → `/chat/completions` with `input_audio` | **15 / 17** |

The Gemini failures returned **HTTP 200 with `content: null`, no `usage` object, and no error
field** — audio silently discarded, indistinguishable from the user saying nothing. Roughly 1 in
10. The identical signature is produced by a **mislabeled format** (webm bytes declared as
`wav`), which is exactly why §5 derives the format from the recorder's real MIME type.

Chirp's response makes the same check trivial and reliable: **`usage.seconds` is present only
when audio was ingested.** §3.1 guards on it. Keep the guard even though Chirp went 10/10 —
it is three lines and the failure it catches is invisible.

### 2.3 Formats — every browser's native output works

Verified accepted: **`wav`, `webm`, `m4a`** (200 + billed `usage.seconds`). OpenRouter documents
the full set as `wav, mp3, flac, m4a, ogg, webm, aac`.

This is the finding that **deletes the hand-rolled WAV encoder** from an earlier draft. Chrome
and Edge record `audio/webm;codecs=opus`, Firefox `audio/ogg;codecs=opus`, Safari `audio/mp4` —
all covered. `MediaRecorder` output goes straight through, ~7× smaller than WAV (13 KB vs
96 KB for 3 s in the probe).

### 2.4 Limits and latency

- **60 s upstream processing timeout**, and **25 MB** on multipart. Our 30 s cap (§5) is
  comfortably inside both.
- Measured **2.3–3.6 s** round trip for 3 s of audio *through the proxy*. Expect better direct.
  Budget a 60 s client timeout.
- Cost confirmed at **$0.016/min**: 3 s billed $0.0008; 4 s billed $0.00107.

Reproduce any of this with `scratchpad/test_audio.py`, or:

```bash
B64=$(base64 -w0 recording.webm)
curl -s https://openrouter.ai/api/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"google/chirp-3\",\"input_audio\":{\"data\":\"$B64\",\"format\":\"webm\"}}" | jq .
```

---

## 3. Component 1 — the worker route

### 3.1 New file: `do-websocket/packages/api/src/routes/speech.ts`

```ts
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { authMiddleware } from "../middleware/auth";
import { speechUsage } from "../db/schema";

const speechRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const MODEL = "google/chirp-3";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_VOCAB_CHARS = 2000;

/**
 * Browser MIME → OpenRouter `format`. The browser sends whatever MediaRecorder
 * gave it; we never assume a container. A wrong format is not rejected upstream,
 * it silently transcribes nothing (§2.2) — so unknown types are rejected here.
 */
const FORMATS: Record<string, string> = {
  "audio/webm": "webm",   // Chrome, Edge
  "audio/ogg": "ogg",     // Firefox
  "audio/mp4": "m4a",     // Safari
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** "audio/webm;codecs=opus" → "webm" */
function toFormat(mime: string): string | undefined {
  return FORMATS[mime.split(";")[0].trim().toLowerCase()];
}

speechRouter.use("*", authMiddleware);   // NOT adminOnly — every signed-in user gets voice

/**
 * GET /speech/capabilities
 * Lets the UI decide whether to render the mic button without a per-client build
 * flag — the worker is the single source of truth for whether voice is configured.
 */
speechRouter.get("/capabilities", (c) =>
  c.json({ available: Boolean(c.env.OPENROUTER_API_KEY), maxDurationMs: 30_000 })
);

/**
 * POST /speech/transcribe
 * multipart/form-data: audio (File), vocabulary? (string), projectId? (string)
 * → { text: string }
 */
speechRouter.post("/transcribe", async (c) => {
  const userId = c.get("userId");
  const orgId = c.get("orgId");

  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: "Voice input is not configured on this deployment" }, 503);
  }

  const { success } = await c.env.SPEECH_RATE_LIMITER.limit({ key: userId });
  if (!success) {
    return c.json({ error: "Too many voice requests. Wait a moment and try again." }, 429);
  }

  const form = await c.req.formData();
  const file = form.get("audio");
  if (!(file instanceof File)) return c.json({ error: "No audio provided" }, 400);

  const format = toFormat(file.type);
  if (!format) return c.json({ error: `Unsupported audio type: ${file.type}` }, 400);
  if (file.size > MAX_AUDIO_BYTES) return c.json({ error: "Audio too large" }, 400);
  if (file.size < 1024) return c.json({ text: "" });   // tapped the mic, said nothing

  const vocabulary = String(form.get("vocabulary") || "").slice(0, MAX_VOCAB_CHARS);
  const projectId = String(form.get("projectId") || "") || null;

  const startedAt = Date.now();
  let text: string;
  let seconds = 0;
  let cost = 0;

  try {
    const res = await transcribe(c.env.OPENROUTER_API_KEY, await file.arrayBuffer(), format, vocabulary);
    text = res.text;
    seconds = res.seconds;
    cost = res.cost;
  } catch (err: any) {
    c.executionCtx.waitUntil(logUsage(c, { userId, orgId, projectId, bytes: file.size, latencyMs: Date.now() - startedAt, ok: false }));
    console.error("[speech] transcription failed:", err?.message);
    return c.json({ error: "Transcription failed. Please try again." }, 502);
  }

  c.executionCtx.waitUntil(logUsage(c, {
    userId, orgId, projectId, bytes: file.size,
    latencyMs: Date.now() - startedAt, seconds, cost, ok: true,
  }));

  return c.json({ text });
});

async function transcribe(apiKey: string, audio: ArrayBuffer, format: string, vocabulary: string) {
  const body: Record<string, unknown> = {
    model: MODEL,
    input_audio: { data: toBase64(audio), format },
    // NO `language` pin — see §4.4. Auto-detect, and return whatever language
    // was spoken. Forcing "en" would make the recognizer decode non-English
    // speech AS English, producing phonetic garbage rather than a translation.
  };
  // Provider passthrough for vocabulary biasing — see §4.3. Harmless if unsupported:
  // unknown provider options are ignored, not rejected (verified).
  if (vocabulary) {
    body.provider = { options: { google: { prompt: `Expected vocabulary: ${vocabulary}` } } };
  }

  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://superatom.ai",
      "X-Title": "Superatom Voice Input",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),   // upstream caps processing at 60s
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data: any = await res.json();

  // Integrity guard (§2.2). `usage.seconds` is present only when audio was really
  // ingested. Without this, a dropped upload reads to the user as "you said nothing."
  const seconds = data?.usage?.seconds ?? 0;
  if (!seconds) throw new Error("audio was not ingested (no usage.seconds in response)");

  return {
    text: String(data?.text ?? "").trim(),
    seconds,
    cost: data?.usage?.cost ?? 0,
  };
}

/** Chunked — String.fromCharCode(...bytes) blows the stack on ~1 MB inputs. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Best-effort metering — never blocks or fails the user's transcription. */
async function logUsage(c: any, row: any) {
  try {
    await c.get("db").insert(speechUsage).values({
      orgId: row.orgId, userId: row.userId, projectId: row.projectId,
      model: MODEL, audioBytes: row.bytes,
      audioSeconds: row.seconds ? String(row.seconds) : null,
      cost: row.cost ? String(row.cost) : null,
      latencyMs: row.latencyMs, ok: row.ok,
    });
  } catch (err: any) {
    console.warn("[speech] usage log failed:", err?.message);
  }
}

export default speechRouter;
```

### 3.2 Mount it — `packages/api/src/index.ts`

```ts
import speechRoutes from "./routes/speech";
app.route("/speech", speechRoutes);   // beside app.route("/upload", uploadRoutes)
```

### 3.3 Env types — `packages/api/src/types.ts`

```ts
export type Env = {
  // ...existing...
  OPENROUTER_API_KEY: string;
  SPEECH_RATE_LIMITER: RateLimit;
  // "true" → run the optional vocabulary-correction pass (§4.3). Leave unset
  // until §8.3 shows the recognizer-side biasing is not honored.
  SPEECH_CORRECT_TERMS?: string;
};
```

### 3.4 `packages/api/wrangler.toml`

```toml
# Per-user voice rate limit. period must be 10 or 60.
[[unsafe.bindings]]
name = "SPEECH_RATE_LIMITER"
type = "ratelimit"
namespace_id = "2001"
simple = { limit = 20, period = 60 }
```

Add to the secrets comment block:
`#   wrangler secret put OPENROUTER_API_KEY   # voice transcription`

### 3.5 Metering table — `packages/api/src/db/schema.ts`

```ts
export const speechUsage = pgTable("speech_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: varchar("org_id", { length: 255 }),
  userId: varchar("user_id", { length: 255 }),
  projectId: varchar("project_id", { length: 255 }),
  model: varchar("model", { length: 128 }).notNull(),
  audioBytes: integer("audio_bytes").notNull(),
  audioSeconds: numeric("audio_seconds"),
  cost: numeric("cost"),
  latencyMs: integer("latency_ms"),
  ok: boolean("ok").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("speech_usage_org_id_idx").on(t.orgId),
  index("speech_usage_user_id_idx").on(t.userId),
  index("speech_usage_created_at_idx").on(t.createdAt),
]);
```

> **⚠ Apply with `db:push`, not `db:migrate`.** The `packages/api` drizzle journal is not in
> sync with the live Neon database — the same trap the `api_keys` table hit. Check
> `drizzle/meta/_journal.json` before running anything.

---

## 4. Component 2 — domain vocabulary from the client backend

### 4.1 Why it exists

Users speak table names, column names, branch codes, SKU prefixes and client jargon —
precisely what general STT mangles. That vocabulary lives in `project_sources.semantic_model`
in the **client's local Postgres**, which the worker cannot reach.

**The browser is the courier.** It fetches the term list once per session over the existing
`DATA_REQ` bus and passes it with each recording. Vocabulary logic stays where the data is;
the worker stays stateless.

### 4.2 New file: `scripts-flow/backend/src/collections/speech.ts`

```ts
import { getSourceManager } from '../sources';
import type { CollectionContext } from './types';

const MAX_TERMS = 300;
const MAX_CHARS = 2000;
const TTL_MS = 30 * 60 * 1000;

/** "dim_branch_location" / "branchLocationId" → "branch location" */
function humanize(raw: string): string {
  return raw
    .replace(/^(dim|fact|tbl|vw)[_\s]/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function registerSpeechCollections({ sdk }: CollectionContext): Promise<void> {
  let cache: { terms: string[]; builtAt: number } | null = null;

  // Ranked domain terms used to bias transcription. Weight favours entity names and
  // synonyms (what users actually say) over raw cell values.
  sdk.addCollection('speech', 'vocabulary', async () => {
    if (cache && Date.now() - cache.builtAt < TTL_MS) return { terms: cache.terms };

    const manager = getSourceManager();
    if (!manager) return { terms: [] };

    const scored = new Map<string, number>();
    const add = (raw: unknown, weight: number) => {
      if (typeof raw !== 'string') return;
      const t = humanize(raw);
      if (t.length < 3 || t.length > 40 || /^\d+$/.test(t)) return;
      scored.set(t, (scored.get(t) || 0) + weight);
    };

    for (const instance of manager.getAllInstances()) {
      const schema = instance.getSchema();
      if (!schema?.entities) continue;
      for (const entity of schema.entities) {
        add(entity.name, 3);
        for (const syn of entity.semantic?.synonyms || []) add(syn, 4);
        for (const field of entity.fields || []) {
          add(field.name, 2);
          for (const v of (field.semantic?.valueVocabulary || []).slice(0, 10)) add(v, 1);
        }
      }
    }

    const terms: string[] = [];
    let chars = 0;
    for (const [term] of [...scored.entries()].sort((a, b) => b[1] - a[1])) {
      if (terms.length >= MAX_TERMS || chars + term.length + 2 > MAX_CHARS) break;
      terms.push(term);
      chars += term.length + 2;
    }

    cache = { terms, builtAt: Date.now() };
    return { terms };
  });
}
```

Register in `scripts-flow/backend/src/collections/index.ts` alongside the other registrars.

### 4.3 ⚠ OPEN ITEM — is the biasing actually honored?

OpenRouter forwards provider-specific options via `provider.options.<slug>.<param>`, but **the
only documented example is Groq** (`provider.options.groq.prompt`). The correct key and
parameter name for Chirp 3 are **not documented**, and could not be verified here because this
sandbox has no way to produce real speech audio.

Probing showed `provider.options.google.prompt` is **accepted without error** — but silently
accepting an unknown option is not evidence it is honored. §3.1 sends it on that basis; it is
harmless either way.

**Resolve it with §8.3 before relying on it.** If biasing turns out to be unsupported, the
fallback is a **text-only correction pass** — one cheap LLM call over the ~20-word transcript
with the *full* 300-term vocabulary, which is strictly more capable than a truncated recognizer
hint because the model sees the whole sentence. Sketch:

```ts
// Only if §8.3 shows provider.options.google is ignored. Fail open — a raw
// transcript always beats no transcript.
async function correctTerms(apiKey: string, transcript: string, vocabulary: string) {
  const sys = [
    "Fix misrecognized domain terms in a speech transcript.",
    "Replace a word ONLY when it clearly corresponds to a vocabulary term.",
    "Preserve the original language — do NOT translate (§4.4).",
    "Never answer the question. Never add commentary. Output only the corrected text.",
    `\nVocabulary: ${vocabulary}`,
  ].join("\n");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite", temperature: 0, max_tokens: 300,
      messages: [{ role: "system", content: sys }, { role: "user", content: transcript }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return transcript;
  const out = (await res.json())?.choices?.[0]?.message?.content;
  return typeof out === "string" && out.trim() ? out.trim() : transcript;
}
```

Gate it on `SPEECH_CORRECT_TERMS === "true"` so it costs nothing until §8.3 says you need it.
**Do not build it speculatively.**

---

## 4.4 Language — transcribe as spoken, no translation

**Decision: the transcript is returned in whatever language was spoken.** No translation step.
The text goes into the input box as-is and becomes an ordinary user prompt from there.

Chirp 3 is multilingual for *recognition* — 24 GA languages, 77+ in preview — with automatic
detection, which is exactly what this needs. §3.1 therefore sends **no `language` parameter**.

> **⚠ Never pin `language: "en"`.** That parameter tells the recognizer which language to
> *decode as*, not which language to *output*. Forcing `en` on Hindi speech produces phonetic
> nonsense rather than either a Hindi transcript or an English translation. Omitting it is both
> simpler and correct.

Two consequences worth knowing before this reaches users, neither of which changes the build:

- **Chirp cannot translate.** It is a recognition model; it emits the spoken language. If
  English output is ever required, that is a separate translation step, not a parameter change.
- **Code-switching ("Hinglish") is the realistic case**, more likely than either pure language
  given the client base. A mixed-language sentence is the thing most likely to transcribe oddly,
  so §8.4 tests it explicitly.

Downstream, the agent receives whatever language the user spoke. That is fine for a first
release — LLMs handle multilingual prompts — but note that schema and KB content are English, so
retrieval quality on a non-English prompt is unmeasured. §8.4 is where you find out whether that
matters in practice.

---

## 5. Component 3 — browser capture

`MediaRecorder` native output, no encoding. **Detect the MIME type once, store it, and send it
to the worker with the audio** so the worker derives the format instead of hardcoding one —
this is what makes a single code path work on Chrome, Edge, Firefox and Safari, and it is what
prevents the mislabeled-format silent failure in §2.2.

### 5.1 New file: `runtime-react/src/hooks/useVoiceInput.ts`

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../services/saApi';
import { getSpeechVocabulary } from '../services/speechVocabulary';

const MAX_MS = 30_000;

// Probed in order; every entry maps to an OpenRouter format in the worker (§3.1).
// Chrome/Edge land on webm, Firefox on ogg, Safari on mp4.
const MIME_PREFS = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
];

/** Detected once at module load — the answer never changes for a given browser. */
export const SUPPORTED_MIME: string | null =
  typeof MediaRecorder === 'undefined'
    ? null
    : MIME_PREFS.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'error';

export function useVoiceInput(onTranscript: (text: string) => void, projectId?: string) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  // Set by cancel() so onstop knows to bin the audio instead of uploading it.
  const discardRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  /** Abandon the recording without transcribing it — Esc, §6.3. */
  const cancel = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      discardRef.current = true;
      recorderRef.current.stop();
    }
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle' || !SUPPORTED_MIME) return;
    setError(null);
    setElapsedMs(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Enable it in your browser settings.'
          : 'No microphone found.'
      );
      setState('error');
      return;
    }

    streamRef.current = stream;
    const mimeType = SUPPORTED_MIME;
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
    recorderRef.current = recorder;

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    recorder.onstop = async () => {
      cleanup();
      if (discardRef.current) { discardRef.current = false; setState('idle'); return; }
      // Blob type must match what was recorded — the worker maps it to the
      // upstream format, and a mismatch transcribes silently to nothing (§2.2).
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size < 1024) { setState('idle'); return; }

      setState('transcribing');
      try {
        const vocabulary = await getSpeechVocabulary();
        const text = await transcribeAudio(blob, vocabulary, projectId);
        if (text) onTranscript(text);
        setState('idle');
      } catch (err: any) {
        setError(err?.message || 'Could not transcribe the audio.');
        setState('error');
      }
    };

    recorder.start();
    setState('recording');

    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      if (ms >= MAX_MS) stop();
    }, 100);
  }, [state, onTranscript, projectId, cleanup, stop]);

  /** Single entry point for both the button and the shortcut (§6.3). */
  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'error') { setError(null); setState('idle'); }
    else if (state === 'idle') start();
    // 'transcribing' → ignore; a request is already in flight.
  }, [state, start, stop]);

  return {
    state, error, elapsedMs, maxMs: MAX_MS, start, stop, cancel, toggle,
    clearError: () => { setError(null); setState('idle'); },
  };
}
```

### 5.2 New file: `runtime-react/src/services/speechVocabulary.ts`

```ts
import { getClient } from '...';   // however the page currently obtains the SDK client

let pending: Promise<string> | null = null;

/**
 * Domain terms used to bias transcription (§4). Fetched once per page load —
 * schemas don't change mid-session — over the same DATA_REQ bus as every other
 * collection call.
 */
export function getSpeechVocabulary(): Promise<string> {
  if (!pending) {
    pending = (async () => {
      try {
        const res: any = await (getClient() as any).requestData({
          collection: 'speech',
          operation: 'vocabulary',
          // ⚠ do NOT pass SA_RUNTIME
        });
        return (res?.data?.terms || []).join(', ');
      } catch {
        return '';   // transcription still works unbiased
      }
    })();
  }
  return pending;
}
```

### 5.3 Add to `runtime-react/src/services/saApi.ts`

```ts
export async function getSpeechCapabilities(): Promise<{ available: boolean }> {
  try {
    const res = await fetch(`${SA_API_BASE_URL}/speech/capabilities`, { headers: authHeaders() });
    return res.ok ? await res.json() : { available: false };
  } catch {
    return { available: false };
  }
}

export async function transcribeAudio(blob: Blob, vocabulary: string, projectId?: string): Promise<string> {
  const form = new FormData();
  // Extension is cosmetic; blob.type is what the worker maps on.
  form.append('audio', blob, 'speech');
  if (vocabulary) form.append('vocabulary', vocabulary);
  if (projectId) form.append('projectId', projectId);

  // No Content-Type header — the browser must set the multipart boundary itself.
  const res = await fetch(`${SA_API_BASE_URL}/speech/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${localStorage.getItem('sa_auth_token')}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: '' }));
    throw new Error(error || `Transcription failed (${res.status})`);
  }
  return (await res.json()).text || '';
}
```

---

## 6. Component 4 — the mic button

`ChatInputProps` **already declares `enableVoice?: boolean`** (`InputBox.tsx:19`), currently
unused. Destructure it and render the button just before the `isResponding ?` ternary (~L170).

```tsx
const { state, error, elapsedMs, maxMs, start, stop, clearError } =
  useVoiceInput((text) => onChange(value ? `${value} ${text}` : text), projectId);

const [voiceSupported, setVoiceSupported] = useState(false);
useEffect(() => {
  // navigator.mediaDevices is undefined on insecure origins; SUPPORTED_MIME is
  // null if no container this stack accepts can be recorded.
  if (!enableVoice || !navigator.mediaDevices?.getUserMedia || !SUPPORTED_MIME) return;
  getSpeechCapabilities().then((c) => setVoiceSupported(c.available));
}, [enableVoice]);
```

```tsx
{voiceSupported && !isResponding && (
  <button
    onClick={state === 'recording' ? stop : state === 'error' ? clearError : start}
    disabled={disabled || state === 'transcribing'}
    title={
      state === 'recording' ? 'Stop recording'
        : state === 'transcribing' ? 'Transcribing…'
        : error || 'Speak your question'
    }
    aria-label="Voice input"
    className={`transition-colors duration-150 rounded-full p-2 flex-shrink-0 ${isMultiline ? 'mb-1' : ''}`}
    style={{
      backgroundColor: state === 'recording' ? '#ef4444' : 'transparent',
      color: state === 'recording' ? 'white' : state === 'error' ? '#ef4444' : themeColor,
    }}
  >
    <Icon
      icon={
        state === 'recording' ? 'ph:stop-fill'
          : state === 'transcribing' ? 'ph:spinner-gap-bold'
          : state === 'error' ? 'ph:microphone-slash-fill'
          : 'ph:microphone-fill'
      }
      width={20} height={20}
      className={`sm:w-6 sm:h-6 ${state === 'transcribing' ? 'animate-spin' : ''}`}
    />
  </button>
)}
{state === 'recording' && (
  <span className="text-xs tabular-nums opacity-60 flex-shrink-0">
    {Math.ceil((maxMs - elapsedMs) / 1000)}s
  </span>
)}
```

The countdown matters — users need to know recording cuts off at 30 s.

**`ChatRuntime.tsx`:** pass `enableVoice` (unconditionally `true`) and `projectId` down. Actual
availability is decided by the worker's `/speech/capabilities`, not a per-client build flag —
`runtime-react` is shared across all clients and must not carry per-client toggles.

### 6.3 Keyboard shortcut — `Ctrl` / `Cmd` + `.` (toggle)

Press once to start recording, press again to stop and transcribe. Same `toggle()` the button
calls, so the two can never disagree about state.

> **⚠ Why not a bare `.` key.** The chat textarea **auto-focuses on mount**
> (`InputBox.tsx:78–82`), so it holds focus almost all the time. A bare `.` would either be
> swallowed by the shortcut — making it impossible to type a full stop — or, if guarded on
> focus, would essentially never fire. Neither is usable. A modifier keeps the dot key you asked
> for while leaving typing untouched.

`Ctrl+.` and `Cmd+.` are both unused today — the codebase has **no** `ctrlKey`/`metaKey`
shortcuts at all, and `Escape` is the only global key in use (`LayoutChatInput.tsx:113`,
`ChatRuntime.tsx:416`, and the modals).

Add to `InputBox.tsx`, following the existing global-listener idiom:

```tsx
// Ctrl/Cmd + . toggles voice input. Registered only while voice is actually
// usable, so it never shadows the key on deployments without a mic or key.
useEffect(() => {
  if (!voiceSupported || disabled || isResponding) return;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== '.' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.repeat) return;          // holding the key must not re-toggle
    e.preventDefault();
    toggle();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}, [voiceSupported, disabled, isResponding, toggle]);

// Esc cancels a recording and discards it — no upload, no charge. Only bound
// while recording, so it never interferes with Esc closing modals/dropdowns,
// and it cannot collide with Esc-to-abort (that binds only while responding).
useEffect(() => {
  if (state !== 'recording') return;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}, [state, cancel]);
```

**Escape-to-cancel matters specifically because this is toggle mode.** Push-to-talk ends when
you release; a toggle can be left running by accident, and without a discard path the only exit
is to stop and pay for a transcription you never wanted.

**Discoverability.** Toggle mode gives no physical feedback that recording is live, so the UI
must. The countdown in §6.1 already covers it; also surface the binding in the button tooltip:

```tsx
const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘.' : 'Ctrl+.';
// ...
title={
  state === 'recording' ? `Stop recording (${SHORTCUT}, Esc to discard)`
    : state === 'transcribing' ? 'Transcribing…'
    : error || `Speak your question (${SHORTCUT})`
}
aria-keyshortcuts="Control+. Meta+."
```

> **Deployment gotcha.** `getUserMedia` requires a secure context. A client VM serving the chat
> UI over plain HTTP on a LAN IP will never show the mic button. Verify HTTPS on each target
> before promising the feature.

---

## 7. Build order

1. `wrangler secret put OPENROUTER_API_KEY` on `sa-api`.
2. Add `speechUsage` to `packages/api/src/db/schema.ts`; apply with **`db:push`** (§3.5 warning).
3. Add the rate-limit binding to `wrangler.toml`; add the keys to `types.ts`.
4. Write `routes/speech.ts`; mount in `index.ts`. Deploy the worker.
5. **Test the route with curl before touching the frontend** (§8.1) — it is fully independent of any UI.
6. Backend: `collections/speech.ts` + register. Restart the backend.
7. Frontend: `useVoiceInput.ts`, `speechVocabulary.ts`, `saApi.ts`, `InputBox.tsx`, `ChatRuntime.tsx`.
8. `pnpm build` in `runtime-react` — it runs from the built Vite bundle, so source edits are
   invisible until rebuilt and reloaded.

No `setup.sh` change and no SDK republish. That is the point of §1.2.

---

## 8. Verification

**8.1 Worker, standalone.** With a real recording at `/tmp/q.webm`:

```bash
curl -s -X POST "$SA_API_BASE_URL/speech/transcribe" \
  -H "Authorization: Bearer $SA_AUTH_TOKEN" \
  -F "audio=@/tmp/q.webm;type=audio/webm" \
  -F "vocabulary=overstock, deadstock, branch location, transfer units" | jq .
```

Returns `{ "text": "..." }` matching what was said. No auth → 401. 21 calls in a minute → 429
on the last. A 3-byte junk file → 400, not 500.

**8.2 Cross-browser MIME.** Record in Chrome, Firefox and Safari; log `SUPPORTED_MIME` and
`blob.type` in each, and confirm all three return a transcript. This is the check that proves
the format-derivation approach — it is the one thing that cannot be verified from one browser.

**8.3 The test that decides §4.3 — vocabulary biasing.** Record one real question containing two
or three client-specific terms. Transcribe **twice**: once with `vocabulary` populated, once
empty. If the biased version is not measurably better on those terms, `provider.options.google`
is not honored — switch to the text-correction fallback in §4.3. Do this before shipping;
everything about the vocabulary pipeline hinges on it.

**8.4 Language handling (§4.4).** Three recordings: a plain English question; the same question
in Hindi (or whichever language your users actually use); and a code-switched "Hinglish"
sentence with English domain terms inside a Hindi frame — that last one is the realistic case
and the one most likely to transcribe oddly. Each must come back **in the language spoken**, not
translated and not phonetically mangled. Then send the non-English transcript through as a real
question and look at what the agent does with it — that tells you whether English-only schema
and KB content degrade retrieval enough to matter.

**8.5 Keyboard shortcut (§6.3).** `Ctrl/Cmd+.` starts, pressing again stops and transcribes.
Then the collision checks: typing a plain `.` in the textarea still inserts a full stop; holding
`Ctrl+.` down does not rapid-toggle; `Esc` while recording discards with no request fired
(watch the network tab); `Esc` with a response streaming still aborts the response, not the
mic; and the button and shortcut always agree on state after mixing the two.

**8.6 End to end.** Mic appears → click → speak → countdown → stop → spinner → text lands in
the textarea → **nothing is sent until Enter**.

**8.7 Failure paths.** Deny mic permission (clear message, no hang). Record silence (no error,
no empty send). Kill network mid-transcription (recoverable error state). Load over plain HTTP
(button hidden, not broken).

---

## 9. Security, privacy, cost

- **Audio is never persisted.** Not to R2, not to the client VM, not to logs — it exists in
  worker memory for one request. Given the ISO 27001 work in flight, keeping voice out of every
  store means it is not a new data class to account for.
- **Never log transcripts.** They are user questions. Log seconds, cost and latency (§3.5), never content.
- **The key stays in the worker** — the argument against both the Web Speech API and any
  browser-direct provider call.
- **Cost.** $0.016/min ⇒ ~$0.008 per 30 s question; 1,000 questions ≈ $8/month. The rate
  limiter bounds abuse, not normal use.
- **Sub-processor disclosure.** Audio now transits Cloudflare and OpenRouter (→ Google). If any
  client contract enumerates sub-processors, confirm all three are listed for this data class.

---

## 10. Out of scope

- **Streaming / live transcription.** Needs a bidirectional audio channel with partial results —
  a different transport that cannot ride a request/response HTTP route, plus its own abort
  plumbing like `USER_PROMPT_ABORT_REQ`. Batch-now does not block it; budget it separately.
- **Text-to-speech.**
- **Translation to English.** Explicitly dropped (§4.4) — transcripts stay in the spoken
  language. If a deployment later needs English, it is a separate text pass, not a parameter.
- **A user-facing language picker.** Detection is automatic, so there is nothing to choose.
- **Answering in the user's language.** Whether the agent should *reply* in the language it was
  asked in is a prompt/answer-pipeline question, not a voice-input one.
- **Restricting recognition to a language allow-list.** Chirp accepts a probable-language set
  (e.g. `["en-US", "hi-IN"]`) which can beat pure auto-detect, but it rides the same
  undocumented `provider.options` passthrough as §4.3. Revisit if §8.4 shows detection errors.
- **Audio longer than 30 s.** The upstream 60 s processing timeout makes long audio a chunking
  problem, which is explicitly not this project.
- **A local/SDK transcription path.** Only worth building if a client contract forbids voice
  transiting Superatom infrastructure. Keep the `speech` collection interface as-is so a local
  implementation stays a drop-in; do not build it speculatively.
