/**
 * Email Service — sends alert notification emails via Resend
 *
 * Replaces the mock email system for alert notifications.
 * Falls back to console logging if RESEND_API_KEY is not configured.
 */

interface AlertEmailParams {
	recipients: string[];
	alertName: string;
	reportName: string;
	reportUrl?: string;
	chatUrl?: string;
	projectName?: string;
	sourceName?: string;
	metricDescription: string;
	currentValue: number;
	reason: string;
	analysis: string | null;
	checkedAt: string;
	emailSubject?: string;
}

/**
 * Send an alert notification email
 */
export async function sendAlertEmail(params: AlertEmailParams): Promise<{ success: boolean; error?: string }> {
	const {
		recipients,
		alertName,
		reportName,
		reportUrl,
		projectName,
		sourceName,
		metricDescription,
		currentValue,
		reason,
		analysis,
		checkedAt,
		emailSubject,
	} = params;

	if (!recipients || recipients.length === 0) {
		return { success: false, error: 'No recipients specified' };
	}

	const subject = emailSubject || `[Alert] ${alertName}`;
	const html = buildAlertEmailHtml({
		alertName,
		reportName,
		reportUrl,
		chatUrl: params.chatUrl,
		projectName,
		sourceName,
		metricDescription,
		currentValue,
		reason,
		analysis,
		checkedAt,
	});

	const apiKey = process.env.RESEND_API_KEY;
	const fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@superatom.ai';

	if (!apiKey) {
		// No Resend key — log to console instead
		console.log('[EMAIL-SERVICE] RESEND_API_KEY not set. Email would be sent:');
		console.log(`  To: ${recipients.join(', ')}`);
		console.log(`  Subject: ${subject}`);
		console.log(`  Alert: ${alertName}`);
		console.log(`  Metric: ${metricDescription} = ${currentValue}`);
		console.log(`  Reason: ${reason}`);
		if (analysis) {
			console.log(`  Analysis: ${analysis.substring(0, 200)}...`);
		}
		return { success: true };
	}

	try {
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: fromEmail,
				to: recipients,
				subject,
				html,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('[EMAIL-SERVICE] Resend API error:', response.status, errorText);
			return { success: false, error: `Resend API error: ${response.status}` };
		}

		console.log(`[EMAIL-SERVICE] Alert email sent to ${recipients.length} recipients for "${alertName}"`);
		return { success: true };
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[EMAIL-SERVICE] Failed to send email:', errorMsg);
		return { success: false, error: errorMsg };
	}
}

/**
 * Build the HTML email body for an alert notification
 */
function buildAlertEmailHtml(params: {
	alertName: string;
	reportName: string;
	reportUrl?: string;
	chatUrl?: string;
	projectName?: string;
	sourceName?: string;
	metricDescription: string;
	currentValue: number;
	reason: string;
	analysis: string | null;
	checkedAt: string;
}): string {
	const { alertName, reportName, reportUrl, chatUrl, projectName, sourceName, metricDescription, currentValue, reason, analysis, checkedAt } = params;

	const formattedDate = new Date(checkedAt).toLocaleString('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC',
	}) + ' UTC';

	const analysisSection = analysis
		? `
		<tr>
			<td style="padding: 24px 32px;">
				<h2 style="margin: 0 0 16px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Analysis</h2>
				<div>${markdownToEmailHtml(analysis)}</div>
			</td>
		</tr>
		<tr><td style="padding: 0 32px;"><hr style="border: none; border-top: 1px solid #e5e7eb;" /></td></tr>
		`
		: '';

	return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
	<table width="100%" cellpadding="0" cellspacing="0" style="padding: 32px 0;">
		<tr>
			<td align="center">
				<table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
					<!-- Header -->
					<tr>
						<td style="padding: 32px; background: #dc2626; border-radius: 8px 8px 0 0;">
							<h1 style="margin: 0; font-size: 20px; color: #ffffff;">ALERT TRIGGERED</h1>
							<p style="margin: 8px 0 0 0; font-size: 14px; color: #fecaca;">
								Report: ${escapeHtml(reportName)}${projectName ? ` | Project: ${escapeHtml(projectName)}` : ''}
							</p>
						</td>
					</tr>
					<!-- Metric Details -->
					<tr>
						<td style="padding: 24px 32px;">
							<h2 style="margin: 0 0 16px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Metric</h2>
							<table cellpadding="0" cellspacing="0" style="font-size: 14px; color: #374151;">
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Alert:</td>
									<td style="padding: 4px 0; font-weight: 600;">${escapeHtml(alertName)}</td>
								</tr>
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Monitoring:</td>
									<td style="padding: 4px 0;">"${escapeHtml(metricDescription)}"</td>
								</tr>
								${sourceName ? `<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Source:</td>
									<td style="padding: 4px 0;">${escapeHtml(sourceName)}</td>
								</tr>` : ''}
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Current Value:</td>
									<td style="padding: 4px 0; font-weight: 600; font-size: 18px; color: #dc2626;">${currentValue.toLocaleString()}</td>
								</tr>
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Status:</td>
									<td style="padding: 4px 0; font-weight: 600; color: #dc2626;">${escapeHtml(reason)}</td>
								</tr>
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Checked At:</td>
									<td style="padding: 4px 0;">${formattedDate}</td>
								</tr>
							</table>
						</td>
					</tr>
					<tr><td style="padding: 0 32px;"><hr style="border: none; border-top: 1px solid #e5e7eb;" /></td></tr>
					<!-- Analysis -->
					${analysisSection}
					<!-- Action Buttons -->
					${reportUrl || chatUrl ? `
					<tr>
						<td style="padding: 24px 32px;" align="center">
							<table cellpadding="0" cellspacing="0"><tr>
								${reportUrl ? `<td style="padding: 0 8px;">
									<a href="${escapeHtml(reportUrl)}" target="_blank" style="display: inline-block; padding: 12px 32px; background-color: #009193; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 6px;">
										View Full Report
									</a>
								</td>` : ''}
								${chatUrl ? `<td style="padding: 0 8px;">
									<a href="${escapeHtml(chatUrl)}" target="_blank" style="display: inline-block; padding: 12px 32px; background-color: #1e40af; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 6px;">
										Dig Deeper with AI
									</a>
								</td>` : ''}
							</tr></table>
						</td>
					</tr>
					<tr><td style="padding: 0 32px;"><hr style="border: none; border-top: 1px solid #e5e7eb;" /></td></tr>
					` : ''}
					<!-- Footer -->
					<tr>
						<td style="padding: 24px 32px; font-size: 12px; color: #9ca3af;">
							You received this because you're subscribed to alerts for "${escapeHtml(reportName)}".
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
}

