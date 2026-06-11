/**
 * Claude Code agent implementation.
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
  ANTHROPIC_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Capture the Claude Code transcript from the sandbox.
 * Claude Code stores transcripts at ~/.claude/projects/-{workdir}/{session-id}.jsonl
 */
async function captureTranscript(sandbox: AnySandbox): Promise<string | undefined> {
  try {
    // Get the working directory to construct the transcript path
    const workdir = sandbox.getWorkingDirectory();
    // Claude Code uses the path with slashes replaced by dashes
    const projectPath = workdir.replace(/\//g, '-');
    const claudeProjectDir = `~/.claude/projects/${projectPath}`;

    // Find the most recent .jsonl file (the transcript)
    const findResult = await sandbox.runShell(
      `ls -t ${claudeProjectDir}/*.jsonl 2>/dev/null | head -1`
    );

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return undefined;
    }

    const transcriptPath = findResult.stdout.trim();
    const content = await sandbox.readFile(transcriptPath);
    return content || undefined;
  } catch {
    // Transcript capture is best-effort
    return undefined;
  }
}

export function extractObservedModelFromClaudeTranscript(transcript: string | undefined): string | undefined {
  if (!transcript) return undefined;

  let observedModel: string | undefined;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { message?: { model?: unknown } };
      if (typeof event.message?.model === 'string') {
        observedModel = event.message.model;
      }
    } catch {
      // Ignore non-JSON transcript lines.
    }
  }

  return observedModel;
}

/**
 * Build the Claude Code CLI argument list.
 *
 * Exported for tests because the argument order is regression-sensitive:
 * `--allowedTools` is variadic — it keeps consuming positional tokens until
 * the next flag. Two rules follow:
 *
 * 1. The tools must be a single comma-separated value (separate tokens broke
 *    every run in #141).
 * 2. `--allowedTools` must be followed by another flag, NEVER directly by
 *    the prompt. The comma token alone is not enough: a live smoke run on
 *    claude 2.1.112 with `... --allowedTools "WebSearch,WebFetch" <prompt>`
 *    consumed the prompt as another tool name and failed with "Input must
 *    be provided either through stdin or as a prompt argument".
 *
 * `--allowedTools` is therefore emitted first, and the always-present
 * `--dangerously-skip-permissions` flag guarantees the variadic capture is
 * terminated before the trailing positional prompt.
 */
export function buildClaudeCodeCliArgs(options: AgentRunOptions): string[] {
  const cliArgs = ['--print'];
  if (options.webResearch) {
    cliArgs.push('--allowedTools', 'WebSearch,WebFetch');
  }
  if (options.model) {
    cliArgs.push('--model', options.model);
  }
  cliArgs.push('--dangerously-skip-permissions');
  const effort = options.agentOptions?.effort as string | undefined;
  if (effort) {
    cliArgs.push('--effort', effort);
  }
  cliArgs.push(options.prompt);
  return cliArgs;
}

/**
 * Create Claude Code agent with specified authentication method.
 */
export function createClaudeCodeAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/claude-code' : 'claude-code',
    displayName: useVercelAiGateway ? 'Claude Code (Vercel AI Gateway)' : 'Claude Code',

    getApiKeyEnvVar(): string {
      if (useVercelAiGateway) return AI_GATEWAY.apiKeyEnvVar;
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
      return ANTHROPIC_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'opus';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    let sandbox: AnySandbox | null = null;
    let agentOutput = '';
    let transcript: string | undefined;
    let aborted = false;
    let sandboxStopped = false;
    let hasReturned = false;

    const captureTranscriptBestEffort = async () => {
      if (!sandbox || sandboxStopped || transcript) return;
      transcript = await captureTranscript(sandbox);
    };

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
          hasReturned = true;
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
        hasReturned = true;
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
        hasReturned = true;
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

      // Install Claude Code CLI globally
      const cliPackage = (options.agentOptions?.cliPackage as string) || '@anthropic-ai/claude-code';
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        cliPackage,
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Claude Code install failed: ${cliInstall.stderr}`);
      }

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Build sandbox environment based on authentication method.
      // Note: options.apiKey is always resolved from process.env[getApiKeyEnvVar()]
      // by the CLI (cli.ts), so the env-var check here is consistent with getApiKeyEnvVar().
      let claudeEnv: Record<string, string>;
      if (useVercelAiGateway) {
        claudeEnv = {
          ANTHROPIC_BASE_URL: AI_GATEWAY.baseUrl,
          ANTHROPIC_AUTH_TOKEN: options.apiKey,
          ANTHROPIC_API_KEY: '',
        };
      } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        claudeEnv = {
          CLAUDE_CODE_OAUTH_TOKEN: options.apiKey,
        };
      } else {
        claudeEnv = {
          ANTHROPIC_API_KEY: options.apiKey,
        };
      }

      // Build CLI arguments
      const cliArgs = buildClaudeCodeCliArgs(options);

      // Run Claude Code with appropriate authentication
      const claudeResult = await sandbox.runCommand(
        'claude',
        cliArgs,
        {
          env: { ...claudeEnv, ...neutralWorkspace.env },
        }
      );

      agentOutput = claudeResult.stdout + claudeResult.stderr;

      if (claudeResult.exitCode !== 0) {
        await captureTranscriptBestEffort();
        const observedModel = extractObservedModelFromClaudeTranscript(transcript);
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        hasReturned = true;
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: errorLines || `Claude Code exited with code ${claudeResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
          observedModel,
        };
      }

      // Capture transcript before validation when available
      await captureTranscriptBestEffort();
      const observedModel = extractObservedModelFromClaudeTranscript(transcript);

      if (options.validation !== 'none') {
        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Inject transcript context so EVAL.ts tests can assert on agent behavior
        await injectTranscriptContext(sandbox, transcript, 'claude-code', options.model);
      }

      // Run validation scripts
      const validationResults = await runValidation(sandbox, options.scripts ?? [], options.validation);

      // Capture generated files
      const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox);

      hasReturned = true;
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
      await captureTranscriptBestEffort();
      // Check if this was an abort
      if (aborted) {
        hasReturned = true;
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox?.sandboxId,
        };
      }
      hasReturned = true;
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        sandboxId: sandbox?.sandboxId,
      };
    } finally {
      // If we're about to return and sandbox is still up, try one final transcript capture.
      if (hasReturned) {
        await captureTranscriptBestEffort();
      }
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
