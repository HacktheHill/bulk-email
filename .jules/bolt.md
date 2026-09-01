## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).

## 2024-08-22 - Regex Pre-filtering with Includes
**Learning:** Checking for the presence of a known literal substring with `.includes()` (which uses a fast native O(n) search) is significantly faster than executing a regular expression test on a large string, especially when the regex has no matches.
**Action:** When running regular expressions to find specific sequences on very large strings in hot loops, always try to pre-filter with a fast `.includes()` check for a known literal part of the target sequence if the match is rare.
