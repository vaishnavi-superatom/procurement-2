# Feedback Mechanism — Implementation Spec

**Status:** Ready to implement (design locked; §6 lists the two product decisions still open)
**Last updated:** 2026-07-28
**Audience:** the engineer implementing this. Read §1–§5 for the *why*, §6 for what's decided,
§8 for the ordered build steps + copy-paste code, §9 to verify.

Two distinct feedback features. They look similar ("a text box the user fills in") but
have different anchors, different storage, different audiences, and different transport.
Keeping them separate end-to-end is the whole point of this doc.

| | **Feedback 1 — Answer correctness** | **Feedback 2 — General product feedback** |
|---|---|---|
| Anchored to | one specific answer (`uiBlockId`) | nothing — the product as a whole |
| User provides | correct/incorrect flag **+** free text | free text (+ optional category) |
| Entry point | per-answer action in `MessageBubble` | floating button in the UI |
| Consumer | answer-quality / eval work | Superatom product backlog |
| Audience | the team improving a deployment's answers | Superatom staff, across all clients |
| Storage | **dual-write** — local Postgres (authoritative) **+** central Neon (aggregate) — see §1.2 | **central Neon** via `packages/api` |
| Transport | generic **`DATA_REQ`** collection call → local write + server-side forward to `sa-api` | HTTP POST to `sa-api` |

---

## 1. Feedback 1 — Answer-correctness feedback

### 1.1 What it is
On any completed assistant answer, the user can say **correct / incorrect** and write a
text note explaining what was wrong. This is eval signal: it must be joinable back to the
exact question, the answer, the source, and the script that produced it.

### 1.2 Storage decision — dual-write: local Postgres (authoritative) + central Neon (aggregate)

Answer feedback is written to **both** databases, each serving a different reader:

- **Local Postgres (authoritative, full context).** Lives next to `reports_conversations`
  in the deployment's own DB. Keyed on the local `ui_block_id`, joinable to that
  deployment's questions / sources / scripts. This is the copy the deployment's eval work
  reads, and the source of truth if the two ever diverge.
- **Central Neon (slim aggregate, cross-org).** A mirror row in `sa-api`, so Superatom
  staff can query **all** organizations' answer feedback in one place. Carries just enough
  to read and triage without the local joins: `org_id`, `project_id`, the question text,
  the correct/incorrect flag, the note, and a snapshot.

**Local table `answer_feedback`** — add to `scripts-flow/database/postgres/drizzle/schema.ts`
(same introspection style as `reportsConversations`; imports `serial, varchar, text, jsonb,
boolean, timestamp, index, uniqueIndex` already exist at top of file):

```ts
export const answerFeedback = pgTable("answer_feedback", {
	id: serial().primaryKey().notNull(),
	uiBlockId: varchar("ui_block_id", { length: 255 }).notNull(),
	threadId: varchar("thread_id", { length: 255 }),
	userId: varchar("user_id", { length: 255 }),
	userPrompt: text("user_prompt").notNull(),          // the question (denormalized)
	answerSnapshot: jsonb("answer_snapshot"),            // responseData.text / DSL (denormalized)
	isCorrect: boolean("is_correct").notNull(),
	feedbackText: text("feedback_text"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	// upsert key — flipping correct↔incorrect updates the same row (see §1.4)
	uniqueIndex("idx_answer_feedback_user_uiblock").using("btree", table.userId.asc().nullsLast(), table.uiBlockId.asc().nullsLast()),
	index("idx_answer_feedback_ui_block_id").using("btree", table.uiBlockId.asc().nullsLast()),
	index("idx_answer_feedback_user_id").using("btree", table.userId.asc().nullsLast()),
	index("idx_answer_feedback_created_at").using("btree", table.createdAt.asc().nullsLast()),
]);
```

