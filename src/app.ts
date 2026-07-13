#!/usr/bin/env node

import { SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/render";
import { program } from "commander";
import dotenv from "dotenv";
import fs from "fs-extra";
import inquirer from "inquirer";
import { createHash } from "node:crypto";
import * as React from "react";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { confirmCampaignSend } from "./confirmation.js";
import { fetchCsvSnapshot, fetchSuppressedEmailSet } from "./list-service.js";
import { applyPlaceholders, createPerSecondRateLimiter, sendWithRetry, type TemplateProps } from "./mailer.js";
import { readRecipientCsv, readRecipientCsvText } from "./recipients.js";
import { fetchSesSuppressedEmailSet, mergeSuppressionSets, verifySesPreflight } from "./ses-service.js";
import { checkpointSentMessage, loadSentEmailSet, SentLogCheckpointError } from "./sent-log.js";
import {
	buildRecipientUnsubscribeUrl,
	deduplicateRecipients,
	isValidCampaignId,
	normalizeEmail,
} from "./utils.js";

dotenv.config();
const { env } = process;

type TemplateModule = {
	default: (props: TemplateProps) => React.ReactElement;
	subject?: string;
};

// Parse the command line arguments
let {
	dev,
	templateDir,
	template,
	file,
	subscriberExportUrl,
	subscriberExportToken,
	from,
	fromName,
	subject,
	region,
	configurationSet,
	unsubscribeBaseUrl,
	unsubscribeSecret,
	unsubscribeUrl,
	suppressionCheckUrl,
	suppressionCheckToken,
	maxPerSecond,
	sentLogFile,
	concurrency,
	batchSize,
	batchDelayMs,
	maxAttempts,
	baseDelayMs,
	campaignId,
	dryRun,
	fetchTimeoutMs,
	maxExportBytes,
	maxSuppressionPageBytes,
	yes,
} = program
	.option("-v, --dev", "Run in development mode")
	.option("-d, --template-dir <templateDir>", "The path to the templates directory")
	.option("-t, --template <template>", "The React Email template filename to send")
	.option("-c, --file <file>", "The CSV file to read")
	.option(
		"--subscriber-export-url <subscriberExportUrl>",
		"Authenticated email list CSV export URL (takes the place of --file)",
	)
	.option(
		"--subscriber-export-token <subscriberExportToken>",
		"Bearer token for the authenticated email list CSV export",
	)
	.option("-f, --from <from>", "The email address to send from")
	.option("--from-name <fromName>", "Display name for the sender (e.g. 'Daniel Thorp')")
	.option("-s, --subject <subject>", "Fallback subject if row does not define subject")
	.option("-r, --region <region>", "AWS SES region (defaults to AWS_REGION)")
	.option("--configuration-set <configurationSet>", "SES configuration set name")
	.option(
		"--unsubscribe-base-url <unsubscribeBaseUrl>",
		"Base URL for one-click unsubscribe endpoint (e.g. https://emails.hackthehill.com/unsubscribe)",
	)
	.option("--unsubscribe-secret <unsubscribeSecret>", "Secret used to sign unsubscribe tokens")
	.option("--unsubscribe-url <unsubscribeUrl>", "URL for List-Unsubscribe header (RFC 8058)")
	.option(
		"--suppression-check-url <suppressionCheckUrl>",
		"Authenticated URL used to sync suppression list (required)",
	)
	.option(
		"--suppression-check-token <suppressionCheckToken>",
		"Bearer token used for suppression sync endpoint authorization (required)",
	)
	.option("--max-per-second <maxPerSecond>", "Maximum SES send attempts per second", Number)
	.option("--sent-log-file <sentLogFile>", "Path to JSONL file tracking successful sends")
	.option("--concurrency <concurrency>", "Maximum concurrent sends per batch", Number)
	.option("--batch-size <batchSize>", "How many emails to send per batch", Number)
	.option("--batch-delay-ms <batchDelayMs>", "Delay between batches in milliseconds", Number)
	.option("--max-attempts <maxAttempts>", "Retry attempts per email", Number)
	.option("--base-delay-ms <baseDelayMs>", "Base retry delay in milliseconds", Number)
	.option("--campaign-id <campaignId>", "Stable identifier used to scope resume logs (required)")
	.option("--dry-run", "Download, validate, and summarize the campaign without sending")
	.option("--fetch-timeout-ms <fetchTimeoutMs>", "Timeout for list service requests in milliseconds", Number)
	.option("--max-export-bytes <maxExportBytes>", "Maximum CSV export size in bytes", Number)
	.option(
		"--max-suppression-page-bytes <maxSuppressionPageBytes>",
		"Maximum suppression response page size in bytes",
		Number,
	)
	.option("--yes", "Skip the final interactive send confirmation")
	.parse()
	.opts();

dev ??= env.NODE_ENV === "development";
subscriberExportUrl ??= env.SUBSCRIBER_EXPORT_URL;
subscriberExportToken ??= env.SUBSCRIBER_EXPORT_TOKEN;
region ??= env.AWS_REGION;
subject ??= env.EMAIL_SUBJECT;
fromName ??= env.EMAIL_FROM_NAME;
unsubscribeBaseUrl ??= env.UNSUBSCRIBE_BASE_URL;
unsubscribeSecret ??= env.UNSUBSCRIBE_SECRET;
unsubscribeUrl ??= env.UNSUBSCRIBE_URL;
suppressionCheckUrl ??= env.SUPPRESSION_CHECK_URL;
suppressionCheckToken ??= env.SUPPRESSION_CHECK_TOKEN;
maxPerSecond ??= Number(env.SES_MAX_PER_SECOND ?? 14);
sentLogFile ??= env.SENT_LOG_FILE;
concurrency ??= Number(env.SEND_CONCURRENCY ?? 25);
batchSize ??= Number(env.BATCH_SIZE ?? 10);
batchDelayMs ??= Number(env.BATCH_DELAY_MS ?? 1200);
maxAttempts ??= Number(env.MAX_ATTEMPTS ?? 5);
baseDelayMs ??= Number(env.BASE_DELAY_MS ?? 500);
configurationSet ??= env.SES_CONFIGURATION_SET;
campaignId ??= env.CAMPAIGN_ID;
fetchTimeoutMs ??= Number(env.FETCH_TIMEOUT_MS ?? 15_000);
maxExportBytes ??= Number(env.MAX_EXPORT_BYTES ?? 25 * 1024 * 1024);
maxSuppressionPageBytes ??= Number(env.MAX_SUPPRESSION_PAGE_BYTES ?? 2 * 1024 * 1024);

if (!campaignId || !isValidCampaignId(campaignId)) {
	throw new Error(
		"campaign-id is required and must contain only letters, numbers, dots, underscores, or hyphens (maximum 128 characters)",
	);
}

if (!Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
	throw new Error("fetch-timeout-ms must be a positive integer");
}

if (!Number.isInteger(maxExportBytes) || maxExportBytes <= 0) {
	throw new Error("max-export-bytes must be a positive integer");
}

if (!Number.isInteger(maxSuppressionPageBytes) || maxSuppressionPageBytes <= 0) {
	throw new Error("max-suppression-page-bytes must be a positive integer");
}

sentLogFile ??= env.SENT_LOG_FILE ?? `.sent-emails-${campaignId}.jsonl`;

// Ask for the template directory
templateDir ??= (
	await inquirer.prompt<{ templateDir: string }>({
		name: "templateDir",
		type: "input",
		message: "Enter the path to the templates directory",
		default: "templates",
	})
)?.templateDir;
// Validate the template directory
if (!templateDir || !(await fs.pathExists(templateDir))) {
	throw new Error("Please specify the templates directory");
}

// Ask for the template
const choices = (await fs.readdir(templateDir)).filter(name => /\.(tsx|ts|jsx|js)$/i.test(name));

if (choices.length === 0) {
	throw new Error("No React Email template files were found in the templates directory");
}

template ??= (
	await inquirer.prompt<{ template: string }>({
		name: "template",
		type: "list",
		message: "Which React Email template do you want to use?",
		choices,
	})
)?.template;
// Validate the template
if (!template || !choices.includes(template)) {
	throw new Error("Please specify the template to send");
}

const templatePath = `${templateDir}/${template}`;

let subscriberSnapshotSha256: string | undefined;
let subscriberSnapshotCsv: string | undefined;

if (subscriberExportUrl && file) {
	throw new Error("Use either --file or --subscriber-export-url, not both");
}

if (!subscriberExportUrl && subscriberExportToken) {
	throw new Error("--subscriber-export-token requires --subscriber-export-url");
}

if (subscriberExportUrl) {
	const parsed = z.string().url().safeParse(subscriberExportUrl);
	if (!parsed.success || !subscriberExportToken) {
		throw new Error(
			"Both --subscriber-export-url and --subscriber-export-token (or SUBSCRIBER_EXPORT_URL and SUBSCRIBER_EXPORT_TOKEN) are required",
		);
	}

	subscriberSnapshotCsv = await fetchCsvSnapshot({
		url: subscriberExportUrl,
		token: subscriberExportToken,
		timeoutMs: fetchTimeoutMs,
		maxBytes: maxExportBytes,
	});
	if (!subscriberSnapshotCsv.trim()) {
		throw new Error("Subscriber export endpoint returned an empty response");
	}

	subscriberSnapshotSha256 = createHash("sha256").update(subscriberSnapshotCsv, "utf8").digest("hex");
	console.info(`Downloaded subscriber CSV snapshot (${subscriberSnapshotSha256})`);
} else {
	// Ask for a local CSV file when an authenticated export is not configured.
	file ??= (
		await inquirer.prompt<{ file: string }>({
			name: "file",
			type: "input",
			message: "Enter the path to a CSV file with name, email, and language columns",
			default: "emails.csv",
		})
	)?.file;
}

// Validate the CSV file
if (!subscriberSnapshotCsv && (!file || !(await fs.pathExists(file)) || !z.string().endsWith(".csv").safeParse(file).success)) {
	throw new Error("Please specify a CSV file to read");
}

// Ask only if sender address is not provided via CLI/env.
if (!from) {
	const envFrom = env.EMAIL_FROM;
	if (envFrom && z.string().email().safeParse(envFrom).success) {
		from = envFrom;
	} else {
		from = (
			await inquirer.prompt<{ from: string }>({
				name: "from",
				type: "input",
				message: "Enter the email address to send from",
				default: env.EMAIL_FROM,
			})
		)?.from;
	}
}
// Validate the email address to send from
if (!from || !z.string().email().safeParse(from).success) {
	throw new Error("Please specify an email address to send from");
}

if (!region || !z.string().min(1).safeParse(region).success) {
	throw new Error("Please specify AWS region (e.g. us-east-1)");
}

if (!configurationSet) {
	throw new Error("Please specify the SES configuration set");
}

if (!Number.isFinite(batchSize) || batchSize <= 0) {
	throw new Error("batch-size must be a positive number");
}

if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) {
	throw new Error("batch-delay-ms must be zero or a positive number");
}

