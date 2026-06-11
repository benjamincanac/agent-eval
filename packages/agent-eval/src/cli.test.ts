import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadConfig } from './lib/config.js';
import { computeFingerprint } from './lib/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = resolve(PROJECT_ROOT, 'src/cli.ts');

const TEST_DIR = '/tmp/eval-framework-cli-test';

function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('npx', ['tsx', CLI_PATH, ...args], {
    cwd: cwd ?? PROJECT_ROOT,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('CLI', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('help', () => {
    it('shows help with --help flag', () => {
      const result = runCli(['--help']);
      expect(result.stdout).toContain('eval');
      expect(result.stdout).toContain('init');
      expect(result.stdout).toContain('run');
    });
  });

  // Helper to scaffold a project/experiments + project/evals layout.
  function scaffoldProject(
    name: string,
    options: { configContent?: string; evals?: string[] } = {}
  ): { projectDir: string; experimentsDir: string; evalsDir: string } {
    const projectDir = join(TEST_DIR, name);
    const experimentsDir = join(projectDir, 'experiments');
    mkdirSync(experimentsDir, { recursive: true });

    const configContent = options.configContent ?? `export default { agent: 'claude-code' };`;
    writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

    const evalsDir = join(projectDir, 'evals');
    mkdirSync(evalsDir);
    for (const evalName of options.evals ?? []) {
      const fixture = join(evalsDir, evalName);
      mkdirSync(fixture);
      writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
      writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    }

    return { projectDir, experimentsDir, evalsDir };
  }

  describe('run command', () => {
    it('shows error when experiment name does not match', () => {
      const { projectDir } = scaffoldProject('no-match-project', { evals: ['my-eval'] });

      const result = runCli(['does-not-exist', '--dry'], projectDir);
      expect(result.stderr).toContain('No experiments matched');
      expect(result.exitCode).toBe(1);
    });

    it('runs a single experiment by name with fingerprint reuse (dry run)', () => {
      const { projectDir } = scaffoldProject('project', { evals: ['my-eval'] });

      // A single name routes through the same run-all path: dry run lists the
      // eval as something to run since nothing is cached yet.
      const result = runCli(['cc', '--dry'], projectDir);
      expect(result.stdout).toContain('my-eval');
      expect(result.stdout).toContain('to run');
      expect(result.exitCode).toBe(0);
    });

    it('--smoke picks first eval alphabetically (dry run)', () => {
      const { projectDir } = scaffoldProject('smoke-project', {
        evals: ['beta-eval', 'alpha-eval'],
      });

      const result = runCli(['cc', '--smoke', '--dry'], projectDir);
      expect(result.stdout).toContain('alpha-eval');
      expect(result.stdout).not.toContain('beta-eval');
      expect(result.exitCode).toBe(0);
    });

    it('shows error when no valid fixtures found', () => {
      const { projectDir } = scaffoldProject('empty-project');

      const result = runCli(['cc'], projectDir);
      expect(result.stderr).toContain('No valid eval fixtures');
      expect(result.exitCode).toBe(1);
    });

    it('surfaces invalid config errors', () => {
      // Missing agent -> config validation fails.
      const { projectDir } = scaffoldProject('bad-config', {
        configContent: `export default { model: 'opus' };`,
        evals: ['my-eval'],
      });

      const result = runCli(['cc', '--dry'], projectDir);
      expect(result.stderr).toContain('Failed to load');
      expect(result.stderr).toContain('agent');
    });

    it('reuses just-passed results: `<name>` then `run-all <name> --dry` reports cached', async () => {
      const { projectDir, experimentsDir, evalsDir } = scaffoldProject('reuse-project', {
        evals: ['my-eval'],
      });

      // Simulate a passed result stored at the canonical single-model layout
      // (results/<name>/<ts>/<eval>/summary.json) with a matching fingerprint,
      // exactly as the unified run path would produce.
      const config = await loadConfig(join(experimentsDir, 'cc.ts'));
      const models = Array.isArray(config.model) ? config.model : [config.model];
      const model = models[0];
      const experimentName = models.length > 1 ? `cc/${model}` : 'cc';
      const modelConfig = { ...config, model, runs: config.runs };
      const fingerprint = computeFingerprint(join(evalsDir, 'my-eval'), modelConfig);

      const evalDir = join(projectDir, 'results', experimentName, '2024-01-26T12-00-00.000Z', 'my-eval');
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(
        join(evalDir, 'summary.json'),
        JSON.stringify({ totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 10, fingerprint })
      );

      // Both the single-name path and explicit run-all should see it as cached.
      const single = runCli(['cc', '--dry'], projectDir);
      expect(single.stdout).toContain('cached');
      expect(single.stdout).toContain('Nothing to run');
      expect(single.exitCode).toBe(0);

      const runAll = runCli(['run-all', 'cc', '--dry'], projectDir);
      expect(runAll.stdout).toContain('cached');
      expect(runAll.stdout).toContain('Nothing to run');
      expect(runAll.exitCode).toBe(0);
    });
  });
});