/**
 * Scheduled Report Email
 */

interface ScheduledReportEmailParams {
	recipients: string[];
	reportName: string;
	reportUrl?: string;
	frequency?: string;
	time?: string;
	timezone?: string;
	emailSubject?: string;
	emailBody?: string;
	/**
	 * When true this is an immediate "send now" delivery (not a recurring
	 * schedule), so the recurring-schedule line is omitted and the copy is
	 * adjusted. frequency/time/timezone are ignored in this mode.
	 */
	immediate?: boolean;
}

/**
 * Defaults used when the user hasn't supplied a custom subject/body.
 * Kept in sync with the UI defaults in ScheduleReportDialog.tsx.
 */
export const DEFAULT_REPORT_EMAIL_SUBJECT = (reportName: string) =>
	`Scheduled Report: ${reportName}`;

export const DEFAULT_REPORT_EMAIL_BODY =
	`Hi,\n\nYour scheduled report is ready for review. Click the button below to view the latest data.\n\nBest,\nThe team`;

export async function sendScheduledReportEmail(params: ScheduledReportEmailParams): Promise<{ success: boolean; error?: string }> {
	const { recipients, reportName, reportUrl, frequency, time, timezone, emailSubject, emailBody, immediate } = params;

	if (!recipients || recipients.length === 0) {
		return { success: false, error: 'No recipients specified' };
	}

	const subject = (emailSubject && emailSubject.trim())
		? emailSubject.trim()
		: (immediate ? `Report: ${reportName}` : DEFAULT_REPORT_EMAIL_SUBJECT(reportName));
	const bodyMarkdown = (emailBody && emailBody.trim()) ? emailBody : DEFAULT_REPORT_EMAIL_BODY;
	const bodyHtml = markdownToEmailHtml(bodyMarkdown);

	// The recurring-schedule line only applies to scheduled deliveries.
	const showScheduleRow = !immediate && !!frequency;
	const timezoneDisplay = timezone ? (timezone.split('/')[1]?.replace('_', ' ') || timezone) : '';
	const scheduleRowHtml = showScheduleRow
		? `<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Schedule:</td>
									<td style="padding: 4px 0;">${escapeHtml(frequency!)}${time ? ` at ${escapeHtml(time)}` : ''}${timezoneDisplay ? ` (${escapeHtml(timezoneDisplay)})` : ''}</td>
								</tr>`
		: '';
	const headerTitle = immediate ? 'Report Ready' : 'Scheduled Report Ready';
	const footerText = immediate
		? `You received this report because it was shared with you.`
		: `You received this because you're subscribed to scheduled delivery of "${escapeHtml(reportName)}".`;

	const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
	<table width="100%" cellpadding="0" cellspacing="0" style="padding: 32px 0;">
		<tr>
			<td align="center">
				<table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
					<tr>
						<td style="padding: 32px; background: #009193; border-radius: 8px 8px 0 0;">
							<h1 style="margin: 0; font-size: 20px; color: #ffffff;">${headerTitle}</h1>
							<p style="margin: 8px 0 0 0; font-size: 14px; color: #b2dfdb;">${escapeHtml(reportName)}</p>
						</td>
					</tr>
					<tr>
						<td style="padding: 24px 32px;">
							<div style="margin: 0 0 16px 0;">${bodyHtml}</div>
							<table cellpadding="0" cellspacing="0" style="font-size: 14px; color: #374151;">
								${scheduleRowHtml}
								<tr>
									<td style="padding: 4px 16px 4px 0; color: #6b7280;">Generated:</td>
									<td style="padding: 4px 0;">${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</td>
								</tr>
							</table>
						</td>
					</tr>
					${reportUrl ? `
					<tr>
						<td style="padding: 24px 32px;" align="center">
							<a href="${escapeHtml(reportUrl)}" target="_blank" style="display: inline-block; padding: 12px 32px; background-color: #009193; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 6px;">
								View Report
							</a>
						</td>
					</tr>` : ''}
					<tr>
						<td style="padding: 24px 32px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb;">
							${footerText}
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;

	const apiKey = process.env.RESEND_API_KEY;
	const fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@superatom.ai';

	if (!apiKey) {
		console.log('[EMAIL-SERVICE] RESEND_API_KEY not set. Scheduled report email would be sent:');
		console.log(`  To: ${recipients.join(', ')}`);
		console.log(`  Subject: ${subject}`);
		console.log(`  Report: ${reportName}`);
		return { success: true };
	}

	try {
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: fromEmail,
				to: recipients,
				subject,
				html,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('[EMAIL-SERVICE] Resend API error:', response.status, errorText);
			return { success: false, error: `Resend API error: ${response.status}` };
		}

		console.log(`[EMAIL-SERVICE] Scheduled report email sent to ${recipients.length} recipients for "${reportName}"`);
		return { success: true };
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[EMAIL-SERVICE] Failed to send scheduled report email:', errorMsg);
		return { success: false, error: errorMsg };
	}
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Convert markdown text to email-safe inline HTML.
 * Handles: headings, bold, bullet lists, numbered lists, line breaks.
 */
function markdownToEmailHtml(md: string): string {
	const lines = md.split('\n');
	const htmlLines: string[] = [];
	let inList = false;
	let listTag: 'ul' | 'ol' = 'ul';

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Headings: ## Heading
		const headingMatch = line.match(/^(#{1,3})\s+(.*)/);
		if (headingMatch) {
			if (inList) { htmlLines.push('</ul>'); inList = false; }
			const level = headingMatch[1].length;
			const sizes: Record<number, string> = { 1: '18px', 2: '16px', 3: '14px' };
			const text = applyInlineFormatting(escapeHtml(headingMatch[2]));
			htmlLines.push(`<p style="margin: 16px 0 8px 0; font-size: ${sizes[level] || '14px'}; font-weight: 700; color: #111827;">${text}</p>`);
			continue;
		}

		// Bullet list: - item or * item
		const bulletMatch = line.match(/^\s*[-*]\s+(.*)/);
		if (bulletMatch) {
			if (!inList) { htmlLines.push('<ul style="margin: 8px 0; padding-left: 20px;">'); inList = true; listTag = 'ul'; }
			const text = applyInlineFormatting(escapeHtml(bulletMatch[1]));
			htmlLines.push(`<li style="margin: 4px 0; font-size: 14px; color: #374151; line-height: 1.6;">${text}</li>`);
			continue;
		}

		// Numbered list: 1. item
		const numMatch = line.match(/^\s*\d+\.\s+(.*)/);
		if (numMatch) {
			if (!inList) { htmlLines.push('<ol style="margin: 8px 0; padding-left: 20px;">'); inList = true; listTag = 'ol'; }
			const text = applyInlineFormatting(escapeHtml(numMatch[1]));
			htmlLines.push(`<li style="margin: 4px 0; font-size: 14px; color: #374151; line-height: 1.6;">${text}</li>`);
			continue;
		}

		// Close list if we hit a non-list line
		if (inList) {
			htmlLines.push(`</${listTag}>`);
			inList = false;
		}

		// Empty line
		if (line.trim() === '') {
			continue;
		}

		// Regular paragraph
		const text = applyInlineFormatting(escapeHtml(line));
		htmlLines.push(`<p style="margin: 6px 0; font-size: 14px; color: #374151; line-height: 1.6;">${text}</p>`);
	}

	if (inList) {
		htmlLines.push(`</${listTag}>`);
	}

	return htmlLines.join('\n');
}

/**
 * Apply inline markdown formatting: **bold**, *italic*, `code`
 */
function applyInlineFormatting(html: string): string {
	// Bold: **text** or __text__
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
	// Italic: *text* or _text_ (but not inside bold)
	html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
	// Inline code: `code`
	html = html.replace(/`(.+?)`/g, '<code style="background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 13px;">$1</code>');
	return html;
}
