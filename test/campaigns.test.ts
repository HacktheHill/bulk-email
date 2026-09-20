import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canSend, parseQueue, planCampaigns, unclaimedCampaigns, type QueueEntry } from "../src/campaign-plan.js";
import { configDigest, parseCampaign, validateCampaignEntry } from "../src/campaign-config.js";
import { emailSetDigest, firstName, recipientCsv, resolveAudience, verifyAudience } from "../src/campaign-audience.js";
import { executeCampaign } from "../src/campaign-runner.js";
import { CampaignLedger } from "../src/campaign-ledger.js";
import { decryptCheckpoint, encryptCheckpoint } from "../src/campaign-checkpoint.js";
import { readRecipientCsvText } from "../src/recipients.js";

const start = "2030-09-13T15:00:00Z";
const end = "2030-09-13T17:00:00Z";
const now = Date.parse(start);
const fixture = {
	version: 1, id: "example-wave", sendAt: start, expiresAt: end,
	template: { ref: "a".repeat(40), file: "application-accepted.tsx" },
	audience: { type: "tally-reviewed", formId: "form", submissionIds: ["one", "two"] },
	expected: { recipients: 1, emailSetSha256: emailSetDigest([{ email: "person@example.com" }]) },
	purpose: "Application decisions for reviewed applicants",
	test: { to: "reviewer@example.com", props: { name: "Alex", language: "en" } }, checkpointKey: "b".repeat(64),
};
const raw = JSON.stringify(fixture);
const entry: QueueEntry = {
	id: fixture.id, configSecret: "CAMPAIGN_CONFIG_EXAMPLE", configSha256: configDigest(raw),
	approvedSha256: configDigest(raw), sendAt: start, expiresAt: end, enabled: true,
};

test("queue approves only the exact configuration during its bounded UTC window", () => {
	assert.equal(canSend(entry, now - 1), false);
	assert.equal(canSend(entry, now), true);
	assert.equal(canSend(entry, Date.parse(end)), false);
	assert.equal(canSend({ ...entry, enabled: false }, now), false);
	assert.equal(canSend({ ...entry, approvedSha256: "c".repeat(64) }, now), false);
	assert.equal(parseQueue(JSON.stringify([entry])).length, 1);
	assert.throws(() => parseQueue(JSON.stringify([entry, entry])));
	assert.throws(() => parseQueue(JSON.stringify([{ ...entry, configSecret: "AWS_SECRET_ACCESS_KEY" }])));
	assert.throws(() => parseQueue(JSON.stringify([{ ...entry, expiresAt: "2030-09-15T15:00:00Z" }])));
	assert.throws(() => parseQueue(JSON.stringify([{ ...entry, sendAt: "2030-02-30T15:00:00Z" }])));
});

test("preview and test remain available without authorising a production send", () => {
	const pending = { ...entry, enabled: false, approvedSha256: undefined };
	assert.deepEqual(planCampaigns([entry, { ...pending, id: "other" }], "schedule", undefined, now), [entry]);
	assert.deepEqual(planCampaigns([pending], "test", entry.id, now), [pending]);
	assert.throws(() => planCampaigns([pending], "send", entry.id, now));
	assert.throws(() => planCampaigns([entry], "preview", "missing", now));
});

test("configuration validation binds dates, audience, fixture and template to approval", () => {
	assert.equal(validateCampaignEntry(raw, entry, true, now).id, entry.id);
	assert.throws(() => validateCampaignEntry(raw + "\n", entry, true, now));
	assert.throws(() => validateCampaignEntry(raw, { ...entry, sendAt: end }, true, now));
	assert.throws(() => parseCampaign(JSON.stringify({ ...fixture, audience: { ...fixture.audience, submissionIds: ["one", "one"] } })));
	assert.throws(() => parseCampaign(JSON.stringify({ ...fixture, template: { ...fixture.template, file: "../other.tsx" } })));
	const noExpected = JSON.stringify({ ...fixture, expected: undefined });
	const noExpectedEntry = { ...entry, configSha256: configDigest(noExpected), approvedSha256: configDigest(noExpected) };
	assert.doesNotThrow(() => validateCampaignEntry(noExpected, noExpectedEntry, false, now));
	assert.throws(() => validateCampaignEntry(noExpected, noExpectedEntry, true, now));
});

