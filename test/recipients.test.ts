import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecipientCsv, readRecipientCsvText } from "../src/recipients.js";

test("reads CSV headers, trims values, and preserves extra template fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	const file = join(directory, "recipients.csv");
	await writeFile(file, "email,name,language,organization\n Alice@Example.com ,Alice,en,Hack the Hill\n", "utf8");

	try {
		assert.deepEqual(await readRecipientCsv(file), [
			{ email: "alice@example.com", name: "Alice", language: "en", organization: "Hack the Hill" },
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects rows without a valid email", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bulk-email-test-"));
	const file = join(directory, "recipients.csv");
	await writeFile(file, "email\nnot-an-email\n", "utf8");

	try {
		await assert.rejects(readRecipientCsv(file), /Failed to validate CSV row 2/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("parses authenticated CSV snapshots directly from memory", () => {
	assert.deepEqual(readRecipientCsvText("email,name\nMEMBER@EXAMPLE.COM,Member\n"), [
		{ email: "member@example.com", name: "Member", language: "en" },
	]);
});
