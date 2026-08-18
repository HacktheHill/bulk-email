## 2024-08-17 - Pre-compiling html-to-text options
**Learning:** In bulk email processors, repeating parser configuration parsing (like `html-to-text` options or format compilation) within the `for (const recipient...)` loop creates an O(N) overhead bottleneck.
**Action:** Extract standard compilation setup or configuration steps out of bulk rendering loops to do it once, improving CPU efficiency from O(N) to O(1) for setup time.
