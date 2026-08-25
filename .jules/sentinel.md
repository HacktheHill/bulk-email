## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The `applyPlaceholders` utility used to replace placeholders like `{{ name }}` in rendered templates does not escape output. If a user provided an unescaped placeholder in the HTML email component (as opposed to passing props directly to React), string substitution happens after React's HTML escaping, exposing the final HTML payload to Cross-Site Scripting (XSS).
**Learning:** Even though React handles output escaping during the `render` step, any string replacements performed *after* React has completed rendering can introduce injection vulnerabilities if not carefully controlled. If the template uses `applyPlaceholders` directly on HTML text, those placeholders aren't protected by React.
**Prevention:** I modified `applyPlaceholders` in `src/mailer.ts` to accept an `escapeHtml` argument. In `src/rendering.ts`, this argument is passed as `true` when applying placeholders against the `html` content.

## 2024-08-25 - SSRF / Credential Leak via HTTP Redirects

**Vulnerability:** The application was fetching data from external URLs (for subscriber lists and suppressions) using standard `fetch` without disabling redirects. Furthermore, it passed an `Authorization` header containing a bearer token in the `init` config. By default, `fetch` follows redirects, and while standard web browsers might strip credentials cross-origin, some `fetch` implementations or Node.js configurations may inadvertently forward headers. Additionally, it could allow an attacker to trigger a redirect to internal metadata IP addresses (e.g., AWS IMDS).
**Learning:** `fetch` behavior defaults to following redirects. When dealing with authentication headers or when the application is running in a cloud environment (AWS SES), following arbitrary redirects from a user-supplied or configurable URL creates SSRF risks and token leakage risks.
**Prevention:** I modified `fetchTextWithTimeout` in `src/list-service.ts` to include `redirect: "error"`, overriding any `init` settings. This enforces strict URL resolution and rejects redirects outright, mitigating SSRF and header leaks via redirects.