if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
	throw new Error("max-attempts must be a positive number");
}

if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
	throw new Error("base-delay-ms must be a positive number");
}

if (!Number.isFinite(maxPerSecond) || maxPerSecond <= 0) {
	throw new Error("max-per-second must be a positive number");
}

if (!Number.isFinite(concurrency) || concurrency <= 0) {
	throw new Error("concurrency must be a positive number");
}

if ((unsubscribeBaseUrl && !unsubscribeSecret) || (!unsubscribeBaseUrl && unsubscribeSecret)) {
	throw new Error(
		"When using tokenized unsubscribe, both --unsubscribe-base-url and --unsubscribe-secret are required",
	);
}

if (unsubscribeBaseUrl) {
	const parsed = z.string().url().safeParse(unsubscribeBaseUrl);
	if (!parsed.success) {
		throw new Error("unsubscribe-base-url must be a valid URL");
	}
}

if (unsubscribeUrl) {
	const parsed = z.string().url().safeParse(unsubscribeUrl);
	if (!parsed.success) {
		throw new Error("unsubscribe-url must be a valid URL");
	}
}

if (!suppressionCheckUrl || !suppressionCheckToken) {
	throw new Error(
		"Suppression sync is required. Set both --suppression-check-url and --suppression-check-token (or SUPPRESSION_CHECK_URL and SUPPRESSION_CHECK_TOKEN)",
	);
}

