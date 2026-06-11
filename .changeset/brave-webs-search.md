---
"@vercel/agent-eval": minor
---

Add an opt-in `webResearch` option that enables each agent's web research tools so recommendation evals can produce citation/source data. Default is off: command construction is byte-identical to previous releases for existing consumers.

The option is available on `AgentRunOptions` and on `ExperimentConfig`, and is forwarded by `runExperiment`/`runSingleEval`, so both direct `executeAgent` callers and experiment-config consumers can use it.

When enabled:

- Claude Code: allows `WebSearch` and `WebFetch` via a single comma-separated `--allowedTools` value (the flag is variadic — the space-separated form in #141 consumed the trailing positional prompt as a tool name, which is what broke all CLI evals and forced the #144 revert).
- Codex: sets `tools.web_search = true` in the generated profile config.
- OpenCode: sets `OPENCODE_ENABLE_EXA=1` and allows the `websearch`/`webfetch` tools.
