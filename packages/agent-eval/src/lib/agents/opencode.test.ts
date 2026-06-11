import { describe, expect, it } from 'vitest';
import {
  extractObservedModelFromOpenCodeOutput,
  extractObservedModelFromSessionExport,
  extractSessionIdFromTranscript,
} from './opencode.js';

describe('OpenCode observed model extraction', () => {
  it('extracts the primary build model from printed logs', () => {
    const output = [
      'INFO service=llm providerID=vercel modelID=anthropic/claude-haiku-4.5 small=true agent=title mode=primary stream',
      'INFO service=llm providerID=vercel modelID=openai/gpt-5.5 small=false agent=build mode=primary stream',
    ].join('\n');

    expect(extractObservedModelFromOpenCodeOutput(output)).toBe('vercel/openai/gpt-5.5');
  });

  it('returns undefined when no matching log lines exist (OpenCode >= 1.17.0 format)', () => {
    const output = [
      'timestamp=2026-06-10T05:40:00.000Z level=INFO run=abc123 message=resolved provider=vercel model=openai/gpt-5.5',
      '{"type":"text","timestamp":1781000000000,"sessionID":"ses_123","part":{"type":"text","text":"hi"}}',
    ].join('\n');

    expect(extractObservedModelFromOpenCodeOutput(output)).toBeUndefined();
  });
});

describe('OpenCode session id extraction', () => {
  it('extracts the session id from JSON transcript events', () => {
    const transcript = [
      '{"type":"step_start","timestamp":1781000000000,"sessionID":"ses_abc123","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":1781000001000,"sessionID":"ses_abc123","part":{"type":"text","text":"done"}}',
    ].join('\n');

    expect(extractSessionIdFromTranscript(transcript)).toBe('ses_abc123');
  });

  it('skips malformed lines and returns undefined when no session id is present', () => {
    expect(extractSessionIdFromTranscript('not json\n{"type":"text"}')).toBeUndefined();
    expect(extractSessionIdFromTranscript(undefined)).toBeUndefined();
    expect(extractSessionIdFromTranscript('')).toBeUndefined();
  });
});

describe('OpenCode session export model extraction', () => {
  it('extracts providerID/modelID from the first assistant message', () => {
    const exportOutput = JSON.stringify({
      info: { id: 'ses_abc123', title: 'Test session' },
      messages: [
        { info: { id: 'msg_1', role: 'user' }, parts: [] },
        {
          info: {
            id: 'msg_2',
            role: 'assistant',
            providerID: 'vercel',
            modelID: 'google/gemini-3-pro-preview',
          },
          parts: [],
        },
      ],
    });

    expect(extractObservedModelFromSessionExport(exportOutput)).toBe(
      'vercel/google/gemini-3-pro-preview'
    );
  });

  it('tolerates non-JSON prefix lines before the JSON document', () => {
    const exportOutput = [
      'Exporting session: ses_abc123',
      JSON.stringify({
        messages: [
          { info: { role: 'assistant', providerID: 'vercel', modelID: 'openai/gpt-5.5' }, parts: [] },
        ],
      }),
    ].join('\n');

    expect(extractObservedModelFromSessionExport(exportOutput)).toBe('vercel/openai/gpt-5.5');
  });

  it('returns undefined for malformed or incomplete exports', () => {
    expect(extractObservedModelFromSessionExport('')).toBeUndefined();
    expect(extractObservedModelFromSessionExport('not json')).toBeUndefined();
    expect(extractObservedModelFromSessionExport('{"messages":"nope"}')).toBeUndefined();
    expect(
      extractObservedModelFromSessionExport(
        JSON.stringify({ messages: [{ info: { role: 'assistant', providerID: 'vercel' } }] })
      )
    ).toBeUndefined();
    expect(
      extractObservedModelFromSessionExport(JSON.stringify({ messages: [{ info: { role: 'user' } }] }))
    ).toBeUndefined();
  });
});
