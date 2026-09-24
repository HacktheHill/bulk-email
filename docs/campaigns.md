# Configured campaigns

Use one private configuration per campaign and one shared **Campaigns** workflow. Campaign-specific dates, audiences, counts and template pins do not belong in workflow code.

## Prepare, review, approve

1. Create an ignored `campaigns.private/<id>.campaign.json` using the schema below. Use a new ID for a new message, never to retry an uncertain send. Generate a random checkpoint key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and keep it private.
2. Run `npm run campaign -- inspect --config campaigns.private/<id>.campaign.json`. It prints a non-private queue entry with the SHA-256 of the exact file bytes and approval disabled. Store the file contents as the indicated `CAMPAIGN_CONFIG_*` Actions secret. Never commit the file.
3. Add the printed entry to the JSON array in the repository variable `CAMPAIGN_QUEUE`. Run **Campaigns → Run workflow**, choosing the ID and `preview`. The output includes the unique recipient count and normalized email-set digest. If `expected` was omitted for discovery, add these values to the private configuration, update its secret and queue digest, and preview again.
4. Run `test`. This performs the same full audience preflight, then sends only to `test.to`, using `test.props` as the greeting/fixture. Review the delivered email.
5. After approval, set the queue entry's `enabled` to `true` and `approvedSha256` to its current `configSha256`. The next scheduled check at or after `sendAt` will send within `expiresAt`. A manual `send` obeys the same approval and time limits; it cannot send early.

Changing any private configuration bytes invalidates the old approval. The private configuration and queue must have identical IDs and send windows. Use UTC ISO timestamps, allow for GitHub Actions scheduling/runner delays, and choose a window no longer than 24 hours. Missed windows never send automatically later. To pause, set `enabled: false` in the queue and cancel any already-running send job.

```json
{
  "version": 1,
  "id": "event-acceptance-wave-1",
  "sendAt": "2030-09-13T15:00:00Z",
  "expiresAt": "2030-09-13T17:00:00Z",
  "template": {
    "ref": "<full 40-character template commit>",
    "file": "application-accepted.tsx"
  },
  "audience": {
    "type": "tally-reviewed",
    "formId": "<form ID>",
    "submissionIds": ["<reviewed submission ID>"]
  },
  "expected": {
    "recipients": 1,
    "emailSetSha256": "<64-character digest from preview>"
  },
  "purpose": "Application decisions for reviewed event applicants",
  "test": {
    "to": "reviewer@example.org",
    "props": {"name": "Alex", "language": "en"}
  },
  "checkpointKey": "<random 32-byte key encoded as 64 hexadecimal characters>"
}
```

The examples contain placeholders; `inspect` validates the real file before it can be used. Each private configuration is limited to the GitHub secret size of 48 KiB.

## Audience sources

- `tally-reviewed`: resolves only the configured completed submission IDs. It reads the English/French applicant email and first-name fields, never guardian emails. Missing, incomplete, ambiguous or repeated source records stop the run. Addresses are deduplicated, conflicting or unusual names get a neutral greeting, and the expected count/digest must match before sending. It does not make admission decisions or automatically add new submissions.
- `csv`: set `data` to CSV text and optionally `encoding` to `gzip-base64` for compressed CSV. Custom columns become template props, supporting RSVP IDs and other service-message fields. Decompression is bounded to 25 MiB. Treat IDs and links as private. The template must declare `provided-csv`.
- `subscribers`: the existing CLI downloads the authenticated email-list-manager export, validates the expected count/digest and applies marketing suppression/unsubscribe rules. The template must declare `subscribers`. If the list changes after approval, sending stops for a refreshed preview and approval.

`respectListSuppressions: true` additionally applies email-list-manager suppressions to service-message CSV/Tally campaigns. SES bounce/complaint suppression always applies. Expectations describe the unique audience before suppression; suppressions can reduce the actual send count. The `tally-incomplete` audience automatically excludes completed applicants.

## Send records and reconciliation

Before the first real message, the runner atomically creates `refs/tags/email-campaign/<id>`. Its annotated tag records only campaign/configuration identifiers, runner commit and run ID, not recipients. This permanent claim prevents a second send even if a run fails, is cancelled, or its Actions logs expire. Preview and test never claim a campaign. The worker token needs `contents: write` solely to create this record; checkouts do not persist credentials.

After an attempted send, the workflow encrypts the CLI manifest, accepted/failure logs and available audience snapshot with AES-256-GCM using the campaign's private checkpoint key. Only `checkpoint.enc` is uploaded, retained for 90 days. The campaign ID and configuration digest authenticate the envelope. Keep the exact private configuration while reconciliation may be needed.

If a send is interrupted, **do not delete its tag, create a replacement ID, or automatically rerun it**. Inspect the original run and SES events first. A lost runner can prevent artifact upload; the permanent claim still blocks duplicates. To inspect an available checkpoint locally:

```sh
npm run campaign -- recover --config campaigns.private/<id>.campaign.json \
  --file checkpoint.enc --output campaigns.private/recovery
```

Recovery refuses to overwrite an existing directory and never sends email or removes the claim. Reconcile ambiguous SES outcomes before a separately authorised CLI resume using the recovered manifest and accepted log. A subscriber resume also requires the original approved live snapshot to match. Remove completed queue entries to keep scheduling lightweight; retain their claim tags and private configurations for the required operational retention period.

The GitHub schedule is a polling scheduler, not an exact-time delivery guarantee. Review expired/failed runs operationally. Do not run the legacy sender in parallel for a campaign managed here.