const suppressionUrlResult = z.string().url().safeParse(suppressionCheckUrl);
if (!suppressionUrlResult.success) {
	throw new Error("suppression-check-url must be a valid URL");
}

const templateModule = (await import(pathToFileURL(templatePath).toString())) as TemplateModule;
if (typeof templateModule.default !== "function") {
	throw new TypeError(`Template ${template} must export a default React component`);
}

const templateSubject = typeof templateModule.subject === "string" ? templateModule.subject : undefined;

const ses = new SESv2Client({ region });

const sesIdentity = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
console.info(`Checking SES account, identity ${sesIdentity}, and configuration set ${configurationSet}...`);
await verifySesPreflight({ client: ses, identity: sesIdentity, configurationSet });

const recipients: TemplateProps[] = subscriberSnapshotCsv
	? readRecipientCsvText(subscriberSnapshotCsv)
	: await readRecipientCsv(file!);

const deduplicated = deduplicateRecipients(recipients as Array<{ email: string; [key: string]: unknown }>);
const uniqueRecipients = deduplicated.recipients as TemplateProps[];
if (deduplicated.duplicates > 0) {
	console.info(`Removed ${deduplicated.duplicates} duplicate recipient row(s).`);
}

if (uniqueRecipients.length === 0) {
	console.info("No recipients were found in CSV");
	process.exit(0);
}

