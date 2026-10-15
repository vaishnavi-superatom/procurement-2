/**
 * One vocabulary for what an embedded pi agent is doing, and one narrator.
 *
 * There are two of these agents — the dashboard builder and the chat agent —
 * and they were each carrying their own copy of the same three hundred lines:
 * the same `prose` extractor, the same event switch, the same delta arithmetic,
 * the same listener set, and two update unions that differed only in spelling.
 * A fix to either was a fix to one.
 *
 * They are the same job. An agent runs, writes prose, calls tools and stops,
 * and something in a browser wants to watch. Nothing in that is specific to
 * dashboards or to chat, so it lives here once and both import it.
 *
 * What is deliberately NOT here: sessions, workspaces, prompts, tools, models.
 * This file turns pi events into updates and hands them to listeners. It never
 * creates a session and never reads one's configuration.
 */
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/**
 * Everything a caller can be told, by either agent.
 *
 * The union is shared rather than merely similar, because the browser code on
 * the other end is shared in shape too: a hook that renders `tool` for one
 * agent and `activity` for the other is two hooks for no reason.
 *
 * `tool` covers both halves of a tool call. The builder emits one at the start
 * and nothing else. The chat agent emits one at the start and a second with
 * `done` when it finishes, which is what lets its transcript tick each line off
 * rather than list them. Optional fields, so neither agent carries the other's
 * bookkeeping.
 */
export type AgentUpdate =
	| { type: 'state'; running: boolean }
	| { type: 'user'; text: string; at: number }
	/**
	 * The tail of an assistant message still being written.
	 *
	 * Never recorded: the `assistant` update that follows carries the same prose
	 * in full, so a reload rebuilds from the transcript and never sees a
	 * half-written sentence twice.
	 */
	| { type: 'delta'; text: string }
	| {
			type: 'tool';
			/** A short phrase. Never tool output. Empty on the closing update. */
			text: string;
			at: number;
			/** pi's own call id, when the caller pairs starts with finishes. */
			id?: string;
			done?: boolean;
			failed?: boolean;
	  }
	| { type: 'assistant'; text: string; at: number }
	/**
	 * A concept the turn wrote down, offered for review.
	 *
	 * Its own entry rather than a line of prose, because the thing on the other
	 * end is a card with the rule in it and two decisions to make. A sentence in
	 * the transcript cannot carry a body to show or an id to act on.
	 *
	 * Nothing here is in force. `previousBody` is set only for a correction, and
	 * is what lets the card show the rule as it stands beside the rule proposed.
	 */
	| {
			type: 'concept';
			action: 'created' | 'revision' | 'refined';
			id: number;
			name: string;
			body: string;
			/** The concept this one would replace, when it is a correction. */
			replaces?: number;
			previousBody?: string;
			/* The rest of the proposal, as stored — the card shows it beside the body. */
			kind?: string;
			requires?: string[];
			aliases?: string[];
			description?: string;
			returns?: Record<string, unknown>;
			at: number;
	  }
	| { type: 'error'; text: string; at: number };

/** The minimum a narrated session record holds. Either agent may add to it. */
export interface LiveSession {
	session: AgentSession;
	running: boolean;
	transcript: AgentUpdate[];
	/** Prose already sent this turn, so a delta can be the tail of it. */
	buffer: string;
	lastActive: number;
}

/** How many updates a live record keeps for a caller that reconnects late. */
const TRANSCRIPT_LIMIT = 400;

/**
 * A broadcast channel plus the record-keeping that goes with it.
 *
 * One per agent rather than one globally: a chat listener has no business being
 * woken by a dashboard build, and keying a single bus by id would leave every
 * listener filtering for its own messages.
 */
export interface UpdateBus {
	/** Subscribe. Returns the unsubscribe. */
	listen(fn: (id: string, update: AgentUpdate) => void): () => void;
	/** Record it against `live` where it belongs, then tell everyone. */
	publish(id: string, live: LiveSession | undefined, update: AgentUpdate): void;
}

