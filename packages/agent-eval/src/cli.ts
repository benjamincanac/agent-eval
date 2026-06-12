#!/usr/bin/env node

/**
 * CLI entry point for the eval framework.
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, basename } from 'path';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { loadConfig, resolveEvalNames } from './lib/config.js';
import { loadAllFixtures } from './lib/fixture.js';
import { runExperiment, StartRateLimiter } from './lib/runner.js';
import { Dashboard, createConsoleProgressHandler } from './lib/dashboard.js';
import type { ProgressEvent, Classification, ResolvedExperimentConfig, EvalFixture } from './lib/types.js';
import { initProject, getPostInitInstructions } from './lib/init.js';
import { getAgent } from './lib/agents/index.js';
import { computeFingerprint } from './lib/fingerprint.js';
import { scanReusableResults } from './lib/results.js';
import { isClassifierEnabled, classifyFailure } from './lib/classifier.js';
import { housekeep } from './lib/housekeeping.js';
import { spawnSync } from 'child_process';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';

// Load environment variables (.env.local first, then .env as fallback)
dotenvConfig({ path: '.env.local', override: true });
dotenvConfig({ override: true });

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();
program.enablePositionalOptions();

program
  .name('@vercel/agent-eval')
  .description('Framework for testing AI coding agents in isolated sandboxes')
  .version(pkg.version);

/**
 * init command - Create a new eval project
 */
program
  .command('init')
  .argument('<name>', 'Name of the project to create')
  .description('Create a new eval project with example fixtures')
  .action(async (name: string) => {
    try {
      console.log(chalk.blue(`Creating new eval project: ${name}`));

      const projectDir = initProject({
        name,
        targetDir: process.cwd(),
      });

      console.log(chalk.green('Project created successfully!'));
      console.log(getPostInitInstructions(projectDir, name));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red('An unknown error occurred'));
      }
      process.exit(1);
    }
  });

/**
 * playground command - Launch the web-based results viewer
 * Spawns @vercel/agent-eval-playground (downloaded on-demand via npx if not installed)
 */
program
  .command('playground')
  .description('Launch the web-based playground for browsing experiment results')
  .option('--port <port>', 'HTTP server port', '3000')
  .option('--results-dir <dir>', 'Path to results directory', './results')
  .option('--evals-dir <dir>', 'Path to evals directory', './evals')
  .option('--watch', 'Enable live mode — watch results directory for changes')
  .action(async (options: { port: string; resultsDir: string; evalsDir: string; watch?: boolean }) => {
    const resultsDir = resolve(process.cwd(), options.resultsDir);
    const evalsDir = resolve(process.cwd(), options.evalsDir);

    console.log(chalk.blue('Starting Agent Eval Playground...'));

    // Build args for the playground CLI
    const playgroundArgs = [
      '--results-dir', resultsDir,
      '--evals-dir', evalsDir,
      '--port', options.port,
    ];
    if (options.watch) {
      playgroundArgs.push('--watch');
    }

    // Try to run the playground package directly, fall back to npx
    const result = spawnSync(
      'npx',
      ['@vercel/agent-eval-playground', ...playgroundArgs],
      { stdio: 'inherit', cwd: process.cwd() }
    );

    process.exit(result.status ?? 1);
  });

/**
 * Normalize an experiment argument to a bare experiment name.
 * Accepts "cc", "cc*" (glob), and path-style "experiments/cc.ts".
 */
function normalizeExperimentArg(arg: string): string {
  return basename(arg).replace(/\.(ts|js)$/, '');
}

type ExperimentPlan =
  | { ok: true; config: ResolvedExperimentConfig; fixtures: EvalFixture[]; evalNames: string[] }
  | { ok: false; reason: 'config' | 'fixtures' };

/**
 * Load an experiment config and the eval fixtures visible to it. Fixtures are
 * loaded per experiment because validation is a config field (`validation:
 * 'none'` makes EVAL.ts optional). Logs and returns `ok: false` on failure;
 * the caller decides how that affects the exit code.
 */
