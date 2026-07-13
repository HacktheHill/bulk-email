import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("CLI exposes --yes and exits successfully for help", async () => {
	const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "--help"]);
	assert.match(result.stdout, /--yes/);
});

test("CLI returns a nonzero exit for invalid campaign configuration", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, ["--import", "tsx", "src/app.ts", "--campaign-id", "../unsafe"]),
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code !== 0,
	);
});
