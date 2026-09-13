import { Command } from "commander";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configDigest, parseCampaign, validateCampaignEntry, type CampaignConfig } from "./campaign-config.js";
import { canSend, parseQueue, type QueueEntry } from "./campaign-plan.js";
import { recipientCsv, resolveAudience, verifyAudience } from "./campaign-audience.js";
import { CampaignLedger } from "./campaign-ledger.js";
import { decryptCheckpoint, encryptCheckpoint } from "./campaign-checkpoint.js";

type Mode = "preview" | "test" | "send";
type Execution = {
	entry: QueueEntry; mode: Mode; ref?: string; attempt?: string;
	now?: () => number;
	exists: () => Promise<boolean>; claim: () => Promise<boolean>;
	preflight: () => Promise<void>; test: () => Promise<void>; send: () => Promise<void>;
};

export async function executeCampaign(input: Execution): Promise<string> {
	const now = input.now ?? Date.now;
	if (input.mode === "send") {
		if (input.ref !== "refs/heads/main" || input.attempt !== "1" || !canSend(input.entry, now())) throw new Error("Sending requires the approved main workflow within its send window");
		if (await input.exists()) return "already-claimed";
	}
	await input.preflight();
	if (input.mode === "test") { await input.test(); return "tested"; }
	if (input.mode === "preview") return "previewed";
	if (!canSend(input.entry, now())) throw new Error("Send window expired during preflight");
	if (!await input.claim()) return "already-claimed";
	if (!canSend(input.entry, now())) throw new Error("Send window expired after claiming; reconcile before retrying");
	await input.send();
	return "sent";
}

function cli(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "src/app.ts", ...args], { stdio: "inherit" });
		child.on("error", () => reject(new Error("Could not start the bulk-email CLI")));
		child.on("exit", code => code === 0 ? resolve() : reject(new Error("The bulk-email CLI failed; inspect its preflight or delivery result")));
	});
}