async function loadExperimentPlan(
  file: string,
  experimentsDir: string,
  evalsDir: string,
  smoke: boolean | undefined,
): Promise<ExperimentPlan> {
  let config: ResolvedExperimentConfig;
  try {
    config = await loadConfig(resolve(experimentsDir, file));
  } catch (err) {
    console.error(chalk.red(`Failed to load ${file}: ${err instanceof Error ? err.message : err}`));
    return { ok: false, reason: 'config' };
  }

  const { fixtures, errors } = loadAllFixtures(evalsDir, { validation: config.validation });
  if (errors.length > 0) {
    console.log(chalk.yellow(`Warning: ${errors.length} invalid fixture(s) for ${file}`));
  }
  if (fixtures.length === 0) {
    console.error(chalk.red(`No valid eval fixtures found for ${file}`));
    return { ok: false, reason: 'fixtures' };
  }

  const availableNames = fixtures.map((f) => f.name);
  let evalNames: string[];
  try {
    evalNames = resolveEvalNames(config.evals, availableNames);
  } catch {
    evalNames = availableNames;
  }

  if (smoke) {
    evalNames = [evalNames.sort()[0]];
  }

  return { ok: true, config, fixtures, evalNames };
}

/**
 * Run-all handler: discover and run all experiments with fingerprint reuse
 * and classification. Used by both `run-all` subcommand and the default
 * (no-args) invocation.
 */
