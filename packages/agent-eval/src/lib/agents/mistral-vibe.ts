/**
 * Mistral Vibe CLI agent implementation.
 * Uses direct Mistral API access.
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
  MISTRAL_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Extract transcript from Vibe streaming output.
 * When run with --output streaming, Vibe outputs newline-delimited JSON per message.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

  const lines = output.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n');
}

/**
 * Create Mistral Vibe agent with direct API authentication.
 */
export function createMistralVibeAgent(): Agent {
  return {
    name: 'mistral-vibe',
    displayName: 'Mistral Vibe',

    getApiKeyEnvVar(): string {
      return MISTRAL_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'devstral-2';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
      const startTime = Date.now();
      let sandbox: AnySandbox | null = null;
      let agentOutput = '';
      let transcript: string | undefined;
      let aborted = false;
      let sandboxStopped = false;

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
        const allFiles = await collectLocalFiles(fixturePath);
        const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

        if (aborted) {
          return {
            success: false,
            output: '',
            error: 'Aborted',
            duration: Date.now() - startTime,
          };
        }

        sandbox = await createSandbox({
          timeout: options.timeout,
          runtime: 'node24',
          backend: options.sandbox,
        });

        if (aborted) {
          return {
            success: false,
            output: '',
            error: 'Aborted',
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        await sandbox.uploadFiles(workspaceFiles);

        await initGitAndCommit(sandbox);

        if (options.setup) {
          await options.setup(sandbox);
        }

        // Install dependencies
        let installResult = await sandbox.runCommand('npm', ['install']);
        if (installResult.exitCode !== 0) {
          installResult = await sandbox.runCommand('npm', ['install']);
        }
        if (installResult.exitCode !== 0) {
          const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
          throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
        }

        // Install Vibe CLI via the official install script
        const cliInstall = await sandbox.runShell(
          'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
        );
        if (cliInstall.exitCode !== 0) {
          throw new Error(`Vibe CLI install failed: ${cliInstall.stderr}`);
        }

        // Ensure vibe is on PATH (the install script puts it in ~/.local/bin)
        const pathSetup = await sandbox.runShell('export PATH="$HOME/.local/bin:$PATH" && which vibe');
        if (pathSetup.exitCode !== 0) {
          throw new Error(`Vibe CLI not found on PATH after install: ${pathSetup.stderr}`);
        }

        await verifyNoTestFiles(sandbox);

        // Run Vibe in programmatic mode with streaming output for transcript
        const escapedPrompt = options.prompt.replace(/'/g, "'\\''");
        const vibeResult = await sandbox.runShell(
          `export PATH="$HOME/.local/bin:$PATH" && vibe --prompt '${escapedPrompt}' --model ${options.model} --output streaming`,
          {
            [MISTRAL_DIRECT.apiKeyEnvVar]: options.apiKey,
          }
        );

        agentOutput = vibeResult.stdout + vibeResult.stderr;
        transcript = extractTranscriptFromOutput(agentOutput);

        if (vibeResult.exitCode !== 0) {
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: errorLines || `Vibe CLI exited with code ${vibeResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        await sandbox.uploadFiles(testFiles);

        await createVitestConfig(sandbox);

        await injectTranscriptContext(sandbox, transcript, 'mistral-vibe', options.model);

        const validationResults = await runValidation(sandbox, options.scripts ?? []);

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
        };
      } catch (error) {
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
