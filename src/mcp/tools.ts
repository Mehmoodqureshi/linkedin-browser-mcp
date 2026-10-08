/**
 * MCP tool definitions and handlers for the LinkedIn driver.
 *
 * This module is the single place where the Model Context Protocol surface is
 * declared. It owns two responsibilities:
 *
 *   1. The *catalog*: a per-tool zod *raw shape* (name, human description, and
 *      `inputSchema`) advertised to the MCP client. The SDK derives the JSON
 *      Schema from the zod shape and validates arguments against it, so this is
 *      what Claude Desktop reads to know what it may call and with what shape.
 *
 *   2. The *dispatch*: a `name -> handler` map. Each handler re-reads its
 *      (already zod-validated) arguments, fetches the process-wide
 *      `LinkedInDriver` singleton, makes sure the browser is launched and the
 *      driver is `ready`, invokes the relevant action module, and serializes
 *      the result back into the MCP `content` envelope.
 *
 * `registerTools(server)` wires the catalog + dispatch onto an `McpServer` by
 * calling `server.registerTool` once per tool, routing each call through
 * `dispatchToolCall`.
 *
 * Design notes:
 *   - Input is validated by the SDK against the zod `inputSchema` BEFORE a
 *     handler runs, so malformed arguments surface as a protocol validation
 *     error. The handler-level runtime guards remain as defence-in-depth.
 *   - Every handler routes through `withReadyDriver`, which lazily launches the
 *     browser. The first tool call therefore pays the Chromium start-up cost;
 *     subsequent calls reuse the live context.
 *   - Handlers never throw raw — `dispatchToolCall` wraps them — but they DO
 *     throw `McpToolError` with a clear message when input is invalid or the
 *     driver cannot reach `ready`, so the client gets an actionable `isError`
 *     result.
 */

import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getInstance, type LinkedInDriver } from '../driver/linkedin';
import type { ReactionType } from '../driver/actions';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from '../driver/actions/search';
import { getQuotaManager, nextResetAt } from '../driver/quota';
import { isMutatingTool, mutationAllowed } from './mutation-gate';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by a tool handler when the request cannot be fulfilled for a reason
 * the caller can act on (bad arguments, driver not ready, etc.). `server.ts`
 * catches it and renders a structured MCP error result.
 */