async function runAllCommand(experimentArgs: string[], options: { dry?: boolean; force?: boolean; smoke?: boolean; ackFailures?: boolean }) {
    try {
      const projectDir = process.cwd();
      const experimentsDir = resolve(projectDir, 'experiments');
      const evalsDir = resolve(projectDir, 'evals');
      const resultsDir = resolve(projectDir, 'results');

      if (!existsSync(experimentsDir)) {
        console.error(chalk.red('experiments/ directory not found'));
        process.exit(1);
      }
      if (!existsSync(evalsDir)) {
        console.error(chalk.red('evals/ directory not found'));
        process.exit(1);
      }

      // Discover experiments
      const allExperimentFiles = readdirSync(experimentsDir)
        .filter((f) => f.endsWith('.ts') && !f.startsWith('_temp_'))
        .sort();

      // Filter by args if provided. Experiments named explicitly must be
      // runnable: failures to load or skips fail the exit code, where a
      // no-args sweep just runs whatever it can.
      const explicit = experimentArgs.length > 0;
      let selectedFiles: string[];
      if (explicit) {
        const wantedNames = experimentArgs.map(normalizeExperimentArg);
        selectedFiles = allExperimentFiles.filter((f) => {
          const name = f.replace(/\.ts$/, '');
          return wantedNames.some((arg) =>
            arg.includes('*') ? minimatch(name, arg) : name === arg
          );
        });
        if (selectedFiles.length === 0) {
          console.error(chalk.red(`No experiments matched: ${experimentArgs.join(', ')}`));
          console.error(chalk.gray(`Available: ${allExperimentFiles.map((f) => f.replace(/\.ts$/, '')).join(', ')}`));
          process.exit(1);
        }
      } else {
        selectedFiles = allExperimentFiles;
      }

      console.log(chalk.blue(`Discovered ${selectedFiles.length} experiment(s):`));
      for (const f of selectedFiles) {
        console.log(chalk.blue(`  - ${f.replace(/\.ts$/, '')}`));
      }

      // --- Dry run: collect info and print a single summary table ---
      if (options.dry) {
        interface DryRunInfo { name: string; toRun: string[]; cached: number; total: number }
        const dryResults: DryRunInfo[] = [];
        let hadErrors = false;

        for (const file of selectedFiles) {
          const baseExperimentName = file.replace(/\.ts$/, '');

          const plan = await loadExperimentPlan(file, experimentsDir, evalsDir, options.smoke);
          if (!plan.ok) {
            if (explicit || plan.reason === 'fixtures') hadErrors = true;
            continue;
          }
          const { config, fixtures, evalNames } = plan;

          const models = Array.isArray(config.model) ? config.model : [config.model];

          for (const model of models) {
            const experimentName = models.length > 1
              ? `${baseExperimentName}/${model}`
              : baseExperimentName;

            const modelConfig = { ...config, model, runs: options.smoke ? 1 : config.runs };
            const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));
            const fingerprints: Record<string, string> = {};
            for (const fixture of selectedFixtures) {
              fingerprints[fixture.name] = computeFingerprint(fixture.path, modelConfig);
            }

            let fixturesToRun = selectedFixtures;
            if (!options.force && !options.smoke) {
              const reusable = scanReusableResults(resultsDir, experimentName, fingerprints);
              if (reusable.size > 0) {
                fixturesToRun = selectedFixtures.filter((f) => !reusable.has(f.name));
              }
            }

            dryResults.push({
              name: experimentName,
              toRun: fixturesToRun.map((f) => f.name),
              cached: selectedFixtures.length - fixturesToRun.length,
              total: selectedFixtures.length,
            });
          }
        }

        // Print summary
        const totalToRun = dryResults.reduce((sum, d) => sum + d.toRun.length, 0);
        const totalCached = dryResults.reduce((sum, d) => sum + d.cached, 0);

        console.log('');
        if (dryResults.length === 0) {
          // Nothing loadable; errors were already printed above.
        } else if (totalToRun === 0) {
          console.log(chalk.green(`  All ${totalCached} evals cached across ${dryResults.length} experiments. Nothing to run.`));
        } else {
          const nameWidth = Math.max(...dryResults.map((d) => d.name.length)) + 2;
          console.log(chalk.bold(`  ${totalToRun} evals to run, ${totalCached} cached\n`));
          for (const d of dryResults) {
            const label = d.name.padEnd(nameWidth);
            if (d.toRun.length === 0) {
              console.log(chalk.gray(`  ${label} ${d.total} cached`));
            } else {
              console.log(
                chalk.white(`  ${label}`) +
                chalk.blue(` ${d.toRun.length} to run`) +
                (d.cached > 0 ? chalk.gray(`, ${d.cached} cached`) : '')
              );
              for (const name of d.toRun) {
                console.log(chalk.green(`  ${' '.repeat(nameWidth)} → ${name}`));
              }
            }
          }
        }
        console.log('');
        process.exit(hadErrors ? 1 : 0);
      }

      // --- Live run ---
      const useDashboard = process.stdout.isTTY && selectedFiles.length > 1;
      const dashboard = useDashboard ? new Dashboard() : null;

      if (dashboard) {
        dashboard.start();
      }

      // Warn if classifier is disabled
      if (!isClassifierEnabled()) {
        console.log(
          chalk.yellow(
            '\n⚠️  Classifier disabled: Neither AI_GATEWAY_API_KEY nor VERCEL_OIDC_TOKEN is set.\n' +
            '  The classifier automatically identifies why evals failed (model error, infrastructure issue, or timeout).\n' +
            '  Without it, all failed results are kept as-is and housekeeping will not remove non-model failures.\n' +
            '  Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN to enable classifier for cleaner result management.\n'
          )
        );
      }

      // Rate-limit sandbox starts across all experiments to avoid 429s (20 starts per 2 seconds)
      const rateLimiter = new StartRateLimiter(20, 2_000);

      let allPassed = true;
      const experimentPromises = selectedFiles.map(async (file) => {
        const baseExperimentName = file.replace(/\.ts$/, '');

        const plan = await loadExperimentPlan(file, experimentsDir, evalsDir, options.smoke);
        if (!plan.ok) {
          if (explicit || plan.reason === 'fixtures') allPassed = false;
          return;
        }
        const { config, fixtures, evalNames } = plan;

        const models = Array.isArray(config.model) ? config.model : [config.model];

        const agent = getAgent(config.agent);
        const apiKeyEnvVar = agent.getApiKeyEnvVar();
        const apiKey = process.env[apiKeyEnvVar] ?? process.env.VERCEL_OIDC_TOKEN;
        if (!apiKey) {
          console.error(chalk.red(`${apiKeyEnvVar} (or VERCEL_OIDC_TOKEN) not set, skipping ${baseExperimentName}`));
          if (explicit) allPassed = false;
          return;
        }

        for (const model of models) {
          const experimentName = models.length > 1
            ? `${baseExperimentName}/${model}`
            : baseExperimentName;

          const modelConfig = {
            ...config,
            model,
            runs: options.smoke ? 1 : config.runs,
          };

          const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));
          const fingerprints: Record<string, string> = {};
          for (const fixture of selectedFixtures) {
            fingerprints[fixture.name] = computeFingerprint(fixture.path, modelConfig);
          }

          const classifierOn = isClassifierEnabled();

          // Scan for reusable results
          let fixturesToRun = selectedFixtures;
          if (!options.force && !options.smoke) {
            const reusable = scanReusableResults(resultsDir, experimentName, fingerprints);
            if (reusable.size > 0) {
              fixturesToRun = selectedFixtures.filter((f) => !reusable.has(f.name));
            }
          }

          if (fixturesToRun.length > 0) {
            if (dashboard) {
              dashboard.addExperiment(experimentName, {
                agent: config.agent,
                model,
                totalEvals: fixturesToRun.length,
              });
            } else {
              console.log(chalk.blue(`\nRunning ${experimentName}: ${fixturesToRun.length} eval(s)`));
            }

            const onProgress: (event: ProgressEvent) => void = dashboard
              ? (event) => dashboard.handleEvent(experimentName, event)
              : createConsoleProgressHandler({ experimentName, model, agent: config.agent });

            try {
              const results = await runExperiment({
                config: modelConfig,
                fixtures: fixturesToRun,
                apiKey: apiKey!,
                resultsDir,
                experimentName,
                fingerprints,
                smoke: options.smoke,
                onProgress,
                rateLimiter,
              });

              // Classify failures (only if classifier is enabled)
              const failedEvals = results.evals.filter((e) => e.passedRuns === 0);
              const classifications = new Map<string, Classification>();

              if (classifierOn) {
                if (dashboard) {
                  dashboard.setPhase(experimentName, 'classifying');
                }

                if (failedEvals.length > 0 && !options.smoke) {
                  const timestamp = results.startedAt.replace(/:/g, '-');
                  const classifyLimit = pLimit(4);
                  let classifyingDone = 0;
                  const classifyingTotal = failedEvals.length;
                  let hasNonModelFailures = false;
                  const classifierErrors: { evalName: string; error: unknown }[] = [];

                  await Promise.all(
                    failedEvals.map((evalSummary) =>
                      classifyLimit(async () => {
                        const evalResultDir = resolve(resultsDir, experimentName, timestamp, evalSummary.name);
                        let classification: Classification | null = null;
                        try {
                          classification = await classifyFailure(
                            evalResultDir,
                            evalSummary.name,
                            experimentName
                          );
                        } catch (err) {
                          classifierErrors.push({ evalName: evalSummary.name, error: err });
                        }

                        classifyingDone++;
                        if (dashboard) {
                          dashboard.setClassifyingProgress(experimentName, classifyingDone, classifyingTotal);
                        }

                        if (classification) {
                          classifications.set(evalSummary.name, classification);

                          if (!dashboard) {
                            const icon = { model: '  ', infra: '  ', timeout: '  ' }[classification.failureType];
                            console.log(chalk.gray(`  ${icon} ${evalSummary.name}: ${classification.failureType} — ${classification.failureReason}`));
                          }

                          if (classification.failureType !== 'model') {
                            hasNonModelFailures = true;
                            if (options.ackFailures) {
                              classification.acknowledged = true;
                              const classificationPath = resolve(evalResultDir, 'classification.json');
                              writeFileSync(classificationPath, JSON.stringify(classification, null, 2));
                              if (!dashboard) {
                                console.log(chalk.yellow(`  ✓ Acknowledged ${evalSummary.name} (${classification.failureType} failure — kept as final result)`));
                              }
                            } else {
                              rmSync(evalResultDir, { recursive: true });
                              if (!dashboard) {
                                console.log(chalk.gray(`  🗑️  Removed ${evalSummary.name} (${classification.failureType} failure)`));
                              }
                            }
                          }
                        }
                      })
                    )
                  );

                  if (classifierErrors.length > 0) {
                    // Surface classifier failures loudly. Without classification.json,
                    // the cache reuse logic in scanReusableResults will force these
                    // failures to re-run on every subsequent invocation. The user
                    // needs to know exactly why classification failed (e.g. AI gateway
                    // billing, network) so they can fix the root cause.
                    console.error(
                      chalk.red(
                        `\n  ⚠️  Classifier failed for ${classifierErrors.length}/${classifyingTotal} eval(s):`
                      )
                    );
                    const seen = new Set<string>();
                    for (const { evalName, error } of classifierErrors) {
                      const msg = error instanceof Error ? error.message : String(error);
                      console.error(chalk.red(`     - ${evalName}: ${msg.split('\n')[0]}`));
                      seen.add(msg.split('\n')[0]);
                    }
                    console.error(
                      chalk.gray(
                        `     These failures have no classification.json and will re-run next invocation.`
                      )
                    );
                    if (seen.size === 1 && [...seen][0].toLowerCase().includes('insufficient funds')) {
                      console.error(
                        chalk.gray(
                          `     Top up your AI Gateway credits at https://vercel.com/dashboard → AI to fix.`
                        )
                      );
                    }
                  }

                  if (hasNonModelFailures && !options.ackFailures && !dashboard) {
                    console.log(chalk.yellow(`\n  To keep non-model failures as final results, re-run with --ack-failures`));
                  }
                }
              }

              if (dashboard) {
                dashboard.completeExperiment(experimentName, results, classifications);
              }
            } catch (err) {
              console.error(chalk.red(`  Error running ${experimentName}: ${err instanceof Error ? err.message : err}`));
              allPassed = false;
              if (dashboard) {
                dashboard.setPhase(experimentName, 'done');
              }
            }

            const stats = housekeep(resultsDir, experimentName);
            if (stats.removedDuplicates + stats.removedIncomplete + stats.removedNonModelFailures > 0) {
              console.log(
                chalk.gray(
                  `  Housekeeping: removed ${stats.removedDuplicates} duplicate(s), ${stats.removedIncomplete} incomplete, ${stats.removedNonModelFailures} non-model failure(s)`
                )
              );
            }
          }

          // Determine final pass/fail for this experiment+model
          const finalReusable = scanReusableResults(resultsDir, experimentName, fingerprints);
          const experimentPassed = selectedFixtures.every((f) => {
            const r = finalReusable.get(f.name);
            return r != null && r.passRate !== '0%';
          });
          if (!experimentPassed) allPassed = false;
        }
      });

      await Promise.all(experimentPromises);

      if (dashboard) {
        dashboard.stop();
      }

      process.exit(allPassed ? 0 : 1);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red('An unknown error occurred'));
      }
      process.exit(1);
    }
}

