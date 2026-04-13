/**
 * MCP tool definitions for agent-bridge v2.
 *
 * Tools:
 * - bridge_list_machines: List paired machines and their status
 * - bridge_status: Check if a machine is reachable
 * - bridge_send_message: Send a message to a remote machine's running agent
 * - bridge_receive_messages: Check for and consume incoming messages
 * - bridge_run_command: Run a shell command on a remote machine
 * - bridge_run_agent_prompt: Run an agent prompt on a remote machine
 * - bridge_clear_inbox: Clear all messages from the local inbox
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadConfig,
  getMachine,
  getLocalMachineName,
} from './config.js';
import { sshExec, sshPing } from './ssh.js';
import { createMessage, sendMessage, consumeInbox, peekInbox, clearInbox } from './inbox.js';
import { logInfo, logError } from './logger.js';

/**
 * Register all agent-bridge tools on the MCP server.
 */
export function registerTools(server: McpServer): void {
  // -- bridge_list_machines --------------------------------------------------
  server.registerTool(
    'bridge_list_machines',
    {
      title: 'List Machines',
      description:
        'List all paired machines and their connection details. Shows machine name, host, user, port, and pairing date.',
    },
    async () => {
      const machines = loadConfig();
      const localName = getLocalMachineName();

      if (machines.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No paired machines found. This machine is "${localName}". Use \`agent-bridge pair\` to add a remote machine.`,
            },
          ],
        };
      }

      const lines = [`Local machine: ${localName}`, '', 'Paired machines:'];
      for (const m of machines) {
        lines.push(
          `  - ${m.name}: ${m.user}@${m.host}:${m.port} (paired ${m.pairedAt})`
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // -- bridge_status ---------------------------------------------------------
  server.registerTool(
    'bridge_status',
    {
      title: 'Machine Status',
      description:
        'Check if a paired machine is reachable via SSH. If no machine name is provided, checks all paired machines.',
      inputSchema: {
        machine: z
          .string()
          .optional()
          .describe('Name of the machine to check. Omit to check all.'),
      },
    },
    async ({ machine }) => {
      const machines = loadConfig();

      if (machines.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No paired machines found.',
            },
          ],
        };
      }

      const toCheck = machine
        ? machines.filter(
            m => m.name.toLowerCase() === machine.toLowerCase()
          )
        : machines;

      if (toCheck.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Machine "${machine}" not found. Available: ${machines.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const results: string[] = [];
      for (const m of toCheck) {
        const reachable = await sshPing(m);
        results.push(
          `${m.name}: ${reachable ? 'ONLINE' : 'OFFLINE'} (${m.user}@${m.host}:${m.port})`
        );
      }

      return {
        content: [{ type: 'text' as const, text: results.join('\n') }],
      };
    }
  );

  // -- bridge_send_message ---------------------------------------------------
  server.registerTool(
    'bridge_send_message',
    {
      title: 'Send Message',
      description:
        'Send a message to a running agent on another machine. The message is delivered to their inbox and will be available when they call bridge_receive_messages.',
      inputSchema: {
        machine: z.string().describe('Name of the target machine'),
        message: z.string().describe('The message content to send'),
        reply_to: z
          .string()
          .optional()
          .describe('Message ID this is a reply to'),
      },
    },
    async ({ machine: machineName, message, reply_to }) => {
      const machine = getMachine(machineName);
      if (!machine) {
        const all = loadConfig();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Machine "${machineName}" not found. Available: ${all.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const localName = getLocalMachineName();
      const msg = createMessage(
        localName,
        machineName,
        'message',
        message,
        reply_to ?? null
      );

      try {
        await sendMessage(machine, msg);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message sent to ${machineName} (id: ${msg.id})`,
            },
          ],
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(`Failed to send message to ${machineName}: ${errMsg}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to send message to ${machineName}: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -- bridge_receive_messages -----------------------------------------------
  server.registerTool(
    'bridge_receive_messages',
    {
      title: 'Receive Messages',
      description:
        'Check for and consume incoming messages from other machines. Messages are removed from the inbox after reading. Use bridge_peek_inbox to check without consuming.',
      inputSchema: {
        peek: z
          .boolean()
          .optional()
          .describe(
            'If true, check messages without consuming them. Default: false (consume).'
          ),
      },
    },
    async ({ peek }) => {
      if (peek) {
        const { count, messages } = peekInbox();
        if (count === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No messages in inbox.' },
            ],
          };
        }
        const lines = [`${count} message(s) in inbox:`, ''];
        for (const msg of messages) {
          lines.push(
            `[${msg.timestamp}] From ${msg.from} (${msg.type}): ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`
          );
          if (msg.replyTo) {
            lines.push(`  (reply to: ${msg.replyTo})`);
          }
          lines.push(`  ID: ${msg.id}`);
          lines.push('');
        }
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      const messages = consumeInbox();
      if (messages.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No messages in inbox.' },
          ],
        };
      }

      const lines = [`Received ${messages.length} message(s):`, ''];
      for (const msg of messages) {
        lines.push(`--- Message from ${msg.from} ---`);
        lines.push(`ID: ${msg.id}`);
        lines.push(`Type: ${msg.type}`);
        lines.push(`Time: ${msg.timestamp}`);
        if (msg.replyTo) {
          lines.push(`Reply to: ${msg.replyTo}`);
        }
        lines.push(`Content: ${msg.content}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // -- bridge_run_command ----------------------------------------------------
  server.registerTool(
    'bridge_run_command',
    {
      title: 'Run Remote Command',
      description:
        'Run a shell command on a remote paired machine via SSH. Returns stdout, stderr, and exit code.',
      inputSchema: {
        machine: z.string().describe('Name of the target machine'),
        command: z.string().describe('Shell command to execute'),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in milliseconds (default: 30000)'),
      },
    },
    async ({ machine: machineName, command, timeout }) => {
      const machine = getMachine(machineName);
      if (!machine) {
        const all = loadConfig();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Machine "${machineName}" not found. Available: ${all.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      logInfo(`Running command on ${machineName}: ${command}`);

      try {
        const result = await sshExec(machine, command, timeout ?? 30000);
        const parts: string[] = [];

        if (result.stdout.trim()) {
          parts.push(`stdout:\n${result.stdout}`);
        }
        if (result.stderr.trim()) {
          parts.push(`stderr:\n${result.stderr}`);
        }
        parts.push(`exit code: ${result.exitCode}`);

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(`Command failed on ${machineName}: ${errMsg}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to run command on ${machineName}: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -- bridge_run_agent_prompt -----------------------------------------------
  server.registerTool(
    'bridge_run_agent_prompt',
    {
      title: 'Run Agent Prompt',
      description:
        'Run an AI agent prompt on a remote machine. By default uses `claude --print`, but you can specify any agent command. The prompt is executed on the remote machine and the output is returned.',
      inputSchema: {
        machine: z.string().describe('Name of the target machine'),
        prompt: z.string().describe('The prompt to send to the agent'),
        agent: z
          .string()
          .optional()
          .describe(
            'Agent command to use (default: "claude --print"). Examples: "claude --print", "codex exec", "aider --message"'
          ),
        timeout: z
          .number()
          .optional()
          .describe(
            'Timeout in milliseconds (default: 120000 for agent prompts)'
          ),
      },
    },
    async ({ machine: machineName, prompt, agent, timeout }) => {
      const machine = getMachine(machineName);
      if (!machine) {
        const all = loadConfig();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Machine "${machineName}" not found. Available: ${all.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const agentCmd = agent ?? 'claude --print';
      // Escape single quotes in prompt for shell safety
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const command = `${agentCmd} '${escapedPrompt}'`;

      logInfo(
        `Running agent prompt on ${machineName} with ${agentCmd}: ${prompt.substring(0, 100)}...`
      );

      try {
        const result = await sshExec(
          machine,
          command,
          timeout ?? 120000
        );
        const parts: string[] = [];

        if (result.stdout.trim()) {
          parts.push(result.stdout.trim());
        }
        if (result.stderr.trim()) {
          parts.push(`[stderr]: ${result.stderr.trim()}`);
        }
        if (result.exitCode !== 0) {
          parts.push(`[exit code: ${result.exitCode}]`);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: parts.join('\n\n') || '(no output)',
            },
          ],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(
          `Agent prompt failed on ${machineName}: ${errMsg}`
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to run agent prompt on ${machineName}: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -- bridge_clear_inbox ----------------------------------------------------
  server.registerTool(
    'bridge_clear_inbox',
    {
      title: 'Clear Inbox',
      description: 'Remove all messages from the local inbox.',
    },
    async () => {
      const count = clearInbox();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              count > 0
                ? `Cleared ${count} message(s) from inbox.`
                : 'Inbox was already empty.',
          },
        ],
      };
    }
  );
}
