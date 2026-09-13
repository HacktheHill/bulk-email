import { z } from "zod";
import { readResponseTextWithLimit } from "./list-service.js";

export type Claim = { campaignId: string; configSha256: string; commit: string; runId: string };

export class CampaignLedger {
	private readonly base: string;
	constructor(private token: string, repository: string, private request = fetch) {
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error("A GitHub repository and token are required for the campaign ledger");
		this.base = `https://api.github.com/repos/${repository}`;
	}
	private ref(id: string) {
		if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid campaign ID");
		return `tags/email-campaign/${id}`;
	}
	private async call(route: string, method = "GET", body?: unknown): Promise<Response> {
		return this.request(this.base + route, {
			method, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000),
		});
	}
	async exists(id: string): Promise<boolean> {
		const response = await this.call(`/git/ref/${this.ref(id)}`);
		if (response.status === 404) return false;
		if (!response.ok) throw new Error("Cannot verify campaign send history");
		return true;
	}
	async claim(input: Claim): Promise<boolean> {
		const ref = this.ref(input.campaignId);
		if (!/^[a-f0-9]{40}$/.test(input.commit) || !/^[a-f0-9]{64}$/.test(input.configSha256) || !/^\d+$/.test(input.runId)) throw new Error("Invalid campaign claim metadata");
		const objectResponse = await this.call("/git/tags", "POST", {
			tag: `email-campaign/${input.campaignId}`, message: JSON.stringify({ ...input, status: "send-attempt-started" }),
			object: input.commit, type: "commit",
			tagger: { name: "Campaign runner", email: "actions@users.noreply.github.com", date: new Date().toISOString() },
		});
		if (!objectResponse.ok) throw new Error("Cannot create campaign send record");
		const { sha } = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(await readResponseTextWithLimit(objectResponse, 1024 * 1024)));
		// Creating a ref is atomic: a second worker cannot claim the same campaign.
		const response = await this.call("/git/refs", "POST", { ref: `refs/${ref}`, sha });
		if (response.status === 201) return true;
		if (response.status === 422 && await this.exists(input.campaignId)) return false;
		throw new Error("Campaign claim is uncertain; inspect GitHub before any send");
	}
}