export class McpToolError extends Error {
  /** Optional stable code, echoed into the error envelope alongside the message. */
  readonly code?: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tool catalog (zod input shapes)
// ---------------------------------------------------------------------------

/**
 * A single advertised MCP tool. Its `inputSchema` is a zod *raw shape* (a plain
 * object mapping field names to zod validators), which `registerTools` hands to
 * `server.registerTool` — the SDK builds the JSON Schema and validates input
 * against it before the handler runs.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
}

/**
 * The full set of tools this server exposes. Mirrors the dispatch table below;
 * keep the two in sync (a name present here MUST have a handler, and vice
 * versa — `registerTools` asserts this at startup).
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'linkedin_login',
    description:
      'Start the manual login flow. Opens the Playwright-controlled Chromium ' +
      'window (headed) on the LinkedIn login page, optionally pre-filling the ' +
      'given email/password, so the user can authenticate manually including ' +
      '2FA/captcha. Waits until the session is established or times out, then ' +
      'persists the session.',
    inputSchema: {
      email: z
        .string()
        .describe(
          'LinkedIn account email to pre-fill on the login form. Optional; ' +
            'if omitted the user types it manually in the opened window.',
        )
        .optional(),
      password: z
        .string()
        .describe(
          'LinkedIn account password to pre-fill. Optional and never stored; ' +
            'if omitted the user types it manually in the opened window.',
        )
        .optional(),
    },
  },
  {
    name: 'linkedin_logout',
    description:
      'Clear the stored LinkedIn session: deletes the saved storageState and ' +
      'clears the persistent browser profile cookies so the next action ' +
      'requires a fresh manual login.',
    inputSchema: {},
  },
  {
    name: 'linkedin_status',
    description:
      'Return the current driver/session status: lifecycle state, whether a ' +
      'LinkedIn session is authenticated, and whether the persisted session ' +
      'cookies are still valid. Useful for deciding whether a login is needed.',
    inputSchema: {},
  },
  {
    name: 'linkedin_get_profile',
    description:
      'Open and scrape a LinkedIn member profile. Returns normalized profile ' +
      'data: name, headline, location, about, experience, education, skills, ' +
      'and connection count.',
    inputSchema: {
      profileUrl: z
        .string()
        .describe(
          'Full profile URL (e.g. https://www.linkedin.com/in/john-doe/) ' +
            'or an /in/ slug (e.g. john-doe).',
        ),
    },
  },
  {
    name: 'linkedin_update_profile',
    description:
      "Update the SIGNED-IN user's OWN profile. Edits only the fields you " +
      'provide (all optional; supply at least one): firstName, lastName, ' +
      'headline, location, about. Drives the "Edit intro" and "Edit about" ' +
      'modals and returns a per-field outcome (updated / unchanged / failed). ' +
      'This is a WRITE action, gated by LINKEDIN_ALLOW_MUTATIONS. Structured ' +
      'sections (experience, education, skills) are not yet supported.',
    inputSchema: {
      firstName: z.string().min(1).max(100).describe('New first name.').optional(),
      lastName: z.string().min(1).max(100).describe('New last name.').optional(),
      headline: z
        .string()
        .max(220)
        .describe('New headline (LinkedIn caps this at ~220 characters).')
        .optional(),
      location: z
        .string()
        .min(1)
        .describe(
          'New location. Resolved via the location typeahead — pass a ' +
            'recognizable city/region (e.g. "San Francisco Bay Area").',
        )
        .optional(),
      about: z
        .string()
        .max(2600)
        .describe('New About / summary text (LinkedIn caps this at ~2600 characters).')
        .optional(),
    },
  },
  {
    name: 'linkedin_search_people',
    description:
      'Run a People search and return normalized result cards (name, ' +
      'headline, location, profile URL, connection degree). Supports a free- ' +
      'text query plus common filters.',
    inputSchema: {
      query: z
        .string()
        .describe("Free-text keywords, e.g. 'head of engineering fintech'."),
      filters: z
        .object({
          locations: z.array(z.string()).optional(),
          currentCompanies: z.array(z.string()).optional(),
          pastCompanies: z.array(z.string()).optional(),
          industries: z.array(z.string()).optional(),
          connectionDegree: z.array(z.enum(['1st', '2nd', '3rd'])).optional(),
          title: z.string().optional(),
          school: z.string().optional(),
        })
        .describe('Optional People-search filters.')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum results to return (default 25). Fewer results means a shorter scroll and a smaller payload.')
        .optional(),
    },
  },
  {
    name: 'linkedin_search_jobs',
    description:
      'Run a Jobs search and return normalized job postings (title, company, ' +
      'location, posted date, workplace type, salary if shown, job URL).',
    inputSchema: {
      query: z
        .string()
        .describe("Job title or keywords, e.g. 'senior typescript engineer'."),
      filters: z
        .object({
          location: z.string().optional(),
          workplaceType: z
            .array(z.enum(['on-site', 'remote', 'hybrid']))
            .optional(),
          experienceLevel: z
            .array(
              z.enum([
                'internship',
                'entry',
                'associate',
                'mid-senior',
                'director',
                'executive',
              ]),
            )
            .optional(),
          jobType: z
            .array(
              z.enum([
                'full-time',
                'part-time',
                'contract',
                'temporary',
                'internship',
                'volunteer',
                'other',
              ]),
            )
            .optional(),
          salary: z
            .string()
            .describe(
              "Minimum salary, e.g. '40k', '100k', or '120000'. Maps to the " +
                'closest LinkedIn salary band.',
            )
            .optional(),
          datePosted: z
            .enum(['any', 'past-month', 'past-week', 'past-24h'])
            .optional(),
          easyApplyOnly: z.boolean().optional(),
        })
        .describe('Optional Jobs-search filters.')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum results to return (default 25). Fewer results means a shorter scroll and a smaller payload.')
        .optional(),
    },
  },
  {
    name: 'linkedin_search_companies',
    description:
      'Run a Company search and return normalized company cards (name, ' +
      'industry, size, company URL).',
    inputSchema: {
      query: z.string().describe('Company name or keywords.'),
      filters: z
        .object({
          locations: z.array(z.string()).optional(),
          industries: z.array(z.string()).optional(),
          companySize: z
            .array(
              z.enum([
                '1-10',
                '11-50',
                '51-200',
                '201-500',
                '501-1000',
                '1001-5000',
                '5001-10000',
                '10001+',
              ]),
            )
            .optional(),
        })
        .describe('Optional Company-search filters.')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum results to return (default 25). Fewer results means a shorter scroll and a smaller payload.')
        .optional(),
    },
  },
  {
    name: 'linkedin_send_message',
    description:
      'Send a direct message to an existing 1st-degree connection (or an ' +
      'open-profile / InMail-eligible member). Returns delivery status; fails ' +
      'with a clear error if messaging is not permitted for that member.',
    inputSchema: {
      profileUrl: z.string().describe('Recipient profile URL or /in/ slug.'),
      message: z.string().min(1).max(8000).describe('Message body text.'),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_send_connection',
    description:
      'Send a connection request to a member, optionally with a personalized ' +
      'note. Subject to rate limits; returns the outcome (sent, ' +
      'already-connected, pending, or unavailable).',
    inputSchema: {
      profileUrl: z.string().describe('Target profile URL or /in/ slug.'),
      note: z
        .string()
        .max(300)
        .describe(
          'Optional personalized note (LinkedIn caps this around 300 ' +
            'characters).',
        )
        .optional(),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_invitations',
    description:
      'List pending RECEIVED connection invitations from the invitation ' +
      'manager. Returns each inviter’s name, headline, profile URL, and ' +
      'profileId (vanity slug). The slug feeds linkedin_accept_invitation.',
    inputSchema: {},
  },
  {
    name: 'linkedin_get_sent_invitations',
    description:
      'List pending connection invitations YOU sent (invitation manager, Sent ' +
      'tab): name, headline, profile URL, profileId, and the "Sent N days ago" ' +
      'label. An invitation that drops off this list was either accepted (see ' +
      'linkedin_get_connections) or withdrawn.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum invitations to return (default 50).')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_connections',
    description:
      'List your 1st-degree connections, most recently added first: name, ' +
      'headline, profile URL, profileId, and connectedDate (YYYY-MM-DD). Use it ' +
      'to see who accepted a connection request and when.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum connections to return (default 40).')
        .optional(),
    },
  },
  {
    name: 'linkedin_accept_invitation',
    description:
      'Accept a pending RECEIVED connection invitation, identified by the ' +
      'inviter’s profileId (vanity slug, as returned by ' +
      'linkedin_get_invitations) or their full profile URL. Fails with a clear ' +
      'error if no matching pending invitation is found.',
    inputSchema: {
      profileId: z
        .string()
        .describe(
          'Inviter vanity slug (e.g. "john-doe") or full /in/ profile URL.',
        ),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_withdraw_invitation',
    description:
      'Withdraw a pending SENT connection invitation, identified by the ' +
      'recipient’s profileId (vanity slug) or their full profile URL. Fails ' +
      'with a clear error if no matching sent invitation is found.',
    inputSchema: {
      profileId: z
        .string()
        .describe(
          'Recipient vanity slug (e.g. "john-doe") or full /in/ profile URL.',
        ),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_react',
    description:
      'React to a post by its permalink URL with one of LinkedIn’s six ' +
      'reactions (like, celebrate, support, love, insightful, funny). Defaults ' +
      'to "like". Subject to rate limits; no-ops cleanly if the post already ' +
      'carries your reaction, and reports "unavailable" if no reaction control ' +
      'is present.',
    inputSchema: {
      postUrl: z
        .string()
        .describe(
          'Post permalink, e.g. ' +
            'https://www.linkedin.com/feed/update/urn:li:activity:1234567890/ ' +
            '(as returned in a feed post’s postUrl).',
        ),
      reaction: z
        .enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny'])
        .describe('Which reaction to apply. Defaults to "like".')
        .optional(),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_comment',
    description:
      'Post a comment on a post by its permalink URL. Returns delivery status; ' +
      'fails with a clear error if the post is not commentable or the comment ' +
      'composer cannot be opened.',
    inputSchema: {
      postUrl: z
        .string()
        .describe(
          'Post permalink, e.g. ' +
            'https://www.linkedin.com/feed/update/urn:li:activity:1234567890/ ' +
            '(as returned in a feed post’s postUrl).',
        ),
      text: z.string().min(1).max(1250).describe('Comment body text.'),
      dryRun: z
        .boolean()
        .describe('Resolve the target and return exactly what WOULD be sent, without performing the action or counting it against the daily quota. Use this to preview a write before it reaches a real person.')
        .optional(),
    },
  },
  {
    name: 'linkedin_apply',
    description:
      'Apply to a LinkedIn job via Easy Apply. Walks the multi-step application ' +
      'modal, reports every screening question it asks, and submits only when all ' +
      'required questions have answers. NEVER guesses an answer: employer questions ' +
      'about work authorization, salary, notice period and years of experience are ' +
      "the applicant's to give, and a wrong one is a misrepresentation on a real " +
      'application. ALWAYS run with dryRun:true first to see the questions, ask the ' +
      'USER for their answers, then re-run with those answers supplied. Postings that ' +
      'hand off to an external system (Workday, Greenhouse, Lever) are reported as ' +
      "'external' with their link rather than half-completed. This is a WRITE action, " +
      'gated by LINKEDIN_ALLOW_MUTATIONS and metered by a daily cap.',
    inputSchema: {
      jobUrl: z
        .string()
        .describe('Job id (e.g. "4444995257") or full /jobs/view/ URL, as returned by linkedin_search_jobs.'),
      answers: z
        .record(z.string(), z.string())
        .describe(
          'Answers keyed by the question label exactly as returned by a dryRun (matching ignores case, ' +
            'trailing punctuation and the required-marker asterisk). For a select or radio question, pass ' +
            'one of its listed options verbatim.',
        )
        .optional(),
      dryRun: z
        .boolean()
        .describe(
          'Walk the application and return every question it asks WITHOUT submitting anything and without ' +
            'counting against the daily cap. Run this first, always.',
        )
        .optional(),
    },
  },
  {
    name: 'linkedin_get_member_posts',
    description:
      'List a member’s recent posts (newest first) with their canonical ' +
      'permalink URLs and a short text preview, by reading their recent-activity ' +
      'page. Use this to locate a specific person’s post (e.g. to react or ' +
      'comment) without waiting for it to appear in the volatile home feed.',
    inputSchema: {
      profileUrl: z.string().describe('Target member profile URL or /in/ slug.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .describe('Number of recent posts to collect.')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_feed',
    description:
      'Read the home feed and return normalized posts (author, author URL, ' +
      'text, posted time, like/comment counts, post URL). Scrolls to gather ' +
      'the requested count.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .describe('Number of posts to collect.')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_notifications',
    description:
      'Read the notifications panel and return normalized notification items ' +
      '(type, actor, text, timestamp, target URL, read/unread state).',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .describe('Number of notifications to collect.')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_conversations',
    description:
      'List the message threads in the LinkedIn inbox as normalized ' +
      'conversation summaries (participant, snippet, conversation id, ' +
      'timestamp, unread state).',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_LIMIT)
        .describe('Maximum threads to return (default 30).')
        .optional(),
    },
  },
  {
    name: 'linkedin_get_messages',
    description:
      'Read one message thread and return its messages in order (sender, text, ' +
      'timestamp). Takes the conversation id from linkedin_get_conversations or ' +
      'linkedin_send_message — a full /messaging/thread/ URL is also accepted. ' +
      'Use it to read replies to a message that was sent.',
    inputSchema: {
      conversationId: z
        .string()
        .describe(
          'Thread id as returned by linkedin_get_conversations, or the full ' +
            'https://www.linkedin.com/messaging/thread/<id>/ URL.',
        ),
    },
  },
  {
    name: 'linkedin_get_quota',
    description:
      "Report today's usage of the daily safety caps on mutating actions " +
      '(connection, message, reaction, comment). Returns each action with its ' +
      'used count, cap, remaining budget, and resetsAt (ISO-8601 local-midnight ' +
      'rollover when the counters reset to zero). Read-only and requires no ' +
      'login — call it before a batch of writes to see how much headroom is left ' +
      'before an action would be blocked to protect the account, and when the ' +
      'budget next refreshes.',
    inputSchema: {},
  },
];

// ---------------------------------------------------------------------------
// Argument validation helpers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

/** Coerce the SDK-provided arguments bag into a plain object. */
function asArgs(raw: unknown): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpToolError('Tool arguments must be a JSON object.');
  }
  return raw as Args;
}

