import { describe, expect, it } from 'vitest';
import { buildCodexExecCommand, generateCodexConfig } from './codex.js';

describe('generateCodexConfig', () => {
  it('writes AI Gateway settings as a Codex profile config', () => {
    const config = generateCodexConfig('openai/gpt-5.2-codex', true);

    expect(config).toContain('model_provider = "vercel"');
    expect(config).toContain('model = "openai/gpt-5.2-codex"');
    expect(config).toContain('[model_providers.vercel]');
    expect(config).toContain('wire_api = "responses"');
    expect(config).not.toContain('profile = "default"');
    expect(config).not.toContain('[profiles.default]');
  });

  it('writes direct OpenAI settings as a Codex profile config', () => {
    const config = generateCodexConfig('openai/gpt-5.2-codex', false);

    expect(config).toContain('model_provider = "openai"');
    expect(config).toContain('model = "gpt-5.2-codex"');
    expect(config).not.toContain('profile = "default"');
    expect(config).not.toContain('[profiles.default]');
  });

  it('enables web search in non-interactive runs', () => {
    const command = buildCodexExecCommand({
      apiKey: 'test-key',
      cliModel: 'openai/gpt-5.2-codex',
      prompt: 'where should this run?',
    });

    expect(command).toContain('codex exec --search --profile default');
    expect(command).toContain('model_reasoning_effort="medium"');
    expect(command).toContain('model_verbosity="medium"');
  });

  it('defaults model_reasoning_effort and verbosity to "medium" for AI Gateway', () => {
    // gpt-5.2-codex rejects the Codex CLI's "low" defaults for both
    // reasoning.effort and text.verbosity — see comment on
    // DEFAULT_REASONING_EFFORT / DEFAULT_MODEL_VERBOSITY in codex.ts.
    const config = generateCodexConfig('openai/gpt-5.2-codex', true);

    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('model_verbosity = "medium"');
    expect(config).not.toContain('model_reasoning_effort = "low"');
    expect(config).not.toContain('model_verbosity = "low"');
  });

  it('defaults model_reasoning_effort and verbosity to "medium" for direct OpenAI', () => {
    const config = generateCodexConfig('openai/gpt-5.2-codex', false);

    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('model_verbosity = "medium"');
    expect(config).not.toContain('model_reasoning_effort = "low"');
    expect(config).not.toContain('model_verbosity = "low"');
  });

  it('honors caller-provided reasoning effort for AI Gateway', () => {
    const config = generateCodexConfig('openai/gpt-5.2-codex', true, 'high');

    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config).not.toContain('model_reasoning_effort = "medium"');
  });

  it('honors caller-provided reasoning effort for direct OpenAI', () => {
    const config = generateCodexConfig('openai/gpt-5.2-codex', false, 'low');

    expect(config).toContain('model_reasoning_effort = "low"');
    expect(config).not.toContain('model_reasoning_effort = "medium"');
  });
});
