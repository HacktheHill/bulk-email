
## 2025-02-12 - Avoid SHA-256 computation in empty Set
**Learning:** Pre-computing SHA-256 for millions of email addresses via `createHash` adds significant CPU overhead. Checking for presence in an empty `Set` is O(1) but still requires the expensive digest computation to be passed as an argument.
**Action:** When using cryptographic hashes as lookup keys for resuming state, always bypass the hash generation if the tracking `Set` or `Map` is empty (e.g. `set.size > 0 && set.has(digest(value))`).
