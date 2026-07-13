import fs from "fs-extra";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeEmail } from "./utils.js";

export type SentLogRecord = {
	campaignId: string;
	recipientDigest: string;
	messageId?: string;
	timestamp: string;
	recipientSnapshotSha256: string;
};

export type FailureLogRecord = {
	campaignId: string;
	recipientDigest: string;
	reasonCode: string;
	outcome: "failed" | "ambiguous";
	timestamp: string;
	recipientSnapshotSha256: string;
};

export type CampaignManifest = {
	campaignId: string;
	templateId: string;
	templateVersion: number;
	templateSha256: string;
	templateCommit: string;
	audience: "subscribers" | "provided-csv";
	recipientSnapshotSha256: string;
	subjectSha256: string;
	from: string;
	replyTo: string;
	configurationSet: string;
	purpose?: string;
	plannedRecipients: number;
	suppressedRecipients: number;
	createdAt: string;
	confirmedAt?: string;
};

export type CampaignState = {
	directory: string;
	manifestFile: string;
	acceptedFile: string;
	failuresFile: string;
	lockFile: string;
};

export class SentLogCheckpointError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SentLogCheckpointError";
	}
}

export function recipientDigest(email: string): string {
	return createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");
}

export async function createCampaignState(root: string, campaignId: string): Promise<CampaignState> {
	const directory = path.resolve(root, campaignId);
	await fs.ensureDir(directory, 0o700);
	await fs.chmod(directory, 0o700);
	return {
		directory,
		manifestFile: path.join(directory, "manifest.json"),
		acceptedFile: path.join(directory, "accepted.jsonl"),
		failuresFile: path.join(directory, "failures.jsonl"),
		lockFile: path.join(directory, "lock"),
	};
}

export async function acquireCampaignLock(state: CampaignState): Promise<() => Promise<void>> {
	let handle: FileHandle;
	try {
		handle = await open(state.lockFile, "wx", 0o600);
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			throw new Error(`Campaign is already locked: ${state.directory}`);
		}
		throw error;
	}
	await handle.writeFile(`${process.pid}\n`, "utf8");
	await handle.sync();
	return async () => {
		await handle.close().catch(() => undefined);
		await fs.remove(state.lockFile);
	};
}

export async function writeOrValidateManifest(file: string, manifest: CampaignManifest): Promise<void> {
	if (await fs.pathExists(file)) {
		const existing = await fs.readJson(file) as CampaignManifest;
		for (const key of ["campaignId", "templateId", "templateVersion", "templateSha256", "templateCommit", "audience", "recipientSnapshotSha256", "subjectSha256", "from", "replyTo", "configurationSet", "purpose"] as const) {
			if (existing[key] !== manifest[key]) throw new Error(`Campaign manifest mismatch for ${key}; use a new campaign ID`);
		}
		return;
	}
	await writePrivateJson(file, manifest);
}

export async function markManifestConfirmed(file: string): Promise<void> {
	const manifest = await fs.readJson(file) as CampaignManifest;
	if (!manifest.confirmedAt) {
		manifest.confirmedAt = new Date().toISOString();
		await writePrivateJson(file, manifest);
	}
}

export async function loadAcceptedRecipientDigests(logFile: string, campaignId: string): Promise<Set<string>> {
	const result = new Set<string>();
	if (!(await fs.pathExists(logFile))) return result;
	const content = await fs.readFile(logFile, "utf8");
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Malformed accepted log line ${index + 1}`);
		}
		if (!isSentLogRecord(parsed)) throw new Error(`Invalid accepted log line ${index + 1}`);
		if (parsed.campaignId === campaignId) result.add(parsed.recipientDigest);
	}
	return result;
}

export async function validateFailureLog(logFile: string, campaignId: string): Promise<void> {
	if (!(await fs.pathExists(logFile))) return;
	const content = await fs.readFile(logFile, "utf8");
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Malformed failure log line ${index + 1}`);
		}
		if (!isFailureLogRecord(parsed) || parsed.campaignId !== campaignId) {
			throw new Error(`Invalid failure log line ${index + 1}`);
		}
		if (parsed.outcome === "ambiguous") {
			throw new Error(`Campaign contains an ambiguous recipient at failure log line ${index + 1}; resolve it before resuming`);
		}
	}
}

export async function appendSentRecord(logFile: string, record: SentLogRecord): Promise<void> {
	await appendPrivateJsonLine(logFile, record);
}

export async function appendFailureRecord(logFile: string, record: FailureLogRecord): Promise<void> {
	await appendPrivateJsonLine(logFile, record);
}

export async function checkpointSentMessage(
	logFile: string,
	record: SentLogRecord,
	append: (file: string, value: SentLogRecord) => Promise<void> = appendSentRecord,
): Promise<void> {
	try {
		await append(logFile, record);
	} catch (error) {
		throw new SentLogCheckpointError(
			`SES accepted a message but its campaign checkpoint could not be written; stop and inspect ${logFile} before resuming`,
			{ cause: error },
		);
	}
}

async function appendPrivateJsonLine(file: string, record: SentLogRecord | FailureLogRecord): Promise<void> {
	const handle = await open(file, "a", 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
	const temporaryFile = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.chmod(temporaryFile, 0o600);
	await fs.rename(temporaryFile, file);
}

function isSentLogRecord(value: unknown): value is SentLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SentLogRecord>;
	return typeof record.campaignId === "string"
		&& /^[a-f0-9]{64}$/.test(record.recipientDigest ?? "")
		&& typeof record.timestamp === "string"
		&& /^[a-f0-9]{64}$/.test(record.recipientSnapshotSha256 ?? "");
}

function isFailureLogRecord(value: unknown): value is FailureLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<FailureLogRecord>;
	return typeof record.campaignId === "string"
		&& /^[a-f0-9]{64}$/.test(record.recipientDigest ?? "")
		&& /^[A-Za-z0-9_.-]{1,100}$/.test(record.reasonCode ?? "")
		&& (record.outcome === "failed" || record.outcome === "ambiguous")
		&& typeof record.timestamp === "string"
		&& /^[a-f0-9]{64}$/.test(record.recipientSnapshotSha256 ?? "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
