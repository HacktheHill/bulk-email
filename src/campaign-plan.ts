import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type CampaignMode = "preview" | "test" | "send" | "schedule";
export type QueueEntry = {
	id: string;
	configSecret: string;
	configSha256: string;
	approvedSha256?: string;
	sendAt: string;
	expiresAt: string;
	enabled: boolean;
};

export function isInstant(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
		&& Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
}

export function parseQueue(raw: string): QueueEntry[] {
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid campaign queue");
	const ids = new Set<string>();
	return value.map((entry: unknown) => {
		if (!entry || typeof entry !== "object") throw new Error("Invalid queue entry");
		const e = entry as Record<string, unknown>;
		if (Object.keys(e).some(k => !["id", "configSecret", "configSha256", "approvedSha256", "sendAt", "expiresAt", "enabled"].includes(k))
			|| typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(e.id) || ids.has(e.id)
			|| typeof e.configSecret !== "string" || !/^CAMPAIGN_CONFIG_[A-Z0-9_]+$/.test(e.configSecret)
			|| typeof e.configSha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.configSha256)
			|| (e.approvedSha256 !== undefined && (typeof e.approvedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.approvedSha256)))
			|| typeof e.enabled !== "boolean" || !isInstant(e.sendAt) || !isInstant(e.expiresAt)
			|| Date.parse(e.expiresAt) <= Date.parse(e.sendAt) || Date.parse(e.expiresAt) - Date.parse(e.sendAt) > 86_400_000) {
			throw new Error("Invalid, duplicate or unsafe campaign queue entry");
		}
		ids.add(e.id);
		return e as QueueEntry;
	});
}

export function canSend(entry: QueueEntry, now = Date.now()): boolean {
	return entry.enabled && entry.approvedSha256 === entry.configSha256
		&& now >= Date.parse(entry.sendAt) && now < Date.parse(entry.expiresAt);
}

export function planCampaigns(queue: QueueEntry[], mode: CampaignMode, id?: string, now = Date.now()): QueueEntry[] {
	if (mode === "schedule") return queue.filter(entry => canSend(entry, now));
	const entry = queue.find(entry => entry.id === id);
	if (!entry) throw new Error("Select a campaign ID present in CAMPAIGN_QUEUE");
	if (mode === "send" && !canSend(entry, now)) throw new Error("Campaign is unapproved, disabled or outside its send window");
	return [entry];
}

export async function unclaimedCampaigns(entries: QueueEntry[], repository: string, token: string, request = fetch): Promise<QueueEntry[]> {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error("Cannot inspect campaign history");
	const pending: QueueEntry[] = [];
	for (const entry of entries) {
		const response = await request(`https://api.github.com/repos/${repository}/git/ref/tags/email-campaign/${entry.id}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 404) pending.push(entry);
		else if (!response.ok) throw new Error("Cannot inspect campaign history");
	}
	return pending;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const mode = process.env.CAMPAIGN_MODE ?? "schedule";
		if (!["preview", "test", "send", "schedule"].includes(mode)) throw new Error("Invalid campaign mode");
		let selected = planCampaigns(parseQueue(process.env.CAMPAIGN_QUEUE ?? "[]"), mode as CampaignMode, process.env.CAMPAIGN_ID);
		if (selected.length && (mode === "schedule" || mode === "send")) selected = await unclaimedCampaigns(selected, process.env.GITHUB_REPOSITORY ?? "", process.env.GH_TOKEN ?? "");
		if (!process.env.GITHUB_OUTPUT) throw new Error("Missing Actions output file");
		appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: selected })}\nhas_work=${selected.length > 0}\n`);
		console.info(`${selected.length} campaign(s) selected for ${mode}.`);
	} catch {
		console.error("Cannot plan campaigns: check the queue, campaign ID, approval and send window.");
		process.exitCode = 1;
	}
}