/** Require a non-empty string argument. */
function requireString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new McpToolError(`Missing or invalid required string argument: "${key}".`);
  }
  return v;
}

/** Read an optional string argument (undefined if absent). */
function optionalString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new McpToolError(`Argument "${key}" must be a string when provided.`);
  }
  return v;
}

/** Read an optional, bounded integer argument (undefined if absent). */
function optionalInt(
  args: Args,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new McpToolError(`Argument "${key}" must be an integer when provided.`);
  }
  if (v < min || v > max) {
    throw new McpToolError(`Argument "${key}" must be between ${min} and ${max}.`);
  }
  return v;
}

/** The accepted reaction verbs for `linkedin_react`, in catalog order. */
const REACTION_TYPES = [
  'like',
  'celebrate',
  'support',
  'love',
  'insightful',
  'funny',
] as const satisfies readonly ReactionType[];

/**
 * Read an optional string argument constrained to a fixed set (undefined if
 * absent). Throws when present but not one of the allowed values.
 */
function optionalEnum<T extends string>(
  args: Args,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) {
    throw new McpToolError(
      `Argument "${key}" must be one of: ${allowed.join(', ')}.`,
    );
  }
  return v as T;
}

/**
 * Normalize a profile reference to its vanity slug. Accepts either a bare slug
 * ("john-doe") or a full /in/ profile URL and returns the slug the connection
 * actions match on, so callers can pass whichever they have to hand. Falls back
 * to the trimmed input when no /in/ segment is present.
 */