**Central table `answer_feedback`** — add to `packages/api/src/db/schema.ts` (uuid style like
`chatAnalytics`; `uuid, varchar, text, jsonb, boolean, timestamp, index` all already
imported). Identity columns are plain `varchar` (no FK) so a missing mapping never fails the
insert — but populate them with the **central** ids per §1.6. Apply with `db:push` (§2.2):

```ts
export const answerFeedback = pgTable("answer_feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: varchar("org_id", { length: 255 }),          // central org id (from analytics identity)
  projectId: varchar("project_id", { length: 255 }),
  userId: varchar("user_id", { length: 255 }),
  uiBlockId: varchar("ui_block_id", { length: 255 }), // correlates to the local row
  userPrompt: text("user_prompt").notNull(),
  isCorrect: boolean("is_correct").notNull(),
  feedbackText: text("feedback_text"),
  answerSnapshot: jsonb("answer_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("answer_feedback_org_id_idx").on(table.orgId),
  index("answer_feedback_ui_block_id_idx").on(table.uiBlockId),
  index("answer_feedback_created_at_idx").on(table.createdAt),
]);
```

> **Denormalize the answer in both copies.** Store the question text **and** an answer
> snapshot (`responseData.text` / DSL), not just `ui_block_id`. Answers are
> cache-regenerated and expire — a "this was wrong" report with only an id is unreadable
> weeks later. This is the single most important storage decision in Feedback 1.

> **Authority + failure model.** The **local** write is authoritative and happens first;
> the central mirror is **best-effort** and must never block or fail the user's submit
> (try/catch + warn, exactly like `reports_conversations` persistence). If the central
> forward fails, the local row still stands and can be back-filled later. Never make the
> user's feedback depend on Neon being reachable.

### 1.3 Identity available at render time (`MessageBubble.tsx`)
All in scope where the toolbar renders:
- `message.uiBlockId` — durable per-answer id, survives the round trip (also keys
  `activeRequests`, logs, bookmarks). **The row key.**
- `message.responseData.question` — the originating prompt.
- `message.responseData.text` / DSL — the answer to snapshot.
- `uiStore.userId`, `threadId`.

### 1.4 UI
- Add a **"Feedback on this answer"** action to the existing hover toolbar in
  `runtime-react/src/components/chat/MessageBubble.tsx` (~L651–700, beside bookmark /
  clear-cache; already gated on `message.responseData`). Text-only answers get the same
  action beside their clear-cache button (~L524–547).
- Clicking opens a **shared text-feedback modal** (new, patterned on `BookmarkModal.tsx`):
  a correct/incorrect toggle + a textarea + submit + success state.
- After submit, reflect state on the message (in `MessageStore`) so the control shows
  "submitted" and doesn't re-submit. Consider an upsert keyed on `(user_id, ui_block_id)`
  so flipping correct↔incorrect updates rather than duplicates.

### 1.5 Transport — generic `DATA_REQ` collection call, server-side fan-out

**No new SDK message type is needed.** The SDK already has a generic collection dispatcher,
`DATA_REQ` (`sdk-nodejs/src/handlers/data-request.ts`): it takes `{ collection, op, params }`
and calls `collections[collection][op](params)` for any collection registered via
`sdk.addCollection(...)`. The web client exposes it as
`client.requestData({ collection, operation, params })`. `BOOKMARKS` has its own message
type only for legacy reasons — the modern path (`reports-conversations`, `dashboards`, …) is
`DATA_REQ`, and that is what we use here.

```
MessageBubble → feedback modal
      │  client.requestData({ collection: 'answer-feedback', operation: 'create',
      │                       params: { uiBlockId, threadId, userId, userPrompt,
      │                                 answerSnapshot, isCorrect, feedbackText } })
      │  ⚠ do NOT pass SA_RUNTIME (see gotcha below)
      ▼
DATA_REQ handler → collections['answer-feedback']['create'](params)   ── the create fn ──┐
      │                                                                                  │
      ├─(1) write LOCAL answer_feedback   ◄── authoritative, must succeed (return this)
      │
      └─(2) best-effort forward to sa-api  ── POST /answer-feedback
                 header X-SA-Service-Token: SA_INTERNAL_SERVICE_TOKEN
                 body { orgId, projectId, userId, uiBlockId, userPrompt,
                        isCorrect, feedbackText, answerSnapshot }
                          │  try/catch — warn only, never throw
                          ▼
                 sa-api writes CENTRAL answer_feedback (Neon)
```

