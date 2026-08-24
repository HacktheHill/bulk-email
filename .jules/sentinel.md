## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The `applyPlaceholders` utility used to replace placeholders like `{{ name }}` in rendered templates does not escape output. If a user provided an unescaped placeholder in the HTML email component (as opposed to passing props directly to React), string substitution happens after React's HTML escaping, exposing the final HTML payload to Cross-Site Scripting (XSS).
**Learning:** Even though React handles output escaping during the `render` step, any string replacements performed *after* React has completed rendering can introduce injection vulnerabilities if not carefully controlled. If the template uses `applyPlaceholders` directly on HTML text, those placeholders aren't protected by React.
**Prevention:** I modified `applyPlaceholders` in `src/mailer.ts` to accept an `escapeHtml` argument. In `src/rendering.ts`, this argument is passed as `true` when applying placeholders against the `html` content.

## 2025-02-14 - Insecure Default in applyPlaceholders

**Vulnerability:** The `applyPlaceholders` utility defaulted to `escapeHtml = false`, putting the burden of security on the caller and increasing the risk of XSS if the caller forgot to explicitly set `escapeHtml = true`.
**Learning:** Security features should be secure-by-default to prevent accidental vulnerabilities during future development. Explicit opt-outs are safer than explicit opt-ins.
**Prevention:** Changed the default value of `escapeHtml` to `true` in `applyPlaceholders` (`src/mailer.ts`). Updated `src/rendering.ts` to explicitly opt-out (`escapeHtml = false`) only when rendering text-based content like the email subject.