export function createUpdateBus(): UpdateBus {
	const listeners = new Set<(id: string, update: AgentUpdate) => void>();

	return {
		listen(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},

		publish(id, live, update) {
			/* `state` carries running-ness rather than text, and `delta` is
			 * superseded by the `assistant` update behind it. Neither belongs in a
			 * transcript a reload rebuilds from. `live` is absent for an update
			 * published before a session exists — it still broadcasts. */
			if (live && update.type !== 'state' && update.type !== 'delta') {
				live.transcript.push(update);
				/* Bounded. Nothing here is the durable record — losing it costs the
				 * replay, not the work. */
				if (live.transcript.length > TRANSCRIPT_LIMIT) {
					live.transcript.splice(0, live.transcript.length - TRANSCRIPT_LIMIT);
				}
			}
			for (const fn of listeners) {
				try {
					fn(id, update);
				} catch {
					/* A listener that throws is not the conversation's problem. */
				}
			}
		},
	};
}

/**
 * Plain text out of an *assistant* message.
 *
 * The role check is the important half. `message_end` also fires for tool
 * result messages, whose content is likewise text blocks, so without it every
 * command's output would be republished as though the agent had said it.
 */
export function prose(message: unknown): string {
	const record = message as { role?: string; content?: unknown[] };
	if (record?.role !== 'assistant' || !Array.isArray(record.content)) return '';
	return record.content
		.filter((block) => (block as { type?: string })?.type === 'text')
		.map((block) => String((block as { text?: string }).text ?? ''))
		.join('');
}

/** The same, for either role. Used to rebuild a transcript from a resumed session. */
export function textOf(message: unknown, role: 'user' | 'assistant'): string {
	const record = message as { role?: string; content?: unknown[] };
	if (record?.role !== role || !Array.isArray(record.content)) return '';
	return record.content
		.filter((block) => (block as { type?: string })?.type === 'text')
		.map((block) => String((block as { text?: string }).text ?? ''))
		.join('')
		.trim();
}

/**
 * Context the turn was prefixed with, which the person never typed.
 *
 * Each is one paragraph above the message, so a blank line ends it.
 */
