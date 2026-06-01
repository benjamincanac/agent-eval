/**
 * OpenAI Codex CLI agent implementation.
 * Uses Vercel AI Gateway for model access.
 */

import type { Agent, AgentRunOptions, AgentRunResult } from './types.js';
import type { ModelTier } from '../types.js';
import {
  createSandbox,
  collectLocalFiles,
  splitTestFiles,
  verifyNoTestFiles,
  type SandboxManager,
} from '../sandbox.js';
import type { DockerSandboxManager } from '../docker-sandbox.js';
import {
  runValidation,
  captureGeneratedFiles,
  createVitestConfig,
  AI_GATEWAY,
  OPENAI_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Parse model string with optional query parameters.
 * e.g. "gpt-5.2-codex?reasoningEffort=high" → { model: "gpt-5.2-codex", reasoningEffort: "high" }
 */
function parseModelString(model: string): { model: string; reasoningEffort?: string } {
  const qIndex = model.indexOf('?');
  if (qIndex === -1) return { model };

  const base = model.slice(0, qIndex);
  const query = model.slice(qIndex + 1);
  let reasoningEffort: string | undefined;

  for (const pair of query.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex);
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    if (key === 'reasoningEffort') {
      reasoningEffort = value;
    }
  }

  return { model: base, reasoningEffort };
}

/**
 * Extract transcript from Codex JSON output.
 * When run with --json, Codex outputs JSONL to stdout with the full transcript.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --json output is already the transcript in JSONL format
  // Filter to only include lines that look like JSON objects
  const lines = output.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n');
}

export function extractCodexThreadId(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: unknown };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        return event.thread_id;
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }

  return undefined;
}

export function extractObservedModelFromCodexSession(transcript: string | undefined): string | undefined {
  if (!transcript) return undefined;

  let observedModel: string | undefined;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        payload?: { model?: unknown; collaboration_mode?: { settings?: { model?: unknown } } };
      };
      const model = event.payload?.model ?? event.payload?.collaboration_mode?.settings?.model;
      if (event.type === 'turn_context' && typeof model === 'string') {
        observedModel = model;
      }
    } catch {
      // Ignore non-JSON transcript lines.
    }
  }

  return observedModel;
}

async function captureCodexSessionTranscript(sandbox: AnySandbox, threadId: string | undefined): Promise<string | undefined> {
  try {
    const escapedThreadId = threadId?.replace(/'/g, "'\\''");
    const command = escapedThreadId
      ? `find ~/.codex/sessions -type f -name '*${escapedThreadId}*.jsonl' -print 2>/dev/null | head -1`
      : `find ~/.codex/sessions -type f -name '*.jsonl' -print 2>/dev/null | sort | tail -1`;
    const findResult = await sandbox.runShell(command);
    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return undefined;
    }

    return await sandbox.readFile(findResult.stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Default reasoning effort and verbosity baked into the generated Codex
 * profile.
 *
 * The Codex CLI itself defaults both `model_reasoning_effort` and
 * `model_verbosity` to `"low"`, but the default Codex model
 * (`gpt-5.2-codex`) only accepts `"medium"` for both — so an out-of-the-box
 * `codex exec` against the AI Gateway fails with:
 *   "Unsupported value: 'low' is not supported with the 'gpt-5.2-codex'
 *    model. Supported values are: 'medium'."
 * (the error covers both the `reasoning.effort` and `text.verbosity` request
 * parameters, depending on which the model rejected first).
 *
 * `"medium"` is also a valid value for the non-codex GPT-5.x models, so it's
 * a safe default. Callers can override reasoning effort per-run via
 * `model: "gpt-5.2-codex?reasoningEffort=high"`.
 */
const DEFAULT_REASONING_EFFORT = 'medium';
const DEFAULT_MODEL_VERBOSITY = 'medium';

