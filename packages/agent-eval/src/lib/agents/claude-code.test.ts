import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildClaudeCodeCliArgs, createClaudeCodeAgent, extractObservedModelFromClaudeTranscript } from './claude-code.js';

describe('buildClaudeCodeCliArgs', () => {
  const baseOptions = {
    prompt: 'where should this run?',
    timeout: 60_000,
    apiKey: 'test-key',
  };

  it('builds unchanged arguments when webResearch is off', () => {
    const args = buildClaudeCodeCliArgs({ ...baseOptions, model: 'opus' });
    expect(args).toEqual([
      '--print',
      '--model',
      'opus',
      '--dangerously-skip-permissions',
      'where should this run?',
    ]);
  });

  it('allows web tools as a single comma-separated --allowedTools value', () => {
    const args = buildClaudeCodeCliArgs({ ...baseOptions, model: 'opus', webResearch: true });
    expect(args).toEqual([
      '--print',
      '--model',
      'opus',
      '--dangerously-skip-permissions',
      '--allowedTools',
      'WebSearch,WebFetch',
      'where should this run?',
    ]);
  });

  it('never passes tools as separate variadic tokens (the #141 regression)', () => {
    // --allowedTools is variadic: separate tokens make the CLI consume the
    // trailing positional prompt as another tool name, so runs execute with
    // no prompt at all.
    const args = buildClaudeCodeCliArgs({ ...baseOptions, webResearch: true });
    const allowedToolsIndex = args.indexOf('--allowedTools');
    expect(allowedToolsIndex).toBeGreaterThan(-1);
    expect(args[allowedToolsIndex + 1]).toBe('WebSearch,WebFetch');
    expect(args[args.length - 1]).toBe(baseOptions.prompt);
  });

  it('keeps the prompt as the final argument with effort set', () => {
    const args = buildClaudeCodeCliArgs({
      ...baseOptions,
      webResearch: true,
      agentOptions: { effort: 'high' },
    });
    expect(args[args.length - 1]).toBe(baseOptions.prompt);
    expect(args).toContain('--effort');
  });
});

describe('createClaudeCodeAgent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getApiKeyEnvVar', () => {
    it('returns AI_GATEWAY_API_KEY when using Vercel AI Gateway', () => {
      const agent = createClaudeCodeAgent({ useVercelAiGateway: true });
      expect(agent.getApiKeyEnvVar()).toBe('AI_GATEWAY_API_KEY');
    });

    it('returns CLAUDE_CODE_OAUTH_TOKEN when OAuth token is set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
      const agent = createClaudeCodeAgent({ useVercelAiGateway: false });
      expect(agent.getApiKeyEnvVar()).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('returns ANTHROPIC_API_KEY when no OAuth token is set', () => {
      const agent = createClaudeCodeAgent({ useVercelAiGateway: false });
      expect(agent.getApiKeyEnvVar()).toBe('ANTHROPIC_API_KEY');
    });

    it('prefers AI Gateway over OAuth token when both could apply', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
      const agent = createClaudeCodeAgent({ useVercelAiGateway: true });
      expect(agent.getApiKeyEnvVar()).toBe('AI_GATEWAY_API_KEY');
    });
  });

  describe('observed model extraction', () => {
    it('extracts the last assistant model from the transcript', () => {
      const transcript = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-7' } }),
      ].join('\n');

      expect(extractObservedModelFromClaudeTranscript(transcript)).toBe('claude-opus-4-7');
    });
  });
});
