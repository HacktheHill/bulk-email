## 2024-08-19 - Avoid uncompiled html-to-text in loops
**Learning:** `html-to-text` parses options and compiles selectors on every `convert()` call. Doing this inside a large loop (e.g., iterating through every recipient in a campaign) causes a massive performance bottleneck due to decision tree compilation.
**Action:** Always extract `compile` from `html-to-text` outside loops, creating a compiled function to process multiple HTML inputs efficiently.
