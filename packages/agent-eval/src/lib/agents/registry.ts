/**
 * Agent registry for managing available agents.
 */

import type { Agent } from './types.js';
import type { AgentType } from '../types.js';

const agents = new Map<string, Agent>();
const aliases = new Map<string, string>();

/**
 * Register an agent in the registry.
 */
export function registerAgent(agent: Agent): void {
  agents.set(agent.name, agent);
}

export function registerAgentAlias(alias: string, target: string): void {
  aliases.set(alias, target);
}

/**
 * Get an agent by name.
 * @throws Error if agent is not found
 */
export function getAgent(name: AgentType | string): Agent {
  const resolvedName = aliases.get(name) ?? name;
  const agent = agents.get(resolvedName);
  if (!agent) {
    const available = listAgents().join(', ');
    throw new Error(`Unknown agent: ${name}. Available agents: ${available}`);
  }
  return agent;
}

/**
 * List all registered agents.
 */
export function listAgents(): string[] {
  return [...Array.from(agents.keys()), ...Array.from(aliases.keys())];
}

/**
 * Check if an agent is registered.
 */
export function hasAgent(name: string): boolean {
  return agents.has(name) || aliases.has(name);
}
