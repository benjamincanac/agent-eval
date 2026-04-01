/**
 * Parser for Mistral Vibe CLI transcript format.
 * When run with --output streaming, Vibe outputs newline-delimited JSON per event.
 *
 * Event types (from Vibe's Pydantic event system):
 * - UserMessageEvent: { type: "user_message", content, message_id }
 * - AssistantEvent: { type: "assistant", content, message_id }
 * - ReasoningEvent: { type: "reasoning", content, message_id }
 * - ToolCallEvent: { type: "tool_call", tool_name, args, tool_call_id }
 * - ToolResultEvent: { type: "tool_result", tool_name, result, error, duration, tool_call_id }
 * - ToolStreamEvent: { type: "tool_stream", tool_name, message, tool_call_id }
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Vibe tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    // Vibe built-in tools
    read_file: 'file_read',
    write_file: 'file_write',
    search_replace: 'file_edit',
    bash: 'shell',
    grep: 'grep',
    todo: 'agent_task',
    task: 'agent_task',

    // Common aliases
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    shell: 'shell',
    exec: 'shell',
    glob: 'glob',
    find: 'glob',
    ls: 'list_dir',
    list_dir: 'list_dir',
    web_fetch: 'web_fetch',
    fetch: 'web_fetch',
    web_search: 'web_search',
    search: 'web_search',
  };

  return toolMap[name.toLowerCase()] || 'unknown';
}

/**
 * Extract file path from tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.file_path || args.filePath || args.file || args.filename) as
    | string
    | undefined;
}

/**
 * Extract command from tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return undefined;
}

/**
 * Extract URL from tool arguments.
 */
function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri || args.href) as string | undefined;
}

/**
 * Parse a single JSONL line from a Vibe streaming transcript.
 */
function parseVibeLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);
    const eventType = data.type;

    switch (eventType) {
      case 'user_message': {
        if (data.content) {
          events.push({
            timestamp: data.timestamp,
            type: 'message',
            role: 'user',
            content: data.content,
            raw: data,
          });
        }
        break;
      }

      case 'assistant': {
        if (data.content) {
          events.push({
            timestamp: data.timestamp,
            type: 'message',
            role: 'assistant',
            content: data.content,
            raw: data,
          });
        }
        break;
      }

      case 'reasoning': {
        if (data.content) {
          events.push({
            timestamp: data.timestamp,
            type: 'thinking',
            content: data.content,
            raw: data,
          });
        }
        break;
      }

      case 'tool_call': {
        const name = data.tool_name;
        const args = (typeof data.args === 'object' && data.args !== null)
          ? data.args
          : {};

        if (name) {
          events.push({
            timestamp: data.timestamp,
            type: 'tool_call',
            tool: {
              name: normalizeToolName(name),
              originalName: name,
              args,
            },
            raw: data,
          });
        }
        break;
      }

      case 'tool_result': {
        const name = data.tool_name || 'unknown';
        const hasError = !!data.error;

        events.push({
          timestamp: data.timestamp,
          type: 'tool_result',
          tool: {
            name: normalizeToolName(name),
            originalName: name,
            result: data.result ?? data.output,
            success: !hasError && !data.skipped,
          },
          raw: data,
        });
        break;
      }

      case 'tool_stream': {
        // Streaming tool output — skip for summary purposes
        break;
      }

      case 'error': {
        events.push({
          timestamp: data.timestamp,
          type: 'error',
          content: data.error?.message || data.message || data.content,
          raw: data,
        });
        break;
      }

      default: {
        // Handle LLMMessage-style events (from --output json format)
        if (data.role === 'assistant' && data.content) {
          events.push({
            timestamp: data.timestamp,
            type: 'message',
            role: 'assistant',
            content: data.content,
            raw: data,
          });

          // Extract tool calls embedded in the message
          if (Array.isArray(data.tool_calls)) {
            for (const call of data.tool_calls) {
              const fnName = call.function?.name || call.name;
              const fnArgs = call.function?.arguments
                ? typeof call.function.arguments === 'string'
                  ? JSON.parse(call.function.arguments)
                  : call.function.arguments
                : call.arguments || call.args || {};

              if (fnName) {
                events.push({
                  timestamp: data.timestamp,
                  type: 'tool_call',
                  tool: {
                    name: normalizeToolName(fnName),
                    originalName: fnName,
                    args: fnArgs,
                  },
                  raw: call,
                });
              }
            }
          }
        } else if (data.role === 'user' && data.content) {
          events.push({
            timestamp: data.timestamp,
            type: 'message',
            role: 'user',
            content: data.content,
            raw: data,
          });
        } else if (data.role === 'tool') {
          events.push({
            timestamp: data.timestamp,
            type: 'tool_result',
            tool: {
              name: data.name ? normalizeToolName(data.name) : 'unknown',
              originalName: data.name || 'unknown',
              result: data.content,
              success: !data.error,
            },
            raw: data,
          });
        }
      }
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Parse Mistral Vibe JSONL transcript into normalized events.
 */
export function parseMistralVibeTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseVibeLine(line);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process: extract metadata into tool args
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool) {
      const args = event.tool.args || {};

      if (['file_read', 'file_write', 'file_edit'].includes(event.tool.name)) {
        const path = extractFilePath(args);
        if (path) {
          event.tool.args = { ...args, _extractedPath: path };
        }
      }

      if (event.tool.name === 'web_fetch') {
        const url = extractUrl(args);
        if (url) {
          event.tool.args = { ...args, _extractedUrl: url };
        }
      }

      if (event.tool.name === 'shell') {
        const command = extractCommand(args);
        if (command) {
          event.tool.args = { ...args, _extractedCommand: command };
        }
      }
    }
  }

  return { events, errors };
}