/**
 * Generate Codex profile config content.
 *
 * `reasoningEffort` and `model_verbosity` are written into the profile so a
 * fresh `codex exec` doesn't pick up the CLI defaults of `"low"`, which are
 * rejected by `gpt-5.2-codex`. Defaults to `"medium"` when `reasoningEffort`
 * is omitted.
 */
export function generateCodexConfig(
  model: string | undefined,
  useVercelAiGateway: boolean,
  reasoningEffort?: string,
): string {
  if (useVercelAiGateway) {
    // AI Gateway uses prefixed model names like "openai/gpt-5.2-codex".
    // Native-default runs intentionally omit model and reasoning overrides.
    const fullModel = model ? (model.includes('/') ? model : `openai/${model}`) : undefined;
    return `# Codex configuration for Vercel AI Gateway
model_provider = "vercel"
${fullModel ? `model = "${fullModel}"\n` : ''}${model ? `model_reasoning_effort = "${reasoningEffort ?? DEFAULT_REASONING_EFFORT}"\nmodel_verbosity = "${DEFAULT_MODEL_VERBOSITY}"\n` : ''}
[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "${AI_GATEWAY.openAiBaseUrl}"
env_key = "${AI_GATEWAY.apiKeyEnvVar}"
wire_api = "responses"
`;
  } else {
    // Direct OpenAI API — use the built-in "openai" provider (no custom provider needed).
    // Native-default runs intentionally omit model and reasoning overrides.
    const directModel = model ? (model.includes('/') ? model.split('/').pop()! : model) : undefined;
    return `# Direct OpenAI API configuration
model_provider = "openai"
${directModel ? `model = "${directModel}"\n` : ''}${model ? `model_reasoning_effort = "${reasoningEffort ?? DEFAULT_REASONING_EFFORT}"\nmodel_verbosity = "${DEFAULT_MODEL_VERBOSITY}"\n` : ''}`;
  }
}

/**
 * Create Codex agent with specified authentication method.
 */
