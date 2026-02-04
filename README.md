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
npx @vercel/agent-eval init my-framework-evals
cd my-framework-evals

# Install dependencies
npm install

# Add your API keys
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY and VERCEL_TOKEN

# Preview what will run (no API calls, no cost)
npx @vercel/agent-eval cc --dry

# Run the evals
npx @vercel/agent-eval cc
```

## A/B Testing AI Techniques

The real power is comparing different approaches. Create multiple experiment configs:

### Control: Baseline Agent

```typescript
// experiments/control.ts
import type { ExperimentConfig } from 'agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,        // Multiple runs for statistical significance
  earlyExit: false, // Run all attempts to measure reliability
};

export default config;
```

### Treatment: Agent with MCP Server

```typescript
// experiments/with-mcp.ts
import type { ExperimentConfig } from 'agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,
  earlyExit: false,

  setup: async (sandbox) => {
    // Install your framework's MCP server
    await sandbox.runCommand('npm', ['install', '-g', '@myframework/mcp-server']);

    // Configure Claude to use it
    await sandbox.writeFiles({
      '.claude/settings.json': JSON.stringify({
        mcpServers: {
          myframework: { command: 'myframework-mcp' }
        }
      })
    });
  },
};

export default config;
```

### Run Both & Compare

```bash
# Preview first
npx @vercel/agent-eval control --dry
npx @vercel/agent-eval with-mcp --dry

# Run experiments
npx @vercel/agent-eval control
npx @vercel/agent-eval with-mcp
```

**Compare results:**
```
Control (baseline):     7/10 passed (70%)
With MCP:              9/10 passed (90%)
```

## Creating Evals for Your Framework

Each eval tests one specific task an agent should be able to do with your framework.

### Example: Testing Component Creation

```
evals/
  create-button-component/
    PROMPT.md           # Task for the agent
    EVAL.ts             # Tests to verify success (or EVAL.tsx for JSX)
    package.json        # Your framework as a dependency
    src/                # Starter code
```

### EVAL.ts vs EVAL.tsx

Use **EVAL.tsx** when your tests require JSX syntax (React Testing Library, component testing):
```typescript
// EVAL.tsx - use when testing React components
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './src/components/Button';

test('Button renders with label', () => {
  render(<Button label="Click me" onClick={() => {}} />);
  expect(screen.getByText('Click me')).toBeDefined();
});
```

Use **EVAL.ts** for tests that don't need JSX:
```typescript
// EVAL.ts - use for file checks, build tests, etc.
import { test, expect } from 'vitest';
import { existsSync } from 'fs';

test('Button component exists', () => {
  expect(existsSync('src/components/Button.tsx')).toBe(true);
});
```

> **Note:** You only need one eval file per fixture. Choose `.tsx` if any test needs JSX, otherwise use `.ts`.

**PROMPT.md** - What you want the agent to do:
```markdown
Create a Button component using MyFramework.

Requirements:
- Export a Button component from src/components/Button.tsx
- Accept `label` and `onClick` props
- Use the framework's styling system for hover states
```

**EVAL.ts** (or **EVAL.tsx**) - How you verify it worked:
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

**package.json** - Include your framework:
```json
{
  "name": "create-button-component",
  "type": "module",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "myframework": "^2.0.0"
  }
}
```

## Experiment Ideas

| Experiment | Control | Treatment |
|------------|---------|-----------|
| MCP impact | No MCP | With MCP server |
| Model comparison | Haiku | Sonnet / Opus |
| Documentation | Minimal docs | Rich examples |
| System prompt | Default | Framework-specific |
| Tool availability | Read/write only | + custom tools |

## Configuration Reference

### Agent Selection

Choose your agent and authentication method:

```typescript
// Vercel AI Gateway (recommended - unified billing & observability)
agent: 'vercel-ai-gateway/claude-code'  // Claude Code via AI Gateway
agent: 'vercel-ai-gateway/codex'        // OpenAI Codex via AI Gateway
agent: 'vercel-ai-gateway/opencode'     // OpenCode via AI Gateway
agent: 'vercel-ai-gateway/ai-sdk-harness' // Simple AI SDK harness (any model)

