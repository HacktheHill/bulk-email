#!/usr/bin/env node

import { SESv2Client } from "@aws-sdk/client-sesv2";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Command, type OptionValues } from "commander";
import dotenv from "dotenv";
import fs from "fs-extra";
import inquirer from "inquirer";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { confirmCampaignSend } from "./confirmation.js";
import { processWithConcurrency } from "./concurrency.js";
import { fetchCsvSnapshot, fetchSuppressedEmailSet } from "./list-service.js";
import { createPerSecondRateLimiter, isAmbiguousSesError, sendWithRetry } from "./mailer.js";
import { readRecipientCsv, readRecipientCsvText, type RecipientRecord } from "./recipients.js";
import { renderCampaign, type RenderLimits, type RenderedMessage } from "./rendering.js";
import { fetchSesSuppressedEmailSet, verifySesPreflight } from "./ses-service.js";
import {
	acquireCampaignLock,
	appendFailureRecord,
	checkpointSentMessage,
	createCampaignState,
	loadAcceptedRecipientDigests,
	markManifestConfirmed,
	recipientDigest,
	SentLogCheckpointError,
	validateFailureLog,
	writeOrValidateManifest,
	type CampaignManifest,
} from "./sent-log.js";
import { inspectTemplateRepository, loadTemplateModule, verifyTemplateDependencies } from "./template.js";
import {
	buildRecipientUnsubscribeUrl,
	deduplicateRecipients,
	isValidCampaignId,
	normalizeEmail,
	parseUnsubscribeKeyring,
} from "./utils.js";

dotenv.config();

const DEFAULT_MAX_RECIPIENTS = 10_000;
const DEFAULT_MAX_HTML_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024;
const DEFAULT_MAX_RENDERED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CSV_BYTES = 25 * 1024 * 1024;

const program = new Command()
	.name("bulk-email")
	.description("Preflight, preview, and send Hack the Hill email campaigns through AWS SES");

addCommonOptions(program.command("send", { isDefault: true }))
	.description("Preflight and send one campaign")
	.option("--campaign-id <campaignId>", "Stable identifier used to resume a campaign")
	.option("--purpose <purpose>", "Required non-promotional event/service purpose for provided-CSV templates")
	.option("--state-dir <stateDir>", "Campaign state root", ".bulk-email/campaigns")
	.option("--dry-run", "Validate and summarize without sending")
	.option("--yes", "Skip the final confirmation prompt")
	.action(async options => runSend(options));

addCommonOptions(program.command("test"))
	.description("Send one real test message immediately")
	.requiredOption("--to <email>", "Test recipient")
	.action(async options => runTest(options));

try {
	await program.parseAsync();
} catch (error) {
	console.error(`Error: ${errorMessage(error)}`);
	process.exitCode = 1;
}