- **(1)** is the registered `answer-feedback` `create` collection
  (`backend/src/collections/answer-feedback.ts` → `sdk.addCollection`, data-access file
  next to `reports-conversations.ts`). Its return value is what the frontend receives.
- **(2)** happens **inside** the same `create` function, after the local insert succeeds.
  Server-to-server, authenticated with `SA_INTERNAL_SERVICE_TOKEN` via `X-SA-Service-Token`
  — the same trusted-machine pattern `source-upload` uses. Wrapped in try/catch that only
  warns; a Neon outage never affects the local write or the user. `orgId` / `projectId` /
  `userId` are the **central** identity values the backend already resolves for
  `chat_analytics` ingest — reuse that resolution (see §1.6), do not trust browser-sent ids.

> **⚠ Gotcha — omit `SA_RUNTIME`.** The `DATA_REQ` handler, if the payload carries
> `SA_RUNTIME.uiBlockId`, treats the collection result as component data and tries to update
> that UIBlock (re-render the answer bubble). For a feedback `create`, send **only**
> `params` — no `SA_RUNTIME` — or it will try to render the insert result into the chat.

An `sa-api` endpoint is needed for (2): `POST /answer-feedback` (new router, or fold into
the existing analytics router), gated by the service token, insert-and-return.

### 1.6 Central identity (important)

The central `answer_feedback` row must carry the **same** central identity values that
`chat_analytics` rows already use, so staff can group feedback by org across all clients.
`chat_analytics` is written server-side by the backend with central `orgId` / `userId` /
`projectId` — find where that analytics event is emitted and **reuse the same identity
resolution** for the answer-feedback forward. Do not send the browser's local ids as if they
were central ids. Central columns are stored as plain `varchar` (no FK) to keep inserts
robust even if a mapping is momentarily missing — see the schema in §1.2.

---

## 2. Feedback 2 — General product feedback

### 2.1 What it is
A user, from anywhere in the product, opens a floating **Feedback** button and writes a
note about the product (not any single answer). Audience: Superatom staff, aggregated
across every client deployment.

### 2.2 Storage decision — central Neon via `packages/api`

`sa-api` (`~/superatom/do-websocket/packages/api/`, Hono on Cloudflare Workers, Neon +
Drizzle) already holds `organizations` / `users` / `projects` across all deployments. That
is the only DB spanning all clients and the natural home for a cross-client backlog.
**Do not** store this in per-client local Postgres — it would scatter Superatom's own
backlog across customer infrastructure and force a per-VM fan-out to read it.

**New table `product_feedback`** in `packages/api/src/db/schema.ts`. Identity is plain
`varchar` here (not uuid FK) because this is submitted from the **browser**, which may not
hold central uuids — store whatever id the runtime has:

```ts
export const productFeedback = pgTable("product_feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: varchar("org_id", { length: 255 }),          // whatever org id the runtime has
  userId: varchar("user_id", { length: 255 }),
  category: varchar("category", { length: 50 }),      // 'bug' | 'idea' | 'other' (optional)
  message: text("message").notNull(),
  pageContext: varchar("page_context", { length: 255 }), // route/screen at submit time
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("product_feedback_org_id_idx").on(table.orgId),
  index("product_feedback_category_idx").on(table.category),
  index("product_feedback_created_at_idx").on(table.createdAt),
]);
```

> **Note the shape differs from `answer_feedback`** (`message`/`category`/`page_context`, and
> **no** `ui_block_id`/`user_prompt`/`is_correct`/`answer_snapshot`). That divergence is why
> these are two separate tables, not one — see §5.