// Direct API (uses provider keys directly)
agent: 'claude-code'  // requires ANTHROPIC_API_KEY
agent: 'codex'        // requires OPENAI_API_KEY
```

See the Environment Variables section below for setup instructions.

### OpenCode Model Configuration

OpenCode uses Vercel AI Gateway exclusively. Models **must** be specified with the `vercel/{provider}/{model}` format:

```typescript
// Anthropic models
model: 'vercel/anthropic/claude-sonnet-4'
model: 'vercel/anthropic/claude-opus-4'

// Minimax models
model: 'vercel/minimax/minimax-m2.1'
model: 'vercel/minimax/minimax-m2.1-lightning'

// Moonshot AI (Kimi) models
model: 'vercel/moonshotai/kimi-k2'
model: 'vercel/moonshotai/kimi-k2-thinking'

// OpenAI models
model: 'vercel/openai/gpt-4o'
model: 'vercel/openai/o3'
```

> **Important:** The `vercel/` prefix is required. OpenCode's config sets up a `vercel` provider, so the model string must start with `vercel/` to route through Vercel AI Gateway correctly. Using just `anthropic/claude-sonnet-4` (without the `vercel/` prefix) will fail with a "provider not found" error.

Under the hood, the agent creates an `opencode.json` config file that configures the Vercel provider:

```json
{
  "provider": {
    "vercel": {
      "options": {
        "apiKey": "{env:AI_GATEWAY_API_KEY}"
      }
    }
  },
  "permission": {
    "write": "allow",
    "edit": "allow",
    "bash": "allow"
  }
}
```

And runs: `opencode run "<prompt>" --model {provider}/{model} --format json`

### AI SDK Harness Model Configuration

The AI SDK harness (`vercel-ai-gateway/ai-sdk-harness`) is a lightweight agent that works with **any model** available on Vercel AI Gateway. Unlike OpenCode, it uses the standard `{provider}/{model}` format without a `vercel/` prefix:

```typescript
// Anthropic models
model: 'anthropic/claude-sonnet-4'
model: 'anthropic/claude-opus-4'

// Moonshot AI (Kimi) models
model: 'moonshotai/kimi-k2.5'
model: 'moonshotai/kimi-k2-thinking'

// Minimax models
model: 'minimax/minimax-m2.1'

// OpenAI models
model: 'openai/gpt-4o'
```

The AI SDK harness includes these tools: `readFile`, `writeFile`, `editFile`, `listFiles`, `glob`, `grep`, and `bash`. It's ideal for evaluating models that may not be fully compatible with OpenCode.

### Full Configuration

```typescript
import type { ExperimentConfig } from 'agent-eval';

const config: ExperimentConfig = {
  // Required: which agent and authentication to use
  agent: 'vercel-ai-gateway/claude-code',

  // Model to use (defaults vary by agent)
  // - claude-code: 'opus'
  // - codex: 'openai/gpt-5.2-codex'
  // - opencode: 'vercel/anthropic/claude-sonnet-4' (note: vercel/ prefix required)
  // - ai-sdk-harness: 'anthropic/claude-sonnet-4' (works with any AI Gateway model)
  model: 'opus',

  // How many times to run each eval
  runs: 10,

  // Stop after first success? (false for reliability measurement)
  earlyExit: false,

  // npm scripts that must pass after agent finishes
  scripts: ['build', 'lint'],

  // Timeout per run in seconds (default: 600)
  timeout: 600,

  // Filter which evals to run (pick one)
  evals: '*',                                // all (default)
  // evals: ['specific-eval'],              // by name
  // evals: (name) => name.startsWith('api-'), // by function

  // Setup function for environment configuration
  setup: async (sandbox) => {
    await sandbox.writeFiles({ '.env': 'API_KEY=test' });
    await sandbox.runCommand('npm', ['run', 'setup']);
  },
};

export default config;
```

## CLI Commands

### `init <name>`

Create a new eval project:
```bash
npx @vercel/agent-eval init my-evals
```

### `<experiment>`

Run an experiment:
```bash
npx @vercel/agent-eval cc
```

**Dry run** - preview without executing (no API calls, no cost):
```bash
npx @vercel/agent-eval cc --dry

