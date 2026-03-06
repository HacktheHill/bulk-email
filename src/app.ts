#!/usr/bin/env node

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/render";
import { program } from "commander";
import csv from "csvtojson";
import dotenv from "dotenv";
import fs from "fs-extra";
import { convert } from "html-to-text";
import inquirer from "inquirer";
import { createHmac } from "node:crypto";
import * as React from "react";
import { pathToFileURL } from "node:url";
import { z } from "zod";

dotenv.config();
const { env } = process;

type TemplateProps = Record<string, unknown>;
type TemplateModule = {
	default: (props: TemplateProps) => React.ReactElement;
	subject?: string;
};

const recipientSchema = z
	.object({
		email: z.string().email(),
		name: z.string().optional().default(""),
		language: z.string().optional().default("en"),
		subject: z.string().optional(),
	})
	.passthrough();

// Parse the command line arguments
let {
	dev,
	templateDir,
	template,
	file,
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
} = program
	.option("-v, --dev", "Run in development mode")
	.option("-d, --template-dir <templateDir>", "The path to the templates directory")
	.option("-t, --template <template>", "The React Email template filename to send")
	.option("-c, --file <file>", "The CSV file to read")
	.option("-f, --from <from>", "The email address to send from")
	.option("--from-name <fromName>", "Display name for the sender (e.g. 'Daniel Thorp')")
	.option("-s, --subject <subject>", "Fallback subject if row does not define subject")
	.option("-r, --region <region>", "AWS SES region (defaults to AWS_REGION)")
	.option("--configuration-set <configurationSet>", "SES configuration set name")
	.option(
		"--unsubscribe-base-url <unsubscribeBaseUrl>",
		"Base URL for one-click unsubscribe endpoint (e.g. https://vote.danielthorp.com/unsubscribe)",
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
	.parse()
	.opts();

dev ??= env.NODE_ENV === "development";
region ??= env.AWS_REGION;
subject ??= env.EMAIL_SUBJECT;
fromName ??= env.EMAIL_FROM_NAME;
unsubscribeBaseUrl ??= env.UNSUBSCRIBE_BASE_URL;
unsubscribeSecret ??= env.UNSUBSCRIBE_SECRET;
unsubscribeUrl ??= env.UNSUBSCRIBE_URL;
suppressionCheckUrl ??= env.SUPPRESSION_CHECK_URL;
suppressionCheckToken ??= env.SUPPRESSION_CHECK_TOKEN;
maxPerSecond ??= Number(env.SES_MAX_PER_SECOND ?? 14);
sentLogFile ??= env.SENT_LOG_FILE ?? ".sent-emails.jsonl";
concurrency ??= Number(env.SEND_CONCURRENCY ?? 25);
batchSize ??= Number(env.BATCH_SIZE ?? 10);
batchDelayMs ??= Number(env.BATCH_DELAY_MS ?? 1200);
maxAttempts ??= Number(env.MAX_ATTEMPTS ?? 5);
baseDelayMs ??= Number(env.BASE_DELAY_MS ?? 500);
configurationSet ??= env.SES_CONFIGURATION_SET;

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

// Ask for the CSV file
file ??= (
	await inquirer.prompt<{ file: string }>({
		name: "file",
		type: "input",
		message: "Enter the path to a CSV file with name, email, and language columns",
		default: "emails.csv",
	})
)?.file;
// Validate the CSV file
if (!file || !(await fs.pathExists(file)) || !z.string().endsWith(".csv").safeParse(file).success) {
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

// Create a parser
const csvParser = csv({
	trim: true,
});

// Open a file stream
fs.createReadStream(file).pipe(csvParser);

// Transform the stream
const recipients: TemplateProps[] = [];
csvParser.subscribe(row => {
	const schema = recipientSchema.safeParse(row);

	if (!schema.success) {
		console.error(`Failed to parse CSV row: ${JSON.stringify(row)}`);
		process.exit(-1);
	}

	recipients.push(schema.data);
});

// Wait for the stream to finish
await csvParser;

if (recipients.length === 0) {
	console.info("No recipients were found in CSV");
	process.exit(0);
}

const alreadySentEmails = await loadSentEmailSet(sentLogFile);
console.info(`Loaded ${alreadySentEmails.size} already-sent address(es) from ${sentLogFile}.`);

console.info("Syncing suppression list...");
const suppressedEmails = await fetchSuppressedEmailSet({
	endpointUrl: suppressionCheckUrl,
	bearerToken: suppressionCheckToken,
});
console.info(`Suppression sync complete. Loaded ${suppressedEmails.size} suppressed address(es).`);

const rateLimiter = createPerSecondRateLimiter(maxPerSecond);

console.info(
	`Sending ${recipients.length} message(s) to AWS SES in batches of ${batchSize} with concurrency ${concurrency} and max ${maxPerSecond}/sec...`,
);

let sent = 0;
let skippedAlreadySent = 0;
let skippedSuppressed = 0;
const failures: Array<{ email: string; reason: string }> = [];
for (let i = 0; i < recipients.length; i += batchSize) {
	const batch = recipients.slice(i, i + batchSize);
	await processWithConcurrency(batch, concurrency, async recipient => {
			const recipientEmail = String(recipient.email);
			const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();

			if (alreadySentEmails.has(normalizedRecipientEmail)) {
				skippedAlreadySent++;
				return;
			}

			if (suppressedEmails.has(normalizedRecipientEmail)) {
				skippedSuppressed++;
				console.info(`Skipping suppressed recipient: ${recipientEmail}`);
				return;
			}

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
				});

				alreadySentEmails.add(normalizedRecipientEmail);
				await appendSentRecord(sentLogFile, {
					email: normalizedRecipientEmail,
					messageId,
					timestamp: new Date().toISOString(),
				});
				sent++;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				failures.push({ email: recipientEmail, reason });
			}
		});

	const nextStart = i + batch.length;
	if (nextStart < recipients.length && batchDelayMs > 0) {
		console.info(
			`Batch complete (${nextStart}/${recipients.length}). Waiting ${batchDelayMs}ms before next batch...`,
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
}

type SendWithRetryInput = {
	ses: SESv2Client;
	from: string;
	fromName?: string;
	templateComponent: (props: TemplateProps) => React.ReactElement;
	recipient: TemplateProps;
	subject: string;
	maxAttempts: number;
	baseDelayMs: number;
	configurationSet?: string;
	rateLimiter: RateLimiter;
	unsubscribeUrl?: string;
};

async function sendWithRetry(input: SendWithRetryInput): Promise<string | undefined> {
	const {
		ses,
		from,
		fromName,
		templateComponent,
		recipient,
		subject,
		maxAttempts,
		baseDelayMs,
		configurationSet,
		rateLimiter,
		unsubscribeUrl,
	} = input;

	const toAddress = String(recipient.email);
	const fromAddress = fromName ? `${fromName} <${from}>` : from;
	const renderedHtml = await render(React.createElement(templateComponent, recipient));
	const html = applyPlaceholders(renderedHtml, recipient);
	const text = convert(html, {
		wordwrap: 120,
		selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
	});

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await rateLimiter.acquire();

			const headers = unsubscribeUrl
				? [
						{ Name: "List-Unsubscribe", Value: `<${unsubscribeUrl}>` },
						{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
					]
				: undefined;

			const command = new SendEmailCommand({
				FromEmailAddress: fromAddress,
				Destination: {
					ToAddresses: [toAddress],
				},
				Content: {
					Simple: {
						Subject: { Data: subject, Charset: "UTF-8" },
						Body: {
							Html: { Data: html, Charset: "UTF-8" },
							Text: { Data: text, Charset: "UTF-8" },
						},
						Headers: headers,
					},
				},
				ConfigurationSetName: configurationSet,
			});

			const result = await ses.send(command);
			if (dev) {
				console.info(`Sent to ${toAddress}: ${result.MessageId ?? "<no-id>"}`);
			}
			return result.MessageId;
		} catch (error) {
			const shouldRetry = isRetryableSesError(error);
			const isLastAttempt = attempt === maxAttempts;

			if (!shouldRetry || isLastAttempt) {
				throw error;
			}

			const delay = computeBackoffDelay(baseDelayMs, attempt);
			console.warn(
				`Retrying ${toAddress} after error (attempt ${attempt}/${maxAttempts}). Waiting ${delay}ms...`,
			);
			await sleep(delay);
		}
	}
}

