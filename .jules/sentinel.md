## 2024-08-17 - HTML injection via applyPlaceholders

**Vulnerability:** The legacy `applyPlaceholders` utility replaced placeholders like `{{ name }}` directly on rendered HTML string output without escaping. If user input contained HTML characters, post-render substitution bypassed React's JSX escaping.
**Learning:** Post-processing rendered HTML with string substitutions breaks React's safety model. React email components must receive recipient data directly as React props so React handles all output escaping natively during component render.
**Prevention:** Removed `applyPlaceholders` from the HTML rendering pipeline in `src/rendering.ts` entirely. All dynamic variables are passed as typed React props into component render calls. `applyPlaceholders` is retained exclusively for plain-text email subject line formatting.
