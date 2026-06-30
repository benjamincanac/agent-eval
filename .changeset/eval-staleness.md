---
"@vercel/agent-eval": minor
---

Incremental eval-staleness workflow, so adopting a changed or new eval doesn't force re-running every experiment.

- Fingerprint split: each result stores a content-only hash next to the combined (content+config) one. A real eval change is never masked; a benign config change (e.g. a `timeout` bump, or pinning a judge) is carried forward by `refingerprint` instead of re-running. Existing `fingerprint` values are byte-identical, so caches stay valid. (Fixes the previous re-fingerprinting that silently re-stamped every result and hid eval changes.)
- `agent-eval status` — read-only: which evals are new vs changed, per experiment (classified by content). `--check` exits non-zero on any new/changed eval (a simple CI gate); `--json` emits per-experiment new/changed so a consumer can apply its own "which staleness is acceptable" policy.
- `agent-eval run <experiments...>` — run the named experiments' new/changed evals (auto-carries config-only changes first).
- Bare `agent-eval` shows status, then (in a terminal) lets you multi-select which experiments to run — it never re-runs everything.
- Removes `run-all` and `--dry` (the run-everything-when-stale behavior). There is no in-framework "acknowledge/keep" — staleness acceptance is the consumer's policy (e.g. filter `status --json` against an accepted-stale list in CI).
