# Bulk Email

Bulk Email is a CLI for sending personalized campaigns using React Email templates and AWS SES v2. It can read a local CSV or download an authenticated CSV snapshot from the standalone Hack the Hill email list service.

## Usage

Run interactively:

```bash
npx tsx src/app.ts
```

For the email list service, configure the export and suppression endpoints:

```bash
SUBSCRIBER_EXPORT_URL="https://emails.hackthehill.com/subscribe?export=csv" \
SUBSCRIBER_EXPORT_TOKEN="replace-with-export-token" \
SUPPRESSION_CHECK_URL="https://emails.hackthehill.com/unsubscribe" \
SUPPRESSION_CHECK_TOKEN="replace-with-suppression-token" \
UNSUBSCRIBE_BASE_URL="https://emails.hackthehill.com/unsubscribe" \
UNSUBSCRIBE_SECRET="replace-with-unsubscribe-secret" \
CAMPAIGN_ID="hack-the-hill-2026-03" \
AWS_PROFILE="bulk-email-sender" \
npx tsx src/app.ts \
  --template-dir templates \
  --template campaign.tsx \
  --from info@hackthehill.com \
  --region ca-central-1 \
  --configuration-set my-first-configuration-set
```

`--subscriber-export-url` and `--subscriber-export-token` are also available as CLI options. When configured, the CLI downloads exactly one CSV snapshot and parses it in memory. It fails closed if the endpoint is unavailable, unauthorized, invalid, oversized, or empty. The snapshot SHA-256 digest is recorded in each successful-send JSONL record.

Every run requires a stable `CAMPAIGN_ID` (or `--campaign-id`). Successful-send records are scoped to that campaign, so a future campaign cannot accidentally skip recipients from an earlier campaign. Use the same campaign ID when resuming an interrupted run and a new campaign ID for a new send.

Run `npx tsx src/app.ts --dry-run ...` with the same options to download and validate the list, synchronize suppressions, deduplicate addresses, render a template sample, and report the planned send count without sending any email. The export and suppression requests have bounded timeouts and response-size limits.

A real send displays the campaign ID, recipient count, sender, and SES configuration set, then requires an explicit confirmation. Use `--yes` only for an intentional non-interactive send. If SES accepts a message but its sent-log checkpoint cannot be written, the campaign stops; inspect the log before resuming because that recipient's state is ambiguous.

Use `--file emails.csv` when intentionally sending from a local file instead. `--file` and an authenticated export cannot be used together.

## CSV format

The required column is `email`. Optional columns include `name`, `language`, and `subject`; all additional columns are passed to the template.

## Unsubscribe behavior

When `UNSUBSCRIBE_BASE_URL` and `UNSUBSCRIBE_SECRET` are set, the sender generates a per-recipient signed URL and sends both RFC 8058 headers:

```text
List-Unsubscribe: <https://emails.hackthehill.com/unsubscribe?token=...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The Worker accepts the canonical `token` parameter. Templates should also display `unsubscribeUrl` in the HTML and text body.

The sender fetches both the email-list-manager suppression list and the SES account-level bounce/complaint suppression list before a campaign, merges them, and skips all matches locally. Logs report counts by source without printing excluded addresses.

## AWS SES setup

1. Verify the sender identity in SES.
2. Use an IAM principal with only `ses:SendEmail`, `ses:GetAccount`, `ses:GetEmailIdentity`, `ses:GetConfigurationSet`, and `ses:ListSuppressedDestinations`. The Hack the Hill setup uses the local `bulk-email-sender` AWS profile.
3. Set an SES region (`AWS_REGION` or `--region`).
4. Configure a configuration set with delivery, bounce, and complaint event destinations.
5. Enable account-level suppression for hard bounces and complaints.

Before loading recipients, the CLI verifies that the account can send in production, the sender's domain identity is verified, and the configured SES configuration set permits sending.

## Configuration

Environment variables:

- `AWS_REGION`
- `AWS_PROFILE` (recommended: `bulk-email-sender`)
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_SUBJECT`
- `SES_CONFIGURATION_SET`
- `SUBSCRIBER_EXPORT_URL` (optional; takes the place of a local CSV)
- `SUBSCRIBER_EXPORT_TOKEN` (required when the export URL is set)
- `CAMPAIGN_ID` (required; letters, numbers, `.`, `_`, and `-` only)
- `UNSUBSCRIBE_BASE_URL`
- `UNSUBSCRIBE_SECRET`
- `UNSUBSCRIBE_URL` (optional static fallback)
- `SUPPRESSION_CHECK_URL` (required)
- `SUPPRESSION_CHECK_TOKEN` (required)
- `SES_MAX_PER_SECOND` (default `14`)
- `SENT_LOG_FILE` (optional; otherwise `.sent-emails-<campaign-id>.jsonl`)
- `SEND_CONCURRENCY` (default `25`)
- `BATCH_SIZE` (default `10`)
- `BATCH_DELAY_MS` (default `1200`)
- `MAX_ATTEMPTS` (default `5`)
- `BASE_DELAY_MS` (default `500`)
- `FETCH_TIMEOUT_MS` (default `15000`)
- `MAX_EXPORT_BYTES` (default `26214400`)
- `MAX_SUPPRESSION_PAGE_BYTES` (default `2097152`)

CLI flags override environment values.

## Scripts

```bash
npm run start
npm run build
npm test
```