# Output:
# Found 5 valid fixture(s), will run 5:
#   - create-button
#   - add-routing
#   - setup-state
#   - ...
# Running 5 eval(s) x 10 run(s) = 50 total runs
# Agent: claude-code, Model: opus, Timeout: 300s
# [DRY RUN] Would execute evals here
```

## Results

Results are saved to `results/<experiment>/<timestamp>/`:

```
results/
  with-mcp/
    2026-01-27T10-30-00Z/
      experiment.json       # Config and summary
      create-button/
        summary.json        # { totalRuns: 10, passedRuns: 9, passRate: "90%" }
        run-1/
          result.json       # Individual run result
          transcript.jsonl  # Agent conversation
          outputs/          # Test/script output
```

### Analyzing Results

```bash
# Quick comparison
cat results/control/*/experiment.json | jq '.evals[] | {name, passRate}'
cat results/with-mcp/*/experiment.json | jq '.evals[] | {name, passRate}'
```

| Pass Rate | Interpretation |
|-----------|----------------|
| 90-100%   | Agent handles this reliably |
| 70-89%    | Usually works, room for improvement |
| 50-69%    | Unreliable, needs investigation |
| < 50%     | Task too hard or prompt needs work |

## Environment Variables

Every run requires **two things**: an API key for the agent and a token for the Vercel sandbox. The exact variables depend on which authentication mode you use.

| Variable | Required when | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | `agent: 'vercel-ai-gateway/...'` | Vercel AI Gateway key — works for all agents (claude-code, codex, opencode) |
| `ANTHROPIC_API_KEY` | `agent: 'claude-code'` | Direct Anthropic API key (`sk-ant-...`) |
| `OPENAI_API_KEY` | `agent: 'codex'` | Direct OpenAI API key (`sk-proj-...`) |
| `VERCEL_TOKEN` | Always (pick one) | Vercel personal access token — for local dev |
| `VERCEL_OIDC_TOKEN` | Always (pick one) | Vercel OIDC token — for CI/CD pipelines |

> **Note:** OpenCode only supports Vercel AI Gateway (`vercel-ai-gateway/opencode`). There is no direct API option for OpenCode.

> You always need **one agent key** + **one sandbox token**.

### Vercel AI Gateway (Recommended)

Use `vercel-ai-gateway/` prefixed agents. One key for all models.

```bash
# Agent access — get yours at https://vercel.com/dashboard -> AI Gateway
AI_GATEWAY_API_KEY=your-ai-gateway-api-key

# Sandbox access — create at https://vercel.com/account/tokens
VERCEL_TOKEN=your-vercel-token
# OR for CI/CD:
# VERCEL_OIDC_TOKEN=your-oidc-token
```

### Direct API Keys (Alternative)

Remove the `vercel-ai-gateway/` prefix and use provider keys directly:

```bash
# For agent: 'claude-code'
ANTHROPIC_API_KEY=sk-ant-...

# For agent: 'codex'
OPENAI_API_KEY=sk-proj-...

# Sandbox access is still required
VERCEL_TOKEN=your-vercel-token
```

### `.env` Setup

The `init` command generates a `.env.example` file. Copy it and fill in your keys:

```bash
cp .env.example .env
```

The framework loads `.env` automatically via [dotenv](https://github.com/motdotla/dotenv).

### Vercel Employees

**To get the environment variables, link to `vercel-labs/agent-eval` on Vercel:**

```bash
# Link to the vercel-labs/agent-eval project
vc link vercel-labs/agent-eval

# Pull environment variables
vc env pull
```

This writes a `.env.local` file with all the required environment variables (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, VERCEL_OIDC_TOKEN) — no manual key setup needed. The framework automatically loads from both `.env` and `.env.local`.

## Tips

**Start with `--dry`**: Always preview before running to verify your config and avoid unexpected costs.

**Use multiple runs**: Single runs don't tell you reliability. Use `runs: 10` and `earlyExit: false` for meaningful data.

**Isolate variables**: Change one thing at a time between experiments. Don't compare "Opus with MCP" to "Haiku without MCP".

**Test incrementally**: Start with simple tasks, add complexity as you learn what works.

## License

MIT
