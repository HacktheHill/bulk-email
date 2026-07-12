#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";
import { program } from "commander";

let { token, secret, url } = program
	.option("--token <token>", "Unsubscribe token in <payload>.<signature> format")
	.option("--secret <secret>", "HMAC secret used to sign unsubscribe tokens")
	.option("--url <url>", "Full unsubscribe URL containing ?t=...")
	.parse()
	.opts();

secret ??= process.env.UNSUBSCRIBE_SECRET;

if (!token && !url) {
	throw new Error("Provide either --token or --url");
}

if (!secret) {
	throw new Error("Missing secret. Provide --secret or UNSUBSCRIBE_SECRET env var");
}

if (url && !token) {
	const parsed = new URL(url);
	token = parsed.searchParams.get("t") ?? undefined;
}

if (!token) {
	throw new Error("Token not found");
}

const [payloadPart, signaturePart] = token.split(".");
if (!payloadPart || !signaturePart) {
	throw new Error("Invalid token format. Expected <payload>.<signature>");
}

const expectedSig = base64UrlEncode(createHmac("sha256", secret).update(payloadPart).digest());
const isValid = safeCompare(expectedSig, signaturePart);

if (!isValid) {
	console.error("Invalid signature");
	process.exit(1);
}

const payloadJson = decodeBase64Url(payloadPart);
const payload = JSON.parse(payloadJson) as { email?: string; iat?: number };

console.info("Token valid");
console.info(JSON.stringify(payload, null, 2));

function safeCompare(a: string, b: string): boolean {
	const aBytes = new Uint8Array(Buffer.from(a));
	const bBytes = new Uint8Array(Buffer.from(b));
	if (aBytes.length !== bBytes.length) {
		return false;
	}

	return timingSafeEqual(aBytes, bBytes);
}

function base64UrlEncode(input: Buffer): string {
	return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): string {
	const base64 = input.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}