const alreadySentEmails = await loadSentEmailSet(sentLogFile, campaignId);
console.info(`Loaded ${alreadySentEmails.size} already-sent address(es) from ${sentLogFile}.`);

console.info("Syncing email-list-manager and SES suppression lists...");
const listManagerSuppressions = await fetchSuppressedEmailSet({
	endpointUrl: suppressionCheckUrl,
	bearerToken: suppressionCheckToken,
	timeoutMs: fetchTimeoutMs,
	maxPageBytes: maxSuppressionPageBytes,
});
const sesSuppressions = await fetchSesSuppressedEmailSet(ses);
const suppressedEmails = mergeSuppressionSets(listManagerSuppressions, sesSuppressions);
console.info(
	`Suppression sync complete: ${listManagerSuppressions.size} email-list-manager, ${sesSuppressions.size} SES, ${suppressedEmails.size} unique.`,
);

const pendingRecipients: TemplateProps[] = [];
let skippedAlreadySent = 0;
let skippedSuppressed = 0;
let skippedListManagerSuppressed = 0;
let skippedSesSuppressed = 0;
let skippedByBothSuppressionSources = 0;
for (const recipient of uniqueRecipients) {
	const recipientEmail = String(recipient.email);
	const normalizedRecipientEmail = normalizeEmail(recipientEmail);

	if (alreadySentEmails.has(normalizedRecipientEmail)) {
		skippedAlreadySent++;
		continue;
	}

	const listManagerSuppressed = listManagerSuppressions.has(normalizedRecipientEmail);
	const sesSuppressed = sesSuppressions.has(normalizedRecipientEmail);
	if (listManagerSuppressed || sesSuppressed) {
		skippedSuppressed++;
		if (listManagerSuppressed) skippedListManagerSuppressed++;
		if (sesSuppressed) skippedSesSuppressed++;
		if (listManagerSuppressed && sesSuppressed) skippedByBothSuppressionSources++;
		continue;
	}

	pendingRecipients.push(recipient);
}

let missingSubjectCount = 0;
for (const recipient of pendingRecipients) {
	const rowSubject = typeof recipient.subject === "string" ? recipient.subject : undefined;
	const rawSubject = templateSubject ?? subject ?? rowSubject;
	if (!rawSubject || !applyPlaceholders(rawSubject, recipient)) {
		missingSubjectCount++;
	}
}

console.info(
	`Campaign ${campaignId}: ${uniqueRecipients.length} unique recipient(s), ${skippedAlreadySent} already sent, ${skippedSuppressed} suppressed, ${pendingRecipients.length} pending${missingSubjectCount > 0 ? `, ${missingSubjectCount} missing subject(s)` : ""}.`,
);
if (skippedSuppressed > 0) {
	console.info(
		`Excluded by suppression source: ${skippedListManagerSuppressed} email-list-manager, ${skippedSesSuppressed} SES, ${skippedByBothSuppressionSources} present in both.`,
	);
}

if (dryRun) {
	if (pendingRecipients.length > 0 && missingSubjectCount < pendingRecipients.length) {
		const sample = pendingRecipients.find(recipient => {
			const rowSubject = typeof recipient.subject === "string" ? recipient.subject : undefined;
			const rawSubject = templateSubject ?? subject ?? rowSubject;
			return rawSubject && applyPlaceholders(rawSubject, recipient);
		});
		if (sample) {
			const rowSubject = typeof sample.subject === "string" ? sample.subject : undefined;
			const rawSubject = templateSubject ?? subject ?? rowSubject;
			await render(React.createElement(templateModule.default, sample));
			console.info(`Dry run template validation succeeded (subject: ${applyPlaceholders(rawSubject!, sample)}).`);
		}
	}
	if (missingSubjectCount > 0) {
		throw new Error(`${missingSubjectCount} pending recipient(s) have no usable subject`);
	}
	console.info("Dry run complete; no messages were sent.");
	process.exit(0);
}

