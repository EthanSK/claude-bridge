#!/usr/bin/env node
/**
 * agent-bridge MCP server — channel plugin for real-time bidirectional
 * communication between running AI agent sessions across machines via SSH.
 *
 * This is the v2 component of agent-bridge. It runs as an MCP server /
 * channel plugin that Claude Code (or any MCP-compatible client) connects
 * to, exposing tools for cross-machine messaging and remote command execution.
 *
 * Channel capability: When new messages arrive in the local inbox, they are
 * PUSHED into the running Claude session via `notifications/claude/channel`
 * — no polling required. Messages appear as:
 *   <channel source="agent-bridge" from="MachineName" ...>content</channel>
 *
 * Design philosophy: enable EXISTING running agent sessions to communicate
 * with each other, NOT spawn new agent processes. Machine A's Claude sends
 * a message to Machine B's inbox, and Machine B's already-running Claude
 * receives it automatically via the channel.
 *
 * Communication protocol:
 * - Messages are JSON files written to ~/.agent-bridge/inbox/ on the target
 * - SSH is used for delivery (reusing v1 key pairs from ~/.agent-bridge/keys/)
 * - A file watcher detects incoming messages and pushes them via channel notifications
 *
 * IMPORTANT: Never use console.log() — stdout is the JSON-RPC transport.
 * Use console.error() or the logger module for diagnostics.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDirectories, getLocalMachineName } from './config.js';
import { initInbox, shutdownInbox } from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { registerTools } from './tools.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { logInfo, logError } from './logger.js';

// Global error handlers — keep the server alive
process.on('unhandledRejection', (err) => {
  logError(`Unhandled rejection: ${err}`);
});
process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err}`);
});

async function main(): Promise<void> {
  // Ensure all directories exist
  ensureDirectories();

  // Initialize the inbox system (dirs, processed IDs, cache, prune timer)
  initInbox();

  const localName = getLocalMachineName();
  logInfo(`agent-bridge MCP server starting on "${localName}"`);

  // Create MCP server with channel capability
  const server = new McpServer(
    {
      name: 'agent-bridge',
      version: '2.1.0',
    },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
      instructions: [
        `You are connected to the agent-bridge channel plugin on machine "${localName}".`,
        'This server enables real-time communication between RUNNING AI agent sessions on different machines.',
        'It does NOT spawn new agent processes — it connects existing, already-running sessions.',
        '',
        'CHANNEL MODE (push-based):',
        'Incoming messages from other machines are PUSHED into this conversation automatically.',
        'They appear as: <channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>',
        'You do NOT need to poll — messages arrive in real time when the remote agent sends them.',
        'Respond using the bridge_send_message tool, passing the sender\'s machine name.',
        '',
        'Available tools:',
        '- bridge_list_machines: List paired machines and their connection details',
        '- bridge_status: Check if a machine is reachable via SSH',
        '- bridge_send_message: Send a message to a running agent on another machine',
        '- bridge_receive_messages: Manually check for messages (usually not needed — channel pushes them)',
        '- bridge_run_command: Run a shell command on a remote machine',
        '- bridge_clear_inbox: Clear all messages from the local inbox',
        '- bridge_inbox_stats: Get inbox statistics and watcher health',
        '',
        'Communication flow:',
        '1. Machine A\'s Claude calls bridge_send_message to deliver a message to Machine B via SSH',
        '2. Machine B\'s file watcher detects the new message file',
        '3. Machine B\'s channel plugin pushes the message into the running Claude session',
        '4. Machine B\'s Claude sees it and responds via bridge_send_message back to Machine A',
        '',
        'All communication is authenticated via SSH keys (managed in ~/.agent-bridge/keys/).',
        'Messages have a TTL (default 1 hour). Expired messages are auto-pruned.',
        'Machines are paired using the `agent-bridge pair` CLI command.',
      ].join('\n'),
    },
  );

  // Register all tools
  registerTools(server);

  // Start the inbox file watcher with channel notification callback.
  // When new messages arrive, we push them into Claude's conversation
  // via the MCP channel notification protocol.
  await startWatcher(
    (newFiles) => {
      logInfo(`New messages detected: ${newFiles.length} file(s)`);
    },
    (message: BridgeMessage) => {
      // Push the message into the running Claude session via channel notification.
      // This makes it appear as <channel source="agent-bridge" ...>content</channel>
      // in Claude's conversation — no polling needed.
      logInfo(`Pushing channel notification for message ${message.id} from ${message.from}`);

      server.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: message.content,
          meta: {
            from: message.from,
            to: message.to,
            message_id: message.id,
            type: message.type,
            ts: message.timestamp,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            ...(message.ttl !== undefined ? { ttl: String(message.ttl) } : {}),
            authenticated: 'ssh-key',
          },
        },
      }).catch((err) => {
        logError(`Failed to push channel notification for ${message.id}: ${err}`);
      });
    },
  );

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logInfo('agent-bridge MCP server connected and ready (channel mode)');

  // Clean shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    logInfo('Shutting down agent-bridge MCP server...');

    // 1. Stop the file watcher (kills fswatch/inotifywait/polling)
    stopWatcher();

    // 2. Stop the prune timer and inbox system
    shutdownInbox();

    // 3. Close the MCP server
    try {
      await server.close();
    } catch (err) {
      logError(`Error closing MCP server: ${err}`);
    }

    logInfo('agent-bridge MCP server shut down cleanly');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // When stdin closes (Claude Code disconnected), shut down
  process.stdin.on('end', () => {
    logInfo('stdin closed, shutting down');
    shutdown();
  });
}

main().catch((err) => {
  logError(`Fatal error: ${err}`);
  process.exit(1);
});
