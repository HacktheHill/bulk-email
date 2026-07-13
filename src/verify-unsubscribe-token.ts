#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { program } from "commander";
import { parseUnsubscribeKeyring } from "./utils.js";

const options = program
	.option("--token <token>", "Unsubscribe token")
	.option("--secret <secret>", "Legacy HMAC secret")
	.option("--keyring <keyring>", "Versioned keyring JSON")
	.option("--url <url>", "Full unsubscribe URL containing ?token=...")
	.parse()
	.opts();

let token = options.token as string | undefined;
if (!token && options.url) token = new URL(String(options.url)).searchParams.get("token") ?? undefined;
if (!token) throw new Error("Provide either --token or --url");

const parts = token.split(".");
let payloadPart: string;
let expectedSignature: string;
let providedSignature: string;
let keyId = "legacy";

if (parts.length === 4 && parts[0] === "v1") {
	const [, parsedKeyId, parsedPayload, parsedSignature] = parts;
	if (!parsedKeyId || !parsedPayload || !parsedSignature) throw new Error("Invalid versioned token format");
	const keyring = parseUnsubscribeKeyring(String(options.keyring ?? process.env.UNSUBSCRIBE_TOKEN_KEYS ?? "") || undefined);
	const secret = keyring[parsedKeyId];
	if (!secret) throw new Error("Token key ID is not in the verification keyring");
	keyId = parsedKeyId;
	payloadPart = parsedPayload;
	providedSignature = parsedSignature;
	expectedSignature = base64UrlEncode(createHmac("sha256", secret).update(`v1.${parsedKeyId}.${parsedPayload}`).digest());
} else if (parts.length === 2) {
	const [parsedPayload, parsedSignature] = parts;
	const secret = String(options.secret ?? process.env.UNSUBSCRIBE_SECRET ?? "");
	if (!parsedPayload || !parsedSignature || !secret) throw new Error("Legacy token verification requires its secret");
	payloadPart = parsedPayload;
	providedSignature = parsedSignature;
	expectedSignature = base64UrlEncode(createHmac("sha256", secret).update(parsedPayload).digest());
} else {
	throw new Error("Invalid token format");
}

if (!safeCompare(expectedSignature, providedSignature)) {
	console.error("Invalid signature");
	process.exitCode = 1;
} else {
	const payload = JSON.parse(decodeBase64Url(payloadPart)) as { email?: unknown };
	if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new Error("Invalid token payload");
	console.info(`Token valid (key ID: ${keyId})`);
}

function safeCompare(a: string, b: string): boolean {
	const aDigest = createHash("sha256").update(a).digest();
	const bDigest = createHash("sha256").update(b).digest();
	return timingSafeEqual(aDigest, bDigest);
}

function base64UrlEncode(input: Buffer): string {
	return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): string {
	const base64 = input.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}