type SentLogRecord = {
	email: string;
	messageId?: string;
	timestamp: string;
};

async function loadSentEmailSet(logFile: string): Promise<Set<string>> {
	const result = new Set<string>();

	if (!(await fs.pathExists(logFile))) {
		return result;
	}

	const content = await fs.readFile(logFile, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		try {
			const parsed = JSON.parse(trimmed) as { email?: unknown };
			if (typeof parsed.email === "string" && parsed.email.trim().length > 0) {
				result.add(parsed.email.trim().toLowerCase());
			}
		} catch {
			continue;
		}
	}

	return result;
}

async function appendSentRecord(logFile: string, record: SentLogRecord): Promise<void> {
	await fs.ensureFile(logFile);
	await fs.appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

type RateLimiter = {
	acquire: () => Promise<void>;
};

function createPerSecondRateLimiter(maxPerSecond: number): RateLimiter {
	let timestamps: number[] = [];

	return {
		acquire: async () => {
			while (true) {
				const now = Date.now();
				timestamps = timestamps.filter(ts => now - ts < 1000);

				if (timestamps.length < maxPerSecond) {
					timestamps.push(now);
					return;
				}

				const oldest = timestamps[0];
				const waitMs = Math.max(1, 1000 - (now - oldest));
				await sleep(waitMs);
			}
		},
	};
}

function isRetryableSesError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const maybeAwsError = error as {
		name?: string;
		$metadata?: { httpStatusCode?: number };
	};

	const statusCode = maybeAwsError.$metadata?.httpStatusCode;
	if (statusCode && statusCode >= 500) {
		return true;
	}

	const retryableNames = new Set([
		"Throttling",
		"ThrottlingException",
		"TooManyRequestsException",
		"ServiceUnavailableException",
		"InternalServiceError",
		"RequestTimeout",
	]);

	return retryableNames.has(maybeAwsError.name ?? "");
}

