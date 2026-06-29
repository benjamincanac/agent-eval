/**
 * Generic agent orchestrator.
 *
 * `runWithDefinition` is the single host-side run() that every agent shares. It
 * reproduces the exact flow the old per-agent adapters had (claude-code.ts is the
 * reference), but the agent-specific parts — install, config, auth env, and CLI
 * invocation/transcript-capture — come from the {@link AgentDefinition} and the
 * agent's in-sandbox `run.mjs`.
 *
 * Everything that is agent-AGNOSTIC stays here (and in shared.ts): sandbox
 * lifecycle, the git baseline, the neutral-workspace relocation, validation,
 * generated-file capture, transcript o11y parsing, and abort/timeout handling.
 * None of that can move into the sandbox — it IS the host↔sandbox control plane.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AgentRunOptions, AgentRunResult } from '../types.js';
import {
  createSandbox,
  collectLocalFiles,
  splitTestFiles,
  verifyNoTestFiles,
  type SandboxManager,
} from '../../sandbox.js';
import type { DockerSandboxManager } from '../../docker-sandbox.js';
import {
  runValidation,
  captureGeneratedFiles,
  createVitestConfig,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
  EVAL_HELPER_PATH,
  JUDGE_TRANSCRIPT_FILE,
  JUDGE_CONFIG_PATH,
} from '../shared.js';
import type { AgentDefinition, AgentRunInput, RunnerResult } from './contract.js';

/** Union of the two sandbox backends (same alias the old adapters used). */
type AnySandbox = SandboxManager | DockerSandboxManager;

/** Result of a host-side sandbox command (stdout/stderr/exitCode). */
type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Well-known paths inside the sandbox for the runner + its result file. */
const RUNNER_PATH = '__agent_eval__/run.mjs';
const RESULT_PATH = '__agent_eval__/agent-result.json';

/**
 * Host-disk path to the in-sandbox eval helper, resolved next to the compiled
 * output (dist/lib/agents/eval-helper.mjs) and in src during dev. Shipped into the
 * sandbox at {@link EVAL_HELPER_PATH} before validation so EVAL.ts judge matchers
 * can re-invoke the agent in this sandbox.
 */
const EVAL_HELPER_DISK_PATH = fileURLToPath(new URL('../eval-helper.mjs', import.meta.url));

/**
 * Run all install steps for an agent, reproducing the old per-step error wording.
 * Throws on final failure so the caller's catch turns it into an error result.
 */
async function runInstallSteps(sandbox: AnySandbox, def: AgentDefinition, options: AgentRunOptions): Promise<void> {
  for (const step of def.install(options)) {
    const exec = (): Promise<CommandResult> =>
      step.kind === 'shell'
        ? sandbox.runShell(step.script ?? '')
        : sandbox.runCommand(step.cmd ?? '', step.args ?? []);

    let result = await exec();
    // Optional single retry (the project `npm install` flakes occasionally).
    if (result.exitCode !== 0 && step.retryOnce) {
      result = await exec();
    }
    if (result.exitCode !== 0) {
      // Match the old messages verbatim:
      //   last10  → `${prefix} (exit code N):\n<last 10 lines of stdout+stderr>`
      //   stderr  → `${prefix}: <stderr>`
      if (step.errorBody === 'last10') {
        const body = (result.stdout + result.stderr).trim().split('\n').slice(-10).join('\n');
        throw new Error(`${step.errorPrefix} (exit code ${result.exitCode}):\n${body}`);
      }
      throw new Error(`${step.errorPrefix}: ${result.stderr}`);
    }
  }
}

/** Write the agent's config files into the sandbox (codex TOML, opencode.json, …). */
async function writeConfigFiles(sandbox: AnySandbox, def: AgentDefinition, options: AgentRunOptions): Promise<void> {
  for (const cf of def.configFiles(options)) {
    if (cf.viaShell) {
      // Absolute `~` paths writeFiles can't target (codex heredoc).
      await sandbox.runShell(cf.viaShell);
    } else if (cf.path) {
      await sandbox.writeFiles({ [cf.path]: cf.content ?? '' });
    }
  }
}

/**
 * Read the RunnerResult the in-sandbox run.mjs produced.
 *
 * Source of truth = the result file. If that can't be read, fall back to the
 * `__AGENT_RESULT__` status line on stdout. If NEITHER is parseable, the runner
 * itself crashed (couldn't spawn node, fs error, …) — throw with the tail so the
 * caller's catch produces a structured error result (mirrors the old CLI-crash path).
 */
async function readRunnerResult(
  sandbox: AnySandbox,
  resultPath: string,
  nodeResult: CommandResult
): Promise<RunnerResult> {
  // 1. Preferred: the result file.
  try {
    const raw = await sandbox.readFile(resultPath);
    if (raw && raw.trim()) return JSON.parse(raw) as RunnerResult;
  } catch {
    // fall through to the marker line
  }

  const combined = `${nodeResult.stdout || ''}\n${nodeResult.stderr || ''}`;

  // 2. Fallback: the compact status line (no transcript — it can be huge).
  const markerLine = combined.split('\n').find((l) => l.startsWith('__AGENT_RESULT__'));
  if (markerLine) {
    try {
      const status = JSON.parse(markerLine.slice('__AGENT_RESULT__'.length).trim());
      return {
        ok: !!status.ok,
        output: combined,
        transcript: null,
        observedModel: status.observedModel ?? null,
        error: status.error ?? null,
        agentExitCode: status.agentExitCode ?? -1,
      };
    } catch {
      // fall through to the throw
    }
  }

  // 3. Runner crashed — surface the last lines (old "CLI crash" behavior).
  const tail = combined.trim().split('\n').slice(-5).join('\n');
  throw new Error(tail || `agent runner exited with code ${nodeResult.exitCode}`);
}

