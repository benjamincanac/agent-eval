---
"@vercel/agent-eval": patch
---

Default the Codex profile's `model_reasoning_effort` to `"medium"`.

The Codex CLI's own default is `"low"`, which `gpt-5.2-codex` (the default
Codex model) rejects with `Unsupported value: 'low' is not supported with
the 'gpt-5.2-codex' model. Supported values are: 'medium'.`. The Codex
adapter now writes `model_reasoning_effort` into the generated profile so
fresh `codex exec` runs against the AI Gateway succeed out of the box.
Callers can still override per-run via
`model: "gpt-5.2-codex?reasoningEffort=high"`.