function addCommonOptions(command: Command): Command {
	return command
		.option("-v, --dev", "Enable non-PII development logging")
		.option("-d, --template-dir <templateDir>", "Directory containing the React Email template")
		.option("-t, --template <template>", "React Email template filename")
		.option("-c, --file <file>", "Provided recipient CSV or test fixture")
		.option("--subscriber-export-url <subscriberExportUrl>", "Authenticated subscriber CSV export URL")
		.option("--subscriber-export-token <subscriberExportToken>", "Subscriber export bearer token")
		.option("-f, --from <from>", "Sender email address")
		.option("--from-name <fromName>", "Sender display name")
		.option("--reply-to <replyTo>", "Reply-To address")
		.option("-r, --region <region>", "AWS SES region")
		.option("--configuration-set <configurationSet>", "SES configuration set")
		.option("--unsubscribe-base-url <unsubscribeBaseUrl>", "Canonical unsubscribe endpoint")
		.option("--unsubscribe-active-key-id <unsubscribeActiveKeyId>", "Active unsubscribe signing key ID")
		.option("--unsubscribe-token-keys <unsubscribeTokenKeys>", "Versioned unsubscribe keyring JSON")
		.option(
			"--suppression-check-url <suppressionCheckUrl>",
			"Authenticated email-list-manager suppression endpoint",
		)
		.option("--suppression-check-token <suppressionCheckToken>", "Suppression endpoint bearer token")
		.option("--max-per-second <maxPerSecond>", "Maximum SES attempts per second", Number)
		.option("--concurrency <concurrency>", "Concurrent sends", Number)
		.option("--batch-size <batchSize>", "Messages per batch", Number)
		.option("--batch-delay-ms <batchDelayMs>", "Delay between batches", Number)
		.option("--max-attempts <maxAttempts>", "Safe retry attempts", Number)
		.option("--base-delay-ms <baseDelayMs>", "Retry backoff base", Number)
		.option("--fetch-timeout-ms <fetchTimeoutMs>", "Network timeout", Number)
		.option("--max-csv-bytes <maxCsvBytes>", "Maximum recipient CSV bytes", Number)
		.option("--max-suppression-page-bytes <maxSuppressionPageBytes>", "Maximum suppression page bytes", Number)
		.option("--max-recipients <maxRecipients>", "Maximum unique recipients", Number)
		.option("--max-html-bytes <maxHtmlBytes>", "Maximum HTML bytes per message", Number)
		.option("--max-text-bytes <maxTextBytes>", "Maximum text bytes per message", Number)
		.option("--max-rendered-bytes <maxRenderedBytes>", "Maximum total pre-rendered bytes", Number);
}

type ResolvedOptions = {
	dev: boolean;
	templateDir: string;
	template: string;
	file?: string;
	subscriberExportUrl?: string;
	subscriberExportToken?: string;
	from: string;
	fromName?: string;
	replyTo: string;
	region: string;
	configurationSet: string;
	unsubscribeBaseUrl?: string;
	unsubscribeActiveKeyId?: string;
	unsubscribeKeyring: Record<string, string>;
	suppressionCheckUrl?: string;
	suppressionCheckToken?: string;
	maxPerSecond: number;
	concurrency: number;
	batchSize: number;
	batchDelayMs: number;
	maxAttempts: number;
	baseDelayMs: number;
	fetchTimeoutMs: number;
	maxCsvBytes: number;
	maxSuppressionPageBytes: number;
	renderLimits: RenderLimits;
};

