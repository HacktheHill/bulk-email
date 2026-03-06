import { createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src';

describe('unsubscribe worker', () => {
	it('returns 404 for unknown routes', async () => {
		const response = await runUnitFetch(new Request('http://example.com/unknown'));

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found');
	});

	it('returns 405 for unsupported methods', async () => {
		const response = await runUnitFetch(new Request('http://example.com/unsubscribe?t=abc', { method: 'PUT' }));

		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, POST');
		expect(await response.text()).toBe('Method Not Allowed');
	});

	it('returns 400 for missing token', async () => {
		const response = await runUnitFetch(new Request('http://example.com/unsubscribe'));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Missing token');
	});

	it('returns 400 for invalid token', async () => {
		const response = await runUnitFetch(new Request('http://example.com/unsubscribe?t=bad.token'));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid token');
	});

	it('returns 401 for suppression list without bearer token', async () => {
		const response = await runUnitFetch(new Request('http://example.com/unsubscribe?suppressed=1'));

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Unauthorized');
	});

	it('returns suppression list with bearer token', async () => {
		const list = vi.fn(async () => ({
			keys: [{ name: 'unsub:user1@example.com' }, { name: 'unsub:user2@example.com' }],
			list_complete: true,
			cursor: undefined,
		}));

		const response = await runUnitFetch(
			new Request('http://example.com/unsubscribe?suppressed=1&limit=1000', {
				headers: { Authorization: 'Bearer read-token' },
			}),
			{
				UOSU_UNSUBSCRIBES: { put: async () => {}, list },
				UOSU_SUPPRESSION_READ_TOKEN: 'read-token',
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toEqual({
			emails: ['user1@example.com', 'user2@example.com'],
			cursor: undefined,
			done: true,
		});
		expect(list).toHaveBeenCalledTimes(1);
	});

	it('stores unsubscribe and returns confirmation on GET', async () => {
		const put = vi.fn(async () => {});
		const token = await createToken({ email: ' User@Example.com ', iat: 1234 }, 'test-secret');
		const response = await runUnitFetch(new Request(`http://example.com/unsubscribe?t=${token}`), {
			UOSU_UNSUBSCRIBES: { put },
			UOSU_UNSUBSCRIBE_TOKEN_SECRET: 'test-secret',
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(await response.text()).toBe('You have been unsubscribed from future emails.');

		expect(put).toHaveBeenCalledTimes(1);
		const [key, value] = put.mock.calls[0] as [string, string];
		expect(key).toBe('unsub:user@example.com');

		const parsed = JSON.parse(value) as {
			email: string;
			iat: number | null;
			unsubscribedAt: string;
		};
		expect(parsed.email).toBe('user@example.com');
		expect(parsed.iat).toBe(1234);
		expect(parsed.unsubscribedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(Number.isNaN(Date.parse(parsed.unsubscribedAt))).toBe(false);
	});

	it('returns ok for POST when token is valid', async () => {
		const put = vi.fn(async () => {});
		const token = await createToken({ email: 'post@example.com' }, 'test-secret');
		const response = await runUnitFetch(new Request(`http://example.com/unsubscribe?t=${token}`, { method: 'POST' }), {
			UOSU_UNSUBSCRIBES: { put },
			UOSU_UNSUBSCRIBE_TOKEN_SECRET: 'test-secret',
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
		expect(put).toHaveBeenCalledOnce();
	});

	it('integration: returns missing token without query string', async () => {
		const response = await SELF.fetch(new Request('http://example.com/unsubscribe'));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Missing token');
	});
});

async function runUnitFetch(
	request: Request,
	overrides?: {
		UOSU_UNSUBSCRIBES?: {
			put: (key: string, value: string) => Promise<void>;
			list?: (options: { prefix?: string; limit?: number; cursor?: string }) => Promise<{
				keys: Array<{ name: string }>;
				list_complete: boolean;
				cursor?: string;
			}>;
		};
		UOSU_UNSUBSCRIBE_TOKEN_SECRET?: string;
		UOSU_SUPPRESSION_READ_TOKEN?: string;
	},
): Promise<Response> {
	const env = {
		UOSU_UNSUBSCRIBES: overrides?.UOSU_UNSUBSCRIBES ?? {
			put: async () => {},
			list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
		},
		UOSU_UNSUBSCRIBE_TOKEN_SECRET: overrides?.UOSU_UNSUBSCRIBE_TOKEN_SECRET ?? 'test-secret',
		UOSU_SUPPRESSION_READ_TOKEN: overrides?.UOSU_SUPPRESSION_READ_TOKEN ?? 'read-token',
	} as unknown as Env;

	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function createToken(payload: { email: string; iat?: number }, secret: string): Promise<string> {
	const payloadPart = encodeBase64Url(JSON.stringify(payload));
	const signaturePart = await signPayload(payloadPart, secret);
	return `${payloadPart}.${signaturePart}`;
}

async function signPayload(payloadPart: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart));
	return encodeBase64UrlBytes(new Uint8Array(signature));
}

function encodeBase64Url(value: string): string {
	return encodeBase64UrlBytes(new TextEncoder().encode(value));
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
