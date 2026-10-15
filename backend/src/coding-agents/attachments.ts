/**
 * Files the user attached to a chat question.
 *
 * The browser has already put each file in R2 (sa-api's /upload/chat-attachment
 * routes); the question carries only references. Before the agent runs, each
 * file is downloaded into the thread's workspace under `attachments/`, and the
 * agent is told it is there — the agent reads it with its own tools, the same
 * way it reads anything else in its cwd.
 *
 * Ported from fusion-5's chat agent (backend/src/agent/chat/attachments.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { PromptAttachment } from '@superatomai/sdk-node';

export const ATTACHMENTS_FOLDER = 'attachments';

/** Most files one thread can have, across all its questions. */
export const MAX_THREAD_ATTACHMENTS = 5;

/** A downloaded attachment: what the user sent, and where the agent finds it (relative to its cwd). */
export interface LocalAttachment {
	attachment: PromptAttachment;
	relativePath: string;
}

/**
 * A name that stays inside `attachments/` and doesn't overwrite an earlier
 * file: the user's name, made safe, with ` (2)`, ` (3)`… when it is taken.
 */
function freeName(dir: string, fileName: string): string {
	const safe = path.basename(fileName).replace(/[^a-zA-Z0-9._ -]/g, '_').trim() || 'file';
	const ext = path.extname(safe);
	const stem = safe.slice(0, safe.length - ext.length);
	let name = safe;
	for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem} (${n})${ext}`;
	return name;
}

/** A short-lived URL for one R2 object, from sa-api (which holds the R2 credentials). */
async function signedUrl(key: string): Promise<string> {
	const apiBase = process.env.SA_API_URL;
	const serviceToken = process.env.SA_INTERNAL_SERVICE_TOKEN;
	if (!apiBase) throw new Error('SA_API_URL is not set — required for chat attachments');
	if (!serviceToken) throw new Error('SA_INTERNAL_SERVICE_TOKEN is not set — required for chat attachments');

	const res = await fetch(`${apiBase.replace(/\/$/, '')}/upload/chat-attachment/signed-get`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-SA-Service-Token': serviceToken },
		body: JSON.stringify({ key }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`could not get a download URL (HTTP ${res.status}) ${text}`.trim());
	}
	return ((await res.json()) as { url: string }).url;
}

/** What a failed download's error starts with, so the provider can show it as it is. */
export const ATTACHMENT_LOAD_ERROR = 'Could not load the attached file';

/**
 * Downloads each attachment into `<cwd>/attachments/`. Throws on the first file
 * that can't be fetched — naming it — and removes any it had already written,
 * so a failed question leaves nothing behind for the agent to find later.
 */
export async function downloadAttachments(cwd: string, attachments: PromptAttachment[]): Promise<LocalAttachment[]> {
	const dir = path.join(cwd, ATTACHMENTS_FOLDER);
	await fs.promises.mkdir(dir, { recursive: true });

	const done: LocalAttachment[] = [];
	try {
		for (const attachment of attachments) {
			const name = freeName(dir, attachment.fileName);
			const target = path.join(dir, name);
			try {
				const res = await fetch(await signedUrl(attachment.key));
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
				await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(target));
			} catch (err: any) {
				await fs.promises.rm(target, { force: true });
				throw new Error(`${ATTACHMENT_LOAD_ERROR} "${attachment.fileName}": ${err?.message ?? err}`);
			}
			done.push({ attachment, relativePath: `${ATTACHMENTS_FOLDER}/${name}` });
		}
	} catch (err) {
		await Promise.all(done.map((d) => fs.promises.rm(path.join(cwd, d.relativePath), { force: true })));
		throw err;
	}
	return done;
}

/**
 * Removes attachments from R2 through sa-api, which holds the R2 credentials.
 *
 * Best-effort: logs and moves on. A file left behind only orphans an object in
 * R2; it must never stop the thread it belonged to from being deleted.
 */
export async function deleteAttachmentsFromR2(keys: string[]): Promise<void> {
	if (!keys.length) return;
	const apiBase = process.env.SA_API_URL;
	const serviceToken = process.env.SA_INTERNAL_SERVICE_TOKEN;
	if (!apiBase || !serviceToken) {
		console.warn(`[chat-attachments] Skipping R2 delete of ${keys.length} file(s): SA_API_URL or SA_INTERNAL_SERVICE_TOKEN not set`);
		return;
	}

	await Promise.all(
		keys.map(async (key) => {
			try {
				const res = await fetch(`${apiBase.replace(/\/$/, '')}/upload/chat-attachment/delete`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'X-SA-Service-Token': serviceToken },
					body: JSON.stringify({ key }),
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					console.warn(`[chat-attachments] R2 delete failed for ${key}: HTTP ${res.status} ${text}`);
				}
			} catch (err: any) {
				console.warn(`[chat-attachments] R2 delete failed for ${key}: ${err?.message ?? err}`);
			}
		}),
	);
}

function sizeLabel(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/**
 * The note that goes ahead of the question when it came with files: only which
 * files, since that changes per question. How to work with them is standing
 * instruction — the "Attached files" section of system.md (a shared graph part).
 * Sent to the agent only — the saved question is the one the user typed.
 */
export function attachmentsNote(files: LocalAttachment[]): string {
	const lines = files.map(
		({ attachment, relativePath }) => `- \`${relativePath}\` — "${attachment.fileName}", ${sizeLabel(attachment.size)}`,
	);
	return [`Attached to this question (refer to each by its name, not its path):`, ...lines].join('\n');
}