async function runSend(rawOptions: OptionValues): Promise<void> {
	const campaignId = String(rawOptions.campaignId ?? process.env.CAMPAIGN_ID ?? "");
	if (!isValidCampaignId(campaignId)) {
		throw new Error("campaign-id is required and must contain only letters, numbers, dots, underscores, or hyphens");
	}
	const options = await resolveOptions(rawOptions);
	const templatePath = path.join(options.templateDir, options.template);
	const templateModule = await loadTemplateModule(templatePath);
	const dryRun = Boolean(rawOptions.dryRun);
	const repository = await inspectTemplateRepository(templatePath, { requireClean: !dryRun });
	await verifyTemplateDependencies(repository.packageJsonPath, path.resolve("package.json"));

	const source = await loadCampaignRecipients(templateModule.metadata.audience, options);
	const deduplicated = deduplicateRecipients(source.recipients);
	if (deduplicated.recipients.length > options.renderLimits.maxRecipients) {
		throw new Error(`Campaign exceeds the ${options.renderLimits.maxRecipients}-recipient limit`);
	}
	if (deduplicated.duplicates > 0)
		console.info(
			`Excluded ${deduplicated.duplicates} duplicate recipient row(s); kept the first row for each address.`,
		);

	const ses = createSesClient(options);
	const identity = options.from.slice(options.from.lastIndexOf("@") + 1).toLowerCase();
	console.info(
		`Checking SES account access, sending identity ${identity}, and configuration set ${options.configurationSet}...`,
	);
	const preflight = await verifySesPreflight({ client: ses, identity, configurationSet: options.configurationSet });
	const effectiveMaxPerSecond = preflight.maxSendRate
		? Math.max(1, Math.min(options.maxPerSecond, preflight.maxSendRate))
		: options.maxPerSecond;

	console.info("Loading SES bounce and complaint suppressions...");
	const sesSuppressions = await fetchSesSuppressedEmailSet(ses);
	let listSuppressions = new Set<string>();
	if (templateModule.metadata.audience === "subscribers") {
		console.info("Loading email-list-manager suppressions...");
		listSuppressions = await fetchListSuppressions(options);
	}

	const state = await createCampaignState(String(rawOptions.stateDir ?? ".bulk-email/campaigns"), campaignId);
	const releaseLock = dryRun ? async () => undefined : await acquireCampaignLock(state);
	try {
		const accepted = dryRun ? new Set<string>() : await loadAcceptedRecipientDigests(state.acceptedFile, campaignId);
		if (!dryRun) await validateFailureLog(state.failuresFile, campaignId);
		const filtered = filterRecipients(deduplicated.recipients, accepted, listSuppressions, sesSuppressions);
		console.info(`Rendering and validating ${filtered.pending.length} pending recipient message(s)...`);
		const messages = await renderCampaign({
			template: templateModule,
			recipients: filtered.pending,
			limits: options.renderLimits,
			buildUnsubscribeUrl: email => buildUnsubscribeUrl(options, email),
		});
		const purpose = templateModule.metadata.audience === "provided-csv"
			? await resolvePurpose(rawOptions.purpose, Boolean(rawOptions.yes))
			: undefined;
		const manifest: CampaignManifest = {
			campaignId,
			templateId: templateModule.metadata.id,
			templateVersion: templateModule.metadata.version,
			templateSha256: repository.templateSha256,
			templateCommit: repository.commit,
			audience: templateModule.metadata.audience,
			recipientSnapshotSha256: source.snapshotSha256,
			subjectSha256: createHash("sha256").update(templateModule.metadata.subject).digest("hex"),
			from: options.from,
			replyTo: options.replyTo,
			configurationSet: options.configurationSet,
			purpose,
			plannedRecipients: messages.length,
			suppressedRecipients: filtered.suppressed,
			createdAt: new Date().toISOString(),
		};
		console.info(
			[
				`Campaign ${campaignId}`,
				`  Template: ${templateModule.metadata.id} v${templateModule.metadata.version}`,
				`  Subject: ${templateModule.metadata.subject}`,
				`  Audience: ${templateModule.metadata.audience}`,
				`  Unique recipients: ${deduplicated.recipients.length}`,
				`  Already accepted: ${filtered.alreadyAccepted}`,
				`  Suppressed by email-list-manager: ${filtered.listSuppressed}`,
				`  Suppressed by SES: ${filtered.sesSuppressed}`,
				`  Suppressed total: ${filtered.suppressed}`,
				`  Pending: ${messages.length}`,
				`  Sender: ${options.fromName ? `${options.fromName} <${options.from}>` : options.from}`,
				`  Reply-To: ${options.replyTo}`,
				`  Configuration set: ${options.configurationSet}`,
				`  Purpose: ${purpose ?? "subscriber updates"}`,
			].join("\n"),
		);

		if (dryRun) {
			console.info(
				`Dry run complete. Preflight passed for ${messages.length} pending recipient(s); no email was sent.`,
			);
			return;
		}
		await writeOrValidateManifest(state.manifestFile, manifest);
		if (messages.length === 0) {
			console.info("No pending recipients remain; no email was sent.");
			return;
		}
		const confirmed = await confirmCampaignSend({
			yes: Boolean(rawOptions.yes),
			message: templateModule.metadata.audience === "provided-csv"
				? "Confirm this message is tied to an existing application, RSVP, attendance, or service relationship, is not promotional, and should be sent now?"
				: "Send this subscribed-updates campaign now?",
			prompt: async message => (await inquirer.prompt<{ confirmed: boolean }>({
				name: "confirmed",
				type: "confirm",
				message,
				default: false,
			})).confirmed,
		});
		if (!confirmed) {
			console.info("Campaign cancelled. No email was sent.");
			return;
		}
		await markManifestConfirmed(state.manifestFile);
		const result = await deliverCampaign({
			messages,
			options,
			ses,
			campaignId,
			state,
			snapshotSha256: source.snapshotSha256,
			maxPerSecond: effectiveMaxPerSecond,
			refreshListSuppressions: templateModule.metadata.audience === "subscribers"
				? async () => { listSuppressions = await fetchListSuppressions(options); return listSuppressions; }
				: undefined,
		});
		console.info(
			`Delivery complete. SES accepted: ${result.sent}; skipped after suppression refresh: ${result.suppressed}; failed: ${result.failed}.`,
		);
		if (result.failed > 0) process.exitCode = 1;
	} finally {
		await releaseLock();
	}
}

