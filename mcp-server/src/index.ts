#!/usr/bin/env node
/**
 * agent-bridge MCP server — real-time bidirectional communication
 * between running AI agent sessions across machines via SSH.
 *
 * This is the v2 component of agent-bridge. It runs as an MCP server
 * that Claude Code (or any MCP-compatible client) connects to, exposing
 * tools for cross-machine messaging, remote command execution, and
 * agent prompt delegation.
 *
 * Communication protocol:
 * - Messages are JSON files written to ~/.agent-bridge/inbox/ on the target
 * - SSH is used for delivery (reusing v1 key pairs from ~/.agent-bridge/keys/)
 * - A file watcher detects incoming messages and makes them available via tools
 *
 * IMPORTANT: Never use console.log() — stdout is the JSON-RPC transport.
 * Use console.error() or the logger module for diagnostics.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDirectories, getLocalMachineName } from './config.js';
import { initInbox, shutdownInbox } from './inbox.js';
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

  // Create MCP server
  const server = new McpServer(
    {
      name: 'agent-bridge',
      version: '2.0.0',
    },
    {
      instructions: [
        `You are connected to the agent-bridge MCP server on machine "${localName}".`,
        'This server enables real-time communication between AI agent sessions running on different machines.',
        '',
        'Available capabilities:',
        '- List and check status of paired machines',
        '- Send messages to agents on other machines',
        '- Receive messages from other machines',
        '- Run shell commands on remote machines',
        '- Run AI agent prompts on remote machines',
        '- Check inbox statistics and watcher health',
        '',
        'Messages are delivered via SSH and stored in the inbox (~/.agent-bridge/inbox/).',
        'Use bridge_receive_messages periodically to check for incoming messages.',
        'Use bridge_inbox_stats to check inbox health and watcher status.',
        '',
        'Messages have a TTL (default 1 hour). Expired messages are auto-pruned.',
        'The inbox is also pruned on startup and every 5 minutes.',
        '',
        'Machines are paired using the `agent-bridge pair` CLI command (v1).',
        'SSH keys are managed in ~/.agent-bridge/keys/.',
      ].join('\n'),
    },
  );

  // Register all tools
  registerTools(server);

  // Start the inbox file watcher
  await startWatcher((newFiles) => {
    logInfo(`New messages detected: ${newFiles.length} file(s)`);
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logInfo('agent-bridge MCP server connected and ready');

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
