import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClaudeCodeAgent, extractObservedModelFromClaudeTranscript } from './claude-code.js';

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
