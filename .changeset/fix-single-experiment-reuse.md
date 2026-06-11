---
"@vercel/agent-eval": patch
---

Fix `agent-eval <name>` silently bypassing fingerprint reuse. The single-experiment path now delegates to the same run-all logic, so results land at `results/<name>/<ts>/` with a `fingerprint` and are reused on subsequent runs instead of being re-run from scratch. `scanReusableResults` also recurses through model-nested directories, so legacy results stored at `results/<name>/<model>/<ts>/` are recovered without a manual backfill.