async function output(key: string, value: string) {
	if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function archive(config: CampaignConfig, raw: string) {
	const files: Record<string, string> = {};
	for (const file of ["manifest.json", "accepted.jsonl", "failures.jsonl"]) {
		try { files[file] = await readFile(path.join(".bulk-email/campaigns", config.id, file), "utf8"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
	}
	try { files["audience.csv"] = await readFile(".bulk-email/audience.csv", "utf8"); }
	catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
	await mkdir(".bulk-email", { recursive: true, mode: 0o700 });
	await writeFile(".bulk-email/checkpoint.enc", encryptCheckpoint(JSON.stringify(files), config.checkpointKey, `${config.id}:${configDigest(raw)}`), { mode: 0o600 });
	console.info("Encrypted reconciliation checkpoint saved. Keep the private campaign configuration to decrypt it.");
}

export async function runConfiguredCampaign(raw: string, entry: QueueEntry, mode: Mode): Promise<void> {
	const config = validateCampaignEntry(raw, entry, mode === "send");
	const ledger = mode === "send" ? new CampaignLedger(process.env.GH_TOKEN ?? "", process.env.GITHUB_REPOSITORY ?? "") : undefined;
	const templateArgs = ["--template-dir", "../react-email-templates/emails/hackthehill", "--template", config.template.file];
	const sendArgs = ["send", "--campaign-id", config.id, ...templateArgs, "--purpose", config.purpose];
	if (config.expected) sendArgs.push("--expected-recipients", String(config.expected.recipients), "--expected-email-set-sha256", config.expected.emailSetSha256);
	if (config.respectListSuppressions) sendArgs.push("--respect-list-suppressions");
	const result = await executeCampaign({
		entry, mode, ref: process.env.GITHUB_REF, attempt: process.env.GITHUB_RUN_ATTEMPT,
		exists: () => ledger!.exists(config.id),
		claim: async () => {
			const claimed = await ledger!.claim({ campaignId: config.id, configSha256: entry.configSha256, commit: process.env.GITHUB_SHA ?? "", runId: process.env.GITHUB_RUN_ID ?? "" });
			if (claimed) await output("claimed", "true");
			return claimed;
		},
		preflight: async () => {
			const recipients = await resolveAudience(config.audience, process.env.TALLY_API_KEY ?? "");
			await mkdir(".bulk-email", { recursive: true, mode: 0o700 });
			if (recipients) {
				verifyAudience(recipients, config.expected);
				for (const recipient of recipients) console.info(`::add-mask::${recipient.email}`);
				await writeFile(".bulk-email/audience.csv", recipientCsv(recipients), { mode: 0o600 });
				sendArgs.push("--file", ".bulk-email/audience.csv");
				console.info(`First-name greetings: ${recipients.filter(r => r.name).length}; neutral fallbacks: ${recipients.filter(r => !r.name).length}.`);
			}
			await cli([...sendArgs, "--dry-run"]);
		},
		test: async () => {
			await writeFile(".bulk-email/test.csv", recipientCsv([{ ...config.test.props, email: config.test.to }]), { mode: 0o600 });
			await cli(["test", "--to", config.test.to, "--file", ".bulk-email/test.csv", ...templateArgs]);
		},
		send: () => cli([...sendArgs, "--yes"]),
	});
	console.info(`Campaign ${config.id}: ${result}.`);
	if (result === "already-claimed") console.info("A permanent send record already exists. Inspect that run; do not automatically retry or change the campaign ID.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const program = new Command().argument("<command>", "inspect, run, checkpoint or recover")
		.option("--config <file>", "Private configuration file; otherwise use CAMPAIGN_CONFIG")
		.option("--mode <mode>", "preview, test or send", process.env.CAMPAIGN_MODE ?? "preview")
		.option("--file <file>", "Encrypted checkpoint to recover")
		.option("--output <directory>", "New recovery directory")
		.action(async (command: string, options: { config?: string; mode: string; file?: string; output?: string }) => {
			const raw = options.config ? await readFile(options.config, "utf8") : process.env.CAMPAIGN_CONFIG ?? "";
			const config = parseCampaign(raw);
			const mode = options.mode === "schedule" ? "send" : options.mode;
			if (!["preview", "test", "send"].includes(mode)) throw new Error("Invalid campaign mode");
			const entry = parseQueue(process.env.CAMPAIGN_ENTRY ? `[${process.env.CAMPAIGN_ENTRY}]` : JSON.stringify([{
				id: config.id, configSecret: `CAMPAIGN_CONFIG_${config.id.toUpperCase().replaceAll("-", "_")}`, configSha256: configDigest(raw),
				sendAt: config.sendAt, expiresAt: config.expiresAt, enabled: false,
			}]))[0];
			if (command === "inspect") {
				validateCampaignEntry(raw, entry, mode === "send");
				await output("template_ref", config.template.ref);
				console.info(JSON.stringify({ ...entry, approvedSha256: undefined, enabled: false }, null, 2));
			} else if (command === "run") {
				await runConfiguredCampaign(raw, entry, mode as Mode);
			} else if (command === "checkpoint") {
				await archive(config, raw);
			} else if (command === "recover" && options.file && options.output) {
				const files: unknown = JSON.parse(decryptCheckpoint(await readFile(options.file), config.checkpointKey, `${config.id}:${configDigest(raw)}`));
				if (!files || typeof files !== "object" || Object.entries(files).some(([key, value]) => !["manifest.json", "accepted.jsonl", "failures.jsonl", "audience.csv"].includes(key) || typeof value !== "string")) throw new Error("Invalid checkpoint contents");
				await mkdir(options.output, { mode: 0o700 }); // Refuse to overwrite an existing recovery directory.
				for (const [key, value] of Object.entries(files)) await writeFile(path.join(options.output, key), String(value), { mode: 0o600 });
				console.info("Checkpoint recovered for manual reconciliation. No email was sent and no send record was removed.");
			} else throw new Error("Choose inspect, run, checkpoint, or recover with --file and --output");
		});
	try { await program.parseAsync(); }
	catch (error) { console.error(error instanceof Error ? error.message : "Campaign operation failed"); process.exitCode = 1; }
}
