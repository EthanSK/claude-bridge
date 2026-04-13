/**
 * Message inbox/outbox management for agent-bridge.
 *
 * Messages are JSON files stored in ~/.agent-bridge/inbox/ (incoming)
 * and delivered to remote machines' inboxes via SSH.
 */

import { randomUUID } from 'crypto';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import { INBOX_DIR, OUTBOX_DIR, type MachineConfig } from './config.js';
import { sshWriteFile } from './ssh.js';
import { logInfo, logError, logDebug } from './logger.js';

export interface BridgeMessage {
  id: string;
  from: string;
  to: string;
  type: 'message' | 'command' | 'agent_prompt' | 'response';
  content: string;
  timestamp: string;
  replyTo: string | null;
}

/**
 * Ensure inbox/outbox directories exist.
 */
export function ensureInboxDirs(): void {
  for (const dir of [INBOX_DIR, OUTBOX_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Create a new message object.
 */
export function createMessage(
  from: string,
  to: string,
  type: BridgeMessage['type'],
  content: string,
  replyTo: string | null = null
): BridgeMessage {
  return {
    id: `msg-${randomUUID()}`,
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
    replyTo,
  };
}

/**
 * Send a message to a remote machine by writing it to their inbox via SSH.
 */
export async function sendMessage(
  machine: MachineConfig,
  message: BridgeMessage
): Promise<void> {
  const remotePath = `~/.agent-bridge/inbox/${message.id}.json`;
  const content = JSON.stringify(message, null, 2);

  logInfo(`Sending message ${message.id} to ${machine.name}: ${message.type}`);

  const result = await sshWriteFile(machine, remotePath, content);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to deliver message to ${machine.name}: ${result.stderr}`
    );
  }

  // Save a copy in the local outbox for tracking
  const outboxPath = join(OUTBOX_DIR, `${message.id}.json`);
  writeFileSync(outboxPath, content, { mode: 0o600 });

  logInfo(`Message ${message.id} delivered to ${machine.name}`);
}

/**
 * Read all messages from the local inbox.
 * Returns messages sorted by timestamp (oldest first).
 */
export function readInbox(): BridgeMessage[] {
  ensureInboxDirs();
  const messages: BridgeMessage[] = [];

  let files: string[];
  try {
    files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(INBOX_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const msg = JSON.parse(raw) as BridgeMessage;
      messages.push(msg);
    } catch (err) {
      logError(`Failed to parse inbox message ${file}: ${err}`);
    }
  }

  // Sort by timestamp, oldest first
  messages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return messages;
}

/**
 * Read and remove all messages from the local inbox (consume them).
 */
export function consumeInbox(): BridgeMessage[] {
  const messages = readInbox();

  // Remove consumed messages
  for (const msg of messages) {
    const filePath = join(INBOX_DIR, `${msg.id}.json`);
    try {
      unlinkSync(filePath);
      logDebug(`Consumed message ${msg.id} from inbox`);
    } catch {
      // File might have been removed already
    }
  }

  return messages;
}

/**
 * Peek at inbox without consuming (for polling/status checks).
 */
export function peekInbox(): { count: number; messages: BridgeMessage[] } {
  const messages = readInbox();
  return { count: messages.length, messages };
}

/**
 * Clear all messages from the inbox.
 */
export function clearInbox(): number {
  ensureInboxDirs();
  let count = 0;
  try {
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      unlinkSync(join(INBOX_DIR, file));
      count++;
    }
  } catch {
    // Directory might not exist
  }
  return count;
}