async function runTest(rawOptions: OptionValues): Promise<void> {
	const options = await resolveOptions(rawOptions);
	const to = z.string().trim().toLowerCase().email().parse(rawOptions.to);
	const templatePath = path.join(options.templateDir, options.template);
	const templateModule = await loadTemplateModule(templatePath);
	const repository = await inspectTemplateRepository(templatePath, { requireClean: true });
	await verifyTemplateDependencies(repository.packageJsonPath, path.resolve("package.json"));
	let recipient: RecipientRecord = { email: to, language: "en", name: "" };
	if (options.file) {
		const fixture = await readRecipientCsv(options.file, options.maxCsvBytes);
		if (fixture.length === 0) throw new Error("Test fixture CSV is empty");
		recipient = { ...fixture[0], email: to };
	}
	const [message] = await renderCampaign({
		template: templateModule,
		recipients: [recipient],
		limits: options.renderLimits,
		buildUnsubscribeUrl: email => buildUnsubscribeUrl(options, email),
	});
	if (!message) throw new Error("Test message did not render");
	const ses = createSesClient(options);
	const identity = options.from.slice(options.from.lastIndexOf("@") + 1).toLowerCase();
	await verifySesPreflight({ client: ses, identity, configurationSet: options.configurationSet });
	const sesSuppressions = await fetchSesSuppressedEmailSet(ses);
	if (sesSuppressions.has(to)) throw new Error("The test recipient is on the SES suppression list");
	const messageId = await sendRendered(message, options, ses, createPerSecondRateLimiter(1));
	console.info(`SES accepted the test message (message ID: ${messageId ?? "not returned"}).`);
}