const PREAMBLES = [
	/^The person has selected the panel `[^`]*` on screen\.[\s\S]*?\n\n/,
	/^The rule catalogue has changed since your last turn[\s\S]*?\n\n/,
	/^The concepts? you proposed, [^\n]* (was|were) (rejected|approved and (is|are) now in force)\.\n\n/,
];

/**
 * The person's own words, from the prompt the agent was given.
 *
 * The live pane shows the message alone, because the prefix is added after it
 * is emitted. A transcript rebuilt from the session file has only the prompt to
 * read, so it strips the same prefixes back off and the conversation reads the
 * same way it did when it happened.
 */
export function personsWords(prompt: string): string {
	let text = prompt;
	for (;;) {
		const preamble = PREAMBLES.find((p) => p.test(text));
		if (!preamble) return text;
		text = text.replace(preamble, '');
	}
}

/**
 * A transcript rebuilt from a resumed session's own message history.
 *
 * User and assistant text only. pi's session file does not keep the tool trail
 * in a form worth re-parsing, so a conversation reopened after a restart shows
 * what was said rather than what was done.
 */
export function seedTranscript(session: AgentSession): AgentUpdate[] {
	const entries: AgentUpdate[] = [];
	for (const message of session.messages) {
		const user = textOf(message, 'user');
		if (user) {
			entries.push({ type: 'user', text: personsWords(user), at: Date.now() });
			continue;
		}
		const assistant = textOf(message, 'assistant');
		if (assistant) entries.push({ type: 'assistant', text: assistant, at: Date.now() });
	}
	return entries.slice(-TRANSCRIPT_LIMIT);
}

/** A short, human phrase for a tool call. Arguments are summarised, never dumped. */
export function describeTool(toolName: string, args: unknown): string {
	if (toolName !== 'bash') return toolName.replace(/_/g, ' ');
	const command = (args as { command?: string } | undefined)?.command ?? '';
	return `Running: ${command.replace(/\s+/g, ' ').slice(0, 120)}`;
}

export interface NarrateOptions {
	/** Emit a second `tool` update when a call finishes, carrying `done`. */
	pairToolCalls?: boolean;
	/**
	 * How to phrase a tool call, when the agent's own tools deserve better than
	 * the command line they were typed as.
	 *
	 * The default states the command. The dashboard builder passes one that knows
	 * its shims, so `./run-resolver revenue` reads as "Running revenue against the
	 * data" — worth having, and worth keeping out of here, since a describer that
	 * knew about both agents' tools would be a third place to update when either
	 * gains one.
	 */
	describe?: (toolName: string, args: unknown) => string;
	/**
	 * The caller reports running and stopped itself.
	 *
	 * For an agent whose turn spans more than one pi prompt — the builder publishes
	 * and may prompt again after the model's reply — so pi's own start and end
	 * would tell a watcher the turn was over while work remains.
	 */
	ownsRunningState?: boolean;
	/** Every tool call, for the turn's debug trace. */
	onToolCall?: (callId: string, toolName: string, args: unknown) => void;
	/** What that call returned — the same text the model was given. */
	onToolResult?: (callId: string, result: unknown, failed: boolean) => void;
}

/**
 * Subscribes to one session's raw pi events and republishes the parts worth
 * showing.
 *
 * pi re-sends the whole assistant message on every update rather than the new
 * characters, so the tail has to be worked out here and `buffer` is the high
 * water mark of what has already gone out. A shorter message means the model
 * rewrote rather than appended, and nothing is emitted for it — the `assistant`
 * update at the end is the authority either way.
 */
export function narrate(
	id: string,
	live: LiveSession,
	bus: UpdateBus,
	opts: NarrateOptions = {},
): void {
	const describe = opts.describe ?? describeTool;

	live.session.subscribe((event: AgentSessionEvent) => {
		const raw = event as {
			message?: unknown;
			toolName?: unknown;
			toolCallId?: unknown;
			args?: unknown;
			isError?: unknown;
		};

		switch (event.type) {
			case 'agent_start':
				live.buffer = '';
				if (opts.ownsRunningState) break;
				live.running = true;
				bus.publish(id, live, { type: 'state', running: true });
				break;

			case 'message_update': {
				const full = prose(raw.message);
				if (full.length > live.buffer.length) {
					bus.publish(id, live, { type: 'delta', text: full.slice(live.buffer.length) });
					live.buffer = full;
				}
				break;
			}

			case 'message_end': {
				const text = prose(raw.message).trim();
				live.buffer = '';
				if (text) bus.publish(id, live, { type: 'assistant', text, at: Date.now() });
				break;
			}

			case 'tool_execution_start':
				opts.onToolCall?.(String(raw.toolCallId ?? ''), String(raw.toolName ?? 'tool'), raw.args);
				bus.publish(id, live, {
					type: 'tool',
					text: describe(String(raw.toolName ?? 'tool'), raw.args),
					at: Date.now(),
					...(opts.pairToolCalls ? { id: String(raw.toolCallId ?? '') } : {}),
				});
				break;

			case 'tool_execution_end':
				opts.onToolResult?.(String(raw.toolCallId ?? ''), (raw as { result?: unknown }).result, Boolean(raw.isError));
				if (!opts.pairToolCalls) break;
				bus.publish(id, live, {
					type: 'tool',
					text: '',
					at: Date.now(),
					id: String(raw.toolCallId ?? ''),
					done: true,
					failed: Boolean(raw.isError),
				});
				break;

			case 'agent_end':
				live.lastActive = Date.now();
				if (opts.ownsRunningState) break;
				live.running = false;
				bus.publish(id, live, { type: 'state', running: false });
				break;

			default:
				break;
		}
	});
}
