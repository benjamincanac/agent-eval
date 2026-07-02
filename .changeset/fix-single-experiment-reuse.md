---
"@vercel/agent-eval": patch
---

Fix `agent-eval <name>` silently bypassing fingerprint reuse. Running a single experiment now fingerprints each eval, stores single-model results at `results/<name>/<ts>/` (instead of an orphaned `results/<name>/<model>/<ts>/`), and skips evals that already have a fresh cached result — so results are reused on later runs instead of being re-run from scratch. `scanReusableResults` also recurses through model-nested directories, so legacy results stored under `results/<name>/<model>/<ts>/` are recovered without a manual backfill.
