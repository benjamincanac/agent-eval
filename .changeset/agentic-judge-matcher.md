---
'@vercel/agent-eval': minor
---

Add an agentic LLM-judge matcher for EVAL.ts. Each judge assertion re-invokes the same agent (and model) that did the codegen, in the same sandbox, to evaluate a criterion — then returns pass/fail. No fresh sandbox, no copied evidence.

```ts
import { test, expect } from 'vitest';
import { environment, transcript } from '@vercel/agent-eval/eval';

test('quality', async () => {
  await expect(environment).toSatisfyCriterion('uses Server Components for the product list');
  await expect(transcript).toSatisfyCriterion('diagnosed with DevTools, not trial-and-error');
  await expect(environment).toScoreAtLeast('production-quality error handling', 0.8);
});
```

- Two implicit subjects (`environment`, `transcript`) — no paths.
- You supply only the criterion; the framework owns the prompt + verdict contract.
- Failures are attributable in the eval output (`[judge:environment] FAIL (score): reason`).
- The raw transcript is materialized to a sandbox file so the judge reads it by path (never dumped into a prompt). Framework files under `__agent_eval__/` are now gitignored, so they no longer appear in captured generated files.
