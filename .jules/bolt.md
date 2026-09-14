## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).

## 2024-05-18 - Avoid Redundant Regex Prefix Scans
**Learning:** V8 automatically performs literal prefix scanning for regular expressions that start with a literal string (like `/\{\{.../`). Adding a manual `.includes()` check before such a regex is redundant and can actually be slower by performing a second scan of the same string.
**Action:** Do not use `.includes()` as a fast path for regular expressions that already start with a specific literal sequence and lack backtracking hazards, as the engine optimizes this natively.