> **Apply with `db:push`, not `db:migrate`.** In this repo the drizzle migration journal is
> **not** the source of truth — `schema.ts` + `drizzle-kit push` is (see the header comment
> in `drizzle/0008_api_keys_active_unique.sql`). Add the table to `schema.ts`, declare
> relations, run `db:push`.

### 2.3 API surface
New Hono sub-router `packages/api/src/routes/feedback.ts`, mounted in `src/index.ts` via
`app.route("/feedback", feedbackRoutes)` **before** the `/` catch-all routers (Hono matches
in registration order). Mirror `users.ts` insert/select `.returning()` shape.

- `POST /feedback` — create. Auth: see §2.4.
- `GET /feedback` — list for staff, gated `authMiddleware, superAdminOnly` (the same gate
  as the existing cross-org `GET /orgs`).

### 2.4 Fork A — auth on submit

The chat runtime (`runtime-react`) authenticates to the **local** deployment over
WebSocket; it does **not** carry an `sa-api` JWT. Options:

- **Follow the analytics precedent (recommended for the chat runtime):** `PATCH
  /analytics/chat/:id/feedback` already accepts unauthenticated frontend calls with ids in
  the payload. `POST /feedback` does the same — no JWT; `org_id` / `user_id` sent in the
  body from what the runtime already knows.
- **Portal case:** if the button lives in `sa-platform-ui`, the user *has* a JWT — require
  `authMiddleware` on POST and derive `user_id` / `org_id` from the token instead of
  trusting the body.
- **Stricter server-to-server:** proxy through the local backend using
  `SA_INTERNAL_SERVICE_TOKEN` (`X-SA-Service-Token`). More plumbing than a low-stakes
  feedback stream warrants.

### 2.5 Fork B — which UI hosts the floating button
- **Chat runtime (`runtime-react`)** → unauthed POST per §2.4 option 1.
- **Portal (`sa-platform-ui`)** → authed POST; add `submitFeedback()` to
  `src/services/saApi.ts` (JWT already attached there).

*Default set in §6.4 (chat runtime, unauthed) so the build isn't blocked — override there.*

---

## 3. How Superatom staff view general feedback

**Finding:** there is no internal cross-org staff console today. `sa-platform-ui` is
org-scoped (an org admin sees only their own org); the one `super_admin` cross-org endpoint
(`GET /orgs`) has no UI consumer, and the analytics page there renders `Math.random()`
dummy data. Whatever we pick is the first staff-facing central view. Ship cheapest first:

1. **Now (zero-build): Slack/email on submit.** The `POST /feedback` handler also fires a
   webhook to a team channel. For a low-volume stream this is the best starting point —
   every note is seen instantly, nothing to maintain. `db:studio` covers ad-hoc browsing.
2. **Soon: a `superAdminOnly` list.** `GET /feedback` + a "Feedback" page in
   `sa-platform-ui` visible only to `super_admin`, reusing the `saApi.ts` client pattern.
   This becomes the first real internal console.
3. **Later: triage** — filters by org / category / date once volume justifies it.

Recommendation: **endpoint + Slack notification first**; add the `superAdminOnly` page when
you want to browse history instead of react to it.

---

## 4. Shared scaffolding (build once)

- **One reusable text-feedback modal** in `runtime-react` (title, optional correct/incorrect
  toggle, textarea, submit, success). Feedback 1 mounts it from the bubble toolbar;
  Feedback 2's floating button mounts it from the app chrome.
- **One `wsMessages`/service wrapper** per destination: `submitAnswerFeedback(...)` (wraps
  `client.requestData({ collection: 'answer-feedback', operation: 'create', params })`) and
  `submitProductFeedback(...)` (HTTP `fetch` → `sa-api`).
- **Wire question — RESOLVED.** No new SDK message type is required. `DATA_REQ` is the
  generic collection dispatcher and `client.requestData(...)` already exists (§1.5). A
  registered `sdk.addCollection('answer-feedback', 'create', …)` on the backend is reachable
  immediately. `BOOKMARKS` has a dedicated type only for legacy reasons; do not copy that.

