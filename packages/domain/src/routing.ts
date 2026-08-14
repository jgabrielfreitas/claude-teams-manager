import type { Agent, AgentMessage } from './entities.js';
import { USER_PARTICIPANT } from './entities.js';
import { DomainError } from './errors.js';

/**
 * Rules that decide whether one agent may talk to another, and the loop
 * guards that keep agent-to-agent conversation from running away.
 * See ADR-003.
 */

export interface RoutingLimits {
  /** Maximum number of agent-to-agent hops a message chain may take. */
  maxHops: number;
  /** Maximum depth of nested synchronous asks. */
  maxRecursionDepth: number;
  /** Maximum messages a single run may produce. */
  maxMessagesPerRun: number;
}

export const DEFAULT_ROUTING_LIMITS: RoutingLimits = {
  maxHops: 8,
  maxRecursionDepth: 4,
  maxMessagesPerRun: 500,
};

export function canMessage(sender: Agent, recipientHandle: string): boolean {
  if (recipientHandle === USER_PARTICIPANT) return true;
  if (sender.handle === recipientHandle) return false;
  if (sender.canMessage.includes('*')) return true;
  return sender.canMessage.includes(recipientHandle);
}

export interface RouteCheckInput {
  sender: Agent;
  recipients: Agent[];
  hop: number;
  path: string[];
  messagesInRun: number;
  limits: RoutingLimits;
  /** Set when this send is a nested synchronous ask. */
  depth?: number;
}

export type RouteRejection =
  | { code: 'permission_denied'; recipient: string; reason: string }
  | { code: 'hop_limit_exceeded'; reason: string }
  | { code: 'cycle_detected'; recipient: string; reason: string }
  | { code: 'message_limit'; reason: string }
  | { code: 'recursion_limit'; reason: string };

/**
 * Validates a delivery attempt. Returns the recipients that may be delivered to
 * plus every rejection, so the caller can partially deliver and still report
 * precisely why a recipient was skipped.
 */
export function checkRoute(input: RouteCheckInput): {
  allowed: Agent[];
  rejections: RouteRejection[];
} {
  const rejections: RouteRejection[] = [];

  if (input.messagesInRun >= input.limits.maxMessagesPerRun) {
    return {
      allowed: [],
      rejections: [
        {
          code: 'message_limit',
          reason: `Run reached its message limit of ${input.limits.maxMessagesPerRun}`,
        },
      ],
    };
  }

  if (input.hop >= input.limits.maxHops) {
    return {
      allowed: [],
      rejections: [
        {
          code: 'hop_limit_exceeded',
          reason: `Message chain exceeded ${input.limits.maxHops} agent-to-agent hops`,
        },
      ],
    };
  }

  if ((input.depth ?? 0) >= input.limits.maxRecursionDepth) {
    return {
      allowed: [],
      rejections: [
        {
          code: 'recursion_limit',
          reason: `Synchronous ask nested deeper than ${input.limits.maxRecursionDepth} levels`,
        },
      ],
    };
  }

  const allowed: Agent[] = [];
  for (const recipient of input.recipients) {
    if (!canMessage(input.sender, recipient.handle)) {
      rejections.push({
        code: 'permission_denied',
        recipient: recipient.handle,
        reason: `${input.sender.handle} is not allowed to message ${recipient.handle}`,
      });
      continue;
    }
    // A synchronous chain that returns to an agent already waiting upstream
    // would deadlock: A asks B, B asks A, both blocked. Refuse it.
    if ((input.depth ?? 0) > 0 && input.path.includes(recipient.id)) {
      rejections.push({
        code: 'cycle_detected',
        recipient: recipient.handle,
        reason: `${recipient.handle} is already waiting earlier in this chain`,
      });
      continue;
    }
    allowed.push(recipient);
  }

  return { allowed, rejections };
}

export function rejectionToError(rejection: RouteRejection): DomainError {
  switch (rejection.code) {
    case 'permission_denied':
      return new DomainError('permission_denied', rejection.reason, { recipient: rejection.recipient });
    case 'hop_limit_exceeded':
      return new DomainError('hop_limit_exceeded', rejection.reason);
    case 'cycle_detected':
      return new DomainError('cycle_detected', rejection.reason, { recipient: rejection.recipient });
    case 'message_limit':
      return new DomainError('budget_exceeded', rejection.reason);
    case 'recursion_limit':
      return new DomainError('hop_limit_exceeded', rejection.reason);
  }
}

/** Everyone an agent is currently allowed to talk to, resolved to agents. */
export function reachableAgents(sender: Agent, team: Agent[]): Agent[] {
  return team.filter((a) => a.id !== sender.id && canMessage(sender, a.handle));
}

/** Inbox view: messages addressed to an agent, newest last. */
export function inboxFor(agentId: string, messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => m.to.includes(agentId)).sort((a, b) => a.seq - b.seq);
}

export function unreadCount(agentId: string, messages: AgentMessage[]): number {
  return inboxFor(agentId, messages).filter((m) => m.status === 'pending').length;
}
