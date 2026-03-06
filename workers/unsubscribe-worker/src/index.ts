type TokenPayload = {
	email: string;
	iat?: number;
};

type WorkerEnv = {
	UOSU_UNSUBSCRIBES: KVNamespace;
	UOSU_UNSUBSCRIBE_TOKEN_SECRET: string;
	UOSU_SUPPRESSION_READ_TOKEN: string;
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== '/unsubscribe') {
			return new Response('Not Found', { status: 404 });
		}

		if (request.method === 'GET' && url.searchParams.get('suppressed') === '1') {
			if (!isAuthorized(request, env.UOSU_SUPPRESSION_READ_TOKEN)) {
				return new Response('Unauthorized', { status: 401 });
			}

			const limitParam = Number(url.searchParams.get('limit') ?? '1000');
			const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 1000;
			const cursor = url.searchParams.get('cursor') ?? undefined;
			const page = await env.UOSU_UNSUBSCRIBES.list({ prefix: 'unsub:', limit, cursor });
			const emails = page.keys
				.map((key) => key.name)
				.filter((name) => name.startsWith('unsub:'))
				.map((name) => name.slice('unsub:'.length));

			return jsonResponse({
				emails,
				cursor: page.cursor,
				done: page.list_complete,
			});
		}

		if (request.method !== 'GET' && request.method !== 'POST') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: { Allow: 'GET, POST' },
			});
		}

		const token = url.searchParams.get('t');
		if (!token) {
			return new Response('Missing token', { status: 400 });
		}

		const payload = await verifyToken(token, env.UOSU_UNSUBSCRIBE_TOKEN_SECRET);
		if (!payload) {
			return new Response('Invalid token', { status: 400 });
		}

		const normalizedEmail = payload.email.trim().toLowerCase();
		const nowIso = new Date().toISOString();

		await env.UOSU_UNSUBSCRIBES.put(
			`unsub:${normalizedEmail}`,
			JSON.stringify({ email: normalizedEmail, iat: payload.iat ?? null, unsubscribedAt: nowIso }),
		);

		if (request.method === 'POST') {
			return new Response('ok', { status: 200 });
		}

		return new Response('You have been unsubscribed from future emails.', {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	},
} satisfies ExportedHandler<WorkerEnv>;

function isAuthorized(request: Request, expectedToken: string): boolean {
	const authHeader = request.headers.get('authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return false;
	}

	const provided = authHeader.slice('Bearer '.length).trim();
	return provided.length > 0 && provided === expectedToken;
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
	const [payloadPart, signaturePart] = token.split('.');
	if (!payloadPart || !signaturePart) {
		return null;
	}

	const expectedSig = await hmacBase64Url(payloadPart, secret);
	if (!constantTimeEquals(expectedSig, signaturePart)) {
		return null;
	}

	try {
		const payloadJson = decodeBase64UrlToString(payloadPart);
		const payload = JSON.parse(payloadJson) as Partial<TokenPayload>;
		if (!payload.email || typeof payload.email !== 'string') {
			return null;
		}

		return {
			email: payload.email,
			iat: typeof payload.iat === 'number' ? payload.iat : undefined,
		};
	} catch {
		return null;
	}
}

async function hmacBase64Url(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return encodeBase64Url(new Uint8Array(sig));
}

function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}

	return mismatch === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	const base64 = btoa(binary);
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64UrlToString(base64url: string): string {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return new TextDecoder().decode(bytes);
}
