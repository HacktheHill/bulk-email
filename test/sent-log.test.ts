import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSentRecord, checkpointSentMessage, loadSentEmailSet, SentLogCheckpointError } from "../src/sent-log.js";

test("scopes resume records to the current campaign", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	const logFile = join(directory, "sent.jsonl");

	try {
		await appendSentRecord(logFile, {
			campaignId: "campaign-a",
			email: "Alice@example.com",
			timestamp: new Date().toISOString(),
		});
		await appendSentRecord(logFile, {
			campaignId: "campaign-b",
			email: "Bob@example.com",
			timestamp: new Date().toISOString(),
		});

		assert.deepEqual(await loadSentEmailSet(logFile, "campaign-a"), new Set(["alice@example.com"]));
		assert.deepEqual(await loadSentEmailSet(logFile, "campaign-b"), new Set(["bob@example.com"]));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("treats a failed post-send checkpoint as fatal", async () => {
	await assert.rejects(
		checkpointSentMessage("sent.jsonl", {
			campaignId: "campaign-a",
			email: "alice@example.com",
			timestamp: new Date().toISOString(),
		}, async () => {
			throw new Error("disk full");
		}),
		SentLogCheckpointError,
	);
});