test("email expectations ignore order/case/duplicates but stop changed audiences", () => {
	const rows = [{ email: " PERSON@example.com " }, { email: "person@example.com" }];
	verifyAudience(rows, fixture.expected);
	assert.throws(() => verifyAudience([{ email: "changed@example.com" }], fixture.expected));
	assert.throws(() => verifyAudience([], fixture.expected));
	assert.equal(firstName(["Jean-François"]), "Jean-François");
	assert.equal(firstName(["李明"]), "李明");
	assert.equal(firstName(["Alex", " Alex "]), "Alex");
	assert.equal(firstName(["Alex", "Sam"]), "");
	assert.equal(firstName(["<b>Alex</b>"]), "");
	assert.equal(firstName(["test"]), "");
});

const questions = [
	{ id: "en", title: "Email address" }, { id: "fr", title: "Adresse courriel" },
	{ id: "nameEn", title: "First name" }, { id: "nameFr", title: "Prénom" }, { id: "guardian", title: "Guardian email" },
];
const submission = (id: string, name = "Alex", french = false) => ({
	id, isCompleted: true, submittedAt: start,
	responses: [{ questionId: french ? "fr" : "en", answer: "person@example.com" },
		{ questionId: french ? "nameFr" : "nameEn", answer: name }, { questionId: "guardian", answer: "guardian@example.com" }],
});
const page = (rows: ReturnType<typeof submission>[], number = 1, hasMore = false) => ({ page: number, hasMore, questions, submissions: rows });
const request = (data: unknown): typeof fetch => async () => new Response(JSON.stringify(data));

test("reviewed Tally IDs exclude unreviewed records and guardian addresses, preserving French names", async () => {
	const source = parseCampaign(raw).audience;
	const result = await resolveAudience(source, "fixture", request(page([submission("one", "Élodie", true), submission("two", "Élodie", true), submission("unreviewed")])));
	assert.deepEqual(result, [{ email: "person@example.com", language: "fr", name: "Élodie" }]);
	assert.equal((await resolveAudience(source, "fixture", request(page([submission("one"), submission("two", "Sam")]))))![0].name, "");
});

test("incomplete Tally audience includes old partials and excludes completed or recent addresses", async () => {
	const old = new Date(now - 25 * 60 * 60 * 1000).toISOString();
	const recent = new Date(now - 2 * 60 * 60 * 1000).toISOString();
	const partial = (id: string, email: string, submittedAt: string) => ({
		id, isCompleted: false, submittedAt,
		responses: [{ questionId: "en", answer: email, updatedAt: submittedAt }],
	});
	const completed = { ...submission("done"), submittedAt: old,
		responses: [{ questionId: "en", answer: "completed@example.com", updatedAt: old }] };
	const source = parseCampaign(JSON.stringify({ ...fixture,
		audience: { type: "tally-incomplete", formId: "form", inactiveHours: 24 }, expected: undefined })).audience;
	let exclusions: string[] = [];
	const result = await resolveAudience(source, "fixture", request(page([
		partial("old", "partial@example.com", old), partial("recent", "recent@example.com", recent),
		partial("before-done", "completed@example.com", old), completed,
	])), now, emails => { exclusions = emails; });
	assert.deepEqual(result, [{ email: "partial@example.com", language: "en", name: "" }]);
	assert.deepEqual(exclusions, ["completed@example.com"]);
});

test("Tally preflight fails closed for missing, partial, ambiguous and repeated records", async () => {
	const source = parseCampaign(raw).audience;
	await assert.rejects(resolveAudience(source, "fixture", request(page([submission("one")]))));
	await assert.rejects(resolveAudience(source, "fixture", request(page([{ ...submission("one"), isCompleted: false }, submission("two")]))));
	const ambiguous = submission("one");
	ambiguous.responses.push({ questionId: "fr", answer: "other@example.com" });
	await assert.rejects(resolveAudience(source, "fixture", request(page([ambiguous, submission("two")]))));
	await assert.rejects(resolveAudience(source, "fixture", request(page([submission("one"), submission("one"), submission("two")]))));
	await assert.rejects(resolveAudience(source, "fixture", request(page([], 1, true))));
	await assert.rejects(resolveAudience(source, "fixture", request(page([submission("one"), submission("two")], 2))));
	await assert.rejects(resolveAudience(source, "fixture", async () => new Response("no", { status: 503 })));
});

