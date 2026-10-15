/**
 * The `dashboard-builder-agent` collection — the browser's way into the conversation.
 *
 * Shaped like `chat-agent`'s prompt/abort/state, with one deliberate
 * difference: **`prompt` does not wait for the turn to finish.**
 *
 * The client's `defaultTimeout` is 120s, and a turn that writes and verifies a
 * dashboard runs for as long as that takes — two to four minutes.
 * Awaiting the turn would therefore time out the request while the work carried
 * on invisibly, and the browser would show a failure for a turn that in fact
 * succeeded. So the turn is started, the request returns, and everything after
 * that arrives by push.
 *
 * Two channels, and both are needed:
 *   - `onUpdate`, a callback the caller supplies, for liveness while the turn
 *     runs. The `DASH_BUILDER_REQ` handler in sdk-nodejs passes one that emits
 *     typed, sequenced stream frames; a CLI passes nothing.
 *   - `state`, for everything a push cannot cover: a reload, a second tab, a
 *     client that connected late, or a backend that restarted mid-conversation.
 *
 * The collection is named for the agent, the message for the capability. There
 * is one agent and one name for it — an earlier split into an "analyst" that
 * decided and a "builder" that wrote left the word analyst scattered through
 * code that no longer had one.
 */
import type { CollectionContext } from './types';
import { analyticsClient } from '@superatomai/sdk-node';
import {
	ask,
	abort,
	getState,
	onBuilderUpdate,
	type BuilderUpdate,
	type TurnOutcome,
} from '../dashboard-builder/agent/session';
import { connectedSourceIds } from '../dashboard-builder/query';
import { isContractRegistered } from '../dashboard-builder/contract/registered';

export async function registerDashboardBuilderAgentCollections({ sdk }: CollectionContext): Promise<void> {
	/**
	 * Starts a turn. Returns as soon as it is running, not when it is done.
	 *
	 * `dashboardId` is the conversation — one per dashboard, so reopening one
	 * resumes rather than restarts. The dashboard is registered before a conversation opens on it.
	 */
	sdk.addCollection(
		'dashboard-builder-agent',
		'prompt',
		async (params: {
			dashboardId?: string;
			text?: string;
			/** A panel the person pointed at before typing. Its `Panel` id. */
			panelId?: string;
			projectId?: string;
			userId?: string;
			/**
			 * Live activity, passed in by the caller.
			 *
			 * The `DASH_BUILDER_REQ` handler supplies one that emits typed, sequenced
			 * stream frames. A caller with no way to receive them — a CLI, a script —
			 * simply omits it and reads `state` instead.
			 *
			 * This used to reach for `sdk.send` with a hand-written message type. That
			 * put a magic string in two repos with an untyped payload, and nothing
			 * connecting the two ends: a typo on either side was silence.
			 */
			onUpdate?: (update: BuilderUpdate) => void;
		}) => {
			/**
			 * Required, with no fallback.
			 *
			 * The platform registers an empty dashboard before opening a conversation
			 * on it, so there is always an id by the time anyone can type. The old
			 * `_new` pseudo-conversation existed because that was not true, and it is
			 * what let an agent invent a name and build into the wrong place.
			 */
			const dashboardId = params?.dashboardId?.trim();
			if (!dashboardId) throw new Error('dashboardId is required');
			const text = params?.text?.trim();
			if (!text) throw new Error('text is required');

			/**
			 * Refused before a session opens, not part-way through a turn.
			 *
			 * The contract is pushed by the browser on connect and on reconnect, so
			 * the only way to be here without it is a backend that restarted while
			 * this tab stayed open. Failing now costs nothing; failing later costs
			 * a two-minute turn that cannot publish.
			 */
			if (!isContractRegistered()) {
				return {
					started: false,
					error:
						'The dashboard components are not loaded yet. They are sent by the browser ' +
						'when the app opens — reload the page and try again.',
				};
			}

			const current = await getState(dashboardId, connectedSourceIds());
			if (current.running) {
				return { started: false, running: true, error: 'This conversation is already working on something.' };
			}

			const unsubscribe = params?.onUpdate
				? onBuilderUpdate((id, update) => {
						if (id === dashboardId) params.onUpdate!(update);
					})
				: undefined;

			/**
			 * Deliberately not awaited.
			 *
			 * Everything the caller needs afterwards is in the transcript, which
			 * `state` returns and the stream pushes. Awaiting here would only
			 * reintroduce the timeout this whole shape exists to avoid.
			 */
			void ask(dashboardId, text, {
				panelId: params?.panelId?.trim() || undefined,
				/**
				 * Every connected source — which is the whole permission model
				 * today, not a shortcut. There is no per-user source permission
				 * anywhere in the platform; anyone who can reach the backend can
				 * query anything it has connected.
				 *
				 * So this grants what a person could already reach by other means,
				 * and adds nothing. What it still buys is a *ceiling*: whatever the
				 * conversation asks for, the agent is held to this list rather than to
				 * a manifest it wrote itself. If per-user permissions ever arrive,
				 * this is the single line that has to consult them.
				 */
				grants: connectedSourceIds(),
			})
				.then((outcome) =>
					recordTurn(sdk, {
						dashboardId,
						projectId: params?.projectId,
						userId: params?.userId,
						prompt: text,
						outcome,
					}),
				)
				.catch(() => {
					/* `ask` resolves with `{ error }` rather than throwing; this is
					 * only for a failure in the plumbing around it, which has already
					 * been published to the transcript. */
				})
				.finally(() => unsubscribe?.());

			return { started: true, running: true, dashboardId };
		},
	);

	/**
	 * The conversation so far, and whether it is working.
	 *
	 * The recovery path for everything the stream cannot reach — a reload, a
	 * second tab, a late connection. Cheap enough to poll while a turn runs.
	 */
	sdk.addCollection('dashboard-builder-agent', 'state', async (params: { dashboardId?: string }) => {
		/* Grants are passed because resuming a session re-registers its workspace,
		 * and the authorised sources are what `./run-resolver` and `./publish` are
		 * held to. */
		const id = params?.dashboardId?.trim();
		if (!id) throw new Error('dashboardId is required');
		return getState(id, connectedSourceIds());
	});

	sdk.addCollection('dashboard-builder-agent', 'abort', async (params: { dashboardId?: string }) => {
		const id = params?.dashboardId?.trim();
		if (!id) throw new Error('dashboardId is required');
		return { aborted: abort(id) };
	});

	console.log('✓ dashboard-builder agent collection registered');
}

