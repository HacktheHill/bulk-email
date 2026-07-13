import assert from "node:assert/strict";
import test from "node:test";
import { confirmCampaignSend } from "../src/confirmation.js";

test("--yes bypasses the interactive prompt", async () => {
	let prompted = false;
	assert.equal(await confirmCampaignSend({
		yes: true,
		prompt: async () => {
			prompted = true;
			return false;
		},
	}), true);
	assert.equal(prompted, false);
});

test("interactive confirmation fails closed", async () => {
	assert.equal(await confirmCampaignSend({ yes: false, prompt: async () => false }), false);
});
