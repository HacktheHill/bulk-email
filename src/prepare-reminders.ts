import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReminderAudiences, fetchTallyApplicants } from "./tally-audience.js";

const directory = path.resolve(".bulk-email", "audiences");
const rows = await fetchTallyApplicants(process.env.TALLY_API_KEY ?? "", "9qga9Q");
const audience = buildReminderAudiences(rows);
await mkdir(directory, { recursive: true, mode: 0o700 });
const csv = (emails: string[]) => `email\n${emails.map(e => `"${e.replaceAll('"', '""')}"`).join("\n")}\n`;
await writeFile(path.join(directory, "completed.csv"), csv(audience.completed), { mode: 0o600 });
await writeFile(path.join(directory, "general-exclusions.csv"), csv(audience.generalExclusions), { mode: 0o600 });
await writeFile(path.join(directory, "incomplete.csv"),
	`email,language\n${audience.incomplete.map(a => `"${a.email.replaceAll('"', '""')}",${a.language}`).join("\n")}\n`, { mode: 0o600 });
await writeFile(path.join(directory, "prepared-at.txt"), new Date().toISOString(), { mode: 0o600 });
console.info(JSON.stringify({ ...audience.counts, preparedAt: new Date().toISOString() }));
