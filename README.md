# Bulk Email

Hack the Hill's local campaign CLI. It preflights and renders every recipient before sending through AWS SES v2. Template metadata—not an operator-selected mode—determines the recipient source and unsubscribe policy.

## Commands

```bash
npm run start -- send --campaign-id hth-save-the-date-2026 \
  --template-dir ../react-email-templates/emails/hackthehill \
  --template save-the-date.tsx

npm run start -- test --to daniel@danielthorp.com \
  --template-dir ../react-email-templates/emails/hackthehill \
  --template save-the-date.tsx
```

Add `--dry-run` to `send` to perform the complete recipient, suppression, SES, template, and render preflight without sending. A real send requires interactive confirmation; `--yes` is available for deliberate non-interactive use.

## Template contract

Every active template exports a default React component and metadata:

```ts
export const metadata = {
  id: "hackthehill-save-the-date",
  version: 1,
  audience: "subscribers", // or "provided-csv"
  localization: "bilingual", // or "localized"
  subject: "Campaign subject",
  requiredFields: [],
} as const;
```

`subscribers` templates automatically download the authenticated `email,language` export, reject `--file`, apply email-list-manager and SES suppressions, render a signed visible `unsubscribeUrl`, and add RFC 8058 headers.

`provided-csv` templates require `--file` and a 10–500 character `--purpose` describing the existing application, RSVP, attendance, or service relationship. They apply SES suppressions but do not receive marketing unsubscribe data or headers. The final prompt explicitly requires the operator to confirm the message is non-promotional.

Required CSV fields are declared by the template. Every CSV must contain `email`; additional columns become template props. Addresses are normalized and deduplicated without being printed.

## Required configuration

Use a local ignored `.env` or process environment:

```dotenv
AWS_PROFILE=bulk-email-sender
AWS_REGION=ca-central-1
EMAIL_FROM=info@hackthehill.com
EMAIL_FROM_NAME=Hack the Hill
EMAIL_REPLY_TO=info@hackthehill.com
SES_CONFIGURATION_SET=my-first-configuration-set

SUBSCRIBER_EXPORT_URL=https://emails.hackthehill.com/subscribe?export=csv
SUBSCRIBER_EXPORT_TOKEN=...
SUPPRESSION_CHECK_URL=https://emails.hackthehill.com/unsubscribe
SUPPRESSION_CHECK_TOKEN=...

UNSUBSCRIBE_BASE_URL=https://emails.hackthehill.com/unsubscribe
UNSUBSCRIBE_TOKEN_ACTIVE_KEY_ID=2026-07
UNSUBSCRIBE_TOKEN_KEYS={"2026-07":"..."}
```

The signing keyring must match `email-list-manager`. Keep export and suppression bearer tokens separate.

## Campaign safety and resume state

State is private and campaign-scoped:

```text
.bulk-email/campaigns/{campaignId}/
  manifest.json
  accepted.jsonl
  failures.jsonl
  lock
```

The manifest records the clean template commit and file hash, metadata version, recipient snapshot hash, subject hash, sender settings, purpose, and counts. Delivery files contain recipient SHA-256 digests, not addresses. Each accepted SES response is appended and fsynced. A checkpoint failure after SES acceptance is fatal and ambiguous: do not automatically retry that recipient.

Before the first send, the CLI validates the entire recipient set, required fields, dependency compatibility, exact HTML and text bodies, placeholders, unsubscribe rendering, and configured memory/body/recipient limits. It also verifies the SES account, domain identity, configuration set, and account suppressions. Subscriber suppressions are refreshed between batches.

## Development

```bash
npm ci
npm run verify
```

The package is private and is not published to npm.

## GitHub Actions Scheduling

Use the **Campaigns** workflow for repeated campaign operations. It has three modes: `preview`, `test`, and `send`. A single scheduler checks the queue every 15 minutes; adding a campaign requires configuration, not another workflow or code commit. See [Campaign configuration and operation](docs/campaigns.md).

The queue contains only campaign IDs, secret names, configuration digests, approval digests, and send windows. Private recipient data stays in an encrypted Actions secret for each campaign. Template metadata still controls subscriber versus service-message policy, and the existing CLI still owns rendering, SES preflight, suppression and delivery.

Configure these repository or environment secrets before using it:

```text
BULK_EMAIL_REPO_TOKEN (optional when running from bulk-email itself)
TEMPLATES_REPO_TOKEN
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN (optional)
AWS_REGION
EMAIL_FROM
EMAIL_FROM_NAME
EMAIL_REPLY_TO
SES_CONFIGURATION_SET
SUBSCRIBER_EXPORT_URL
SUBSCRIBER_EXPORT_TOKEN
SUPPRESSION_CHECK_URL
SUPPRESSION_CHECK_TOKEN
UNSUBSCRIBE_BASE_URL
UNSUBSCRIBE_TOKEN_ACTIVE_KEY_ID
UNSUBSCRIBE_TOKEN_KEYS
```

Set `TEMPLATES_REPO_TOKEN` to a read-only token that can check out `HacktheHill/react-email-templates`. The `production` environment remains available for additional human approval requirements. `TALLY_API_KEY` is needed only for reviewed Tally audiences.

The older `send-campaign.yml` remains compatible with existing callers and one-off tests, including an optional `test_name`. It does not use the configured-campaign ledger; do not use it to resend a campaign managed by **Campaigns**.
