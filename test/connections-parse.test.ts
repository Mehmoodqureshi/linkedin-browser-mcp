/**
 * Unit tests for the Sent-invitations and Connections card parsers. Pure
 * functions over the card text lines, so no browser is needed.
 *   npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConnectedOn,
  parseConnectionCards,
  parseSentCards,
} from '../src/driver/actions/connections';

test('parseConnectedOn turns the English label into YYYY-MM-DD', () => {
  assert.equal(parseConnectedOn('Connected on October 4, 2026'), '2026-10-04');
  assert.equal(parseConnectedOn('Connected on September 29, 2026'), '2026-09-29');
  assert.equal(parseConnectedOn('Connected on May 1, 2025'), '2025-05-01');
});

test('parseConnectedOn returns undefined for labels it cannot read', () => {
  assert.equal(parseConnectedOn(undefined), undefined);
  assert.equal(parseConnectedOn('Connected 2 days ago'), undefined);
  assert.equal(parseConnectedOn('Connected on Octember 4, 2026'), undefined);
});

test('parseConnectionCards reads name, headline and the connected date', () => {
  const out = parseConnectionCards([
    {
      href: 'https://www.linkedin.com/in/obaid-ur-rahmaan-5bb29814b/',
      lines: [
        'Obaid Ur-Rahmaan',
        'Co-Founder / CTO @ NaironAI',
        'Connected on October 4, 2026',
        'Message',
      ],
    },
  ]);
  assert.deepEqual(out, [
    {
      profileUrl: 'https://www.linkedin.com/in/obaid-ur-rahmaan-5bb29814b/',
      name: 'Obaid Ur-Rahmaan',
      profileId: 'obaid-ur-rahmaan-5bb29814b',
      headline: 'Co-Founder / CTO @ NaironAI',
      connectedOn: 'Connected on October 4, 2026',
      connectedDate: '2026-10-04',
    },
  ]);
});

test('parseSentCards reads the Sent label and resolves relative hrefs', () => {
  const out = parseSentCards([
    {
      href: '/in/mehwar-zaidi?miniProfileUrn=x',
      lines: ['Mehwar Zaidi', 'Remote Hiring Specialist', 'Sent 2 weeks ago', 'Withdraw'],
    },
    // A card with only buttons (no name) is dropped.
    { href: '/in/ghost', lines: ['Withdraw'] },
  ]);
  assert.deepEqual(out, [
    {
      profileUrl: 'https://www.linkedin.com/in/mehwar-zaidi',
      name: 'Mehwar Zaidi',
      profileId: 'mehwar-zaidi',
      headline: 'Remote Hiring Specialist',
      sent: 'Sent 2 weeks ago',
    },
  ]);
});