function computeBackoffDelay(baseDelayMs: number, attempt: number): number {
	const exponential = baseDelayMs * 2 ** (attempt - 1);
	const jitter = Math.floor(Math.random() * baseDelayMs);
	return Math.min(exponential + jitter, 30_000);
}

type BuildRecipientUnsubscribeUrlInput = {
	baseUrl?: string;
	secret?: string;
	email: string;
	staticUrl?: string;
};

function buildRecipientUnsubscribeUrl(input: BuildRecipientUnsubscribeUrlInput): string | undefined {
	const { baseUrl, secret, email, staticUrl } = input;

	if (baseUrl && secret) {
		const normalizedEmail = email.trim().toLowerCase();
		const payload = JSON.stringify({ email: normalizedEmail, iat: Date.now() });
		const payloadB64 = base64UrlEncode(payload);
		const signatureB64 = base64UrlEncode(createHmac("sha256", secret).update(payloadB64).digest());
		const token = `${payloadB64}.${signatureB64}`;
		const url = new URL(baseUrl);
		url.searchParams.set("t", token);
		return url.toString();
	}

	return staticUrl;
}

function base64UrlEncode(input: string | Buffer): string {
	const base64 = Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input, "utf8").toString("base64");
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function processWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	if (items.length === 0) {
		return;
	}

	const effectiveLimit = Math.max(1, Math.min(limit, items.length));
	let cursor = 0;

	const runners = Array.from({ length: effectiveLimit }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor++;
			await worker(items[index]);
		}
	});

	await Promise.all(runners);
}

type SuppressionCheckInput = {
	endpointUrl: string;
	bearerToken: string;
};

async function fetchSuppressedEmailSet(input: SuppressionCheckInput): Promise<Set<string>> {
	const { endpointUrl, bearerToken } = input;
	const result = new Set<string>();
	let cursor: string | undefined;

	for (let page = 0; page < 10_000; page++) {
		const url = new URL(endpointUrl);
		url.searchParams.set("suppressed", "1");
		url.searchParams.set("limit", "1000");
		if (cursor) {
			url.searchParams.set("cursor", cursor);
		}

		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${bearerToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Suppression sync endpoint returned ${response.status}`);
		}

		const payload = (await response.json()) as {
			emails?: unknown;
			cursor?: unknown;
			done?: unknown;
		};

		if (!Array.isArray(payload.emails)) {
			throw new TypeError("Suppression sync endpoint returned invalid emails payload");
		}

		for (const value of payload.emails) {
			if (typeof value === "string" && value.trim().length > 0) {
				result.add(value.trim().toLowerCase());
			}
		}

		const done = payload.done === true;
		const nextCursor = typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : undefined;

		if (done || !nextCursor) {
			break;
		}

		cursor = nextCursor;
	}

	return result;
}

function applyPlaceholders(input: string, values: TemplateProps): string {
	return input.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
		const value = values[key];

		if (value === undefined || value === null) {
			return "";
		}

		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}

		return "";
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
