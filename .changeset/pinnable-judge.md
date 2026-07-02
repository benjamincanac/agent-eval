---
"@vercel/agent-eval": minor
---

Pin the agentic LLM judge to a fixed agent + model via `ExperimentConfig.judge`. By default the `expect(environment|transcript)` matchers still self-grade with the codegen agent+model; setting `judge: { agent?, model }` grades every run with one fixed judge — the apples-to-apples choice for cross-model comparisons (judge quality no longer varies with the model under test, and a model never grades itself). When `judge.agent` names a different agent, its CLI is installed in the sandbox and its key is resolved from its own env var (falling back to `VERCEL_OIDC_TOKEN`). Pinning is reflected in the eval fingerprint, so pinned runs don't reuse self-graded cached results.
