## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The legacy `applyPlaceholders` utility replaced placeholders like `{{ name }}` directly on rendered HTML string output without escaping. If user input contained HTML characters, post-render substitution bypassed React's JSX escaping.
**Learning:** Post-processing rendered HTML with string substitutions breaks React's safety model. React email components must receive recipient data directly as React props so React handles all output escaping natively during component render.
**Prevention:** Removed `applyPlaceholders` from the HTML rendering pipeline in `src/rendering.ts` entirely. All dynamic variables are passed as typed React props into component render calls. `applyPlaceholders` is retained exclusively for plain-text email subject line formatting.

## 2026-08-21 - GitHub Actions Command Injection via Inputs

**Vulnerability:** In `.github/workflows/send-campaign.yml`, the workflow inputs (`${{ inputs.campaign_id }}` and `${{ inputs.template }}`) were directly interpolated into bash script execution blocks (`run: ...`). An attacker with permissions to trigger the workflow could craft input strings containing arbitrary shell commands, which would be executed with the privileges of the GitHub Actions runner.
**Learning:** GitHub Actions expression syntax (`${{ ... }}`) is evaluated and substituted into the workflow file *before* the script is executed by the runner's shell. If the input contains quotes or shell metacharacters, it breaks out of the intended context and executes arbitrary code.
**Prevention:** Never use `${{ ... }}` directly inside `run:` scripts. Instead, bind workflow inputs or secrets to environment variables within the step's `env:` block, and reference them in the bash script using standard shell variable syntax (e.g., `$CAMPAIGN_ID`). This ensures the inputs are passed safely as strings and not evaluated as executable commands.
