/**
 * MCP server bootstrap for the LinkedIn driver.
 *
 * This module wires the `@modelcontextprotocol/sdk` {@link Server} to a
 * {@link StdioServerTransport} so that an MCP client (Claude Desktop) can drive
 * the LinkedIn automation over stdin/stdout using JSON-RPC.
 *
 * Responsibilities:
 *   - construct the `Server` with our identity (the canonical package name and shipped version)
 *     and declare the `tools` capability,
 *   - register every tool from `tools.ts` via `registerTools`,
 *   - install crash-safety so a thrown handler never corrupts the transport,
 *   - connect the stdio transport and keep it alive,
 *   - expose `startMcpServer()` (called by the main process) and a matching
 *     `stopMcpServer()` for clean shutdown.
 *
 * CRITICAL: when running as an MCP stdio server, **nothing** may be written to
 * stdout except the JSON-RPC stream — any stray `console.log` would corrupt the
 * protocol. All diagnostics therefore go to stderr.
 */

import net from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const SERVER_NAME = 'linkedin-browser-mcp';

/**
 * The version advertised in the MCP handshake, read from the shipped
 * package.json rather than hardcoded.
 *
 * It used to be a literal `'1.0.0'`, so every MCP client — and every bug report
 * written from what a client displayed — named a version this package has never
 * published. Read once at module load; falls back to `'0.0.0'` only if the file
 * is unreadable, which is a clearer signal than a plausible-looking lie.
 */
export const SERVER_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The live server instance, or null when stopped. Kept so we can stop it. */
let server: McpServer | null = null;

/** The live transport, or null when stopped. */
let transport: StdioServerTransport | null = null;

// ---------------------------------------------------------------------------
// Logging (stderr only — never stdout in stdio mode)
// ---------------------------------------------------------------------------

function logErr(message: string): void {
  process.stderr.write(`[mcp] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

/**
 * Build a fresh `Server` with our capabilities and the full tool surface
 * registered. Pure: creates and returns the instance without connecting any
 * transport, so it is easy to unit-test.
 */
export function createServer(): McpServer {
  const srv = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        // We expose tools only — no prompts/resources surface for now.
        tools: {},
      },
    },
  );

  // Register every tool via `server.registerTool`. `registerTools` already wraps
  // each tool invocation in try/catch (via dispatchToolCall) and returns a
  // structured `isError` result instead of throwing, so a failing tool can
  // never tear down the transport.
  registerTools(srv);

  // Belt-and-suspenders: surface any protocol-level error to stderr instead of
  // letting it bubble out unobserved. `McpServer` wraps the low-level `Server`,
  // which owns the `onerror` hook.
  srv.server.onerror = (err: unknown): void => {
    logErr(`server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  };

  return srv;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the MCP server over stdio. Idempotent: a second call while already
 * running is a no-op. Called by the main process during bootstrap.
 *
 * The returned promise resolves once the transport is connected and the server
 * is ready to receive JSON-RPC requests; the process then stays alive serving
 * requests until `stopMcpServer()` is called or stdin closes.
 */
export async function startMcpServer(): Promise<void> {
  if (server) {
    logErr('startMcpServer called but server is already running; ignoring.');
    return;
  }

  const srv = createServer();
  const tx = new StdioServerTransport();

  try {
    await srv.connect(tx);
  } catch (err) {
    logErr(`failed to connect stdio transport: ${String(err)}`);
    // Leave module state clean so a retry can succeed.
    server = null;
    transport = null;
    throw err;
  }

  server = srv;
  transport = tx;
  logErr(`${SERVER_NAME} v${SERVER_VERSION} connected over stdio.`);
}

/**
 * Stop the MCP server and release the stdio transport. Idempotent: safe to call
 * when already stopped. Best-effort — failures are logged but never thrown, so
 * shutdown is never blocked.
 */
export async function stopMcpServer(): Promise<void> {
  const srv = server;
  if (!srv) return;

  // Drop references first so a re-entrant call short-circuits.
  server = null;
  const tx = transport;
  transport = null;

  try {
    await srv.close();
  } catch (err) {
    logErr(`error while closing server: ${String(err)}`);
  }

  try {
    await tx?.close();
  } catch (err) {
    logErr(`error while closing transport: ${String(err)}`);
  }

  logErr('MCP server stopped.');
}

/** Whether the MCP server is currently connected and serving. */
export function isMcpServerRunning(): boolean {
  return server !== null;
}

// ---------------------------------------------------------------------------
// Socket server — lets a SECOND (MCP-mode) process bridge into THIS running
// instance so Claude Desktop drives the same in-app browser.
// ---------------------------------------------------------------------------
// The desktop (UI-mode) instance owns the single-instance lock and the in-app
// BrowserView. When Claude Desktop spawns the binary in MCP mode it can't get
// the lock; instead of quitting, that process connects here and pipes its stdio.
// We serve a FRESH MCP Server per connection over the socket (a net.Socket is a
// duplex stream, so StdioServerTransport(socket, socket) just works), all of
// which dispatch to the same shared driver singleton — i.e. the visible view.

let socketServer: net.Server | null = null;
const socketConnections = new Set<net.Socket>();

/**
 * Start a local IPC server at `socketPath` (a Unix socket / Windows named pipe).
 * Idempotent. Each inbound connection gets its own MCP Server + transport.
 */
export async function startMcpSocketServer(socketPath: string): Promise<void> {
  if (socketServer) return;

  // Clear a stale socket file from an unclean prior shutdown.
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* best effort */
  }

  const srvNet = net.createServer((socket) => {
    socketConnections.add(socket);
    const mcp = createServer();
    const tx = new StdioServerTransport(socket, socket);
    mcp.connect(tx).catch((err) => {
      logErr(`socket transport connect failed: ${String(err)}`);
    });
    const cleanup = (): void => {
      socketConnections.delete(socket);
      void mcp.close().catch(() => undefined);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    srvNet.once('error', reject);
    srvNet.listen(socketPath, () => {
      srvNet.removeListener('error', reject);
      resolve();
    });
  });

  socketServer = srvNet;
  logErr(`MCP socket server listening at ${socketPath}`);
}

/** Stop the socket server and drop every bridged connection. Idempotent. */
export async function stopMcpSocketServer(): Promise<void> {
  const srvNet = socketServer;
  socketServer = null;
  for (const conn of socketConnections) {
    try {
      conn.destroy();
    } catch {
      /* ignore */
    }
  }
  socketConnections.clear();
  if (srvNet) {
    await new Promise<void>((resolve) => srvNet.close(() => resolve()));
  }
}
