import { createHash } from "node:crypto";
import { z } from "zod";
import { canSend, isInstant, type QueueEntry } from "./campaign-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.discriminatedUnion("type", [
	z.object({ type: z.literal("subscribers") }).strict(),
	z.object({ type: z.literal("csv"), data: z.string().min(1), encoding: z.enum(["utf8", "gzip-base64"]).default("utf8") }).strict(),
	z.object({
		type: z.literal("tally-incomplete"), formId: z.string().regex(/^[A-Za-z0-9]+$/),
		inactiveHours: z.number().int().min(1).max(24 * 30).default(24),
	}).strict(),
	z.object({
		type: z.literal("tally-reviewed"), formId: z.string().regex(/^[A-Za-z0-9]+$/),
		submissionIds: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).min(1).max(10_000)
			.refine(ids => new Set(ids).size === ids.length),
	}).strict(),
]);
export const campaignSchema = z.object({
	version: z.literal(1),
	id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
	sendAt: z.string().refine(isInstant), expiresAt: z.string().refine(isInstant),
	template: z.object({ ref: z.string().regex(/^[a-f0-9]{40}$/), file: z.string().regex(/^[a-zA-Z0-9_-]+\.tsx$/) }).strict(),
	audience: source,
	expected: z.object({ recipients: z.number().int().positive().max(10_000), emailSetSha256: hash }).strict().optional(),
	purpose: z.string().min(10).max(500),
	respectListSuppressions: z.boolean().default(false),
	test: z.object({ to: z.string().email(), props: z.record(z.string(), z.string()).default({}) }).strict(),
	checkpointKey: hash,
}).strict();
export type CampaignConfig = z.infer<typeof campaignSchema>;
export const configDigest = (raw: string) => createHash("sha256").update(raw).digest("hex");

export function parseCampaign(raw: string): CampaignConfig {
	try {
		if (Buffer.byteLength(raw) > 48 * 1024) throw new Error();
		const result = campaignSchema.parse(JSON.parse(raw));
		if (Date.parse(result.expiresAt) <= Date.parse(result.sendAt) || Date.parse(result.expiresAt) - Date.parse(result.sendAt) > 86_400_000) throw new Error();
		return result;
	} catch {
		throw new Error("Invalid private campaign configuration; no private values are logged");
	}
}

export function validateCampaignEntry(raw: string, entry: QueueEntry, send: boolean, now = Date.now()): CampaignConfig {
	const config = parseCampaign(raw);
	if (configDigest(raw) !== entry.configSha256 || config.id !== entry.id
		|| config.sendAt !== entry.sendAt || config.expiresAt !== entry.expiresAt) throw new Error("Campaign configuration does not match its queue entry");
	if (send && (!canSend(entry, now) || !config.expected)) throw new Error("Sending requires an approved exact audience and a valid send window");
	return config;
}
