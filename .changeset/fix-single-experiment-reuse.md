---
"@vercel/agent-eval": patch
---

Fix `agent-eval <name>` silently bypassing fingerprint reuse. The single-experiment path now delegates to the same run-all logic, so results land at `results/<name>/<ts>/` with a `fingerprint` and are reused on subsequent runs instead of being re-run from scratch. `scanReusableResults` also recurses through model-nested directories, so legacy results stored at `results/<name>/<model>/<ts>/` are recovered without a manual backfill.

Also part of unifying the two paths:

- Fixtures are now loaded per experiment, so the `validation` config field (e.g. `validation: 'none'`) is honored when running all experiments, not just one.
- Explicitly named experiments that cannot run (config fails to load, missing API key, no valid fixtures) exit non-zero instead of being silently skipped with exit 0. No-args sweeps still skip unloadable configs, but an experiment with no valid fixtures now fails the sweep's exit code.
- Path-style arguments (`agent-eval experiments/cc.ts`) keep working — they are normalized to the bare experiment name.