export function createCodexAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/codex' : 'codex',
    displayName: useVercelAiGateway ? 'OpenAI Codex (Vercel AI Gateway)' : 'OpenAI Codex',

    getApiKeyEnvVar(): string {
      return useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'openai/gpt-5.2-codex';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    let sandbox: AnySandbox | null = null;
    let agentOutput = '';
    let transcript: string | undefined;
    let aborted = false;
    let sandboxStopped = false;

    // Handle abort signal
    const abortHandler = () => {
      aborted = true;
      if (sandbox && !sandboxStopped) {
        sandboxStopped = true;
        sandbox.stop().catch(() => {});
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted before start',
          duration: 0,
        };
      }
      options.signal.addEventListener('abort', abortHandler);
    }

    try {
      // Collect files from fixture
      const allFiles = await collectLocalFiles(fixturePath);
      const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

      // Check for abort before expensive operations
      if (aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted',
          duration: Date.now() - startTime,
        };
      }

      // Create sandbox
      sandbox = await createSandbox({
        timeout: options.timeout,
        runtime: 'node24',
        backend: options.sandbox,
      });

      // Check for abort after sandbox creation (abort may have fired during create)
      if (aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload workspace files (excluding tests)
      await sandbox.uploadFiles(workspaceFiles);
	  
	  await initGitAndCommit(sandbox);

      // Run setup function if provided
      if (options.setup) {
        await options.setup(sandbox);
      }
      const neutralWorkspace = await prepareNeutralWorkspace(sandbox);

      // Install dependencies
      let installResult = await sandbox.runCommand('npm', ['install']);
      if (installResult.exitCode !== 0) {
        installResult = await sandbox.runCommand('npm', ['install']);
      }
      if (installResult.exitCode !== 0) {
        const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
        throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
      }

      // Install Codex CLI globally
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        '@openai/codex',
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Codex CLI install failed: ${cliInstall.stderr}`);
      }

      // Parse model string for query parameters (e.g. "gpt-5.2-codex?reasoningEffort=high").
      // Native-default runs intentionally leave the model undefined.
      const parsedModel = options.model ? parseModelString(options.model) : { model: undefined, reasoningEffort: undefined };
      const { model: baseModel, reasoningEffort } = parsedModel;

      // Create Codex profile config. Recent Codex CLI versions reject the old
      // top-level `profile = "default"` key in config.toml and instead load
      // `$CODEX_HOME/<profile>.config.toml` when `--profile <profile>` is set.
      // For explicit models, reasoning_effort is baked into the profile (rather
      // than passed via -c at runtime) so the value is visible in saved configs
      // and so the CLI's own default of "low" can't sneak through. For
      // native-default runs we omit these settings to match the CLI's behavior.
      await sandbox.runShell('mkdir -p ~/.codex');
      const configContent = generateCodexConfig(baseModel, useVercelAiGateway, reasoningEffort);
      await sandbox.runShell(`cat > ~/.codex/default.config.toml << 'EOF'
${configContent}
EOF`);

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Build Codex CLI command
      const envVarToSet = useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
      const escapedPrompt = options.prompt.replace(/'/g, "'\\''");
      // Direct OpenAI API needs unprefixed model names (e.g. "gpt-5.2-codex" not "openai/gpt-5.2-codex")
      const cliModel = baseModel
        ? (useVercelAiGateway ? baseModel : (baseModel.includes('/') ? baseModel.split('/').pop()! : baseModel))
        : undefined;
      const modelFlag = cliModel ? ` --model ${cliModel}` : '';
      // Pass reasoning effort and verbosity via -c too; CLI flags have the
      // highest precedence and we've observed Codex CLI silently falling back
      // to its "low" defaults for both fields even when the profile sets them.
      // Both default to "medium" for compatibility with gpt-5.2-codex.
      const effectiveReasoningEffort = baseModel ? (reasoningEffort ?? DEFAULT_REASONING_EFFORT) : undefined;
      const reasoningFlag = effectiveReasoningEffort ? ` -c model_reasoning_effort="${effectiveReasoningEffort}"` : '';
      const verbosityFlag = baseModel ? ` -c model_verbosity="${DEFAULT_MODEL_VERBOSITY}"` : '';
      // codex login sets up bearer auth for the CLI; the built-in openai provider requires it
      const codexResult = await sandbox.runShell(
        `echo '${options.apiKey}' | codex login --with-api-key && codex exec --profile default${modelFlag} --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check${reasoningFlag}${verbosityFlag} '${escapedPrompt}'`,
        { [envVarToSet]: options.apiKey, ...neutralWorkspace.env }
      );

      agentOutput = codexResult.stdout + codexResult.stderr;
      transcript = extractTranscriptFromOutput(agentOutput);
      const threadId = extractCodexThreadId(agentOutput);
      const sessionTranscript = await captureCodexSessionTranscript(sandbox, threadId);
      const observedModel = extractObservedModelFromCodexSession(sessionTranscript);

      if (codexResult.exitCode !== 0) {
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: errorLines || `Codex CLI exited with code ${codexResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
          observedModel,
        };
      }

      if (options.validation !== 'none') {
        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Inject transcript context so EVAL.ts tests can assert on agent behavior
        await injectTranscriptContext(sandbox, transcript, 'codex', options.model);
      }

      // Run validation scripts
      const validationResults = await runValidation(sandbox, options.scripts ?? [], options.validation);

      // Capture generated files
      const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox);

      return {
        success: validationResults.allPassed,
        output: agentOutput,
        transcript,
        duration: Date.now() - startTime,
        testResult: validationResults.test,
        scriptsResults: validationResults.scripts,
        sandboxId: sandbox.sandboxId,
        generatedFiles,
        deletedFiles,
        observedModel,
      };
    } catch (error) {
      // Check if this was an abort
      if (aborted) {
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox?.sandboxId,
        };
      }
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        sandboxId: sandbox?.sandboxId,
      };
    } finally {
      // Clean up abort listener
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (sandbox && !sandboxStopped) {
        sandboxStopped = true;
        await sandbox.stop();
      }
    }
  },
};
}
