# Bulk Email

Bulk Email is a CLI for sending personalized campaigns using React Email templates and AWS SES v2.
It reads recipients from CSV, renders each row into HTML + text, sends in controlled batches, and retries transient SES failures with exponential backoff.

## Usage

Run the CLI with:

```bash
npx tsx src/app.ts
```

You can also pass options directly:

```bash
npx tsx src/app.ts \
    --template-dir templates \
    --template uosu.tsx \
    --file emails.csv \
    --from campaign@example.com \
    --from-name "Campaign Team" \
    --subject "Voting closes tonight" \
    --region us-east-1 \
    --unsubscribe-base-url "https://vote.danielthorp.com/unsubscribe" \
    --unsubscribe-secret "replace-with-long-random-secret" \
    --batch-size 10 \
    --batch-delay-ms 1200 \
    --max-attempts 5 \
    --base-delay-ms 500
```

## Required AWS Setup

1. Use an IAM principal with SES permissions, at minimum `ses:SendEmail`.
2. Set AWS credentials using standard AWS SDK resolution (env vars, shared config, role, etc.).
3. Set your SES region (`AWS_REGION` or `--region`).
4. Verify the sender identity in SES (`--from`).
5. If your account is in SES sandbox, you must verify recipient addresses too.

## Template Format (React Email)

Templates live as files in `templates/` and must export a default React component.
The CLI passes the full CSV row as props to the component.
Templates can also export `subject` to define a campaign-wide subject line.

Example template:

```tsx
import { Html, Body, Text } from "@react-email/components";
import * as React from "react";

type Props = {
    name?: string;
};

export const subject = "Campaign update";

export default function ExampleEmail({ name = "friend" }: Props) {
    return (
        <Html>
            <Body>
                <Text>Hello {name}, this is your campaign update.</Text>
            </Body>
        </Html>
    );
}
```

Placeholders like `{{name}}` are replaced using CSV values in template subject and rendered HTML.

## CSV Format

Required column:

- `email`

Common optional columns:

- `name`
- `language`
- `subject` (used only when template and CLI subject are not provided)

Any additional columns are passed into template props.

## Retry + Batching Behavior

- Emails are sent in batches (`--batch-size`).
- The CLI waits between batches (`--batch-delay-ms`).
- Retryable SES errors (throttling/5xx/transient) are retried with exponential backoff and jitter.
- Per-recipient retries are bounded by `--max-attempts`.

## Configuration

Environment variables:

- `AWS_REGION`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_SUBJECT`
- `SES_CONFIGURATION_SET` (optional)
- `UNSUBSCRIBE_BASE_URL` (optional, requires `UNSUBSCRIBE_SECRET`)
- `UNSUBSCRIBE_SECRET` (optional, requires `UNSUBSCRIBE_BASE_URL`)
- `UNSUBSCRIBE_URL` (optional static fallback URL if not using tokens)
- `BATCH_SIZE` (default: `10`)
- `BATCH_DELAY_MS` (default: `1200`)
- `MAX_ATTEMPTS` (default: `5`)
- `BASE_DELAY_MS` (default: `500`)

CLI flags override environment values.

## Unsubscribe Tokens

When `UNSUBSCRIBE_BASE_URL` and `UNSUBSCRIBE_SECRET` are set, the sender generates a per-recipient URL:

`https://vote.danielthorp.com/unsubscribe?t=<signed-token>`

The same URL is used in `List-Unsubscribe` headers and exposed to templates as `unsubscribeUrl`.
Token format is `<payload_b64url>.<hmac_sha256_signature_b64url>` where payload is JSON containing recipient email and issue time.

## Best Practices

1. Use SES configuration sets + CloudWatch/Kinesis/SNS event destinations for delivery, bounce, and complaint tracking.
2. Always include both HTML and text bodies (this CLI does).
3. Maintain suppression handling (global and account-level suppression lists).
4. Warm up gradually: start with smaller batch sizes and increase as reputation stabilizes.
5. Keep retry bounded and only for transient errors to avoid duplicate-send amplification.

## Scripts

```bash
npm run start
npm run build
```

## License

This package is under an [MIT license](LICENSE).
