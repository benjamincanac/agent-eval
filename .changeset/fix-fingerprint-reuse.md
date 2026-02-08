---
"@vercel/agent-eval": patch
---

Fix fingerprint reuse: fingerprints are now persisted to `summary.json` so results can actually be reused across runs. Also fixes `--dry` to check reusability and report what would run, `--smoke` to always run fresh and skip housekeeping, and housekeeping to dedupe by fingerprint so results from different configs coexist.
