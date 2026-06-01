import { describe, expect, it } from 'vitest';
import { extractObservedModelFromOpenCodeOutput } from './opencode.js';

describe('OpenCode observed model extraction', () => {
  it('extracts the primary build model from printed logs', () => {
    const output = [
      'INFO service=llm providerID=vercel modelID=anthropic/claude-haiku-4.5 small=true agent=title mode=primary stream',
      'INFO service=llm providerID=vercel modelID=openai/gpt-5.5 small=false agent=build mode=primary stream',
    ].join('\n');

    expect(extractObservedModelFromOpenCodeOutput(output)).toBe('vercel/openai/gpt-5.5');
  });
});
