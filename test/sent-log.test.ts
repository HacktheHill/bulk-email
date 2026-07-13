import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireCampaignLock,
	appendSentRecord,
	checkpointSentMessage,
	createCampaignState,
	loadAcceptedRecipientDigests,
	recipientDigest,
	SentLogCheckpointError,
	validateFailureLog,
} from "../src/sent-log.js";

test("stores private recipient digests and loads strict campaign resume state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	try {
		const state = await createCampaignState(directory, "campaign-a");
		await appendSentRecord(state.acceptedFile, {
			campaignId: "campaign-a",
			recipientDigest: recipientDigest("Alice@example.com"),
			timestamp: new Date().toISOString(),
			recipientSnapshotSha256: "a".repeat(64),
		});
		assert.deepEqual(await loadAcceptedRecipientDigests(state.acceptedFile, "campaign-a"), new Set([recipientDigest("alice@example.com")]));
		assert.equal((await stat(state.acceptedFile)).mode & 0o777, 0o600);
		assert.doesNotMatch(await (await import("node:fs/promises")).readFile(state.acceptedFile, "utf8"), /alice@/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed accepted state instead of silently resending", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	try {
		const file = join(directory, "accepted.jsonl");
		await writeFile(file, "not-json\n", "utf8");
		await assert.rejects(loadAcceptedRecipientDigests(file, "campaign-a"), /Malformed accepted log line 1/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed failure state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	try {
		const file = join(directory, "failures.jsonl");
		await writeFile(file, "{}\n", "utf8");
		await assert.rejects(validateFailureLog(file, "campaign-a"), /Invalid failure log line 1/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("blocks resume when an ambiguous recipient is recorded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	try {
		const file = join(directory, "failures.jsonl");
		await writeFile(file, `${JSON.stringify({
			campaignId: "campaign-a",
			recipientDigest: "a".repeat(64),
			reasonCode: "TimeoutError",
			outcome: "ambiguous",
			timestamp: new Date().toISOString(),
			recipientSnapshotSha256: "b".repeat(64),
		})}\n`, "utf8");
		await assert.rejects(validateFailureLog(file, "campaign-a"), /ambiguous recipient/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("prevents two processes from holding a campaign lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	try {
		const state = await createCampaignState(directory, "campaign-a");
		const release = await acquireCampaignLock(state);
		await assert.rejects(acquireCampaignLock(state), /already locked/);
		await release();
		const releaseAgain = await acquireCampaignLock(state);
		await releaseAgain();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("treats a failed post-send checkpoint as fatal", async () => {
	await assert.rejects(
		checkpointSentMessage("accepted.jsonl", {
			campaignId: "campaign-a",
			recipientDigest: recipientDigest("alice@example.com"),
			timestamp: new Date().toISOString(),
			recipientSnapshotSha256: "a".repeat(64),
		}, async () => { throw new Error("disk full"); }),
		SentLogCheckpointError,
	);
});
