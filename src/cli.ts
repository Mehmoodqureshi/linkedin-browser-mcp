#!/usr/bin/env node
/**
 * CLI entry point — the `npx`-distributable MCP server.
 *
 *     npx mcp-linkedin-browser@latest
 *
 * This is a pure Node MCP server: it drives your INSTALLED Google Chrome via
 * Playwright (`channel: 'chrome'`) — no bundled/desktop app, and no browser
 * download. On the first LinkedIn action a Chrome window opens so you can log in
 * once; the session persists under `~/.linkedin-mcp`.
 *
 * CRITICAL: in stdio mode, stdout carries the JSON-RPC stream. Never write
 * human-readable text to stdout — all diagnostics go to stderr. Help/version
 * output is fine because those exit before the server starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startMcpServer, stopMcpServer } from './mcp/server';
import { getInstance } from './driver/linkedin';

/** Read the shipped package.json (one level up from dist/cli.js) for metadata. */
function readPkg(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

function printHelp(): void {
  const { name = 'mcp-linkedin-browser', version = '?' } = readPkg();
  process.stdout.write(
    `${name} v${version} — LinkedIn automation as an MCP server (stdio)\n\n` +
      `Usage:\n` +
      `  npx mcp-linkedin-browser@latest            Start the MCP server over stdio\n` +
      `  npx mcp-linkedin-browser@latest --help     Show this help\n` +
      `  npx mcp-linkedin-browser@latest --version  Print the version\n\n` +
      `This binary speaks the Model Context Protocol over stdin/stdout, so it is\n` +
      `normally launched by an MCP client (Claude Desktop, Claude Code, etc.)\n` +
      `rather than run by hand. Add it to your client config, e.g.:\n\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `      "linkedin": {\n` +
      `        "command": "npx",\n` +
      `        "args": ["-y", "mcp-linkedin-browser@latest"]\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `Requires Google Chrome installed (it drives your Chrome; no download).\n\n` +
      `Environment:\n` +
      `  LINKEDIN_MCP_USERDATA   Override the data dir (default: ~/.linkedin-mcp)\n` +
      `  LINKEDIN_HEADLESS=1     Run Chrome headless (default: headed, so you can\n` +
      `                          complete the one-time manual login)\n` +
      `  LINKEDIN_USER_DATA_DIR  Alias for the persistent Chrome profile dir\n` +
      `  LINKEDIN_ALLOW_MUTATIONS  Comma-separated allowlist of write actions to enable\n` +
      `                          (e.g. send_message,react) or "all". Write actions\n` +
      `                          (message/connect/comment/react/invitations/update_profile)\n` +
      `                          are DISABLED by default.\n`,
  );
}

function printVersion(): void {
  const { version = '0.0.0' } = readPkg();
  process.stdout.write(`${version}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    printVersion();
    return;
  }

  // Eagerly create the driver singleton (browser launch stays lazy inside it),
  // then bind the MCP server to stdio. Connecting the stdio transport keeps the
  // event loop alive (it reads stdin), so the process stays up serving requests
  // until the client disconnects or sends a termination signal.
  getInstance();
  await startMcpServer();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await stopMcpServer();
        await getInstance().close();
      } catch (err) {
        process.stderr.write(`[cli] error during shutdown: ${String(err)}\n`);
      } finally {
        process.exit(code);
      }
    })();
  };

  // MCP clients terminate the server with SIGTERM/SIGINT on shutdown. We do NOT
  // attach our own stdin reader — the stdio transport owns stdin, and a second
  // reader would corrupt the JSON-RPC stream.
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[cli] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
