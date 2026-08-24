## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The `applyPlaceholders` utility used to replace placeholders like `{{ name }}` in rendered templates does not escape output. If a user provided an unescaped placeholder in the HTML email component (as opposed to passing props directly to React), string substitution happens after React's HTML escaping, exposing the final HTML payload to Cross-Site Scripting (XSS).
**Learning:** Even though React handles output escaping during the `render` step, any string replacements performed *after* React has completed rendering can introduce injection vulnerabilities if not carefully controlled. If the template uses `applyPlaceholders` directly on HTML text, those placeholders aren't protected by React.
**Prevention:** I modified `applyPlaceholders` in `src/mailer.ts` to accept an `escapeHtml` argument. In `src/rendering.ts`, this argument is passed as `true` when applying placeholders against the `html` content.

## 2026-08-21 - GitHub Actions Command Injection via Inputs

**Vulnerability:** In `.github/workflows/send-campaign.yml`, the workflow inputs (`${{ inputs.campaign_id }}` and `${{ inputs.template }}`) were directly interpolated into bash script execution blocks (`run: ...`). An attacker with permissions to trigger the workflow could craft input strings containing arbitrary shell commands, which would be executed with the privileges of the GitHub Actions runner.
**Learning:** GitHub Actions expression syntax (`${{ ... }}`) is evaluated and substituted into the workflow file *before* the script is executed by the runner's shell. If the input contains quotes or shell metacharacters, it breaks out of the intended context and executes arbitrary code.
**Prevention:** Never use `${{ ... }}` directly inside `run:` scripts. Instead, bind workflow inputs or secrets to environment variables within the step's `env:` block, and reference them in the bash script using standard shell variable syntax (e.g., `$CAMPAIGN_ID`). This ensures the inputs are passed safely as strings and not evaluated as executable commands.
