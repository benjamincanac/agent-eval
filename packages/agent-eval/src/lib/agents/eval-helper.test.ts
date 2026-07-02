import { describe, it, expect } from 'vitest';
// Importing the helper registers the judge matchers on `expect` as a side effect
// (harmless here); we only exercise the pure exports.
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  transcriptPath,
  environment,
  transcript,
} from './eval-helper.mjs';

describe('buildJudgePrompt', () => {
  it('environment variant: explores cwd, embeds criterion + verdict path + contract', () => {
    const p = buildJudgePrompt('environment', 'uses Server Components', '__agent_eval__/judge/1-verdict.json');
    expect(p).toContain('Inspect the project in the current directory');
    expect(p).not.toContain('__agent_eval__/transcript.txt');
    expect(p).toContain('Criterion: uses Server Components');
    expect(p).toContain('__agent_eval__/judge/1-verdict.json');
    expect(p).toContain('"pass": true|false');
    expect(p).not.toContain('"score"'); // non-numeric by default
  });

  it('transcript variant: points at the materialized transcript, not cwd exploration', () => {
    const p = buildJudgePrompt('transcript', 'used DevTools', '__agent_eval__/judge/2-verdict.json');
    expect(p).toContain('__agent_eval__/transcript.txt');
    expect(p).not.toContain('Inspect the project in the current directory');
    expect(p).toContain('Criterion: used DevTools');
  });

  it('numeric mode asks for a score and includes it in the contract', () => {
    const p = buildJudgePrompt('environment', 'code quality', 'v.json', { numeric: true });
    expect(p).toContain('score from 0 to 1');
    expect(p).toContain('"score": <0-1>');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a clean verdict object', () => {
    expect(parseJudgeVerdict('{"pass":true,"reason":"ok"}')).toEqual({
      pass: true,
      score: undefined,
      reason: 'ok',
    });
  });

  it('tolerates prose and ```json fences around the object', () => {
    const raw = 'Here:\n```json\n{"pass":false,"reason":"nope"}\n```\ndone';
    expect(parseJudgeVerdict(raw)).toEqual({ pass: false, score: undefined, reason: 'nope' });
  });

  it('keeps a numeric score', () => {
    expect(parseJudgeVerdict('{"pass":true,"score":0.7,"reason":"good"}')).toEqual({
      pass: true,
      score: 0.7,
      reason: 'good',
    });
  });

  it('coerces a truthy non-boolean pass and a missing reason', () => {
    const v = parseJudgeVerdict('{"pass":"yes"}');
    expect(v?.pass).toBe(true);
    expect(v?.reason).toBe('');
  });

  it('returns null when nothing parseable is present', () => {
    expect(parseJudgeVerdict('no json here')).toBeNull();
    expect(parseJudgeVerdict(undefined)).toBeNull();
    expect(parseJudgeVerdict('{ broken "pass": true ')).toBeNull();
  });
});

describe('subjects', () => {
  it('environment and transcript are distinct judge sentinels', () => {
    expect(environment).toEqual({ __judgeSubject: 'environment' });
    expect(transcript).toEqual({ __judgeSubject: 'transcript' });
  });

  it('transcriptPath() returns the canonical materialized path', () => {
    expect(transcriptPath()).toBe('__agent_eval__/transcript.txt');
  });
});
