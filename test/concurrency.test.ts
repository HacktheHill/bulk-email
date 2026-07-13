import assert from "node:assert/strict";
import test from "node:test";
import { processWithConcurrency } from "../src/concurrency.js";

test("a fatal result aborts in-flight work and stops scheduling new recipients", async () => {
	const started: number[] = [];
	const observedAbort: number[] = [];
	await assert.rejects(processWithConcurrency([1, 2, 3, 4], 2, async (item, signal) => {
		started.push(item);
		if (item === 1) throw new Error("fatal");
		await new Promise<void>(resolve => {
			if (signal.aborted) {
				observedAbort.push(item);
				resolve();
				return;
			}
			signal.addEventListener("abort", () => {
				observedAbort.push(item);
				resolve();
			}, { once: true });
		});
	}), /fatal/);
	assert.deepEqual(started, [1, 2]);
	assert.deepEqual(observedAbort, [2]);
});
