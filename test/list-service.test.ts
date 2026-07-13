import assert from "node:assert/strict";
import test from "node:test";
import { fetchCsvSnapshot, fetchSuppressedEmailSet, readResponseTextWithLimit } from "../src/list-service.js";

test("fetches and combines paginated suppression results", async () => {
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];
	globalThis.fetch = async input => {
		const url = String(input);
		requestedUrls.push(url);
		if (!url.includes("cursor=")) {
			return new Response(JSON.stringify({ emails: ["A@example.com"], cursor: "next", done: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ emails: ["b@example.com"], done: true }), { status: 200 });
	};

	try {
		const result = await fetchSuppressedEmailSet({
			endpointUrl: "https://emails.example.test/unsubscribe",
			bearerToken: "token",
			timeoutMs: 1_000,
			maxPageBytes: 10_000,
		});
		assert.deepEqual(result, new Set(["a@example.com", "b@example.com"]));
		assert.equal(requestedUrls.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects repeated suppression cursors", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ emails: [], cursor: "same", done: false }), { status: 200 });

	try {
		await assert.rejects(
			fetchSuppressedEmailSet({
				endpointUrl: "https://emails.example.test/unsubscribe",
				bearerToken: "token",
				timeoutMs: 1_000,
				maxPageBytes: 10_000,
			}),
			/repeated cursor/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects done=false suppression pages without a cursor", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ emails: [], done: false }), { status: 200 });
	try {
		await assert.rejects(fetchSuppressedEmailSet({
			endpointUrl: "https://emails.example.test/unsubscribe",
			bearerToken: "token",
			timeoutMs: 1_000,
			maxPageBytes: 10_000,
		}), /done=false without a cursor/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("keeps the timeout active while the response body is being read", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		const signal = init?.signal;
		return new Response(new ReadableStream({
			start(controller) {
				signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
			},
		}));
	};
	try {
		await assert.rejects(fetchCsvSnapshot({
			url: "https://emails.example.test/subscribe?export=csv",
			token: "token",
			timeoutMs: 10,
			maxBytes: 1_000,
		}), /aborted/i);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("enforces response size limits", async () => {
	const response = new Response("0123456789");
	await assert.rejects(readResponseTextWithLimit(response, 5), /exceeds/);
});
