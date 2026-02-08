# @vercel/agent-eval

Test AI coding agents on your framework. Measure what actually works.

## Why?

You're building a frontend framework and want AI agents to work well with it. But how do you know if:
- Your documentation helps agents write correct code?
- Adding an MCP server improves agent success rates?
- Sonnet performs as well as Opus for your use cases?
- Your latest API changes broke agent compatibility?

**This framework gives you answers.** Run controlled experiments, measure pass rates, compare techniques.

## Quick Start

```bash
# Create a new eval project
npx @vercel/agent-eval init my-agent-evals
cd my-agent-evals

# Install dependencies
npm install

# Add your API keys
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY and VERCEL_TOKEN

# Preview what will run (no API calls, no cost)
npx @vercel/agent-eval --dry

# Run all experiments
npx @vercel/agent-eval
```

## CLI

### Run all experiments

```bash
npx @vercel/agent-eval
```

With no arguments, the CLI discovers every `experiments/*.ts` file and runs them all. Each experiment runs in parallel. Results with matching fingerprints are reused automatically (see [Result Reuse](#result-reuse)).

### Run a single experiment

```bash
npx @vercel/agent-eval cc
```

The argument is the experiment filename without `.ts`. This resolves to `experiments/cc.ts`.

### Flags

| Flag | Description |
|------|-------------|
| `--dry` | Preview what would run without executing. No API calls, no cost. |
| `--smoke` | Quick setup verification. Picks the first eval alphabetically, runs once per model. |
| `--force` | Ignore cached fingerprints and re-run everything. Only applies when running all experiments. |

Flags work with both modes:

```bash
npx @vercel/agent-eval --dry          # preview all experiments
npx @vercel/agent-eval cc --dry       # preview a single experiment
npx @vercel/agent-eval --smoke        # smoke test all experiments
npx @vercel/agent-eval cc --smoke     # smoke test one experiment
```

### Other commands

```bash
npx @vercel/agent-eval init <name>          # scaffold a new eval project
npx @vercel/agent-eval playground           # launch web-based results viewer
npx @vercel/agent-eval playground --watch   # live mode (watches for new results)
```

## Creating Evals

Each eval tests one specific task an agent should be able to do with your framework.

### Directory structure

```
evals/
  create-button-component/
    PROMPT.md           # Task for the agent
    EVAL.ts             # Tests to verify success (or EVAL.tsx for JSX)
    package.json        # Your framework as a dependency
    src/                # Starter code
```

**PROMPT.md** -- what you want the agent to do:

```markdown
Create a Button component using MyFramework.

Requirements:
- Export a Button component from src/components/Button.tsx
- Accept `label` and `onClick` props
- Use the framework's styling system for hover states
```

**EVAL.ts** -- how you verify it worked:

```typescript
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

test('Button component exists', () => {
  expect(existsSync('src/components/Button.tsx')).toBe(true);
});

test('has required props', () => {
  const content = readFileSync('src/components/Button.tsx', 'utf-8');
  expect(content).toContain('label');
  expect(content).toContain('onClick');
});

test('project builds', () => {
  execSync('npm run build', { stdio: 'pipe' });
});
```

Use **EVAL.tsx** when your tests require JSX syntax (React Testing Library, component rendering). You only need one eval file per fixture -- choose `.tsx` if any test needs JSX.

## Configuration Reference

### Experiment config

```typescript
// experiments/my-experiment.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  // Required: which agent to use
  agent: 'vercel-ai-gateway/claude-code',

  // Model to use (defaults vary by agent)
  // Provide an array to run the same experiment across multiple models.
  model: 'opus',

  // How many times to run each eval (default: 1)
  runs: 10,

  // Stop after first success? (default: true)
  earlyExit: false,

  // npm scripts that must pass after agent finishes (default: [])
  scripts: ['build', 'lint'],

  // Timeout per run in seconds (default: 600)
  timeout: 600,

  // Filter which evals to run (default: '*' for all)
  evals: '*',
  // evals: ['specific-eval'],
  // evals: (name) => name.startsWith('api-'),

  // Setup function for sandbox pre-configuration
  setup: async (sandbox) => {
    await sandbox.writeFiles({ '.env': 'API_KEY=test' });
    await sandbox.runCommand('npm', ['run', 'setup']);
  },

  // Rewrite the prompt before running
  editPrompt: (prompt) => `Use the skill.\n\n${prompt}`,

  // Sandbox backend (default: 'auto' -- Vercel if token present, else Docker)
  sandbox: 'auto',
};

export default config;
```

### Agent selection

```typescript
// Vercel AI Gateway (recommended -- unified billing and observability)
agent: 'vercel-ai-gateway/claude-code'  // Claude Code via AI Gateway
agent: 'vercel-ai-gateway/codex'        // OpenAI Codex via AI Gateway
agent: 'vercel-ai-gateway/opencode'     // OpenCode via AI Gateway

// Direct API (uses provider keys directly)
agent: 'claude-code'  // requires ANTHROPIC_API_KEY
agent: 'codex'        // requires OPENAI_API_KEY
```

### Multi-model experiments

Provide an array of models to run the same experiment on each one. Results are stored under separate directories (`experiment-name/model-name`):

```typescript
const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: ['opus', 'sonnet'],
  runs: 10,
};
```

### OpenCode model format

OpenCode uses Vercel AI Gateway exclusively. Models must use the `vercel/{provider}/{model}` format:

```typescript
model: 'vercel/anthropic/claude-sonnet-4'
model: 'vercel/openai/gpt-4o'
model: 'vercel/moonshotai/kimi-k2'
model: 'vercel/minimax/minimax-m2.1'
```

The `vercel/` prefix is required. Using `anthropic/claude-sonnet-4` (without `vercel/`) will fail with a "provider not found" error.

## A/B Testing

The real power is comparing different approaches. Create multiple experiment configs:

```typescript
// experiments/control.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,
  earlyExit: false,
};

export default config;
```

```typescript
// experiments/with-mcp.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,
  earlyExit: false,
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install', '-g', '@myframework/mcp-server']);
    await sandbox.writeFiles({
      '.claude/settings.json': JSON.stringify({
        mcpServers: { myframework: { command: 'myframework-mcp' } }
      })
    });
  },
};

export default config;
```

```bash
npx @vercel/agent-eval
```

Compare the results:
```
control (baseline):     7/10 passed (70%)
with-mcp:              9/10 passed (90%)
```

| Experiment | Control | Treatment |
|------------|---------|-----------|
| MCP impact | No MCP | With MCP server |
| Model comparison | Haiku | Sonnet / Opus |
| Documentation | Minimal docs | Rich examples |
| System prompt | Default | Framework-specific |
| Tool availability | Read/write only | + custom tools |

## Results

Results are saved to `results/<experiment>/<timestamp>/`:

```
results/
  with-mcp/
    2026-01-27T10-30-00Z/
      create-button/
        summary.json            # Pass rate, fingerprint, classification
        classification.json     # Cached failure classification (if failed)
        run-1/
          result.json           # Individual run result + o11y summary
          transcript.json       # Parsed/structured agent transcript
          transcript-raw.jsonl  # Raw agent output (for debugging)
          outputs/
            eval.txt            # EVAL.ts test output
            scripts/
              build.txt         # npm script output
```

### summary.json

Each eval directory contains a `summary.json` with:

```json
{
  "totalRuns": 2,
  "passedRuns": 0,
  "passRate": "0%",
  "meanDuration": 45.2,
  "fingerprint": "a1b2c3...",
  "classification": {
    "failureType": "infra",
    "failureReason": "Rate limited (HTTP 429) — model never ran"
  },
  "valid": false
}
```

The `fingerprint` field enables result reuse across runs. The `classification` and `valid` fields appear only for failed evals -- `valid: false` marks non-model failures so they are not reused by fingerprinting and are automatically retried.

### Playground UI

Browse results in a web-based dashboard:

```bash
npx @vercel/agent-eval playground
```

This opens a local Next.js app with:
- **Overview** dashboard with stats and recent experiments
- **Experiment detail** with per-eval pass rates and run results
- **Transcript viewer** to inspect agent tool calls, thinking, and errors
- **Compare** two runs side-by-side with pass rate deltas

Options:
```bash
npx @vercel/agent-eval playground --results-dir ./results --evals-dir ./evals --port 3001
```

## Result Reuse

The framework computes a SHA-256 fingerprint for each (eval, config) pair. The fingerprint covers all eval directory files and the config fields that affect results: `agent`, `model`, `scripts`, `timeout`, `earlyExit`, and `runs`.

On subsequent runs, evals with a matching fingerprint and a valid cached result (at least one passing run) are skipped automatically. This means:

- **Adding new evals** -- safe, no existing results to invalidate.
- **Extending the model array** -- safe, each model gets its own experiment directory.
- **Changing the `evals` filter** -- safe, the filter is not part of the fingerprint.
- **Editing an eval file** -- only invalidates that specific eval.
- **Changing config fields** (agent, model, timeout, etc.) -- invalidates all evals in that experiment.

Use `--force` to bypass fingerprinting and re-run everything. Functions like `setup` and `editPrompt` cannot be hashed, so use `--force` when you change those.

## Failure Classification

When evals fail, the framework classifies each failure as one of:

- **model** -- the agent tried but wrote incorrect code
- **infra** -- infrastructure broke (API errors, rate limits, crashes)
- **timeout** -- the run hit its time limit

Classification uses Claude Sonnet 4.5 via the Vercel AI Gateway with sandboxed read-only tools to inspect result files. This requires `AI_GATEWAY_API_KEY` to be set. Classifications are cached in `classification.json` within the eval result directory.

### Auto-retry

When ALL runs of an eval fail with non-model failures (infra or timeout), the framework automatically retries once. This handles transient issues like rate limits or API outages without wasting retries on genuine model failures.

## Housekeeping

After each experiment completes, the framework automatically:
- Removes duplicate results for the same eval (keeps the newest)
- Removes incomplete results (missing `summary.json` or transcripts)
- Removes empty timestamp directories

## Environment Variables

Every run requires an API key for the agent and a token for the sandbox.

| Variable | Required when | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Always | Vercel AI Gateway key -- required for failure classification and for `vercel-ai-gateway/` agents |
| `ANTHROPIC_API_KEY` | `agent: 'claude-code'` | Direct Anthropic API key |
| `OPENAI_API_KEY` | `agent: 'codex'` | Direct OpenAI API key |
| `VERCEL_TOKEN` | Always (pick one) | Vercel personal access token -- for local dev |
| `VERCEL_OIDC_TOKEN` | Always (pick one) | Vercel OIDC token -- for CI/CD pipelines |

`AI_GATEWAY_API_KEY` is always required, even when using direct API agents like `claude-code` or `codex`. The framework uses it to classify failures via `anthropic/claude-sonnet-4-5` on the AI Gateway.

OpenCode only supports Vercel AI Gateway (`vercel-ai-gateway/opencode`). There is no direct API option for OpenCode.

### Setup

The `init` command generates a `.env.example` file. Copy it and fill in your keys:

```bash
cp .env.example .env
```

The framework loads `.env.local` first, then `.env` as a fallback, via [dotenv](https://github.com/motdotla/dotenv).

### Vercel AI Gateway (recommended)

One key for all models:

```bash
AI_GATEWAY_API_KEY=your-ai-gateway-api-key
VERCEL_TOKEN=your-vercel-token
```

### Direct API keys (alternative)

Remove the `vercel-ai-gateway/` prefix from the agent and use provider keys:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
VERCEL_TOKEN=your-vercel-token
```

## Tips

**Start with `--dry`**: Always preview before running to verify your config and avoid unexpected costs.

**Use `--smoke` first**: Verify API keys, model IDs, and sandbox connectivity before launching a full run.

**Use multiple runs**: Single runs don't tell you reliability. Use `runs: 10` and `earlyExit: false` for meaningful data.

**Isolate variables**: Change one thing at a time between experiments. Don't compare "Opus with MCP" to "Haiku without MCP".

**Test incrementally**: Start with simple tasks, add complexity as you learn what works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and release process.

## License

MIT
