import { pgTable, index, uniqueIndex, serial, bigserial, bigint, jsonb, timestamp, varchar, foreignKey, text, integer, boolean, doublePrecision, customType, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// Feedback status enum - supports 3 states
export const feedbackStatus = pgEnum('feedback_status', ['correct', 'incorrect', 'partial'])

/**
 * Where a concept sits in review. See `concepts.status`.
 *
 * Ordered as a concept moves through it, which is also the order a reviewer
 * reads them in — not alphabetically.
 */
export const conceptStatus = pgEnum('concept_status', [
	'draft',
	'proposed',
	'approved',
	'rejected',
	'superseded',
])

export const bookmarks = pgTable("bookmarks", {
	id: serial().primaryKey().notNull(),
	userId: varchar("user_id", { length: 255 }).notNull(),
	threadId: varchar("thread_id", { length: 255 }),
	name: varchar({ length: 255 }),
	description: text(),
	uiblock: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_bookmarks_uiblock").using("gin", table.uiblock.asc().nullsLast().op("jsonb_ops")),
	index("idx_bookmarks_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_bookmarks_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("idx_bookmarks_thread_id").using("btree", table.threadId.asc().nullsLast().op("text_ops")),
]);

export const answerFeedback = pgTable("answer_feedback", {
	id: serial().primaryKey().notNull(),
	uiBlockId: varchar("ui_block_id", { length: 255 }).notNull(),
	threadId: varchar("thread_id", { length: 255 }),
	userId: varchar("user_id", { length: 255 }),
	userPrompt: text("user_prompt").notNull(),
	answerSnapshot: jsonb("answer_snapshot"),
	status: feedbackStatus("status"),
	feedbackText: text("feedback_text"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	uniqueIndex("idx_answer_feedback_user_uiblock").using("btree", table.userId.asc().nullsLast(), table.uiBlockId.asc().nullsLast()),
	index("idx_answer_feedback_ui_block_id").using("btree", table.uiBlockId.asc().nullsLast()),
	index("idx_answer_feedback_user_id").using("btree", table.userId.asc().nullsLast()),
	index("idx_answer_feedback_status").using("btree", table.status.asc().nullsLast()),
	index("idx_answer_feedback_created_at").using("btree", table.createdAt.asc().nullsLast()),


]);

export const kbNodes = pgTable("kb_nodes", {
	id: serial().primaryKey().notNull(),
	title: varchar({ length: 500 }).notNull(),
	content: text().notNull(),
	category: varchar({ length: 200 }),
	tags: text().array(),
	type: varchar({ length: 50 }).default('query'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	createdBy: varchar("created_by", { length: 255 }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedBy: varchar("updated_by", { length: 255 }),
}, (table) => [
	index("idx_kb_nodes_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("idx_kb_nodes_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("idx_kb_nodes_content_fts").using("gin", sql`to_tsvector('english'::regconfig, content)`),
	index("idx_kb_nodes_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_kb_nodes_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
	index("idx_kb_nodes_tags").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("idx_kb_nodes_title").using("btree", table.title.asc().nullsLast().op("text_ops")),
	index("idx_kb_nodes_title_fts").using("gin", sql`to_tsvector('english'::regconfig, (title)::text)`),
	index("idx_kb_nodes_updated_by").using("btree", table.updatedBy.asc().nullsLast().op("text_ops")),
]);

export const userConversations = pgTable("user_conversations", {
	id: serial().primaryKey().notNull(),
	userId: varchar("user_id", { length: 255 }).notNull(),
	threadid: varchar({ length: 255 }),
	userprompt: text().notNull(),
	// { id, component, analysis, user_prompt, errorMessage } — renamed from
	// `uiblock` for consistency with dashboard_agent_conversations/
	// reports_conversations, which both already call this column `response`.
	response: jsonb().notNull(),
	// 'success' | 'error' | 'aborted' — defaults to 'success' since every row
	// saved before this column existed was, by construction, a successful turn
	// (failed/aborted turns were previously never saved at all).
	status: varchar({ length: 20 }).default('success').notNull(),
	// The chat agent (sa-api app id) the question was asked to. Null on rows
	// saved before agents were recorded.
	agentId: varchar("agent_id", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_user_conversations_user_id").using("btree", table.userId.asc().nullsLast()),
	index("idx_user_conversations_thread_id").using("btree", table.threadid.asc().nullsLast()),
	index("idx_user_conversations_created_at").using("btree", table.createdAt.asc().nullsLast()),
	// Powers conversation search — prompt only, deliberately not the AI's
	// answer text. Postgres's text search parser corrupts tokenization of
	// everything after a 4-byte UTF-8 character (emoji), which AI-generated
	// answers are full of (📝, ✅, etc. used for formatting) — that silently
	// broke search on real content. Prompts are short, user-typed text that
	// essentially never contains emoji, so searching only this column sidesteps
	// the bug entirely instead of working around it.
	index("idx_user_conversations_user_prompt_fts").using("gin", sql`to_tsvector('simple'::regconfig, userprompt)`),
	index("idx_user_conversations_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	// Created by migration 0016 but never declared here, so generate kept
	// proposing to drop it. Backs the "which turns used this recipe" lookup.
	index("idx_user_conversations_script_recipe").using("btree", sql`((response -> 'scriptBinding' ->> 'recipeId'))`),
]);

// One row per conversation thread (a client-minted id grouping the Q&A rows in
// user_conversations via its `threadid` column). Kept in sync on every write
// (see createConversation/deleteThread/delete* in project-data-db/user-conversations.ts)
// so the sidebar's thread list is an indexed lookup instead of a GROUP BY scan
// over the entire user_conversations table. `id` is a plain string (nanoid
// going forward, legacy short ids for threads backfilled from existing data)
// rather than Postgres's strict `uuid` type, so both formats coexist safely.
export const threads = pgTable("threads", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 255 }).notNull(),
	title: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	// Schema-only for now — no query/UI reads or writes this yet; reserved for
	// a future archive-thread feature.
	archived: boolean().default(false).notNull(),
	// What the thread was started on, when that was not the chat page:
	// `{ dashboardId }` for a thread begun by asking about a dashboard. Written
	// once from the first question (setThreadConfig) and read back so the UI
	// reopens the thread where it belongs. Null for an ordinary chat thread,
	// which is most of them.
	config: jsonb(),
	// The chat agent (sa-api app id) the thread belongs to. Set by its first
	// question, never changed after. Null on threads started before agents
	// were recorded — those don't show under any agent.
	agentId: varchar("agent_id", { length: 255 }),
	// Files attached to the thread's questions, in the order they came —
	// [{ key, fileName, size, contentType }], `key` being the R2 object. Each
	// question can add more, up to a per-thread limit. Null until the first one.
	attachments: jsonb(),
}, (table) => [
	index("idx_threads_user_id").using("btree", table.userId.asc().nullsLast()),
	index("idx_threads_user_updated_at").using("btree", table.userId.asc().nullsLast(), table.updatedAt.desc().nullsLast()),
	// The sidebar's per-agent thread list.
	index("idx_threads_user_agent_updated_at").using("btree", table.userId.asc().nullsLast(), table.agentId.asc().nullsLast(), table.updatedAt.desc().nullsLast()),
	// Title defaults to the thread's opening prompt but can diverge via rename
	// (see updateThreadTitle) — search needs to match on it directly, since a
	// custom title otherwise has no other searchable text tying it back.
	index("idx_threads_title_fts").using("gin", sql`to_tsvector('simple'::regconfig, title)`),
]);

// One row per chat_agent conversation turn's retrieval/generation trace — captured
// alongside user_conversations.create so the team can debug why a specific answer
// came out the way it did (which schema/KB nodes were retrieved, what script ran)
// without digging through logs. Deliberately a separate table, not a column on
// user_conversations: conversation rows are user-deletable (delete/deleteByUiBlockId/
// deleteByUserPrompt/deleteThread), and a trace should survive even if the
// conversation it describes is later deleted — often exactly the conversations
// someone was unhappy enough with to delete. `conversationId` is therefore a soft
// pointer (no FK, no cascade), same convention as chat_analytics.conversationId in
// the central sa-api service.
export const conversationTraces = pgTable("conversation_traces", {
	id: serial().primaryKey().notNull(),
	conversationId: integer("conversation_id").notNull(),
	// conversationId is only unique WITHIN its own source table
	// (user_conversations / dashboard_agent_conversations / reports_conversations
	// each have their own independent id sequence) — so a chat conversation #50
	// and a dashboard conversation #50 can both exist and both have a trace row
	// here. `type` disambiguates which source table conversationId refers to;
	// lookups must always filter on (conversationId, type) together, never
	// conversationId alone. Same values as chat_analytics.type / sdk-nodejs's
	// AnalyticsEventType: 'chat_agent' | 'dashboard' | 'report'. Defaulted to
	// 'chat_agent' for rows written before this column existed — chat was the
	// only flow that ever wrote a trace before dashboard/report trace capture
	// was added, so that backfill is actually correct, not just a placeholder.
	type: varchar({ length: 20 }).notNull().default('chat_agent'),
	userId: varchar("user_id", { length: 255 }).notNull(),
	threadId: varchar("thread_id", { length: 255 }),
	// { version, kbNodes: {global,query}, script: {reused,recipeId,body,reasoning},
	//   scriptMatcher: {sent,received}, mainAgent/mainAgentEdit: {sent,toolCalls,
	//   iterations,received}, sourceAgent: [{sent,toolCalls,iterations,received}],
	//   componentReauthor: {sent,attempts,received} } — see RunTrace in
	// sdk-nodejs's src/userResponse/agents/types.ts for the full shape.
	trace: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_conversation_traces_conversation_id").using("btree", table.conversationId.asc().nullsLast()),
	// The actual lookup pattern getConversationTrace uses — conversationId AND
	// type together, not conversationId alone.
	index("idx_conversation_traces_conversation_id_type").using("btree", table.conversationId.asc().nullsLast(), table.type.asc().nullsLast()),
	index("idx_conversation_traces_user_id").using("btree", table.userId.asc().nullsLast()),
	index("idx_conversation_traces_created_at").using("btree", table.createdAt.asc().nullsLast()),
]);

export const dashboardAgentConversations = pgTable("dashboard_agent_conversations", {
	id: serial().primaryKey().notNull(),
	dashboardId: varchar("dashboard_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }),
	userId: varchar("user_id", { length: 255 }),
	userPrompt: text("user_prompt").notNull(),
	// { response_text: string, dsl: <whatever pi wrote to the draft — the full
	// {mode,dsl}/{mode,widgets} shape> } — was a plain text column; widened to
	// jsonb so the actual dashboard DSL travels with the narration text instead
	// of only the text summary.
	response: jsonb("response").notNull(),
	// 'success' | 'error' | 'aborted' — see user_conversations.status comment.
	status: varchar({ length: 20 }).default('success').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_dashboard_agent_conversations_dashboard_id").using("btree", table.dashboardId.asc().nullsLast().op("text_ops")),
	index("idx_dashboard_agent_conversations_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_dashboard_agent_conversations_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("idx_dashboard_agent_conversations_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_dashboard_agent_conversations_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

// One row per successful report-generation run (the user's prompt and a
// summary of the components generated) — same shape and convention as
// dashboard_agent_conversations above. Reports previously had only an
// in-memory, 30-minute-TTL history (dashboardConversationHistory in
// sdk-nodejs) with nothing persisted; this gives them a durable record too.
export const reportsConversations = pgTable("reports_conversations", {
	id: serial().primaryKey().notNull(),
	reportId: varchar("report_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }),
	userId: varchar("user_id", { length: 255 }),
	userPrompt: text("user_prompt").notNull(),
	// { response_text: string, dsl: <llmResponse.data — the components/report
	// content that was generated> } — same jsonb shape as
	// dashboard_agent_conversations.response above.
	response: jsonb("response").notNull(),
	// 'success' | 'error' | 'aborted' — see user_conversations.status comment.
	status: varchar({ length: 20 }).default('success').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_reports_conversations_report_id").using("btree", table.reportId.asc().nullsLast().op("text_ops")),
	index("idx_reports_conversations_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_reports_conversations_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("idx_reports_conversations_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_reports_conversations_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const dashboards = pgTable("dashboards", {
	id: serial().primaryKey().notNull(),
	dashboardId: varchar("dashboard_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }).notNull(),
	name: varchar({ length: 255 }),
	description: text(),
	dashboard: jsonb(),
	published: boolean().default(false),
	allowedUsers: jsonb("allowed_users").$type<string[]>().default([]),
	createdBy: varchar("created_by", { length: 255 }),
	updatedBy: varchar("updated_by", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_dashboards_dashboard_id").using("btree", table.dashboardId.asc().nullsLast().op("text_ops")),
	index("idx_dashboards_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_dashboards_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_dashboards_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
	index("idx_dashboards_updated_by").using("btree", table.updatedBy.asc().nullsLast().op("text_ops")),
	index("idx_dashboards_allowed_users").using("gin", table.allowedUsers.asc().nullsLast().op("jsonb_ops")),
]);

export const reports = pgTable("reports", {
	id: serial().primaryKey().notNull(),
	reportId: varchar("report_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }).notNull(),
	name: varchar({ length: 255 }),
	description: text(),
	report: jsonb(),
	published: boolean().default(false),
	scheduleConfig: jsonb("schedule_config"),
	lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true, mode: 'string' }),
	createdBy: varchar("created_by", { length: 255 }),
	updatedBy: varchar("updated_by", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_reports_report_id").using("btree", table.reportId.asc().nullsLast().op("text_ops")),
	index("idx_reports_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_reports_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_reports_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
	index("idx_reports_updated_by").using("btree", table.updatedBy.asc().nullsLast().op("text_ops")),
]);

export const uis = pgTable("uis", {
	id: serial().primaryKey().notNull(),
	uiId: varchar("ui_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }).notNull(),
	name: varchar({ length: 255 }),
	description: text(),
	ui: jsonb(),
	createdBy: varchar("created_by", { length: 255 }),
	updatedBy: varchar("updated_by", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_uis_ui_id").using("btree", table.uiId.asc().nullsLast().op("text_ops")),
	index("idx_uis_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_uis_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("idx_uis_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
	index("idx_uis_updated_by").using("btree", table.updatedBy.asc().nullsLast().op("text_ops")),
]);

export const menus = pgTable("menus", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	menuJson: jsonb("menu_json"),
	version: integer(),
	isActive: boolean("is_active").default(true),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_menus_is_active").using("btree", table.isActive.asc().nullsLast()),
]);

export const artifacts = pgTable("artifacts", {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    dsl: jsonb(),
	type: varchar({length : 100}),
	filters: jsonb(),
	deleted: boolean().default(false),
	status: varchar({ length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
  }, (table) => [
   index("idx_artifacts_created_by").using("btree", table.createdBy.asc().nullsLast().op("text_ops")),
    index("idx_artifacts_created_at").using("btree", table.createdAt.asc().nullsLast()),
  ]);

  export const projectDetails = pgTable("project_details", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	icon: varchar({ length: 500 }),
	description: text(),
	databaseType: varchar("database_type", { length: 100 }),
	databaseName: varchar("database_name", { length: 255 }),
	primaryColor: varchar("primary_color", { length: 50 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_project_details_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const projectSources = pgTable("project_sources", {
	id: varchar({ length: 100 }).primaryKey().notNull(),
	projectId: varchar("project_id", { length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	type: varchar({ length: 50 }).notNull(), // postgres, mssql, salesforce, excel, api, etc.
	config: jsonb().notNull(),               // Connection config (should be encrypted in production)
	schema: jsonb(),                         // Cached raw schema (tables/fields/stats)
	semanticModel: jsonb("semantic_model"),  // Claude-authored semantic superset (descriptions, synonyms, joins, embedText, value vocab); runtime prefers this over `schema`
	isPrimary: boolean("is_primary").default(false),
	isActive: boolean("is_active").default(true),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_project_sources_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_project_sources_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("idx_project_sources_is_active").using("btree", table.isActive.asc().nullsLast()),
	foreignKey({
		columns: [table.projectId],
		foreignColumns: [projectDetails.id],
		name: "project_sources_project_id_fkey"
	}).onDelete("cascade"),
]);

export const reportAlerts = pgTable("report_alerts", {
	id: serial().primaryKey().notNull(),
	alertId: varchar("alert_id", { length: 255 }).notNull().unique(),
	reportId: varchar("report_id", { length: 255 }).notNull(),
	projectId: varchar("project_id", { length: 255 }).notNull(),
	name: varchar({ length: 255 }),
	enabled: boolean().default(true),
	// Metric definition
	metricDescription: text("metric_description"),
	sourceId: varchar("source_id", { length: 255 }),
	generatedQuery: text("generated_query"),
	resultColumn: varchar("result_column", { length: 255 }),
	// Alert condition
	conditionType: varchar("condition_type", { length: 50 }),
	config: jsonb(),
	// Schedule
	checkInterval: varchar("check_interval", { length: 50 }),
	// Notification
	recipients: jsonb().$type<string[]>().default([]),
	emailSubject: varchar("email_subject", { length: 255 }),
	cooldownMinutes: integer("cooldown_minutes").default(60),
	// Tracking
	lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: 'string' }),
	lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true, mode: 'string' }),
	lastValue: doublePrecision("last_value"),
	consecutiveErrors: integer("consecutive_errors").default(0),
	status: varchar({ length: 50 }).default('unchecked'),
	// Metadata
	createdBy: varchar("created_by", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_report_alerts_alert_id").using("btree", table.alertId.asc().nullsLast().op("text_ops")),
	index("idx_report_alerts_report_id").using("btree", table.reportId.asc().nullsLast().op("text_ops")),
	index("idx_report_alerts_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_report_alerts_enabled").using("btree", table.enabled.asc().nullsLast()),
	index("idx_report_alerts_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_report_alerts_created_at").using("btree", table.createdAt.asc().nullsLast()),
]);

export const alertHistory = pgTable("alert_history", {
	id: serial().primaryKey().notNull(),
	alertId: varchar("alert_id", { length: 255 }).notNull(),
	triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	value: doublePrecision(),
	reason: text(),
	analysis: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_alert_history_alert_id").using("btree", table.alertId.asc().nullsLast().op("text_ops")),
	index("idx_alert_history_triggered_at").using("btree", table.triggeredAt.asc().nullsLast()),
]);

/**
 * Script recipes — metadata for the script-flow matcher.
 *
 * Stores ONLY the searchable/queryable metadata. The script body lives on
 * disk as `scripts-store/<file_base>.ts` (editable in the IDE); `bodyHash`
 * lets the runtime detect manual edits. Postgres full-text search over the
 * weighted name/tags/intent replaces the old "load every file + send the whole
 * catalog to the LLM" matcher. See backend/docs/SCRIPT-FLOW-SCALING-ISSUES.md.
 */
export const scriptRecipes = pgTable("script_recipes", {
	// Recipe id (e.g. "script_1714745623_x9k2") — PK, matches the SDK ScriptRecipe.id.
	id: varchar({ length: 128 }).primaryKey().notNull(),
	// Project scope. Nullable for single-project VM deployments.
	projectId: varchar("project_id", { length: 255 }),
	version: integer().default(1).notNull(),

	// --- MATCHING (searchable) ---
	name: text().notNull(),
	intentDescription: text("intent_description").notNull(),
	tags: text().array(),
	createdFrom: text("created_from"),

	// --- EXECUTION / PRESENTATION (jsonb + arrays) ---
	sourceIds: text("source_ids").array(),
	tables: text().array(),
	parameters: jsonb(),
	components: jsonb(),

	// --- BODY POINTER (body lives on disk) ---
	fileBase: text("file_base").notNull(),          // <file_base>.ts stem on disk
	bodyHash: varchar("body_hash", { length: 64 }), // sha256 of the .ts body

	// --- QUALITY TRACKING ---
	successCount: integer("success_count").default(0).notNull(),
	failureCount: integer("failure_count").default(0).notNull(),
	lastUsed: timestamp("last_used", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),

	// --- LINEAGE (fork-and-adapt) ---
	parentId: varchar("parent_id", { length: 128 }),
	forkDepth: integer("fork_depth").default(0),
	forkReason: text("fork_reason"),

	// --- DRAFT LIFECYCLE ---
	status: varchar({ length: 20 }).default('verified').notNull(), // 'draft' | 'verified'
	turnId: varchar("turn_id", { length: 64 }),
	lastError: jsonb("last_error"),

	// --- USER-DIRECTED EDIT PROVENANCE ---
	// Recipes are project-scoped, so one user's correction changes everyone's
	// answers — these give the audit trail. Prior bodies are archived on disk as
	// <file_base>.v<version>.ts; `history` records what changed and who did it.
	// See backend/docs/SCRIPT-EDIT-DESIGN.md § Component 5.
	editedBy: varchar("edited_by", { length: 255 }),
	editedFrom: text("edited_from"),
	history: jsonb(),

	// --- DURABLE DISPLAY PREFERENCE ---
	// What the user explicitly asked the output to LOOK like, e.g.
	// { componentTypes: ['DynamicBarChart','DynamicDataTable'], instruction: '…', at: '…' }.
	// Deliberately separate from `components`: those are validated bindings that
	// MUST be cleared on a data edit (columns and titles go stale), whereas a
	// rendering choice the user made is still valid afterwards. Without this the
	// user's chart type silently vanishes the next time anyone edits the SQL.
	displayPreference: jsonb("display_preference"),

	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	// FTS GIN indexes (functional — same pattern as kb_nodes). The search query
	// ORs these `@@` conditions, then ranks with ts_rank over a weighted vector.
	index("idx_script_recipes_name_fts").using("gin", sql`to_tsvector('english'::regconfig, ${table.name})`),
	index("idx_script_recipes_intent_fts").using("gin", sql`to_tsvector('english'::regconfig, ${table.intentDescription})`),
	index("idx_script_recipes_created_from_fts").using("gin", sql`to_tsvector('english'::regconfig, coalesce(${table.createdFrom}, ''))`),
	index("idx_script_recipes_tags").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("idx_script_recipes_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_script_recipes_project_id").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("idx_script_recipes_last_used").using("btree", table.lastUsed.asc().nullsLast()),
	// One canonical file per (project, file_base) so the on-disk body never collides.
	uniqueIndex("uq_script_recipes_project_file_base").on(table.projectId, table.fileBase),
]);

// ============================================================================
// ENTITY SEARCH ENGINE — see backend/docs/ENTITY-SEARCH-DESIGN.md
// Resolves free-form mentions in a user question ("FDC") to exact business ids
// BEFORE the agent plans a query, and records how to reach a user-facing
// concept ("customer", "lane") in the underlying source.
// ============================================================================

/**
 * Entity map: one row per USER-FACING concept, not per table. `customer` is an
 * entity; com_mst_party is an implementation detail living inside `resolution`.
 */
export const searchEntityTypes = pgTable("search_entity_types", {
	entityType: varchar("entity_type", { length: 64 }).primaryKey().notNull(),
	// Everything about reaching the concept: tables, id/label columns, join
	// path, match pattern. JSONB because concepts differ in shape — `customer`
	// is one table, `outstanding-booking` is a join plus a filter predicate.
	// Structure is enforced at the write layer, not by columns.
	resolution: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Value index: BOUNDED master data only (names + codes). Transaction
 * identifiers are deliberately NOT indexed — they grow forever and are reached
 * through the entity map instead. See ENTITY-SEARCH-DESIGN.md § 2.1.
 */
export const searchValues = pgTable("search_values", {
	id: bigserial({ mode: 'number' }).primaryKey().notNull(),
	entityType: varchar("entity_type", { length: 64 }).notNull(),
	// Business key of the INSTANCE (PartyId 10141) — this is what the agent puts
	// in its SQL. Opaque to the resolver; composite keys keep parts in `attrs`.
	instanceId: varchar("instance_id", { length: 128 }).notNull(),
	value: text().notNull(),
	// name | code | alias — drives RANKING, not matching.
	valueKind: varchar("value_kind", { length: 32 }).default('name').notNull(),
	// Payload returned with a hit, so a resolve needs no follow-up query.
	attrs: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),

	// --- NORMALIZED FORMS (generated) ---
	// The indexer writes only `value`, so a normalization rule can never drift
	// from the data it describes. 'F D C LIMITED' -> 'f d c limited'/'fdclimited'
	valueNorm: text("value_norm").generatedAlwaysAs(
		sql`btrim(regexp_replace(lower("value"), '[^a-z0-9]+', ' ', 'g'))`
	),
	valueSquashed: text("value_squashed").generatedAlwaysAs(
		sql`regexp_replace(lower("value"), '[^a-z0-9]+', '', 'g')`
	),
	// 2-arg to_tsvector is IMMUTABLE; the 1-arg form is only STABLE and is
	// rejected in a generated column. 'simple' — no stemming on proper nouns.
	valueTsv: tsvector("value_tsv").generatedAlwaysAs(
		sql`to_tsvector('simple', btrim(regexp_replace(lower("value"), '[^a-z0-9]+', ' ', 'g')))`
	),
}, (table) => [
	foreignKey({
		columns: [table.entityType],
		foreignColumns: [searchEntityTypes.entityType],
		name: "search_values_entity_type_fk"
	}).onDelete("cascade"),
	// Fuzzy match on the squashed form. THIS is the index that fixes the
	// acronym/spacing miss: plain FTS tokenizes 'F D C' to three tokens and can
	// never match the single token 'FDC'.
	index("idx_search_values_squashed_trgm").using("gin", table.valueSquashed.op("gin_trgm_ops")),
	index("idx_search_values_norm_trgm").using("gin", table.valueNorm.op("gin_trgm_ops")),
	// Word-level match for multi-word natural-language names.
	index("idx_search_values_tsv").using("gin", table.valueTsv.op("tsvector_ops")),
	// text_pattern_ops makes LIKE 'foo%' index-usable for exact + prefix tiers.
	index("idx_search_values_norm_prefix").using("btree", table.valueNorm.op("text_pattern_ops")),
	index("idx_search_values_entity_type").using("btree", table.entityType.op("text_ops")),
	index("idx_search_values_instance").using("btree", table.entityType.op("text_ops"), table.instanceId.op("text_ops")),
	// Re-indexing the same value must UPDATE, not duplicate. md5() keeps the
	// key inside the btree size limit regardless of value length.
	uniqueIndex("uq_search_values").on(table.entityType, table.instanceId, table.valueKind, sql`md5("value")`),
]);

/**
 * Concepts: one row per computable idea the agent must know how to find or
 * derive — `revenue forecast`, `at-risk project`, `billing rate`.
 *
 * DELIBERATELY SEPARATE from search_entity_types, which a full entity load
 * WIPES (clearAllEntityTypes → DELETE FROM, cascading to search_values). Concepts
 * are authored, not dumped, so co-locating them would delete the whole store on
 * every routine value refresh. The eventual merge — entity types becoming
 * concepts that happen to carry a value index — is why `name` is varchar(64):
 * it matches search_entity_types.entity_type so the FK can be re-pointed rather
 * than rebuilt.
 *
 * Only `name` and `body` are required. Everything else defaults, so authoring a
 * concept is the same two fields as an entity_map entry today.
 */
export const concepts = pgTable("concepts", {
	id: serial().primaryKey().notNull(),
	// The catalog key the agent asks for. Matched case-insensitively.
	name: varchar({ length: 64 }).notNull(),
	// The complete rule — formula, filter, join path. One rule per concept: a
	// body that needs "and also…" is two concepts joined by `requires`.
	body: text().notNull(),
	// Drives INJECTION POLICY, not just labelling: 'invariant' concepts are
	// always injected (date encoding, valid-row filters — preconditions no
	// question is semantically close to), everything else is retrieved on demand.
	kind: varchar({ length: 24 }).default('definition').notNull(),
	// Who the concept applies to: global (everyone) | user | group, or null (not
	// set). Set on the platform and replicated here (graph-replica.ts). Stored
	// only for now — nothing filters on it yet.
	type: varchar({ length: 8 }),
	// Concept names this one depends on, resolved TRANSITIVELY at injection.
	// Without this the dependency gets written into `body` as prose and can only
	// be extracted later by re-authoring every concept by hand.
	requires: text().array().default(sql`'{}'::text[]`).notNull(),
	// Output contract: { type, unit, grain, caveats }. The field that makes an
	// unstated unit (revenue summed across AUD and NZD) visible at authoring time.
	returns: jsonb().default({}).notNull(),
	// Alternate names users say. Structured rather than blended into an embedding
	// so a hit can be matched exactly and shown in the catalog.
	aliases: text().array().default(sql`'{}'::text[]`).notNull(),
	// One line: what this concept is FOR, shown beside every search hit so a
	// caller can choose without fetching bodies. Curated and short on purpose —
	// searching bodies returned a fifth of the catalog for a word like
	// "customer", because a body mentions every term it cross-references.
	description: varchar({ length: 240 }),
	// Where this came from: data_source | knowledge_node | user_question |
	// agent_validated. Nullable, but the ONE field that cannot be reconstructed
	// later — after a bulk load nothing records which node each concept came from.
	origin: varchar({ length: 24 }),
	// project_sources.id. NULL = applies across sources. Not an FK: a concept
	// should outlive a source being dropped and re-added under a new id.
	sourceId: varchar("source_id", { length: 100 }),
	// WHICH source this came from, not just what kind — 'kb:42', 'conv:1200-1209'.
	// `origin` alone cannot support "the node was edited, update its concept":
	// the only alternative is matching by name, which breaks as soon as a
	// concept is renamed or one node yields two concepts.
	originRef: varchar("origin_ref", { length: 100 }),
	// This row is a PROPOSED REPLACEMENT for concepts.id — an agent's correction
	// to a rule a human already approved. Overwriting the original outright is
	// not the agent's call, but discarding the correction loses real signal: one
	// such proposal argued an existing filter had its condition negated, which
	// would make every number computed through it wrong. So the revision is
	// stored as its own unverified row and reviewed like any other.
	supersedes: integer(),
	// GATES whether the agent may use this at all — not a display badge.
	// A concept body overrides the schema, the knowledge base and the model's
	// own reasoning ("USE ITS BODY AS WRITTEN", see MainAgent's resolve_concepts
	// description), so an unreviewed one is an override nobody approved.
	// Coding-agent proposals land false and are invisible to the runtime until a
	// human verifies them; every read path filters on this.
	verified: boolean().default(false).notNull(),
	// WHERE THIS SITS IN REVIEW. `verified` remains the gate every runtime read
	// filters on; this says why, and carries the states a boolean cannot.
	//
	//   draft       being written, offered to nobody yet
	//   proposed    awaiting a human decision — where an agent's work lands
	//   approved    in force. The only status that may have verified = true
	//   rejected    reviewed and refused. Kept as signal, out of the queue
	//   superseded  a proposal that was applied to the concept it replaced
	//
	// The pair must agree: approved if and only if verified. Everything that
	// writes `verified` writes this too (createConcept, setConceptVerified, the
	// graph import and graph-replica.ts).
	//
	// Two statements belong in the migration that adds this and cannot be
	// expressed here, so drizzle will not generate them:
	//
	//   UPDATE concepts SET status = 'approved' WHERE verified = true;
	//   ALTER TABLE concepts ADD CONSTRAINT concepts_status_matches_verified
	//     CHECK ((status = 'approved') = verified);
	//
	// Without the first, every already-approved concept comes back as a pending
	// proposal. Without the second, the pair can drift and nothing objects.
	status: conceptStatus().default('proposed').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	// Every runtime read filters verified; the review queue selects the inverse.
	index("idx_concepts_verified").using("btree", table.verified.asc().nullsLast()),
	// The review queue is "proposed", not "everything unverified" — rejected and
	// superseded rows are unverified too and must not come back.
	index("idx_concepts_status").using("btree", table.status.asc().nullsLast()),
	// "which concepts came from this node" on every KB edit.
	index("idx_concepts_origin_ref").using("btree", table.originRef.asc().nullsLast()),
	// "is there a pending revision for this concept?"
	index("idx_concepts_supersedes").using("btree", table.supersedes.asc().nullsLast()),
	// One concept per name per source. lower() so 'Revenue Forecast' and
	// 'revenue forecast' are the same key; coalesce because NULL != NULL would
	// otherwise let unlimited cross-source duplicates through.
	// Partial: a pending revision deliberately carries the same name as the
	// concept it replaces, so the original and its proposed replacement coexist.
	uniqueIndex("uq_concepts_name")
		.on(sql`lower("name")`, sql`coalesce("source_id", '')`)
		.where(sql`"supersedes" IS NULL`),
	// getInvariants() runs on every question — the always-injected tier.
	index("idx_concepts_kind").using("btree", table.kind.op("text_ops")),
	// Alias lookup is an array containment check, which needs GIN.
	index("idx_concepts_aliases").using("gin", table.aliases.op("array_ops")),
]);

/**
 * ANSWER VALIDATIONS — what a coding agent found when it re-derived an answer
 * from the source data.
 *
 * The agent already produces this; before this table it lived only in its
 * private memory/ directory, which is machine-local, gitignored and pruned. A
 * run that verified an answer as correct therefore produced NO durable output
 * at all — the most reassuring result was the one that vanished.
 *
 * Deliberately append-only rather than one row per conversation: re-validating
 * after a concept changes is exactly when you want the old verdict kept, so the
 * history shows a rule change flipping an answer from wrong to right.
 */
export const answerValidations = pgTable("answer_validations", {
	id: serial().primaryKey().notNull(),
	// user_conversations.id. Not an FK: a validation is evidence about an answer
	// and should outlive the conversation row being pruned.
	conversationId: integer("conversation_id").notNull(),
	// A snapshot of the question, not a join. This table is explicitly meant to
	// outlive the conversation row, and a verdict whose question has been pruned
	// away is unreadable — "Answer #1243 was wrong" tells nobody anything.
	question: text(),
	// match | mismatch | unverifiable — 'unverifiable' is a real, useful result,
	// not a failure: it records that nobody should trust this answer either way.
	verdict: varchar({ length: 24 }).notNull(),
	// Kept as text, not numeric: an answer may be a count, a currency amount, or
	// a sentence, and coercing them all to a number loses the ones that matter.
	reportedAnswer: text("reported_answer"),
	rederivedAnswer: text("rederived_answer"),
	// Where a mismatch usually hides — unconverted currencies, hours vs days.
	unit: text(),
	// The explanation a human actually reads.
	finding: text(),
	// { sql, rowCount, ... } — how it was checked, so the check is reproducible.
	evidence: jsonb().default({}).notNull(),
	// The agent run that produced this, for tracing back to the workspace.
	agentRunId: varchar("agent_run_id", { length: 64 }),
	// How many times this answer has been re-derived. A conversation can be
	// legitimately re-read — a partially covered batch hands the remainder back
	// — and two independent checks that agree is a stronger signal than one, so
	// it is recorded as a count rather than as a second row.
	checks: integer().default(1).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	// First checked vs. last checked.
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	// One verdict per answer, enforced HERE rather than in the writer: this
	// table is the review surface and the accuracy denominator, so a duplicate
	// is not just noise — it silently weights one conversation twice in the
	// accuracy figure. Also serves "show the validation for this answer", which
	// is why the plain index it replaces is gone.
	uniqueIndex("uq_answer_validations_conversation").using("btree", table.conversationId.asc().nullsLast()),
	// "how many mismatches this month" — the accuracy view.
	index("idx_answer_validations_verdict").using("btree", table.verdict.asc().nullsLast(), table.createdAt.desc().nullsLast()),
]);

export const dataSourceIndex = pgTable("data_source_index", {
	// "NetSuite.customer.entityid" — the dotted natural key, written by the
	// indexer (see buildIndexId) so it can never drift from the three parts.
	id: text().primaryKey().notNull(),

	// The three search axes, kept as separate columns rather than parsed back
	// out of `id` — a source or table name containing a dot would make the
	// dotted form ambiguous, and every query below filters on these directly.
	sourceName: varchar("source_name", { length: 128 }).notNull(),
	tableName: varchar("table_name", { length: 128 }).notNull(),
	columnName: varchar("column_name", { length: 128 }).notNull(),

	// 'active' | 'disabled'. A deleted or deactivated source disables its rows
	// rather than erasing them, so ids referenced elsewhere stay resolvable.
	// Every read filters to 'active' (see searchDataSourceIndex).
	status: varchar({ length: 16 }).default('active').notNull(),

	// --- METRICS PRESENT FOR EVERY EXTRACTOR (worth filtering/sorting on) ---
	dataType: varchar("data_type", { length: 64 }),
	isNullable: boolean("is_nullable"),
	// bigint, not integer: this source already has a 9.9M-row table, and row
	// counts are the one number here with no natural ceiling.
	rowCount: bigint("row_count", { mode: 'number' }),
	distinctCount: bigint("distinct_count", { mode: 'number' }),
	nonNullCount: bigint("non_null_count", { mode: 'number' }),
	// unique | high | medium | low — the extractor's own bucketing.
	cardinality: varchar({ length: 16 }),

	// 1-50 entries per column, so it can never be columns. Cap at ingest: one
	// observed value is 4.7KB against an 11-char average.
	sampleValues: jsonb("sample_values").default([]).notNull(),
	// The raw statistics block, verbatim — the escape hatch described above.
	statistics: jsonb().default({}).notNull(),
	description: text(),

	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	// Where the row came from ('semantic-model' | 'schema' | 'live'), so a caller
	// can tell a cached projection from a live extraction.
	indexedFrom: varchar("indexed_from", { length: 24 }),

	// What makes a join safe to write. Per COLUMN.
	isPrimaryKey: boolean("is_primary_key"),
	// What the TABLE is: { description, primaryKey, joins, synonyms, notes }.
	// Denormalised onto every column of the table so one lookup answers "what is
	// this table and how do I join it" — the alternative is a second table whose
	// only job is to be joined back on every read.
	tableMeta: jsonb("table_meta").default({}).notNull(),

}, (table) => [
	// Drill-down AND upsert key in one index. Column order matters: a btree
	// scans any left prefix, so this alone answers "tables in a source"
	// (source_name), "columns in a table" (source_name, table_name), and
	// "pin one column" (all three).
	uniqueIndex("uq_data_source_index_path").on(table.sourceName, table.tableName, table.columnName),

	// FTS across all three names. Functional, with NO stored/normalized column
	// behind it: Postgres's own parser already tokenizes
	// 'custentity_lead_source' -> custentity/lead/source, so pre-normalizing
	// with regexp_replace would only repeat what the tokenizer does. Same
	// convention as kb_nodes and script_recipes above. 'simple' — no stemming,
	// these are identifiers, not prose.
	// Covers: whole word, multi-word AND, and prefix via to_tsquery('cust:*').
	index("idx_data_source_index_fts").using(
		"gin",
		sql`to_tsvector('simple', ${table.sourceName} || ' ' || ${table.tableName} || ' ' || ${table.columnName})`
	),

	// The two things FTS structurally cannot reach, both measured against this
	// data: infix ('entity' inside the token 'custentity') and camelCase, which
	// the parser leaves whole ('customerName' -> one token 'customername').
	// NetSuite is snake_case so FTS alone suffices there, but SQL sources
	// routinely use camelCase. Also functional — still no stored column.
	index("idx_data_source_index_trgm").using(
		"gin",
		sql`lower(${table.sourceName} || ' ' || ${table.tableName} || ' ' || ${table.columnName}) gin_trgm_ops`
	),
]);

/**
 * COMPOSITION GRAPH — domains composed from atomic nodes.
 *
 * One node holds one piece of logic, and a domain lists the nodes it uses in
 * order; nothing is copied between domains. That is the point: the one
 * contradiction we shipped (consignor vs billing party, stated one way in a
 * concept and the other way in a table description) changed a customer ranking
 * in 19 runs out of 19, and neither copy knew about the other.
 *
 * The data seam underneath — concepts, data_source_index, search_values — is
 * unchanged. A domain says which of it applies and how this area is queried.
 */
export const graphNodes = pgTable("graph_nodes", {
	id: serial().primaryKey().notNull(),
	// part | file | setting | program | domain. Kinds share a table because they
	// share everything that matters here: hashing, versioning, review state.
	kind: varchar({ length: 16 }).notNull(),
	name: varchar({ length: 96 }).notNull(),
	title: varchar({ length: 160 }),
	body: text().notNull(),
	// Kind-specific fields: a file's path, a setting's key/value/type, a
	// program's params and row cap, a domain's routing threshold.
	meta: jsonb().default({}).notNull(),
	// sha256 of kind + name + body + meta. A domain's composed prompt and folder
	// are cached against a hash built from this one plus its members', so an
	// edit anywhere below re-places the workspace on the next question.
	hash: varchar({ length: 64 }).notNull(),
	// draft | published | retired. Only published is ever composed — a draft is
	// for the viewer and the human who approves it.
	status: varchar({ length: 12 }).default('draft').notNull(),
	version: integer().default(1).notNull(),
	supersedes: integer(),
	// human | agent | import — an agent may propose, a person publishes.
	origin: varchar({ length: 24 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("uq_graph_nodes_kind_name_version").using("btree", table.kind, sql`lower(${table.name})`, table.version),
	index("idx_graph_nodes_published").using("btree", table.kind, sql`lower(${table.name})`).where(sql`status = 'published'`),
]);

/** What a domain is made of, and in what order. */
export const graphDomainMembers = pgTable("graph_domain_members", {
	domainId: integer("domain_id").notNull(),
	// Null for a concept member: a concept lives in the concept store and is
	// referenced BY NAME, never copied here. Copying it would recreate the two
	// sources of truth the domain exists to avoid.
	nodeId: integer("node_id"),
	conceptName: varchar("concept_name", { length: 160 }),
	// prompt | concept | file | setting | program — where the member lands in
	// the composition, since one domain composes into both a prompt and a folder.
	role: varchar({ length: 12 }).notNull(),
	position: integer().notNull(),
}, (table) => [
	index("idx_graph_domain_members_order").using("btree", table.domainId, table.role, table.position),
]);

/**
 * The reverse index the router scores against. Terms are the words a person
 * types, not our table names: the retrieval miss that cost us an answer was
 * "lorry hire charges" against a concept that knew all about hire charges.
 */
export const graphDomainTerms = pgTable("graph_domain_terms", {
	domainId: integer("domain_id").notNull(),
	// Lowercase. A multi-word term matches as a phrase, so "freight revenue"
	// cannot be satisfied by "revenue" alone.
	term: varchar({ length: 64 }).notNull(),
	weight: integer().default(1).notNull(),
}, (table) => [
	index("idx_graph_domain_terms_term").using("btree", table.term),
]);

/**
 * One row per routed question, written BEFORE the agent starts so a misroute is
 * visible even when the run then fails. This is the audit trail the viewer
 * reads, and the list of fallbacks is the gap report: questions this client
 * asks that no domain covers yet.
 */
export const graphRoutes = pgTable("graph_routes", {
	id: bigserial({ mode: 'number' }).primaryKey().notNull(),
	question: text().notNull(),
	domainId: integer("domain_id"),
	// The composed hash actually used, so an answer can be tied to the exact
	// knowledge that produced it after the graph has moved on.
	domainHash: varchar("domain_hash", { length: 64 }),
	score: doublePrecision(),
	runnerUpId: integer("runner_up_id"),
	runnerUpScore: doublePrecision("runner_up_score"),
	matchedTerms: jsonb("matched_terms").default([]).notNull(),
	// index | llm | fallback — how the decision was reached.
	decidedBy: varchar("decided_by", { length: 12 }).notNull(),
	threadId: varchar("thread_id", { length: 64 }),
	userId: varchar("user_id", { length: 64 }),
	// What the answer needed that the routed domain lacked, written when the run ends.
	gaps: jsonb("gaps"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("idx_graph_routes_domain").using("btree", table.domainId, table.createdAt),
]);
