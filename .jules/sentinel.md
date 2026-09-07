## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The legacy `applyPlaceholders` utility replaced placeholders like `{{ name }}` directly on rendered HTML string output without escaping. If user input contained HTML characters, post-render substitution bypassed React's JSX escaping.
**Learning:** Post-processing rendered HTML with string substitutions breaks React's safety model. React email components must receive recipient data directly as React props so React handles all output escaping natively during component render.
**Prevention:** Removed `applyPlaceholders` from the HTML rendering pipeline in `src/rendering.ts` entirely. All dynamic variables are passed as typed React props into component render calls. `applyPlaceholders` is retained exclusively for plain-text email subject line formatting.

## 2026-08-21 - GitHub Actions Command Injection via Inputs

**Vulnerability:** In `.github/workflows/send-campaign.yml`, the workflow inputs (`${{ inputs.campaign_id }}` and `${{ inputs.template }}`) were directly interpolated into bash script execution blocks (`run: ...`). An attacker with permissions to trigger the workflow could craft input strings containing arbitrary shell commands, which would be executed with the privileges of the GitHub Actions runner.
**Learning:** GitHub Actions expression syntax (`${{ ... }}`) is evaluated and substituted into the workflow file *before* the script is executed by the runner's shell. If the input contains quotes or shell metacharacters, it breaks out of the intended context and executes arbitrary code.
**Prevention:** Never use `${{ ... }}` directly inside `run:` scripts. Instead, bind workflow inputs or secrets to environment variables within the step's `env:` block, and reference them in the bash script using standard shell variable syntax (e.g., `$CAMPAIGN_ID`). This ensures the inputs are passed safely as strings and not evaluated as executable commands.

## 2026-08-25 - Fix SSRF and credential leak via HTTP redirects

**Vulnerability:** The `fetch` calls in `fetchTextWithTimeout` were following HTTP redirects by default. If a configured endpoint redirected the request (or if an attacker compromised the endpoint URL), `fetch` would follow the redirect. This could lead to Server-Side Request Forgery (SSRF) against internal services (like AWS IMDS) and could leak the cross-origin `Authorization` headers to the redirect target.
**Learning:** By default, the `fetch` API follows redirects and will send headers (including `Authorization`) to the new destination.
**Prevention:** Always add `redirect: "error"` (or `"manual"`) to `fetch` calls handling sensitive headers or interacting with external endpoints to prevent unintentional redirection.

## 2026-09-07 - Prevent Prototype Pollution in JSON Keyring Parsing
**Vulnerability:** The parseUnsubscribeKeyring function in src/utils.ts initialized a result dictionary using a plain object literal ({}). A parsed JSON payload with a __proto__ key could cause prototype lookup Denial of Service (DoS) or unexpected behavior.
**Learning:** Plain objects inherit from Object.prototype, which introduces risks when storing arbitrary keys from user input or JSON parsing.
**Prevention:** Always use Object.create(null) instead of {} to create prototype-less dictionaries when storing keys from external sources.
