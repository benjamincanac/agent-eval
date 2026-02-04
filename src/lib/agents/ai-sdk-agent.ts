/**
 * AI SDK Agent - A simple coding agent using the Vercel AI SDK.
 * Works with any model available on Vercel AI Gateway.
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
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * The CLI script source code that runs inside the sandbox.
 * This is a self-contained script that uses the AI SDK.
 */
const CLI_SCRIPT = `
import { generateText, tool, stepCountIs } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';

// Parse command line arguments
const args = process.argv.slice(2);
let prompt = '';
let model = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prompt' && args[i + 1]) {
    prompt = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    model = args[++i];
  }
}

if (!prompt || !model) {
  console.error('Usage: ai-sdk-agent --prompt "..." --model "provider/model"');
  process.exit(1);
}

// Create AI Gateway client
const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

// Transcript events
const events = [];

function logEvent(type, data) {
  const event = { type, timestamp: Date.now(), ...data };
  events.push(event);
  console.log(JSON.stringify(event));
}

// Define coding tools
const tools = {
  readFile: tool({
    description: 'Read the contents of a file at the given path',
    inputSchema: z.object({
      path: z.string().describe('The file path to read'),
    }),
    execute: async ({ path }) => {
      try {
        const content = readFileSync(path, 'utf-8');
        logEvent('tool_result', { tool: 'readFile', path, success: true });
        return content;
      } catch (error) {
        logEvent('tool_result', { tool: 'readFile', path, success: false, error: error.message });
        return \`Error reading file: \${error.message}\`;
      }
    },
  }),

  writeFile: tool({
    description: 'Write content to a file at the given path. Creates directories if needed.',
    inputSchema: z.object({
      path: z.string().describe('The file path to write'),
      content: z.string().describe('The content to write'),
    }),
    execute: async ({ path, content }) => {
      try {
        const dir = dirname(path);
        if (dir && dir !== '.') {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(path, content);
        logEvent('tool_result', { tool: 'writeFile', path, success: true });
        return 'File written successfully';
      } catch (error) {
        logEvent('tool_result', { tool: 'writeFile', path, success: false, error: error.message });
        return \`Error writing file: \${error.message}\`;
      }
    },
  }),

  editFile: tool({
    description: 'Edit a file by replacing a specific string with new content',
    inputSchema: z.object({
      path: z.string().describe('The file path to edit'),
      oldString: z.string().describe('The exact string to find and replace'),
      newString: z.string().describe('The replacement string'),
    }),
    execute: async ({ path, oldString, newString }) => {
      try {
        const content = readFileSync(path, 'utf-8');
        if (!content.includes(oldString)) {
          logEvent('tool_result', { tool: 'editFile', path, success: false, error: 'String not found' });
          return 'Error: The specified string was not found in the file';
        }
        const newContent = content.replace(oldString, newString);
        writeFileSync(path, newContent);
        logEvent('tool_result', { tool: 'editFile', path, success: true });
        return 'File edited successfully';
      } catch (error) {
        logEvent('tool_result', { tool: 'editFile', path, success: false, error: error.message });
        return \`Error editing file: \${error.message}\`;
      }
    },
  }),

  listFiles: tool({
    description: 'List files in a directory. Call with path="." to list current directory.',
    inputSchema: z.object({
      path: z.string().describe('The directory path to list (use "." for current directory)'),
      recursive: z.boolean().describe('Whether to list recursively').optional(),
    }),
    execute: async ({ path, recursive }) => {
      const targetPath = path || '.';
      const isRecursive = recursive || false;
      try {
        if (isRecursive) {
          const result = execSync(\`find \${targetPath} -type f | head -100\`, { encoding: 'utf-8' });
          logEvent('tool_result', { tool: 'listFiles', path: targetPath, recursive: isRecursive, success: true });
          return result;
        }
        const files = readdirSync(targetPath);
        logEvent('tool_result', { tool: 'listFiles', path: targetPath, recursive: isRecursive, success: true });
        return files.join('\\n');
      } catch (error) {
        logEvent('tool_result', { tool: 'listFiles', path: targetPath, success: false, error: error.message });
        return \`Error listing files: \${error.message}\`;
      }
    },
  }),

  glob: tool({
    description: 'Find files matching a pattern (e.g., "*.ts" for TypeScript files)',
    inputSchema: z.object({
      pattern: z.string().describe('The file pattern (e.g., "*.ts", "*.js")'),
    }),
    execute: async ({ pattern }) => {
      try {
        // Extract just the file pattern, remove any path prefix
        const filePattern = pattern.replace(/^\\*\\*\\//, '').replace(/^\\.\\//, '');
        const result = execSync(\`find . -name "\${filePattern}" -type f 2>/dev/null | grep -v node_modules | head -50\`, { encoding: 'utf-8' });
        logEvent('tool_result', { tool: 'glob', pattern, success: true });
        return result.trim() || 'No files found';
      } catch (error) {
        logEvent('tool_result', { tool: 'glob', pattern, success: false, error: error.message });
        return 'No files found';
      }
    },
  }),

  grep: tool({
    description: 'Search for a text pattern in files',
    inputSchema: z.object({
      pattern: z.string().describe('The search pattern'),
      path: z.string().describe('The file or directory to search in').optional(),
    }),
    execute: async ({ pattern, path }) => {
      const targetPath = path || '.';
      try {
        const result = execSync(\`grep -rn "\${pattern}" \${targetPath} 2>/dev/null | grep -v node_modules | head -50\`, { encoding: 'utf-8' });
        logEvent('tool_result', { tool: 'grep', pattern, path: targetPath, success: true });
        return result.trim() || 'No matches found';
      } catch (error) {
        logEvent('tool_result', { tool: 'grep', pattern, path: targetPath, success: false });
        return 'No matches found';
      }
    },
  }),

  bash: tool({
    description: 'Run a bash command',
    inputSchema: z.object({
      command: z.string().describe('The command to run'),
    }),
    execute: async ({ command }) => {
      try {
        const result = execSync(command, { encoding: 'utf-8', timeout: 30000 });
        logEvent('tool_result', { tool: 'bash', command, success: true });
        return result;
      } catch (error) {
        logEvent('tool_result', { tool: 'bash', command, success: false, error: error.message });
        return \`Error: \${error.message}\\n\${error.stdout || ''}\\n\${error.stderr || ''}\`;
      }
    },
  }),
};

// System prompt for the coding agent
const systemPrompt = \`You are an expert coding agent. Your job is to complete programming tasks by reading, writing, and modifying files.

Available tools:
- readFile(path): Read a file's contents
- writeFile(path, content): Write/create a file (creates directories if needed)
- editFile(path, oldString, newString): Replace a specific string in a file
- listFiles(path): List files in a directory (use path="." for current directory)
- glob(pattern): Find files by pattern (e.g., "*.ts")
- grep(pattern, path): Search for text in files
- bash(command): Run shell commands

IMPORTANT WORKFLOW:
1. First, list files to understand the project structure: listFiles(path=".")
2. Read any relevant existing files to understand the context
3. Make the necessary code changes using writeFile or editFile
4. If needed, run build/test commands with bash to verify

RULES:
- Always check what files exist before modifying them
- Create complete, working code - not placeholders
- Put files in the correct directories (e.g., src/ for source files)
- Be thorough but efficient\`;

// Run the agent
async function main() {
  logEvent('start', { model, prompt });

  try {
    const result = await generateText({
      model: gateway(model),
      tools,
      stopWhen: stepCountIs(100), // Allow up to 100 steps
      system: systemPrompt,
      prompt,
      onStepFinish: ({ stepType, text, toolCalls, toolResults }) => {
        logEvent('step', { stepType, text, toolCalls: toolCalls?.length, toolResults: toolResults?.length });
      },
    });

    logEvent('complete', {
      success: true,
      steps: result.steps.length,
      text: result.text,
    });
  } catch (error) {
    logEvent('error', {
      success: false,
      error: error.message,
      name: error.name,
    });
    process.exit(1);
  }
}

main();
`;

