import { normalizeEmail } from "./utils.js";

export async function fetchCsvSnapshot(input: {
	url: string;
	token: string;
	timeoutMs: number;
	maxBytes: number;
}): Promise<string> {
	return fetchTextWithTimeout(
		input.url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "text/csv",
			},
		},
		input.timeoutMs,
		input.maxBytes,
		"Subscriber export endpoint",
	);
}

export type SuppressionCheckInput = {
	endpointUrl: string;
	bearerToken: string;
	timeoutMs: number;
	maxPageBytes: number;
	maxPages?: number;
};

export async function fetchSuppressedEmailSet(input: SuppressionCheckInput): Promise<Set<string>> {
	const { endpointUrl, bearerToken, timeoutMs, maxPageBytes, maxPages = 10_000 } = input;
	const result = new Set<string>();
	let cursor: string | undefined;
	const seenCursors = new Set<string>();

	for (let page = 0; page < maxPages; page++) {
		const url = new URL(endpointUrl);
		url.searchParams.set("suppressed", "1");
		url.searchParams.set("limit", "1000");
		if (cursor) {
			url.searchParams.set("cursor", cursor);
		}

		if (cursor) {
			if (seenCursors.has(cursor)) {
				throw new Error("Suppression sync endpoint returned a repeated cursor");
			}
			seenCursors.add(cursor);
		}

		const payloadText = await fetchTextWithTimeout(
			url,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${bearerToken}`,
					Accept: "application/json",
				},
			},
			timeoutMs,
			maxPageBytes,
			"Suppression sync endpoint",
		);

		const payload = JSON.parse(payloadText) as {
			emails?: unknown;
			cursor?: unknown;
			done?: unknown;
		};

		if (!Array.isArray(payload.emails)) {
			throw new TypeError("Suppression sync endpoint returned invalid emails payload");
		}

		for (const value of payload.emails) {
			if (typeof value === "string" && value.trim().length > 0) {
				result.add(normalizeEmail(value));
			}
		}

		const done = payload.done === true;
		const nextCursor = typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : undefined;

		if (done) {
			return result;
		}
		if (!nextCursor) {
			throw new Error("Suppression sync endpoint returned done=false without a cursor");
		}

		if (seenCursors.has(nextCursor)) {
			throw new Error("Suppression sync endpoint returned a repeated cursor");
		}
		cursor = nextCursor;
	}

	throw new Error(`Suppression sync endpoint exceeded the ${maxPages}-page limit`);
}

export async function fetchTextWithTimeout(
	url: string | URL,
	init: RequestInit,
	timeoutMs: number,
	maxBytes: number,
	endpointName: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			throw new Error(`${endpointName} returned ${response.status}`);
		}
		return await readResponseTextWithLimit(response, maxBytes);
	} finally {
		clearTimeout(timeout);
	}
}

export async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw new Error(`Response exceeds the configured ${maxBytes}-byte limit`);
		}
	}

	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maxBytes) {
			throw new Error(`Response exceeds the configured ${maxBytes}-byte limit`);
		}
		return text;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`Response exceeds the configured ${maxBytes}-byte limit`);
			}

			chunks.push(decoder.decode(value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}

	chunks.push(decoder.decode());
	return chunks.join("");
}
