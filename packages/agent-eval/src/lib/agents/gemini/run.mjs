/**
 * Gemini CLI in-sandbox runner.
 *
 * This file is shipped INTO the sandbox by the orchestrator and executed there as
 * `node __agent_eval__/run.mjs '<AgentRunInput JSON>'`. It is intentionally
 * ZERO-DEPENDENCY (only `node:*` builtins) because the sandbox only has the
 * fixture's own deps + the installed `gemini` CLI — it cannot import anything from
 * the @vercel/agent-eval package.
 *
 * Dual mode:
 *   - runnable: invoked directly → reads argv, runs the agent, writes the result
 *     file + prints a status line, exits 0.
 *   - importable: `import { runAgent } from './run.mjs'` → returns a RunnerResult
 *     (no file write, no exit). This is what a future in-sandbox judge reuses.
 *
 * The pure helpers below are exported (not just `runAgent`) so they can be
 * unit-tested directly — the same code the sandbox runs.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the Gemini CLI argument list.
 *
 * Order is preserved verbatim from the old adapter:
 *   `--prompt <prompt>` [ `--model <model>` ] `--approval-mode yolo`
 *   `--output-format stream-json`
 *
 * `--output-format stream-json` makes Gemini emit JSONL (newline-delimited JSON)
 * so we can capture a detailed event transcript (similar to Codex's --json).
 * `--approval-mode yolo` auto-approves tool actions (non-interactive sandbox run).
 *
 * @param {{prompt:string, model?:string}} input
 * @returns {string[]}
 */
export function buildGeminiCliArgs(input) {
  const geminiArgs = ['--prompt', input.prompt];
  if (input.model) {
    geminiArgs.push('--model', input.model);
  }
  geminiArgs.push('--approval-mode', 'yolo', '--output-format', 'stream-json');
  return geminiArgs;
}

/**
 * Extract transcript from Gemini stream-json output.
 *
 * Preserved verbatim from the old adapter. When run with
 * `--output-format stream-json`, Gemini outputs JSONL (one JSON object per line);
 * we keep only the lines that look like a JSON object ({ ... }) and re-join them.
 *
 * @param {string|undefined|null} output combined stdout+stderr
 * @returns {string|undefined}
 */
export function extractTranscriptFromOutput(output) {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --output-format stream-json output contains JSON events, one per line.
  // Filter to only include lines that look like JSON objects.
  const lines = output.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n');
}

/**
 * Run Gemini CLI over the workspace at `input.cwd` and return a RunnerResult.
 *
 * Auth (GEMINI_API_KEY) arrives via process.env — the orchestrator sets it on the
 * `node run.mjs` invocation, and we pass process.env straight through to the CLI.
 * The runner never handles secrets itself.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  const args = buildGeminiCliArgs(input);

  // spawnSync (not a shell string): the prompt is a plain argv element, so there is
  // no shell quoting/escaping to get wrong. Blocking is fine — the runner has
  // nothing else to do while the agent works. The sandbox-level timeout bounds it.
  const res = spawnSync('gemini', args, {
    cwd: input.cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  // Preserve the old concatenation order: stdout THEN stderr.
  const output = stdout + stderr;
  // spawnSync sets status=null + error when the binary can't be spawned at all.
  const agentExitCode = res.status == null ? -1 : res.status;

  // Transcript from the stream-json output. Gemini exposes no observable model,
  // so observedModel is always null (matches the old adapter exactly).
  const transcript = extractTranscriptFromOutput(output) ?? null;
  const observedModel = null;

  if (res.error || agentExitCode !== 0) {
    // Mirror the old error string: last 5 lines of output, else a coded fallback.
    const errorLines = output.trim().split('\n').slice(-5).join('\n');
    const fallback = res.error
      ? `Failed to run gemini: ${res.error.message}`
      : `Gemini CLI exited with code ${agentExitCode}`;
    return {
      ok: false,
      output,
      transcript,
      observedModel,
      error: errorLines || fallback,
      agentExitCode,
    };
  }

  return { ok: true, output, transcript, observedModel, error: null, agentExitCode };
}

/* ─────────────────────────── runnable (CLI) entry ─────────────────────────── */

// True when this file is executed directly (`node run.mjs ...`), false when imported.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // argv[2] is the AgentRunInput JSON (never contains secrets).
  const input = JSON.parse(process.argv[2]);

  // Always produce a RunnerResult, even if the runner itself throws, so the host
  // always has a result file to read (node exit code stays 0 except on a truly
  // unrecoverable crash before we can write).
  let result;
  try {
    result = await runAgent(input);
  } catch (e) {
    result = {
      ok: false,
      output: '',
      transcript: null,
      observedModel: null,
      error: e && e.message ? e.message : String(e),
      agentExitCode: -1,
    };
  }

  // Source of truth: the result file the host reads back via sandbox.readFile.
  try {
    mkdirSync(dirname(input.resultPath), { recursive: true });
    writeFileSync(input.resultPath, JSON.stringify(result));
  } catch {
    // If the file can't be written, the host falls back to the marker line below.
  }

  // Fallback channel: a compact status line (no transcript — it can be huge).
  process.stdout.write(
    '__AGENT_RESULT__ ' +
      JSON.stringify({
        ok: result.ok,
        observedModel: result.observedModel,
        error: result.error,
        agentExitCode: result.agentExitCode,
      }) +
      '\n'
  );

  // Exit 0: "the runner ran". Agent success/failure is conveyed via result.ok, not
  // the node exit code (the host distinguishes the two).
  process.exit(0);
}