/**
 * Create AI SDK agent with Vercel AI Gateway authentication.
 */
export function createAiSdkAgent(): Agent {
  return {
    name: 'vercel-ai-gateway/ai-sdk-harness',
    displayName: 'AI SDK Harness (Vercel AI Gateway)',

    getApiKeyEnvVar(): string {
      return AI_GATEWAY.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'anthropic/claude-sonnet-4';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
      const startTime = Date.now();
      let sandbox: AnySandbox | null = null;
      let agentOutput = '';
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

        // Check for abort after sandbox creation
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

        // Run setup function if provided
        if (options.setup) {
          await options.setup(sandbox);
        }

        // Install dependencies
        const installResult = await sandbox.runCommand('npm', ['install']);
        if (installResult.exitCode !== 0) {
          throw new Error(`npm install failed: ${installResult.stderr}`);
        }

        // Install AI SDK dependencies
        const aiInstall = await sandbox.runCommand('npm', [
          'install',
          'ai@^5.0.11',
          '@ai-sdk/gateway@^1.0.0',
          'zod@^3.23.8',
        ]);
        if (aiInstall.exitCode !== 0) {
          throw new Error(`AI SDK install failed: ${aiInstall.stderr}`);
        }

        // Write the CLI script to the sandbox
        await sandbox.writeFiles({
          'ai-sdk-agent.mjs': CLI_SCRIPT,
        });

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        // Run the AI SDK agent
        const agentResult = await sandbox.runCommand(
          'node',
          [
            'ai-sdk-agent.mjs',
            '--prompt',
            options.prompt,
            '--model',
            options.model,
          ],
          {
            env: {
              [AI_GATEWAY.apiKeyEnvVar]: options.apiKey,
            },
          }
        );

        agentOutput = agentResult.stdout + agentResult.stderr;

        if (agentResult.exitCode !== 0) {
          // Extract meaningful error from output
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            error: errorLines || `AI SDK agent exited with code ${agentResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // The agent outputs JSON events, use that as transcript
        const transcript = agentOutput;

        // Run validation scripts
        const validationResults = await runValidation(sandbox, options.scripts ?? []);

        // Capture generated files
        const generatedFiles = await captureGeneratedFiles(sandbox);

        return {
          success: validationResults.allPassed,
          output: agentOutput,
          transcript,
          duration: Date.now() - startTime,
          testResult: validationResults.test,
          scriptsResults: validationResults.scripts,
          sandboxId: sandbox.sandboxId,
          generatedFiles,
        };
      } catch (error) {
        // Check if this was an abort
        if (aborted) {
          return {
            success: false,
            output: agentOutput,
            error: 'Aborted',
            duration: Date.now() - startTime,
            sandboxId: sandbox?.sandboxId,
          };
        }
        return {
          success: false,
          output: agentOutput,
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
