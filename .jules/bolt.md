## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).
## 2024-05-19 - Fast-pathing String Search & Regex Compilation
**Learning:** In heavily repeated loops, regex execution overhead can become a measurable bottleneck, particularly when checking for the existence of specific tokens (like template placeholders). Node.js's native `.toString("base64url")` is also significantly faster than manual `.toString("base64")` followed by chained string replacements for padding and characters.
**Action:** When a regex check is likely to fail (i.e. the string doesn't contain the token), prefix it with a highly optimized native string check like `input.includes("{{")`. Also, always extract literal regular expressions from inner loops or functions into module-level constants to avoid regex engine re-compilation overhead on every invocation. Prefer native format handlers (like `base64url`) over manual string manipulation when possible.
