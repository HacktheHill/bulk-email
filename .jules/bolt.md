## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).
## 2023-09-05 - Fast-Path Regex Check for Placeholders
**Learning:** Using regex inside a loop (like iterating through rendered emails) to check for a simple character combination can be extremely slow, particularly if the string size is large.
**Action:** Extract stateless regex to a module-level constant. Guard the regex evaluation with a native fast-path `.includes()` check that acts as a cheap precondition to avoid calling the regex engine unless necessary.
## 2023-09-05 - Fast-Path Regex Check vs V8 Optimization
**Learning:** V8 engine is highly optimized and automatically performs prefix-scans for regular expressions that start with a literal string and have no backtracking hazards (e.g., `/\{\{\s*[A-Za-z][A-Za-z0-9_.]*\s*\}\}/`). Adding a manual fast-path check like `.includes("{{")` before such a regex actually degrades performance by adding a redundant second scan of the string.
**Action:** Do not manually add fast-path substring checks before regular expressions that have a literal prefix and no backtracking hazard, as modern JS engines (like V8) already optimize these cases.
