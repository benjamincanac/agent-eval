import { describe, expect, it } from 'vitest';
import { extractCodexThreadId, extractObservedModelFromCodexSession, generateCodexConfig } from './codex.js';

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

  it('omits model and reasoning overrides for native-default AI Gateway runs', () => {
    const config = generateCodexConfig(undefined, true);

    expect(config).toContain('model_provider = "vercel"');
    expect(config).not.toMatch(/^model =/m);
    expect(config).not.toContain('model_reasoning_effort');
    expect(config).not.toContain('model_verbosity');
  });

  it('omits model and reasoning overrides for native-default direct OpenAI runs', () => {
    const config = generateCodexConfig(undefined, false);

    expect(config).toContain('model_provider = "openai"');
    expect(config).not.toMatch(/^model =/m);
    expect(config).not.toContain('model_reasoning_effort');
    expect(config).not.toContain('model_verbosity');
  });

  it('omits the tools section by default', () => {
    expect(generateCodexConfig(undefined, true)).not.toContain('[tools]');
    expect(generateCodexConfig(undefined, false)).not.toContain('[tools]');
  });

  it('enables web_search when webResearch is set', () => {
    const gatewayConfig = generateCodexConfig(undefined, true, undefined, true);
    expect(gatewayConfig).toContain('[tools]');
    expect(gatewayConfig).toContain('web_search = true');
    // The tools table must come after the provider table's keys so the
    // provider settings are not absorbed into [tools].
    expect(gatewayConfig.indexOf('[tools]')).toBeGreaterThan(gatewayConfig.indexOf('wire_api'));

    const directConfig = generateCodexConfig(undefined, false, undefined, true);
    expect(directConfig).toContain('[tools]');
    expect(directConfig).toContain('web_search = true');
  });
});

describe('Codex observed model extraction', () => {
  it('extracts the thread id from Codex JSON output', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      JSON.stringify({ type: 'turn.started' }),
    ].join('\n');

    expect(extractCodexThreadId(output)).toBe('thread-123');
  });

  it('extracts the observed model from the Codex session transcript', () => {
    const transcript = [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'vercel' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    ].join('\n');

    expect(extractObservedModelFromCodexSession(transcript)).toBe('gpt-5.5');
  });
});