/**
 * run-all subcommand (explicit)
 */
program
  .command('run-all')
  .description('Discover and run all experiments with fingerprint reuse and classification')
  .argument('[experiments...]', 'Experiment names, glob patterns, or paths like "experiments/cc.ts" (default: all)')
  .option('--dry', 'Preview what would run without executing')
  .option('--force', 'Ignore fingerprints, re-run everything')
  .option('--smoke', 'Run 1 eval per experiment for sanity checking')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(runAllCommand);

/**
 * Default command - run experiments with fingerprint reuse and classification.
 *
 * Delegates to runAllCommand so the single-experiment path and the run-all path
 * share identical fingerprinting, result storage, and reuse behavior. Running a
 * single experiment is just run-all filtered to one name.
 *
 * Usage:
 *   agent-eval           # runs all experiments
 *   agent-eval cc        # runs single experiment
 *   agent-eval cc --dry  # preview single experiment
 */
program
  .argument('[config]', 'Experiment name (e.g., "cc") or path (e.g., "experiments/cc.ts"). Omit to run all experiments.')
  .option('--dry', 'Preview what would run without executing')
  .option('--smoke', 'Run a single eval to verify setup (API keys, model IDs, sandbox)')
  .option('--force', 'Ignore fingerprints, re-run everything')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(async (configInput: string | undefined, options: { dry?: boolean; smoke?: boolean; force?: boolean; ackFailures?: boolean }) => {
    await runAllCommand(configInput ? [configInput] : [], options);
  });

program.parse();
