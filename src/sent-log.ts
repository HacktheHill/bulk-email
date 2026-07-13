import fs from "fs-extra";
import { normalizeEmail } from "./utils.js";

export type SentLogRecord = {
	campaignId: string;
	email: string;
	messageId?: string;
	timestamp: string;
	subscriberSnapshotSha256?: string;
};

export class SentLogCheckpointError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SentLogCheckpointError";
	}
}

export async function loadSentEmailSet(logFile: string, campaignId: string): Promise<Set<string>> {
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
			const parsed = JSON.parse(trimmed) as { campaignId?: unknown; email?: unknown };
			if (
				parsed.campaignId === campaignId &&
				typeof parsed.email === "string" &&
				parsed.email.trim().length > 0
			) {
				result.add(normalizeEmail(parsed.email));
			}
		} catch {
			continue;
		}
	}

	return result;
}

export async function appendSentRecord(logFile: string, record: SentLogRecord): Promise<void> {
	await fs.ensureFile(logFile);
	await fs.appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
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
			`SES accepted a message but its sent-log checkpoint could not be written; stop and inspect ${logFile} before resuming`,
			{ cause: error },
		);
	}
}
