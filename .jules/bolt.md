## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).

## 2024-09-13 - V8 Regex Prefix Scanning
**Learning:** V8 natively optimizes regexes that start with literal prefixes (e.g., `/\{\{.../`) by performing a fast prefix scan automatically. Adding a manual `.includes()` check before such a regex is an anti-pattern, as it forces the engine to scan the string twice without saving any time.
**Action:** Do not manually add fast-path string checks (`.includes()` or `.indexOf()`) in front of regexes that begin with literal character sequences, as this has no performance benefit and adds a backtracking hazard. Rely on V8's native regex engine for prefix scanning.
