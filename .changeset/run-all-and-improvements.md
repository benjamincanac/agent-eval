---
"@vercel/agent-eval": minor
---

Add `run-all` command with fingerprinting, failure classification, and housekeeping.

- **run-all command**: Auto-discovers `experiments/*.ts` and runs them all with fingerprint reuse, AI failure classification, auto-retry of infra failures, and housekeeping. Now the default when `agent-eval` is invoked with no arguments.
- **Content fingerprinting**: Computes SHA-256 fingerprints from eval files + config. Skips evals with matching cached results. Safe to extend model arrays or add new evals.
- **Failure classification**: Classifies failed evals as model/infra/timeout using AI via `gateway('anthropic/claude-sonnet-4-5')` with sandboxed tools. Requires `AI_GATEWAY_API_KEY`.
- **Housekeeping**: Removes duplicate results, incomplete results, and empty timestamp directories after each experiment.
- **--smoke flag**: Picks the first eval alphabetically and runs it once per model for quick setup verification.
- **Output naming fix**: Script outputs moved to `outputs/scripts/{name}.txt` to prevent collision with `outputs/eval.txt`.
