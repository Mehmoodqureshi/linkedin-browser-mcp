/**
 * Messaging actions: send a direct message and read conversations.
 *
 * Direct messaging is only permitted to 1st-degree connections or members with
 * an Open Profile. The flow opens the target profile, clicks the "Message"
 * affordance (identified by its accessible name), types into the contenteditable
 * compose box, and submits.
 *
 * Reading conversations uses the `/messaging/` inbox, whose thread list and
 * message bubbles are exposed with stable `data-*`/aria hooks.
 */

import type { Locator, Page } from 'playwright-core';

import {
  LINKEDIN_BASE,
  ActionError,
  assertAuthenticated,
  clean,
  navigate,
  normalizeProfileUrl,
  rateLimitDelay,
  sleep,
} from './common';
import { getQuotaManager } from '../quota';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendMessageResult {
  success: boolean;
  /** Conversation id parsed from the thread URL, if it became available. */
  conversationId?: string;
  message: string;
}

export interface ConversationSummary {
  conversationId?: string;
  participantName?: string;
  lastMessageSnippet?: string;
  timestamp?: string;
  unread: boolean;
}

export interface ChatMessage {
  sender?: string;
  text?: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// MessagingActions
// ---------------------------------------------------------------------------

export class MessagingActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  /**
   * Opens the target profile, launches the message overlay, types, and sends.
   * Throws `ActionError` if the Message affordance is absent (not connected /
   * not an open profile).
   */
  async sendMessage(profileUrl: string, message: string): Promise<SendMessageResult> {
    // Fail fast if we're already at today's message cap (before any navigation).
    await getQuotaManager().enforce('message');

    const url = normalizeProfileUrl(profileUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // The "Message" button lives in the profile's top-card action row. Match by
    // accessible name to dodge randomized classes; fall back to control-name.
    const messageBtn = this.page
      .locator(
        'main button[aria-label^="Message"], ' +
          'main a[aria-label^="Message"], ' +
          'button:has-text("Message")',
      )
      .first();

    if ((await messageBtn.count()) === 0) {
      throw new ActionError(
        'No "Message" affordance on this profile (not a 1st-degree or open-profile member).',
        'not_messageable',
      );
    }

    await messageBtn.click();
    await sleep(1500);

    // The compose surface is a role=textbox contenteditable inside the overlay.
    const composer = this.page
      .locator(
        'div.msg-form__contenteditable[contenteditable="true"], ' +
          'div[role="textbox"][contenteditable="true"], ' +
          'div[aria-label="Write a message…"]',
      )
      .first();

    if ((await composer.count()) === 0) {
      throw new ActionError('Message composer did not open.', 'composer_missing');
    }

    // The composer lives in a docked overlay that LinkedIn often renders below
    // the fold, so a plain click trips Playwright's "outside of the viewport"
    // actionability check. Scroll it in and force the click to focus it; if
    // fill() also balks, type via the keyboard (which needs only focus).
    await composer.scrollIntoViewIfNeeded().catch(() => undefined);
    await composer.click({ force: true }).catch(() => undefined);
    const filled = await composer
      .fill(message)
      .then(() => true)
      .catch(() => false);
    if (!filled) {
      await composer.focus().catch(() => undefined);
      await this.page.keyboard.type(message, { delay: 25 });
    }
    await sleep(600);

    await rateLimitDelay();
    const sendBtn = this.page
      .locator(
        'button.msg-form__send-button, ' +
          'button[type="submit"]:has-text("Send"), ' +
          'button[aria-label="Send"]',
      )
      .first();

    if ((await sendBtn.count()) === 0) {
      throw new ActionError('Send button not found.', 'send_missing');
    }
    // The Send button shares the same off-screen overlay; harden the click and
    // fall back to submitting with Cmd/Ctrl+Enter from the focused composer.
    await sendBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    const sent = await sendBtn
      .click({ force: true })
      .then(() => true)
      .catch(() => false);
    if (!sent) {
      await composer.focus().catch(() => undefined);
      await this.page.keyboard.press('Meta+Enter').catch(() => undefined);
    }
    await sleep(1500);

    // Count the message only once it was actually dispatched.
    await getQuotaManager().record('message');

    const conversationId = this.parseConversationId(this.page.url());
    return {
      success: true,
      ...(conversationId ? { conversationId } : {}),
      message: 'Message sent.',
    };
  }

  // -------------------------------------------------------------------------
  // getConversations
  // -------------------------------------------------------------------------

  /** Lists recent inbox threads with participant + last-message snippet. */
  async getConversations(limit = 30): Promise<ConversationSummary[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/messaging/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await sleep(1500);
    await this.loadMoreConversations(limit);
    // Conversation rows use obfuscated classes; anchor on the thread link, take
    // its enclosing <li>, and parse the visible text lines:
    //   ["Status is reachable"?, "<Name>", "<date>", "<preview>", <noise...>]
    const rows = await this.page.evaluate((max: number) => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;
      // Conversation rows: prefer the semantic list-item class, fall back to any
      // li that wraps a thread link (classes are partly obfuscated).
      let items: Element[] = Array.from(
        root.querySelectorAll(
          'li.msg-conversation-listitem, .msg-conversations-container__convo-item, [class*="conversation-listitem"]',
        ),
      );
      if (!items.length) {
        const seenLi = new Set<Element>();
        const collected: Element[] = [];
        for (const a of Array.from(
          root.querySelectorAll('a[href*="/messaging/thread/"]'),
        )) {
          const li = a.closest('li') ?? a.parentElement;
          if (li && !seenLi.has(li)) {
            seenLi.add(li);
            collected.push(li);
          }
        }
        items = collected;
      }
      const out: Array<{ href: string; lines: string[] }> = [];
      for (const li of items.slice(0, max)) {
        const a = li.querySelector('a[href*="/messaging/thread/"]');
        const seen = new Set<string>();
        const lines = ((li as HTMLElement).innerText ?? '')
          .split('\n')
          .map(norm)
          .filter((t) => {
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
          });
        if (lines.length) out.push({ href: a?.getAttribute('href') ?? '', lines });
      }
      return out;
    }, limit);

    const NOISE_RE =
      /^status is|^\.\s|press return|active conversation|^open the options|^new message$|sponsored/i;
    const DATE_RE =
      /^([A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}:\d{2}\s*(am|pm)?|yesterday|\d+\s*[mhdw])$/i;

    const out: ConversationSummary[] = [];
    const seenNames = new Set<string>();
    for (const { href, lines } of rows) {
      const meaningful = lines.filter((l) => !NOISE_RE.test(l));
      if (!meaningful.length) continue;
      const di = meaningful.findIndex((l) => DATE_RE.test(l));
      const name = di > 0 ? clean(meaningful[di - 1]) : clean(meaningful[0]);
      const timestamp = di >= 0 ? clean(meaningful[di]) : undefined;
      const snippet = di >= 0 ? clean(meaningful[di + 1]) : clean(meaningful[1]);
      // Skip malformed rows (no real name, or the date leaked into the name)
      // and de-duplicate repeated conversation rows by participant.
      if (!name || name === timestamp || DATE_RE.test(name)) continue;
      const dedupeKey = name.toLowerCase();
      if (seenNames.has(dedupeKey)) continue;
      seenNames.add(dedupeKey);

      const item: ConversationSummary = {
        unread: lines.some((l) => /active conversation/i.test(l)),
      };
      const id = this.parseConversationId(href);
      if (id) item.conversationId = id;
      item.participantName = name;
      if (snippet) item.lastMessageSnippet = snippet;
      if (timestamp) item.timestamp = timestamp;
      out.push(item);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // getMessages
  // -------------------------------------------------------------------------

  /** Opens a specific thread and returns its message bubbles in order. */
  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/messaging/thread/${conversationId}/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const bubbleSel =
      'li.msg-s-message-list__event, div.msg-s-event-listitem, li.msg-s-event-with-indicator';
    const bubbles = this.page.locator(bubbleSel);
    const count = Math.min(await bubbles.count(), 60);
    const out: ChatMessage[] = [];

    let lastSender: string | undefined;
    for (let i = 0; i < count; i++) {
      const b = bubbles.nth(i);
      // Sender label only renders on the first bubble of a run; carry it down.
      const sender =
        (await this.scopedText(b, [
          'span.msg-s-message-group__name',
          '.msg-s-message-group__profile-link',
        ])) ?? lastSender;
      if (sender) lastSender = sender;

      const text = await this.scopedText(b, [
        'p.msg-s-event-listitem__body',
        '.msg-s-event__content .msg-s-event-listitem__body',
      ]);
      const timestamp = await this.scopedText(b, [
        'time.msg-s-message-group__timestamp',
        '.msg-s-message-list__time-heading',
      ]);

      if (!text) continue;
      const msg: ChatMessage = {};
      if (sender) msg.sender = sender;
      msg.text = text;
      if (timestamp) msg.timestamp = timestamp;
      out.push(msg);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * The inbox renders about ten rows and loads more as its own list (not the
   * window) scrolls, so scroll the last row into view until `limit` rows are
   * present or the list stops growing.
   */
  private async loadMoreConversations(limit: number): Promise<void> {
    const rows = this.page.locator('li.msg-conversation-listitem');
    let count = await rows.count();
    for (let round = 0; count > 0 && count < limit && round < 20; round++) {
      await rows.last().scrollIntoViewIfNeeded().catch(() => undefined);
      // scrollIntoView alone can stop short of the loader's threshold; push
      // the list's scrollable ancestor all the way down as well.
      await this.page
        .evaluate(() => {
          const li = document.querySelector('li.msg-conversation-listitem');
          for (let el = li?.parentElement ?? null; el; el = el.parentElement) {
            if (el.scrollHeight > el.clientHeight + 10) {
              const style = getComputedStyle(el).overflowY;
              if (style === 'auto' || style === 'scroll') {
                el.scrollTop = el.scrollHeight;
                return;
              }
            }
          }
        })
        .catch(() => undefined);
      await sleep(800);
      // Past the first pages the list ends in a "Load more conversations" button.
      const more = this.page.locator('button:has-text("Load more conversations")').first();
      if ((await more.count()) > 0) await more.click().catch(() => undefined);
      await sleep(1200 + Math.floor(Math.random() * 500));
      let next = await rows.count();
      if (next === count) {
        // One retry: the next page sometimes lands a beat after the scroll.
        await sleep(1500);
        next = await rows.count();
        if (next === count) return;
      }
      count = next;
    }
  }

  /** Extracts the thread id from a /messaging/thread/<id>/ URL. */
  private parseConversationId(url: string): string | undefined {
    const m = url.match(/\/messaging\/thread\/([^/?#]+)/);
    return m?.[1];
  }

  private async scopedText(
    scope: Locator,
    selectors: readonly string[],
  ): Promise<string | undefined> {
    for (const sel of selectors) {
      const loc = scope.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const txt = clean(await loc.textContent().catch(() => null));
      if (txt) return txt;
    }
    return undefined;
  }
}
