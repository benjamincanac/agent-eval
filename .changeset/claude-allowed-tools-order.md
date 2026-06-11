---
"@vercel/agent-eval": patch
---

Fix Claude Code prompt being consumed by `--allowedTools` when `webResearch` is enabled. The flag is variadic and keeps capturing positionals until the next flag, so even the single comma-separated token from 1.1.0 swallowed the trailing prompt ("Input must be provided either through stdin or as a prompt argument when using --print", verified live on claude 2.1.112). `--allowedTools` is now emitted before the always-present `--dangerously-skip-permissions`, which terminates the variadic capture before the prompt. Default-off argument construction is unchanged.
