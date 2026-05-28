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
  });
});
