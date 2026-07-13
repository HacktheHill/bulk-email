import assert from "node:assert/strict";
import test from "node:test";
import { ListSuppressedDestinationsCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { fetchSesSuppressedEmailSet, mergeSuppressionSets } from "../src/ses-service.js";

test("loads all SES bounce and complaint suppressions", async () => {
	const tokens: Array<string | undefined> = [];
	const client = {
		send: async (command: ListSuppressedDestinationsCommand) => {
			tokens.push(command.input.NextToken);
			return command.input.NextToken
				? { SuppressedDestinationSummaries: [{ EmailAddress: "Complaint@Example.com" }] }
				: { SuppressedDestinationSummaries: [{ EmailAddress: "Bounce@Example.com" }], NextToken: "next" };
		},
	} as unknown as SESv2Client;

	assert.deepEqual(await fetchSesSuppressedEmailSet(client), new Set(["bounce@example.com", "complaint@example.com"]));
	assert.deepEqual(tokens, [undefined, "next"]);
});

test("merges suppression sources without exposing or duplicating recipients", () => {
	assert.deepEqual(
		mergeSuppressionSets(new Set(["A@example.com"]), new Set(["a@example.com", "b@example.com"])),
		new Set(["a@example.com", "b@example.com"]),
	);
});