/**
 * Records a finished turn in the two places a conversation is kept.
 *
 * Mirrors what `dashboardAgent/collection.ts` does when its own run ends, and
 * deliberately so — a second way of recording the same kind of event would mean
 * two shapes to reconcile in analytics.
 *
 *  1. **Local, authoritative.** `dashboard-agent-conversations` is the DSL
 *     flow's table and we share it. Not ideal — the blueprint keeps these two
 *     flows namespaced apart everywhere else — but `AnalyticsEventType` is a
 *     closed union validated in sa-api, so a new type is not ours to add.
 *     `source: 'dashboard-builder'` rides along in the response payload so the
 *     two can be separated later without a migration.
 *  2. **Central sa-api**, via `analyticsClient`, carrying the local row's id so
 *     the two records can be joined.
 *
 * Neither write may affect the turn. It has already happened, the transcript
 * already has it, and losing the record is a smaller failure than turning a
 * finished answer into an error.
 */
async function recordTurn(
	sdk: CollectionContext['sdk'],
	args: {
		dashboardId: string;
		projectId?: string;
		userId?: string;
		prompt: string;
		outcome: TurnOutcome;
	},
): Promise<void> {
	const { dashboardId, projectId, userId, prompt, outcome } = args;

	/* Without a user there is nothing to attribute the turn to, and the central
	 * event is keyed by one. Same condition the dashboard agent applies. */
	if (!userId) return;

	let conversationId: number | undefined;
	try {
		const saved: any = await sdk.callCollection('dashboard-agent-conversations', 'create', {
			dashboardId,
			projectId,
			userId,
			userPrompt: prompt,
			responseText: outcome.answer,
			/* No DSL here — this flow writes a React program, not a document. The
			 * marker is what tells the two flows apart in a shared table. */
			dsl: { source: 'dashboard-builder' },
			status: outcome.status,
			...(outcome.status === 'error' ? { error: outcome.error ?? 'Unknown error' } : {}),
		});
		const id = Number(saved?.data?.id);
		conversationId = Number.isFinite(id) ? id : undefined;
	} catch (err: any) {
		console.warn(
			`[dashboard-builder] ${dashboardId}: conversation not saved locally: ${err?.message ?? err}`,
		);
	}

	/* What the agent ran, for the debug view. Keyed by the local row's id, so it
	 * is skipped when that write failed. */
	if (conversationId && outcome.trace) {
		try {
			await sdk.callCollection('user-conversations', 'saveTrace', {
				conversationId,
				type: 'dashboard',
				userId,
				threadId: dashboardId,
				trace: outcome.trace,
			});
		} catch (err: any) {
			console.warn(`[dashboard-builder] ${dashboardId}: trace not saved: ${err?.message ?? err}`);
		}
	}

	try {
		await analyticsClient.track(
			analyticsClient.buildEvent({
				type: 'dashboard',
				userId,
				projectId: projectId ?? '',
				appId: dashboardId,
				question: prompt,
				status: outcome.status,
				latencyMs: outcome.latencyMs,
				model: outcome.model,
				conversationId,
				...(outcome.error ? { errorMessage: outcome.error } : {}),
				/* The same marker as the local row, in the same field. The analytics
				 * response is documented as mirroring what was stored, so the two
				 * must not diverge — separating these flows later means matching on
				 * one value in two places, not two. */
				response: { response_text: outcome.answer, dsl: { source: 'dashboard-builder' } },
				usage: outcome.usage,
			}),
		);
	} catch {
		/* Best effort, exactly as the dashboard agent treats it. */
	}
}