---

## 5. Why two tables, not one

Tempting to make one `feedback` table with a nullable `ui_block_id`. Don't. The two have
different lifecycles and different readers: answer feedback feeds answer-quality/eval work
(join to question / source / script); product feedback feeds a product backlog (triage by
category / page). Different columns, different queries, different people. One half-null
table muddies both; two small tables cost almost nothing.

---

## 6. Decisions

**Resolved**
1. ~~Feedback 1 storage~~ → **dual-write**: local Postgres authoritative + central Neon
   aggregate mirror (§1.2).
2. ~~Feedback 1 transport~~ → **single client submit → local collection write → best-effort
   server-side forward to `sa-api`** with `SA_INTERNAL_SERVICE_TOKEN` (§1.5).

3. ~~Feedback 1 transport / SDK wiring~~ → **`DATA_REQ` generic collection call**; no new SDK
   message type (§1.5, §4).

**Open — product calls for Ashish (defaults set so the build isn't blocked; change here if you disagree)**
4. **Feedback 2 host UI** *(default: chat runtime `runtime-react` floating button, unauthed
   POST)* — that's where end-users are. Portal (`sa-platform-ui`, authed, cleaner identity)
   is the alternative (§2.4/§2.5). Affects only Feedback 2's UI + auth, nothing in Feedback 1.
5. **Feedback 2 staff view** *(default: Slack webhook on submit + `db:studio` for browsing;
   build `GET /feedback` now, the UI page later)* — §3.
6. **Answer-feedback cross-org view** *(default: ad-hoc `db:studio` / SQL to start)* — promote
   to a `superAdminOnly` page alongside Feedback 2's when one exists.

---

## 7. File touch-points (reference)

**Feedback 1 — Answer feedback (dual-write).** No SDK-node/SDK-web changes — uses `DATA_REQ`.

*Local write (scripts-flow):*
- `database/postgres/drizzle/schema.ts` — add `answerFeedback` table (§1.2)
- `database/postgres/src/project-data-db/answer-feedback.ts` — data-access `createAnswerFeedback` / `queryAnswerFeedback` (mirror `reports-conversations.ts`)
- `backend/src/collections/answer-feedback.ts` — `sdk.addCollection('answer-feedback', 'create'|'query', …)` (mirror `reports-conversations.ts` registrar); the `create` fn does the local insert **then** the §1.6 central forward
- `backend/src/collections/index.ts` — import + `await registerAnswerFeedbackCollections(ctx)`

*Central write (do-websocket/packages/api → Neon):*
- `packages/api/src/db/schema.ts` — add central `answerFeedback` table (§1.2), then `db:push`
- `packages/api/src/routes/answer-feedback.ts` — `POST /answer-feedback`, gated by `SA_INTERNAL_SERVICE_TOKEN` (`X-SA-Service-Token`), insert-and-return (or fold into `analytics.ts`)
- `packages/api/src/index.ts` — `app.route("/answer-feedback", …)` before the `/` catch-all

*UI (runtime-react):*
- `src/components/chat/MessageBubble.tsx` — toolbar action (~L651–700 for component answers, ~L524–547 for text-only)
- `src/components/chat/*` — shared feedback modal (correct/incorrect toggle + textarea; pattern: `BookmarkModal.tsx`)
- `src/services/wsMessages/feedback.ts` (new) — `submitAnswerFeedback(...)` → `client.requestData({ collection:'answer-feedback', operation:'create', params })` **(no `SA_RUNTIME`)**; export from `wsMessages/index.ts`
- `src/stores/MessageStore.ts` — reflect submitted state so the control shows "submitted"

**Feedback 2 — Product feedback (central only).**
- `packages/api/src/db/schema.ts` — add `productFeedback` table (§2.2), then `db:push`
- `packages/api/src/routes/feedback.ts` (new) — `POST /feedback` (submit) + `GET /feedback` (`authMiddleware, superAdminOnly`); mirror `users.ts` insert/select `.returning()`
- `packages/api/src/index.ts` — `app.route("/feedback", …)` before the `/` catch-all
- host UI (per §2.5 decision) — floating button + shared modal → `fetch` POST to `sa-api /feedback`

---

## 8. Build order (do in this sequence)

Build **Feedback 1** back-to-front so each layer is testable before the next. Then Feedback 2.

### Feedback 1 — Answer feedback

**Step 1 — Local table.** Add the `answerFeedback` table (§1.2) to
`database/postgres/drizzle/schema.ts`. Generate/apply the migration the way this repo already
does for its local Postgres (follow how an existing table like `reports_conversations` was
migrated — check `database/postgres/drizzle/` for the migration command in use).

**Step 2 — Local data-access.** New file
`database/postgres/src/project-data-db/answer-feedback.ts` (mirror `reports-conversations.ts`):

```ts
import { db, schema } from "./drizzle-db";
import { and, desc, eq, SQL } from "drizzle-orm";

const { answerFeedback } = schema;

export interface CreateAnswerFeedbackParams {
  uiBlockId: string;
  threadId?: string;
  userId?: string;
  userPrompt: string;
  answerSnapshot?: unknown;
  isCorrect: boolean;
  feedbackText?: string;
}

export async function createAnswerFeedback(params: CreateAnswerFeedbackParams) {
  const { uiBlockId, threadId, userId, userPrompt, answerSnapshot, isCorrect, feedbackText } = params;
  if (!uiBlockId) throw new Error("uiBlockId is required");
  if (typeof isCorrect !== "boolean") throw new Error("isCorrect is required");

  // upsert on (user_id, ui_block_id) so re-submitting flips the flag/text
  const result = await db
    .insert(answerFeedback)
    .values({ uiBlockId, threadId: threadId || null, userId: userId || null,
              userPrompt, answerSnapshot: answerSnapshot ?? null, isCorrect,
              feedbackText: feedbackText || null })
    .onConflictDoUpdate({
      target: [answerFeedback.userId, answerFeedback.uiBlockId],
      set: { isCorrect, feedbackText: feedbackText || null },
    })
    .returning();

  return { success: true, data: result[0] };
}

export async function queryAnswerFeedback(params: { filters?: { userId?: string; uiBlockId?: string }, limit?: number }) {
  const { filters = {}, limit = 50 } = params;
  const conditions: SQL[] = [];
  if (filters.userId) conditions.push(eq(answerFeedback.userId, filters.userId));
  if (filters.uiBlockId) conditions.push(eq(answerFeedback.uiBlockId, filters.uiBlockId));
  let q = db.select().from(answerFeedback);
  if (conditions.length) q = q.where(and(...conditions)) as typeof q;
  const result = await q.orderBy(desc(answerFeedback.createdAt)).limit(limit);
  return { success: true, data: result, count: result.length };
}
```

**Step 3 — Central table + route (packages/api).** Add the central `answerFeedback` table
(§1.2) to `packages/api/src/db/schema.ts`, run `db:push`. Add
`packages/api/src/routes/answer-feedback.ts`: a Hono router whose `POST /` checks
`c.req.header("X-SA-Service-Token") === c.env.SA_INTERNAL_SERVICE_TOKEN` (else 401), then
`db.insert(answerFeedback).values({...}).returning()`. Mount it in `src/index.ts` with
`app.route("/answer-feedback", answerFeedbackRoutes)` **before** the `/` catch-all routers.

**Step 4 — Backend collection + central forward.** New file
`backend/src/collections/answer-feedback.ts` (mirror `reports-conversations.ts` registrar).
The `create` fn does the local insert, then best-effort forwards to `sa-api`:

```ts
import * as answerFeedbackService from '../../../database/postgres/src/project-data-db/answer-feedback';
import type { CollectionContext } from './types';

export async function registerAnswerFeedbackCollections({ sdk }: CollectionContext): Promise<void> {
  sdk.addCollection('answer-feedback', 'create', async (params: answerFeedbackService.CreateAnswerFeedbackParams) => {
    // (1) authoritative local write
    const local = await answerFeedbackService.createAnswerFeedback(params);

    // (2) best-effort central mirror — never throws to the caller
    try {
      // resolve CENTRAL org/user/project ids the same way chat_analytics ingest does (§1.6)
      const identity = resolveCentralIdentity(params); // { orgId, projectId, userId }
      await fetch(`${process.env.SA_API_BASE_URL}/answer-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SA-Service-Token': process.env.SA_INTERNAL_SERVICE_TOKEN! },
        body: JSON.stringify({ ...identity, uiBlockId: params.uiBlockId, userPrompt: params.userPrompt,
                               isCorrect: params.isCorrect, feedbackText: params.feedbackText,
                               answerSnapshot: params.answerSnapshot }),
      });
    } catch (e) { console.warn('[answer-feedback] central forward failed (local row stands):', e); }

    return local;
  });

  sdk.addCollection('answer-feedback', 'query', async (params: any) =>
    answerFeedbackService.queryAnswerFeedback(params));
}
```
Then register it in `backend/src/collections/index.ts` (import + `await registerAnswerFeedbackCollections(ctx)`).
Confirm `SA_API_BASE_URL` + `SA_INTERNAL_SERVICE_TOKEN` are in the backend env (reuse whatever
the existing chat_analytics forward uses — `resolveCentralIdentity` should call the same code).

**Step 5 — Frontend wrapper.** New `runtime-react/src/services/wsMessages/feedback.ts`:

```ts
import { client } from '@/main';

