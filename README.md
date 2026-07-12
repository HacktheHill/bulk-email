# Bulk Email

Bulk Email is a CLI for sending personalized campaigns using React Email templates and AWS SES v2. It can read a local CSV or download an authenticated CSV snapshot from the standalone Hack the Hill email list service.

## Usage

Run interactively:

```bash
npx tsx src/app.ts
```

For the email list service, configure the export and suppression endpoints:

```bash
SUBSCRIBER_EXPORT_URL="https://email-list-manager.hackthehill.com/subscribe?export=csv" \
SUBSCRIBER_EXPORT_TOKEN="replace-with-export-token" \
SUPPRESSION_CHECK_URL="https://email-list-manager.hackthehill.com/unsubscribe" \
SUPPRESSION_CHECK_TOKEN="replace-with-suppression-token" \
UNSUBSCRIBE_BASE_URL="https://email-list-manager.hackthehill.com/unsubscribe" \
UNSUBSCRIBE_SECRET="replace-with-unsubscribe-secret" \
npx tsx src/app.ts \
  --template-dir templates \
  --template campaign.tsx \
  --from info@hackthehill.com \
  --region us-east-1
```

`--subscriber-export-url` and `--subscriber-export-token` are also available as CLI options. When configured, the CLI downloads exactly one CSV snapshot before parsing and sending. It fails closed if the endpoint is unavailable, unauthorized, invalid, or empty. The snapshot SHA-256 digest is recorded in each successful-send JSONL record.

Use `--file emails.csv` when intentionally sending from a local file instead. `--file` and an authenticated export cannot be used together.

## CSV format

The required column is `email`. Optional columns include `name`, `language`, and `subject`; all additional columns are passed to the template.

## Unsubscribe behavior

When `UNSUBSCRIBE_BASE_URL` and `UNSUBSCRIBE_SECRET` are set, the sender generates a per-recipient signed URL and sends both RFC 8058 headers:

```text
List-Unsubscribe: <https://email-list-manager.hackthehill.com/unsubscribe?t=...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The Worker accepts both the current `token` parameter and the legacy `t` parameter. Templates should also display `unsubscribeUrl` in the HTML and text body.

The sender fetches the suppression list once before a campaign and skips suppressed addresses locally. This remains defense in depth alongside AWS SES account-level suppression.

## AWS SES setup

1. Verify the sender identity in SES.
2. Use an IAM principal with only the SES permissions required by the campaign sender.
3. Set an SES region (`AWS_REGION` or `--region`).
4. Configure a configuration set with delivery, bounce, and complaint event destinations.
5. Enable account-level suppression for hard bounces and complaints.

## Configuration

Environment variables:

- `AWS_REGION`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_SUBJECT`
- `SES_CONFIGURATION_SET`
- `SUBSCRIBER_EXPORT_URL` (optional; takes the place of a local CSV)
- `SUBSCRIBER_EXPORT_TOKEN` (required when the export URL is set)
- `UNSUBSCRIBE_BASE_URL`
- `UNSUBSCRIBE_SECRET`
- `UNSUBSCRIBE_URL` (optional static fallback)
- `SUPPRESSION_CHECK_URL` (required)
- `SUPPRESSION_CHECK_TOKEN` (required)
- `SES_MAX_PER_SECOND` (default `14`)
- `SENT_LOG_FILE` (default `.sent-emails.jsonl`)
- `SEND_CONCURRENCY` (default `25`)
- `BATCH_SIZE` (default `10`)
- `BATCH_DELAY_MS` (default `1200`)
- `MAX_ATTEMPTS` (default `5`)
- `BASE_DELAY_MS` (default `500`)

CLI flags override environment values.

## Scripts

```bash
npm run start
npm run build
```