test("CSV source preserves custom template fields and compressed snapshots", async () => {
	const csv = recipientCsv([{ email: "person@example.com", name: 'Alex, "A"', id: "opaque-id", note: "line one\nline two" }]);
	const plain = await resolveAudience({ type: "csv", data: csv, encoding: "utf8" }, "");
	const compressed = await resolveAudience({ type: "csv", data: gzipSync(csv).toString("base64"), encoding: "gzip-base64" }, "");
	assert.deepEqual(compressed, plain);
	assert.equal(plain![0].id, "opaque-id");
	assert.equal(readRecipientCsvText(csv)[0].note, "line one\nline two");
	assert.equal(await resolveAudience({ type: "subscribers" }, ""), undefined);
});

function execution(mode: "preview" | "test" | "send") {
	const calls: string[] = [];
	const action = (name: string) => async () => { calls.push(name); };
	return { calls, input: {
		entry, mode, ref: "refs/heads/main", attempt: "1", now: () => now,
		exists: async () => { calls.push("exists"); return false; },
		claim: async () => { calls.push("claim"); return true; },
		preflight: action("preflight"), test: action("test"), send: action("send"),
	} };
}

test("preview/test never claim or send a campaign; production claims only after preflight", async () => {
	for (const mode of ["preview", "test", "send"] as const) {
		const { calls, input } = execution(mode);
		await executeCampaign(input);
		assert.deepEqual(calls, mode === "preview" ? ["preflight"] : mode === "test" ? ["preflight", "test"] : ["exists", "preflight", "claim", "send"]);
	}
});

test("preflight failure, duplicate claim, rerun or expiration cannot reach SES send", async () => {
	const failed = execution("send");
	await assert.rejects(executeCampaign({ ...failed.input, preflight: async () => { throw new Error("preflight failed"); } }));
	assert.deepEqual(failed.calls, ["exists"]);
	const duplicate = execution("send");
	assert.equal(await executeCampaign({ ...duplicate.input, exists: async () => true }), "already-claimed");
	assert.deepEqual(duplicate.calls, []);
	const race = execution("send");
	assert.equal(await executeCampaign({ ...race.input, claim: async () => false }), "already-claimed");
	assert.deepEqual(race.calls, ["exists", "preflight"]);
	await assert.rejects(executeCampaign({ ...execution("send").input, attempt: "2" }));
	await assert.rejects(executeCampaign({ ...execution("send").input, ref: "refs/heads/feature" }));
	const expired = execution("send");
	let clock = now;
	await assert.rejects(executeCampaign({ ...expired.input, now: () => clock, preflight: async () => { clock = Date.parse(end); } }));
	assert.deepEqual(expired.calls, ["exists"]);
});

test("GitHub claim is atomic across workers and survives later scheduler runs", async () => {
	let claimed = false;
	const mock: typeof fetch = async (_url, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as { ref?: string };
			if (!body.ref) return new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 201 });
			if (claimed) return new Response("{}", { status: 422 });
			claimed = true;
			return new Response("{}", { status: 201 });
		}
		return new Response("{}", { status: claimed ? 200 : 404 });
	};
	const a = new CampaignLedger("token", "org/repo", mock);
	const b = new CampaignLedger("token", "org/repo", mock);
	const claim = { campaignId: entry.id, configSha256: entry.configSha256, commit: "a".repeat(40), runId: "123" };
	assert.deepEqual((await Promise.all([a.claim(claim), b.claim(claim)])).sort(), [false, true]);
	assert.deepEqual(await unclaimedCampaigns([entry], "org/repo", "token", mock), []);
	await assert.rejects(unclaimedCampaigns([entry], "org/repo", "token", async () => new Response("{}", { status: 503 })));
});

test("checkpoints are confidential and authenticated to their exact campaign configuration", () => {
	const plaintext = JSON.stringify({ "audience.csv": "person@example.com,Alex" });
	const encrypted = encryptCheckpoint(plaintext, fixture.checkpointKey, entry.id + entry.configSha256);
	assert.equal(encrypted.includes(Buffer.from("person@example.com")), false);
	assert.equal(decryptCheckpoint(encrypted, fixture.checkpointKey, entry.id + entry.configSha256), plaintext);
	assert.throws(() => decryptCheckpoint(encrypted, fixture.checkpointKey, "another-campaign"));
	assert.throws(() => decryptCheckpoint(encrypted, "c".repeat(64), entry.id + entry.configSha256));
	encrypted[encrypted.length - 1] ^= 1;
	assert.throws(() => decryptCheckpoint(encrypted, fixture.checkpointKey, entry.id + entry.configSha256));
});
