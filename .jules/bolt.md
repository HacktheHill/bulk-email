## 2025-01-24 - Memoize placeholder values in replaceAll

**Learning:** String `replaceAll` runs match functions synchronously on every single match, making regexes over large templates (with repeated placeholders) a bottleneck if the replacer function does work (like escaping).
**Action:** Caching the replacer output based on the capture group prevents redundant work and significantly speeds up HTML escaping for repeated values.
