import { describe, it, expect } from 'vitest';
import { shouldRetry } from './classifier.js';
import type { Classification } from './types.js';

describe('shouldRetry', () => {
  it('returns true when all failures are infra', () => {
    const classifications: Classification[] = [
      { failureType: 'infra', failureReason: 'Rate limited' },
      { failureType: 'timeout', failureReason: 'Timed out' },
    ];
    expect(shouldRetry(classifications)).toBe(true);
  });

  it('returns false when any failure is model', () => {
    const classifications: Classification[] = [
      { failureType: 'model', failureReason: 'Wrong code' },
      { failureType: 'infra', failureReason: 'Rate limited' },
    ];
    expect(shouldRetry(classifications)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(shouldRetry([])).toBe(false);
  });
});