function profileSlug(ref: string): string {
  const m = ref.match(/\/in\/([^/?#]+)/);
  return (m?.[1] ?? ref).trim();
}

/**
 * Normalize a conversation reference to its bare thread id. Accepts either the
 * id itself or a full /messaging/thread/<id>/ URL, so a caller can pass back
 * whichever form it copied out of a conversation listing. Falls back to the
 * trimmed input when no thread segment is present.
 */
export function conversationThreadId(ref: string): string {
  const m = ref.match(/\/messaging\/thread\/([^/?#]+)/);
  return (m?.[1] ?? ref).trim();
}

/** Read an optional object argument (undefined if absent). */
function optionalObject(args: Args, key: string): Args | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new McpToolError(`Argument "${key}" must be an object when provided.`);
  }
  return v as Args;
}

// ---------------------------------------------------------------------------
// Driver readiness
// ---------------------------------------------------------------------------

/**
 * Fetch the singleton driver, lazily launch the browser if needed, and ensure
 * it reaches the `ready` state before handing it to a tool handler.
 *
 * The login/logout/status tools must run even when not yet authenticated, so
 * readiness here means "browser is up", not "user is logged in".
 */
async function withReadyDriver(): Promise<LinkedInDriver> {
  const driver = getInstance();

  // Lazily bring up Chromium AND self-heal a mid-session disconnect: if the
  // browser died (crash / closed window) or the primary tab was lost, this
  // relaunches and re-wires the action modules to a live page. Idempotent and a
  // no-op once ready with a live page.
  try {
    await driver.ensureOperational();
  } catch (err) {
    throw new McpToolError(
      `Failed to launch the LinkedIn driver: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (driver.status !== 'ready') {
    throw new McpToolError(
      `LinkedIn driver is not ready (status: ${driver.status}). ` +
        'Try again, or call linkedin_status to inspect the session.',
    );
  }

  return driver;
}

/**
 * Like `withReadyDriver`, but additionally asserts an authenticated session.
 * Used by every data/action tool that needs a logged-in member. Surfaces a
 * clear "log in first" error rather than letting the scraper fail deep in the
 * DOM.
 */
async function withAuthedDriver(): Promise<LinkedInDriver> {
  const driver = await withReadyDriver();
  await driver.refreshSession();
  const { isLoggedIn } = driver.getStatus();
  if (!isLoggedIn) {
    throw new McpToolError(
      'Not logged in to LinkedIn. Run linkedin_login to start the manual ' +
        'login flow, then retry.',
    );
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** The MCP tool result shape (text content carrying serialized JSON). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

/** Wrap an arbitrary serializable value in the standard text-content envelope. */
function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/** Whether the caller asked to preview a write rather than perform it. */
function isDryRun(args: Args): boolean {
  return args.dryRun === true;
}

/**
 * Render a preview of a write that was NOT performed.
 *
 * `LINKEDIN_ALLOW_MUTATIONS` is all-or-nothing for a session: once writes are
 * enabled, an agent had no way to check what it was about to put in a real
 * person's inbox — the confirmation step the HITL harness has always given a
 * human reviewer. A dry run resolves the target and returns the exact payload,
 * performs no action, and records nothing against the daily quota.
 */
function dryRunResult(tool: string, payload: Record<string, unknown>): ToolResult {
  return jsonResult({
    dryRun: true,
    tool,
    performed: false,
    quotaCharged: false,
    wouldSend: payload,
    note: 'Nothing was sent. Re-run the same call without dryRun to perform this action.',
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type ToolHandler = (args: Args) => Promise<ToolResult>;

/**
 * The dispatch table: tool name -> handler. Each handler validates its inputs,
 * obtains an appropriately-gated driver, calls the action module, and
 * serializes the result.
 */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // --- Auth ---------------------------------------------------------------
  linkedin_login: async (args) => {
    const driver = await withReadyDriver();
    const email = optionalString(args, 'email') ?? '';
    const password = optionalString(args, 'password') ?? '';
    const result = await driver.auth.login(email, password);
    await driver.refreshSession();
    return jsonResult(result);
  },

  linkedin_logout: async () => {
    const driver = await withReadyDriver();
    const result = await driver.auth.logout();
    await driver.refreshSession();
    return jsonResult(result);
  },

  linkedin_status: async () => {
    // Report the AUTHORITATIVE live state, not a stale pre-launch snapshot:
    // lazily launch the browser and re-check the session so a freshly-started
    // server doesn't misreport an authenticated profile as logged-out. If the
    // launch fails (e.g. no display), fall back to the cached snapshot so the
    // tool still answers instead of erroring.
    try {
      const driver = await withReadyDriver();
      await driver.refreshSession();
      return jsonResult(driver.getStatus());
    } catch {
      return jsonResult(getInstance().getStatus());
    }
  },

  // --- Profile ------------------------------------------------------------
  linkedin_get_profile: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const result = await driver.profile.getProfile(profileUrl);
    return jsonResult(result);
  },

  linkedin_update_profile: async (args) => {
    const driver = await withAuthedDriver();
    const firstName = optionalString(args, 'firstName');
    const lastName = optionalString(args, 'lastName');
    const headline = optionalString(args, 'headline');
    const location = optionalString(args, 'location');
    const about = optionalString(args, 'about');

    const input = {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(about !== undefined ? { about } : {}),
    };
    if (Object.keys(input).length === 0) {
      throw new McpToolError(
        'Provide at least one profile field to update: firstName, lastName, ' +
          'headline, location, or about.',
      );
    }

    const result = await driver.profileEdit.updateProfile(input);
    return jsonResult(result);
  },

  // --- Search -------------------------------------------------------------
  linkedin_search_people: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? DEFAULT_RESULT_LIMIT;
    const result = await driver.search.searchPeople(query, filters as never, limit);
    return jsonResult(result);
  },

  linkedin_search_jobs: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? DEFAULT_RESULT_LIMIT;
    const result = await driver.search.searchJobs(query, filters as never, limit);
    return jsonResult(result);
  },

  linkedin_search_companies: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? DEFAULT_RESULT_LIMIT;
    const result = await driver.search.searchCompanies(query, filters as never, limit);
    return jsonResult(result);
  },

  // --- Messaging ----------------------------------------------------------
  linkedin_send_message: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const message = requireString(args, 'message');
    if (isDryRun(args)) {
      return dryRunResult('linkedin_send_message', {
        recipient: await driver.profile.getProfile(profileUrl),
        message,
      });
    }
    const result = await driver.messages.sendMessage(profileUrl, message);
    return jsonResult(result);
  },

  linkedin_get_conversations: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? 30;
    const result = await driver.messages.getConversations(limit);
    return jsonResult(result);
  },

  linkedin_get_messages: async (args) => {
    const driver = await withAuthedDriver();
    const conversationId = conversationThreadId(requireString(args, 'conversationId'));
    if (!conversationId) {
      throw new McpToolError('Argument "conversationId" must name a thread.');
    }
    const result = await driver.messages.getMessages(conversationId);
    return jsonResult(result);
  },

  // --- Quota (read-only, browser-free) -----------------------------------
  linkedin_get_quota: async () => {
    // Purely reads the persisted counters; no driver/browser or login needed,
    // so this answers even before the first login or if Chromium can't launch.
    const rows = await getQuotaManager().snapshot();
    // Same rollover instant for every row: when the local calendar date flips,
    // all counters reset together. Surfacing it lets a caller decide whether to
    // pause a batch until the budget refreshes rather than hit a hard block.
    const resetsAt = nextResetAt();
    const quota = rows.map(({ action, used, cap }) => ({
      action,
      used,
      cap,
      remaining: Math.max(0, cap - used),
      resetsAt,
    }));
    return jsonResult(quota);
  },

  // --- Connections --------------------------------------------------------
  linkedin_send_connection: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const note = optionalString(args, 'note');
    if (isDryRun(args)) {
      return dryRunResult('linkedin_send_connection', {
        recipient: await driver.profile.getProfile(profileUrl),
        note: note ?? null,
      });
    }
    const result = await driver.connections.sendConnectionRequest(profileUrl, note);
    return jsonResult(result);
  },

  linkedin_get_invitations: async () => {
    const driver = await withAuthedDriver();
    const result = await driver.connections.getConnectionRequests();
    return jsonResult(result);
  },

  linkedin_get_sent_invitations: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? 50;
    const result = await driver.connections.getSentInvitations(limit);
    return jsonResult(result);
  },

  linkedin_get_connections: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, MAX_RESULT_LIMIT) ?? 40;
    const result = await driver.connections.getConnections(limit);
    return jsonResult(result);
  },

  linkedin_accept_invitation: async (args) => {
    const driver = await withAuthedDriver();
    const profileId = profileSlug(requireString(args, 'profileId'));
    if (isDryRun(args)) {
      const pending = await driver.connections.getConnectionRequests();
      return dryRunResult('linkedin_accept_invitation', {
        profileId,
        matchedInvitation:
          pending.find((i) => profileSlug(i.profileUrl ?? i.profileId ?? '') === profileId) ?? null,
      });
    }
    const result = await driver.connections.acceptConnectionRequest(profileId);
    return jsonResult(result);
  },

  linkedin_withdraw_invitation: async (args) => {
    const profileId = profileSlug(requireString(args, 'profileId'));
    if (isDryRun(args)) {
      return dryRunResult('linkedin_withdraw_invitation', { profileId });
    }
    const driver = await withAuthedDriver();
    const result = await driver.connections.withdrawConnectionRequest(profileId);
    return jsonResult(result);
  },

  // --- Feed engagement ----------------------------------------------------
  linkedin_react: async (args) => {
    const postUrl = requireString(args, 'postUrl');
    const reaction = optionalEnum(args, 'reaction', REACTION_TYPES) ?? 'like';
    // The preview echoes the resolved payload, so it needs nothing from the
    // browser — answer before launching Chrome.
    if (isDryRun(args)) {
      return dryRunResult('linkedin_react', { postUrl, reaction });
    }
    const driver = await withAuthedDriver();
    const result = await driver.feed.reactToPost(postUrl, reaction);
    return jsonResult(result);
  },

  linkedin_comment: async (args) => {
    const postUrl = requireString(args, 'postUrl');
    const text = requireString(args, 'text');
    if (isDryRun(args)) {
      return dryRunResult('linkedin_comment', { postUrl, comment: text });
    }
    const driver = await withAuthedDriver();
    const result = await driver.feed.commentOnPost(postUrl, text);
    return jsonResult(result);
  },

  // --- Job applications ---------------------------------------------------
  linkedin_apply: async (args) => {
    const jobUrl = requireString(args, 'jobUrl');
    const answers = (optionalObject(args, 'answers') ?? {}) as Record<string, string>;
    const driver = await withAuthedDriver();
    const result = await driver.apply.applyToJob(jobUrl, {
      dryRun: isDryRun(args),
      answers,
    });
    return jsonResult(result);
  },

  // --- Feed / notifications ----------------------------------------------
  linkedin_get_member_posts: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const limit = optionalInt(args, 'limit', 1, 20);
    const result = await driver.feed.getMemberPosts(profileUrl, limit);
    return jsonResult(result);
  },

  linkedin_get_feed: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, 50);
    const result = await driver.feed.getFeed(limit);
    return jsonResult(result);
  },

  linkedin_get_notifications: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, 50);
    const result = await driver.feed.getNotifications(limit);
    return jsonResult(result);
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wire the tool catalog and dispatch onto an MCP `McpServer`.
 *
 * Registers every tool from `TOOL_DEFINITIONS` via `server.registerTool`, which
 * advertises the tool (name + description + JSON Schema derived from the zod
 * `inputSchema`) AND validates incoming arguments against that zod schema before
 * the callback runs. Each callback routes through `dispatchToolCall`, which owns
 * the deny-by-default mutation gate and the never-throw error firewall, so the
 * safety behaviour is identical to the previous low-level wiring.
 *
 * Errors thrown inside a handler are caught by `dispatchToolCall` and converted
 * into an MCP error result (`isError: true`) so the client sees a clean failure
 * rather than a transport-level crash.
 */
export function registerTools(server: McpServer): void {
  // Invariant: every advertised tool has a handler and vice versa. Catch
  // drift at startup instead of at call time.
  for (const def of TOOL_DEFINITIONS) {
    if (!TOOL_HANDLERS[def.name]) {
      throw new Error(`Tool "${def.name}" is advertised but has no handler.`);
    }
  }
  for (const name of Object.keys(TOOL_HANDLERS)) {
    if (!TOOL_DEFINITIONS.some((d) => d.name === name)) {
      throw new Error(`Handler "${name}" has no advertised tool definition.`);
    }
  }

  // `server.registerTool` is heavily generic (it infers the argument type from
  // the zod shape). Feeding it a loop variable typed as the broad `ZodRawShape`
  // makes the compiler try to instantiate that inference infinitely, so we pin a
  // concrete, simplified call signature. Runtime behaviour is unchanged: the SDK
  // still builds the JSON Schema, validates input against the zod shape, and
  // invokes the callback with the validated args.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: ZodRawShape },
    cb: (args: Args) => Promise<CallToolResult>,
  ) => void;

  for (const def of TOOL_DEFINITIONS) {
    register(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // The zod-validated args are handed to `dispatchToolCall`, which runs the
      // mutation gate + firewall. Our envelope is a structurally valid
      // CallToolResult (text content + optional isError); cast past the SDK's
      // task-augmented union variant.
      async (args) => dispatchToolCall(def.name, args) as Promise<CallToolResult>,
    );
  }
}

/**
 * Resolve and run a tool by name. Every error — bad tool name, invalid
 * arguments, driver-not-ready, or a failure deep inside an action module — is
 * caught and converted into a structured MCP error result (`isError: true`)
 * rather than propagating as a thrown exception. This keeps the JSON-RPC
 * transport healthy and gives the client an actionable message.
 *
 * Exported so `server.ts` (and tests) can drive a tool call directly with the
 * same error semantics the registered handler uses.
 */
export async function dispatchToolCall(
  name: string,
  rawArgs: unknown,
): Promise<ToolResult & { isError?: boolean }> {
  try {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new McpToolError(`Unknown tool: "${name}".`);
    }
    const args = asArgs(rawArgs);
    // Deny-by-default gate for account-modifying actions. Runs BEFORE the handler
    // so a denied write never even launches the browser.
    //
    // A dry run is exempt: it resolves the target and returns the payload without
    // performing anything, so it is a read. Gating it would make previewing
    // impossible in exactly the configuration where a preview matters most —
    // mutations still off, deciding whether to turn them on. Every dryRun branch
    // returns before its write call, so nothing here can reach a mutation.
    if (
      isMutatingTool(name) &&
      !isDryRun(args) &&
      !mutationAllowed(name, process.env.LINKEDIN_ALLOW_MUTATIONS)
    ) {
      throw new McpToolError(
        `"${name}" takes an action on your LinkedIn account and is disabled by default. ` +
          'Enable write actions by setting LINKEDIN_ALLOW_MUTATIONS ' +
          '(e.g. LINKEDIN_ALLOW_MUTATIONS=send_message,react), or "all" to allow every write action.',
        'mutations_disabled',
      );
    }
    return await handler(args);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: message, tool: name, ...errorCodeFields(err) },
            null,
            2,
          ),
        },
      ],
    };
  }
}

/** What a caller should do about a given error code, in one clause. */
const RECOVERY: Record<string, string> = {
  needs_login: 'call linkedin_login and retry once the browser shows you signed in',
  needs_verification: 'solve the challenge in the open Chrome window, then retry the same call',
  quota_exceeded: 'wait for the daily cap to reset (linkedin_get_quota reports resetsAt); retrying now will fail identically',
  action_failed: 'the page did not match what the driver expected — retry once, then report it if it persists',
  mutations_disabled: 'set LINKEDIN_ALLOW_MUTATIONS to enable this write action',
};

/**
 * Project a thrown error's stable `code` into the MCP error envelope.
 *
 * The driver has carried typed codes since the Electron days
 * (`NeedsLoginError`, `CheckpointError`, `QuotaError`, `ActionError`), but the
 * MCP layer flattened every one of them to an English sentence — so an agent had
 * to string-match prose to tell "solve the captcha and retry" from "wait until
 * midnight" from "the selector broke". Only a known code is echoed, so an
 * unrelated library that happens to expose a `.code` cannot inject a value the
 * caller would read as one of ours.
 */
function errorCodeFields(err: unknown): { code?: string; recovery?: string } {
  if (!(err instanceof Error)) return {};
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return {};
  const recovery = RECOVERY[code];
  if (recovery === undefined) return {};
  return { code, recovery };
}
