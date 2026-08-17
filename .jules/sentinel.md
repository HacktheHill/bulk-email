## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The `applyPlaceholders` utility used to replace placeholders like `{{ name }}` in rendered templates does not escape output. If a user provided an unescaped placeholder in the HTML email component (as opposed to passing props directly to React), string substitution happens after React's HTML escaping, exposing the final HTML payload to Cross-Site Scripting (XSS).
**Learning:** Even though React handles output escaping during the `render` step, any string replacements performed *after* React has completed rendering can introduce injection vulnerabilities if not carefully controlled. If the template uses `applyPlaceholders` directly on HTML text, those placeholders aren't protected by React.
**Prevention:** I modified `applyPlaceholders` in `src/mailer.ts` to accept an `escapeHtml` argument. In `src/rendering.ts`, this argument is passed as `true` when applying placeholders against the `html` content.