/**
 * The shared host-side run(). Each agent's createXxxAgent() wires this up with its
 * definition; the public Agent interface is unchanged, so runner.ts is untouched.
 */
export async function runWithDefinition(
  def: AgentDefinition,
  fixturePath: string,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const startTime = Date.now();
  let sandbox: AnySandbox | null = null;
  let agentOutput = '';
  let transcript: string | undefined;
  let observedModel: string | undefined;
  let aborted = false;
  let sandboxStopped = false;

  // --- abort wiring (identical to the old adapter) ---------------------------
  const abortHandler = () => {
    aborted = true;
    if (sandbox && !sandboxStopped) {
      sandboxStopped = true;
      sandbox.stop().catch(() => {});
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      return { success: false, output: '', error: 'Aborted before start', duration: 0 };
    }
    options.signal.addEventListener('abort', abortHandler);
  }

  try {
    // 1. Collect fixture files; hold test files back until validation.
    const allFiles = await collectLocalFiles(fixturePath);
    const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

    if (aborted) {
      return { success: false, output: '', error: 'Aborted', duration: Date.now() - startTime };
    }

    // 2. Create the sandbox.
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

    // 3. Upload workspace, establish the git baseline, run user setup, relocate to
    //    the neutral workspace. (All agent-agnostic; unchanged shared helpers.)
    await sandbox.uploadFiles(workspaceFiles);
    await initGitAndCommit(sandbox);
    if (options.setup) {
      await options.setup(sandbox);
    }
    const neutralWorkspace = await prepareNeutralWorkspace(sandbox);

    // 4. SETUP from the definition: install (project deps + CLI) then config files.
    await runInstallSteps(sandbox, def, options);
    await writeConfigFiles(sandbox, def, options);

    // 5. Guard: no stray test files leaked into the workspace before the agent runs.
    await verifyNoTestFiles(sandbox);

    // 6. Ship the agent's in-sandbox runner. We read run.mjs from disk on the host
    //    (next to the compiled definition) and write it into the sandbox.
    const runnerSource = readFileSync(def.runnerPath, 'utf8');
    await sandbox.writeFiles({ [RUNNER_PATH]: runnerSource });

    // 7. INVOKE the runner. Auth + neutral env are set on the node process (merged,
    //    neutral overrides — same precedence as the old adapter). The apiKey rides
    //    in env only, never in the argv JSON.
    const input: AgentRunInput = {
      prompt: options.prompt,
      model: options.model,
      modelPolicy: options.modelPolicy,
      webResearch: options.webResearch,
      agentOptions: options.agentOptions,
      cwd: sandbox.getWorkingDirectory(), // post-relocation cwd; transcript paths use it
      resultPath: RESULT_PATH,
      // Optional host-computed values (e.g. codex's resolved model/effort/verbosity
      // that must match the TOML config). Omitted entirely for agents without it.
      extra: def.runnerExtra?.(options),
    };
    const runEnv = { ...def.authEnv(options), ...neutralWorkspace.env };
    const nodeResult = await sandbox.runCommand('node', [RUNNER_PATH, JSON.stringify(input)], { env: runEnv });

    // 8. Read the runner's result (file → marker → throw-on-crash).
    const runnerResult = await readRunnerResult(sandbox, RESULT_PATH, nodeResult);
    agentOutput = runnerResult.output;
    transcript = runnerResult.transcript ?? undefined;
    observedModel = runnerResult.observedModel ?? undefined;

    if (aborted) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: 'Aborted',
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
      };
    }

    // 9. Agent CLI failed (non-zero exit). Return a failed result, NOT a throw —
    //    mirrors the old non-zero-exit path exactly.
    if (!runnerResult.ok) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: runnerResult.error ?? `${def.displayName} exited with code ${runnerResult.agentExitCode}`,
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
        observedModel,
      };
    }

    // 10. VALIDATION (unchanged shared helpers; parseTranscript runs host-side here).
    // The auth env is reused for the eval process so EVAL.ts judge matchers can
    // re-invoke the agent in-sandbox (the vitest process inherits it to children).
    const validationEnv = { ...def.authEnv(options), ...neutralWorkspace.env };
    if (options.validation !== 'none') {
      await sandbox.uploadFiles(testFiles);
      await createVitestConfig(sandbox);
      await injectTranscriptContext(sandbox, transcript, def.o11yAgentName, options.model);
      // Judge runtime: ship the eval helper, materialize the raw transcript as a
      // file the judge agent can read by path, and record the judge config (same
      // agent/model + host-computed extra the codegen run used).
      await sandbox.writeFiles({
        [EVAL_HELPER_PATH]: readFileSync(EVAL_HELPER_DISK_PATH, 'utf8'),
        [JUDGE_TRANSCRIPT_FILE]: transcript ?? '',
        [JUDGE_CONFIG_PATH]: JSON.stringify({
          model: options.model ?? null,
          extra: def.runnerExtra?.(options) ?? null,
        }),
      });
    }
    const validationResults = await runValidation(
      sandbox,
      options.scripts ?? [],
      options.validation,
      validationEnv
    );

    // 11. Capture generated/deleted files (git diff).
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
    // Abort wins over a generic error (same as the old adapter).
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
      observedModel,
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
}