async function resolveOptions(raw: OptionValues): Promise<ResolvedOptions> {
	const env = process.env;
	const templateDir = String(raw.templateDir ?? await promptTemplateDirectory());
	if (!(await fs.pathExists(templateDir))) throw new Error("Please specify an existing template directory");
	const template = String(raw.template ?? await promptTemplate(templateDir));
	if (!(await fs.pathExists(path.join(templateDir, template)))) throw new Error("Please specify an existing template file");
	const from = String(raw.from ?? env.EMAIL_FROM ?? "");
	const replyTo = String(raw.replyTo ?? env.EMAIL_REPLY_TO ?? "info@hackthehill.com");
	const region = String(raw.region ?? env.AWS_REGION ?? "");
	const configurationSet = String(raw.configurationSet ?? env.SES_CONFIGURATION_SET ?? "");
	for (const [name, value] of [["from", from], ["reply-to", replyTo]] as const) {
		if (!z.string().email().safeParse(value).success) throw new Error(`Please specify a valid ${name} address`);
	}
	if (!region) throw new Error("Please specify AWS region");
	if (!configurationSet) throw new Error("Please specify the SES configuration set");
	const numeric = {
		maxPerSecond: numberOption(raw.maxPerSecond, env.SES_MAX_PER_SECOND, 14, "max-per-second", 1),
		concurrency: numberOption(raw.concurrency, env.SEND_CONCURRENCY, 5, "concurrency", 1),
		batchSize: numberOption(raw.batchSize, env.BATCH_SIZE, 10, "batch-size", 1),
		batchDelayMs: numberOption(raw.batchDelayMs, env.BATCH_DELAY_MS, 1_200, "batch-delay-ms", 0),
		maxAttempts: numberOption(raw.maxAttempts, env.MAX_ATTEMPTS, 5, "max-attempts", 1),
		baseDelayMs: numberOption(raw.baseDelayMs, env.BASE_DELAY_MS, 500, "base-delay-ms", 1),
		fetchTimeoutMs: numberOption(raw.fetchTimeoutMs, env.FETCH_TIMEOUT_MS, 15_000, "fetch-timeout-ms", 1),
		maxCsvBytes: numberOption(raw.maxCsvBytes, env.MAX_CSV_BYTES, DEFAULT_MAX_CSV_BYTES, "max-csv-bytes", 1),
		maxSuppressionPageBytes: numberOption(raw.maxSuppressionPageBytes, env.MAX_SUPPRESSION_PAGE_BYTES, 2 * 1024 * 1024, "max-suppression-page-bytes", 1),
		maxRecipients: numberOption(raw.maxRecipients, env.MAX_RECIPIENTS, DEFAULT_MAX_RECIPIENTS, "max-recipients", 1),
		maxHtmlBytes: numberOption(raw.maxHtmlBytes, env.MAX_HTML_BYTES, DEFAULT_MAX_HTML_BYTES, "max-html-bytes", 1),
		maxTextBytes: numberOption(raw.maxTextBytes, env.MAX_TEXT_BYTES, DEFAULT_MAX_TEXT_BYTES, "max-text-bytes", 1),
		maxRenderedBytes: numberOption(raw.maxRenderedBytes, env.MAX_RENDERED_BYTES, DEFAULT_MAX_RENDERED_BYTES, "max-rendered-bytes", 1),
	};
	const keyring = parseUnsubscribeKeyring(String(raw.unsubscribeTokenKeys ?? env.UNSUBSCRIBE_TOKEN_KEYS ?? "") || undefined);
	const activeKeyId = String(raw.unsubscribeActiveKeyId ?? env.UNSUBSCRIBE_TOKEN_ACTIVE_KEY_ID ?? "") || undefined;
	if (activeKeyId && !keyring[activeKeyId]) throw new Error("The active unsubscribe key ID is missing from the keyring");
	return {
		dev: Boolean(raw.dev ?? env.NODE_ENV === "development"),
		templateDir,
		template,
		file: raw.file ? String(raw.file) : undefined,
		subscriberExportUrl: String(raw.subscriberExportUrl ?? env.SUBSCRIBER_EXPORT_URL ?? "") || undefined,
		subscriberExportToken: String(raw.subscriberExportToken ?? env.SUBSCRIBER_EXPORT_TOKEN ?? "") || undefined,
		from,
		fromName: String(raw.fromName ?? env.EMAIL_FROM_NAME ?? "") || undefined,
		replyTo,
		region,
		configurationSet,
		unsubscribeBaseUrl: String(raw.unsubscribeBaseUrl ?? env.UNSUBSCRIBE_BASE_URL ?? "") || undefined,
		unsubscribeActiveKeyId: activeKeyId,
		unsubscribeKeyring: keyring,
		suppressionCheckUrl: String(raw.suppressionCheckUrl ?? env.SUPPRESSION_CHECK_URL ?? "") || undefined,
		suppressionCheckToken: String(raw.suppressionCheckToken ?? env.SUPPRESSION_CHECK_TOKEN ?? "") || undefined,
		...numeric,
		renderLimits: {
			maxRecipients: numeric.maxRecipients,
			maxHtmlBytes: numeric.maxHtmlBytes,
			maxTextBytes: numeric.maxTextBytes,
			maxTotalBytes: numeric.maxRenderedBytes,
		},
	};
}