export async function submitAnswerFeedback(p: {
  uiBlockId: string; threadId?: string; userId?: string;
  userPrompt: string; answerSnapshot?: unknown; isCorrect: boolean; feedbackText?: string;
}) {
  // NB: no SA_RUNTIME — see §1.5 gotcha
  return client.requestData({ collection: 'answer-feedback', operation: 'create', params: p });
}
```
Export it from `wsMessages/index.ts`.

**Step 6 — UI.** Shared feedback modal (correct/incorrect toggle + textarea + submit/success,
pattern `BookmarkModal.tsx`); toolbar action in `MessageBubble.tsx` (§1.4) that opens it with
`uiBlockId` / `responseData.question` / `responseData.text` / `userId` / `threadId` in scope;
on success mark the message submitted in `MessageStore`.

### Feedback 2 — Product feedback
**Step 7** — `productFeedback` table (§2.2) in `packages/api/src/db/schema.ts` → `db:push`.
**Step 8** — `packages/api/src/routes/feedback.ts`: `POST /` (auth per §2.4 decision) +
`GET /` (`authMiddleware, superAdminOnly`); mount before catch-all. Optionally fire a Slack
webhook inside `POST /` (§3).
**Step 9** — floating button + shared modal in the host UI (§2.5 decision) → `fetch` POST.

---

## 9. Verification

- **Local write:** submit feedback in chat → row appears in local `answer_feedback`; re-submit
  with the opposite flag → **same** row updates (no duplicate), proving the upsert key.
- **No render side-effect:** submitting does **not** re-render/replace the answer bubble
  (proves `SA_RUNTIME` was omitted, §1.5 gotcha).
- **Central mirror:** a matching row lands in Neon `answer_feedback` with the **central**
  org/user ids (not local ids) — compare against a `chat_analytics` row for the same user.
- **Failure isolation:** stop `sa-api` (or blank `SA_API_BASE_URL`) → local write still
  succeeds and the user sees success; backend logs the warn. Nothing throws to the UI.
- **Product feedback:** submit from the floating button → row in Neon `product_feedback`;
  `GET /feedback` returns it only for a `super_admin` token, 403 otherwise.