if (pendingRecipients.length === 0) {
	console.info("No pending recipients remain after resume and suppression checks.");
	process.exit(0);
}

console.info([
	"Ready to send:",
	`  Campaign: ${campaignId}`,
	`  Recipients: ${pendingRecipients.length}`,
	`  Sender: ${fromName ? `${fromName} <${from}>` : from}`,
	`  SES configuration set: ${configurationSet}`,
	"  Dry run: no",
].join("\n"));
const confirmed = await confirmCampaignSend({
	yes: Boolean(yes),
	prompt: async message => (await inquirer.prompt<{ confirmed: boolean }>({
		name: "confirmed",
		type: "confirm",
		message,
		default: false,
	})).confirmed,
});
if (!confirmed) {
	console.info("Campaign cancelled; no messages were sent.");
	process.exit(0);
}

const rateLimiter = createPerSecondRateLimiter(maxPerSecond);

console.info(
	`Sending ${pendingRecipients.length} message(s) to AWS SES in batches of ${batchSize} with concurrency ${concurrency} and max ${maxPerSecond}/sec...`,
);

let sent = 0;
const failures: Array<{ email: string; reason: string }> = [];
for (let i = 0; i < pendingRecipients.length; i += batchSize) {
	const batch = pendingRecipients.slice(i, i + batchSize);
	await processWithConcurrency(batch, concurrency, async recipient => {
		const recipientEmail = String(recipient.email);
		const normalizedRecipientEmail = normalizeEmail(recipientEmail);

		const rowSubject = typeof recipient.subject === "string" ? recipient.subject : undefined;
		const rawSubject = templateSubject ?? subject ?? rowSubject;
		const messageSubject = rawSubject ? applyPlaceholders(rawSubject, recipient) : undefined;
		const generatedUnsubscribeUrl = buildRecipientUnsubscribeUrl({
			baseUrl: unsubscribeBaseUrl,
			secret: unsubscribeSecret,
			email: recipientEmail,
			staticUrl: unsubscribeUrl,
		});
		const recipientWithComputedUrls = generatedUnsubscribeUrl
			? { ...recipient, unsubscribeUrl: generatedUnsubscribeUrl }
			: recipient;

		if (!messageSubject) {
			failures.push({
				email: recipientEmail,
				reason: 'Missing subject. Add `export const subject = "..."` to template, set --subject, or add subject column',
			});
			return;
		}

		try {
			const messageId = await sendWithRetry({
				ses,
				from,
				fromName,
				templateComponent: templateModule.default,
				recipient: recipientWithComputedUrls,
				subject: messageSubject,
				maxAttempts,
				baseDelayMs,
				configurationSet,
				rateLimiter,
				unsubscribeUrl: generatedUnsubscribeUrl,
				dev,
			});

			await checkpointSentMessage(sentLogFile, {
				email: normalizedRecipientEmail,
				campaignId,
				messageId,
				timestamp: new Date().toISOString(),
				subscriberSnapshotSha256,
			});
			alreadySentEmails.add(normalizedRecipientEmail);
			sent++;
		} catch (error) {
			if (error instanceof SentLogCheckpointError) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ email: recipientEmail, reason });
		}
	});

	const nextStart = i + batch.length;
	if (nextStart < pendingRecipients.length && batchDelayMs > 0) {
		console.info(
			`Batch complete (${nextStart}/${pendingRecipients.length}). Waiting ${batchDelayMs}ms before next batch...`,
		);
		await sleep(batchDelayMs);
	}
}

console.info(
	`Done. Sent: ${sent}, Already-sent skipped: ${skippedAlreadySent}, Suppressed skipped: ${skippedSuppressed}, Failed: ${failures.length}`,
);
if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`- ${failure.email}: ${failure.reason}`);
	}
	process.exitCode = 1;
}

async function processWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	if (items.length === 0) {
		return;
	}

	const effectiveLimit = Math.max(1, Math.min(limit, items.length));
	let cursor = 0;

	let fatalError: unknown;
	const runners = Array.from({ length: effectiveLimit }, async () => {
		while (cursor < items.length && fatalError === undefined) {
			const index = cursor;
			cursor++;
			try {
				await worker(items[index]);
			} catch (error) {
				fatalError ??= error;
			}
		}
	});

	await Promise.all(runners);
	if (fatalError !== undefined) throw fatalError;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
