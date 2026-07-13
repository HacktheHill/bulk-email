import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("CLI exposes the unified send and exact-path test commands", async () => {
	const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "send", "--help"]);
	assert.match(result.stdout, /--yes/);
	const root = await execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "--help"]);
	assert.match(root.stdout, /send \[options\]/);
	assert.match(root.stdout, /test \[options\]/);
	const test = await execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "test", "--help"]);
	assert.match(test.stdout, /real test message immediately/);
	assert.doesNotMatch(test.stdout, /legacy|secret/i);
});

test("CLI returns a nonzero exit for invalid campaign configuration", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "send", "--campaign-id", "../unsafe"]),
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code !== 0,
	);
});