async function loadCampaignRecipients(audience: "subscribers" | "provided-csv", options: ResolvedOptions): Promise<{
	recipients: RecipientRecord[];
	snapshotSha256: string;
}> {
	if (audience === "subscribers") {
		if (options.file) throw new Error("Subscriber templates cannot be paired with --file");
		if (!options.subscriberExportUrl || !options.subscriberExportToken) {
			throw new Error("Subscriber templates require the authenticated subscriber export URL and token");
		}
		const csv = await fetchCsvSnapshot({
			url: options.subscriberExportUrl,
			token: options.subscriberExportToken,
			timeoutMs: options.fetchTimeoutMs,
			maxBytes: options.maxCsvBytes,
		});
		if (!csv.trim()) throw new Error("Subscriber export endpoint returned an empty response");
		return { recipients: readRecipientCsvText(csv), snapshotSha256: sha256(csv) };
	}
	if (!options.file || !(await fs.pathExists(options.file)) || path.extname(options.file).toLowerCase() !== ".csv") {
		throw new Error("Provided-CSV templates require --file with an existing CSV");
	}
	const bytes = await fs.readFile(options.file);
	if (bytes.byteLength > options.maxCsvBytes) throw new Error(`Recipient CSV exceeds the configured ${options.maxCsvBytes}-byte limit`);
	return { recipients: await readRecipientCsv(options.file, options.maxCsvBytes), snapshotSha256: createHash("sha256").update(bytes).digest("hex") };
}

function filterRecipients(
	recipients: RecipientRecord[],
	accepted: ReadonlySet<string>,
	listSuppressions: ReadonlySet<string>,
	sesSuppressions: ReadonlySet<string>,
): { pending: RecipientRecord[]; alreadyAccepted: number; suppressed: number; listSuppressed: number; sesSuppressed: number } {
	const pending: RecipientRecord[] = [];
	let alreadyAccepted = 0;
	let listSuppressed = 0;
	let sesSuppressed = 0;
	for (const recipient of recipients) {
		const normalized = normalizeEmail(recipient.email);
		if (accepted.has(recipientDigest(normalized))) { alreadyAccepted++; continue; }
		if (sesSuppressions.has(normalized)) { sesSuppressed++; continue; }
		if (listSuppressions.has(normalized)) { listSuppressed++; continue; }
		pending.push(recipient);
	}
	return { pending, alreadyAccepted, suppressed: listSuppressed + sesSuppressed, listSuppressed, sesSuppressed };
}

async function deliverCampaign(input: {
	messages: RenderedMessage[];
	options: ResolvedOptions;
	ses: SESv2Client;
	campaignId: string;
	state: Awaited<ReturnType<typeof createCampaignState>>;
	snapshotSha256: string;
	maxPerSecond: number;
	refreshListSuppressions?: () => Promise<Set<string>>;
}): Promise<{ sent: number; failed: number; suppressed: number }> {
	const limiter = createPerSecondRateLimiter(input.maxPerSecond);
	let sent = 0;
	let failed = 0;
	let suppressed = 0;
	for (let offset = 0; offset < input.messages.length; offset += input.options.batchSize) {
		const latestListSuppressions = input.refreshListSuppressions && offset > 0
			? await input.refreshListSuppressions()
			: new Set<string>();
		const batch = input.messages.slice(offset, offset + input.options.batchSize).filter(message => {
			if (latestListSuppressions.has(normalizeEmail(message.email))) { suppressed++; return false; }
			return true;
		});
		await processWithConcurrency(batch, input.options.concurrency, async (message, signal) => {
			const digest = recipientDigest(message.email);
			try {
				const messageId = await sendRendered(message, input.options, input.ses, limiter, signal);
				await checkpointSentMessage(input.state.acceptedFile, {
					campaignId: input.campaignId,
					recipientDigest: digest,
					messageId,
					timestamp: new Date().toISOString(),
					recipientSnapshotSha256: input.snapshotSha256,
				});
				sent++;
			} catch (error) {
				if (error instanceof SentLogCheckpointError || isAmbiguousSesError(error)) {
					await appendFailureRecord(input.state.failuresFile, {
						campaignId: input.campaignId,
						recipientDigest: digest,
						reasonCode: error instanceof SentLogCheckpointError ? "CheckpointAfterAcceptance" : safeErrorCode(error),
						outcome: "ambiguous",
						timestamp: new Date().toISOString(),
						recipientSnapshotSha256: input.snapshotSha256,
					}).catch(() => undefined);
					throw error;
				}
				failed++;
				await appendFailureRecord(input.state.failuresFile, {
					campaignId: input.campaignId,
					recipientDigest: digest,
					reasonCode: safeErrorCode(error),
					outcome: "failed",
					timestamp: new Date().toISOString(),
					recipientSnapshotSha256: input.snapshotSha256,
				});
			}
		});
		const next = offset + input.options.batchSize;
		if (next < input.messages.length && input.options.batchDelayMs > 0) await sleep(input.options.batchDelayMs);
	}
	return { sent, failed, suppressed };
}

