## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.

## 2023-08-20 - Delay Expensive Crypto Hashing
**Learning:** Checking fast O(1) `Set` lookups before calling an expensive hashing function (e.g., `createHash("sha256")`) can provide significant performance improvements in high-throughput filtering functions.
**Action:** Always reorder conditionals in filtering loops to evaluate the least expensive checks first. Avoid performing heavy computations (like hashing) on items that are going to be discarded anyway based on a simpler rule.

## 2026-08-21 - Early Hash Return
**Learning:** If you are evaluating membership in a `Set` by running an expensive crypto hash function on every element, check if the `Set` is completely empty first.
**Action:** When a set may often be empty, skip iterating or hashing items against it by early returning or short-circuiting (`set.size > 0 && set.has(...)`).

## 2024-05-19 - Regex matching vs String.includes() on large strings
**Learning:** `RegExp.test()` on very large strings (~250kb+) like rendered HTML emails is extremely slow and causes a massive bottleneck. Testing a pre-compiled regex takes ~150-200ms per million iterations, while `String.prototype.includes()` takes ~4ms. Combining them as an early exit strategy (`if (str.includes('prefix') && regex.test(str))`) is an order of magnitude faster when the target pattern is rare/absent. Precompiling regex inside an inner loop instead of instantiating it inline is also critical.
**Action:** Always use `String.prototype.includes()` as a fast-path guard before running `RegExp.test()` on long text/HTML contents generated per-item in a large loop. Ensure regexes used inside loops are instantiated outside.
