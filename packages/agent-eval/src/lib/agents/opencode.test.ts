import { describe, expect, it } from 'vitest';
import { generateOpenCodeConfig } from './opencode.js';

describe('generateOpenCodeConfig', () => {
  it('allows web fetch and web search tools for source collection', () => {
    const config = JSON.parse(generateOpenCodeConfig(undefined, 'test-key'));

    expect(config.permission.webfetch).toBe('allow');
    expect(config.permission.websearch).toBe('allow');
  });
});
