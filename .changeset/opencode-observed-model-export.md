---
"@vercel/agent-eval": patch
---

Fix OpenCode observed model extraction for OpenCode >= 1.17.0. The log-scrape source (`service=llm ... providerID= modelID=` lines) was removed in OpenCode 1.17.0's logging rewrite, which caused native-default runs to report no observed model. The adapter now falls back to `opencode export <sessionID>`, reading `providerID`/`modelID` from the exported assistant message. The legacy log scrape is kept as the first, cheaper source for older CLI versions.