async function sendRendered(message: RenderedMessage, options: ResolvedOptions, ses: SESv2Client, rateLimiter: ReturnType<typeof createPerSecondRateLimiter>, abortSignal?: AbortSignal): Promise<string | undefined> {
	return sendWithRetry({
		ses,
		from: options.from,
		fromName: options.fromName,
		replyTo: options.replyTo,
		to: message.email,
		subject: message.subject,
		html: message.html,
		text: message.text,
		maxAttempts: options.maxAttempts,
		baseDelayMs: options.baseDelayMs,
		configurationSet: options.configurationSet,
		rateLimiter,
		unsubscribeUrl: message.unsubscribeUrl,
		dev: options.dev,
		abortSignal,
	});
}

function buildUnsubscribeUrl(options: ResolvedOptions, email: string): string | undefined {
	return buildRecipientUnsubscribeUrl({
		baseUrl: options.unsubscribeBaseUrl,
		activeKeyId: options.unsubscribeActiveKeyId,
		keyring: options.unsubscribeKeyring,
		email,
	});
}

async function fetchListSuppressions(options: ResolvedOptions): Promise<Set<string>> {
	if (!options.suppressionCheckUrl || !options.suppressionCheckToken) {
		throw new Error("Subscriber templates require the authenticated suppression endpoint and token");
	}
	return fetchSuppressedEmailSet({
		endpointUrl: options.suppressionCheckUrl,
		bearerToken: options.suppressionCheckToken,
		timeoutMs: options.fetchTimeoutMs,
		maxPageBytes: options.maxSuppressionPageBytes,
	});
}

function createSesClient(options: ResolvedOptions): SESv2Client {
	return new SESv2Client({
		region: options.region,
		maxAttempts: 1,
		requestHandler: new NodeHttpHandler({
			connectionTimeout: options.fetchTimeoutMs,
			requestTimeout: options.fetchTimeoutMs,
		}),
	});
}

async function resolvePurpose(value: unknown, yes: boolean): Promise<string> {
	let purpose = typeof value === "string" ? value.trim() : "";
	if (!purpose && process.stdin.isTTY && !yes) {
		purpose = (await inquirer.prompt<{ purpose: string }>({
			name: "purpose",
			type: "input",
			message: "Describe the existing event/service relationship for this non-promotional campaign",
		})).purpose.trim();
	}
	if (purpose.length < 10 || purpose.length > 500) {
		throw new Error("Provided-CSV templates require a 10-500 character non-promotional purpose statement");
	}
	return purpose;
}

async function promptTemplateDirectory(): Promise<string> {
	return (await inquirer.prompt<{ value: string }>({
		name: "value", type: "input", message: "Template directory", default: "templates",
	})).value;
}

async function promptTemplate(directory: string): Promise<string> {
	const choices = (await fs.readdir(directory)).filter(name => /\.(tsx|ts|jsx|js)$/i.test(name));
	if (choices.length === 0) throw new Error("No React Email templates were found");
	return (await inquirer.prompt<{ value: string }>({
		name: "value", type: "list", message: "Template", choices,
	})).value;
}

function numberOption(cliValue: unknown, envValue: string | undefined, fallback: number, name: string, minimum: number): number {
	const value = cliValue === undefined ? Number(envValue ?? fallback) : Number(cliValue);
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
	return value;
}

function safeErrorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "UnknownError";
	const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	if (typeof value.name === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value.name)) return value.name;
	const status = value.$metadata?.httpStatusCode;
	return typeof status === "number" ? `HTTP_${status}` : "UnknownError";
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
