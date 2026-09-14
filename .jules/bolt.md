## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).

## 2024-05-19 - Regex literal prefix scanning in V8
**Learning:** Adding a fast-path `.includes()` check before a regular expression is unnecessary and counterproductive if the regex already starts with a literal prefix (e.g., `/\{\{\s*.../`) and has no backtracking hazards. V8's regex engine already optimizes this by prefix-scanning the literal part natively. A manual `.includes()` check simply adds a redundant second scan of the same string.
**Action:** Do not manually prefix-scan strings with `.includes()` for regular expressions that start with static literal prefixes, as V8 already handles this optimization efficiently.
