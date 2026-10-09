import { describe, expect, it, vi } from 'vitest';
import { STATS_MISSED_LEAVE_CAP_MS, STATS_TIMEZONE } from '../constants.js';
import { computeReport } from './compute.js';
import { buildReport, scopeOf, userIdsOf } from './pipeline.js';
import { reconstructSessions } from './sessions.js';
import { DAY_MS, MINUTE_MS } from './time.js';
import type { Checkpoint, GuildVoiceHistory, PersonInfo, VoiceEvent } from './types.js';
import type * as ComputeModule from './compute.js';
import type * as SessionsModule from './sessions.js';

// The real sessions + compute run; the spies only record what the pipeline passed them.
vi.mock('./sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionsModule>();
  return { ...actual, reconstructSessions: vi.fn(actual.reconstructSessions) };
});
vi.mock('./compute.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ComputeModule>();
  return { ...actual, computeReport: vi.fn(actual.computeReport) };
});

const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const ROBOT = '100000000000000009';
const GENERAL = '200000000000000001';
const GAMING = '200000000000000002';

const NOW = Date.UTC(2026, 9, 8, 16, 0); // noon in Toronto
const T0 = NOW - 2 * DAY_MS;

let seq = 0;
function event(kind: VoiceEvent['kind'], userId: string, at: number, from: string | null, to: string | null): VoiceEvent {
  seq += 1;
  return { id: String(300000000000000000n + BigInt(seq)), kind, userId, at, from, to };
}

const events: VoiceEvent[] = [
  event('connect', ALICE, T0, null, GENERAL),
  event('connect', ROBOT, T0 + MINUTE_MS, null, GENERAL),
  event('connect', BOB, T0 + 10 * MINUTE_MS, null, GENERAL),
  event('move', BOB, T0 + 40 * MINUTE_MS, GENERAL, GAMING),
  event('disconnect', ALICE, T0 + 70 * MINUTE_MS, GENERAL, null),
  event('disconnect', BOB, T0 + 70 * MINUTE_MS, GAMING, null),
  event('disconnect', ROBOT, T0 + 80 * MINUTE_MS, GENERAL, null),
];

const history: GuildVoiceHistory = {
  channelId: 'sys',
  events,
  checkpoints: [
    { at: T0 + 5 * MINUTE_MS, present: new Map([[ALICE, GENERAL], [ROBOT, GENERAL]]) },
    // Recorded after `now` (clock skew): must not reach reconstruction.
    { at: NOW + MINUTE_MS, present: new Map([[BOB, GENERAL]]) },
  ],
  oldestEventAt: T0,
};

const people = new Map<string, PersonInfo>([
  [ALICE, { name: 'Alice', bot: false }],
  [BOB, { name: 'Bob', bot: false }],
  [ROBOT, { name: 'Robot', bot: true }],
]);

const live: Checkpoint = { at: NOW, present: new Map([[ROBOT, GAMING]]) };

describe('userIdsOf', () => {
  it('collects every user from events, stored checkpoints and the live checkpoint', () => {
    const extra: Checkpoint = { at: NOW, present: new Map([['100000000000000077', GENERAL]]) };
    expect([...userIdsOf(history, extra)].sort()).toEqual([ALICE, BOB, ROBOT, '100000000000000077'].sort());
  });
});

describe('scopeOf', () => {
  it('maps channel views to channel scope and everything else to server scope', () => {
    expect(scopeOf({ kind: 'server', page: 'overview', days: 30 })).toEqual({ kind: 'server' });
    expect(scopeOf({ kind: 'user', userId: ALICE, days: 30 })).toEqual({ kind: 'server' });
    expect(scopeOf({ kind: 'channel', channelId: GENERAL, page: 'people', days: 7 })).toEqual({ kind: 'channel', channelId: GENERAL });
  });
});

describe('buildReport', () => {
  it('drops bots from events and checkpoints before reconstruction', () => {
    const report = buildReport({ history, people, live, view: { kind: 'server', page: 'overview', days: 30 }, now: NOW });

    const [passedEvents, opts] = vi.mocked(reconstructSessions).mock.calls[0]!;
    expect(passedEvents.map((e) => e.userId)).not.toContain(ROBOT);
    expect(passedEvents).toHaveLength(events.length - 2);
    expect(opts.now).toBe(NOW);
    expect(opts.capMs).toBe(STATS_MISSED_LEAVE_CAP_MS);
    expect(opts.checkpoints.map((c) => c.at)).toEqual([T0 + 5 * MINUTE_MS, NOW]);
    for (const c of opts.checkpoints) expect([...c.present.keys()]).not.toContain(ROBOT);

    expect(report.people.map((p) => p.userId).sort()).toEqual([ALICE, BOB]);
    expect(report.totals.people).toBe(2);
    // Alice 70 min + Bob 60 min.
    expect(report.totals.personMs).toBe(130 * MINUTE_MS);
  });

  it('treats people missing from the map as humans', () => {
    const report = buildReport({ history, people: new Map(), live, view: { kind: 'server', page: 'overview', days: 30 }, now: NOW });
    expect(report.people.map((p) => p.userId)).toContain(ROBOT);
  });

  it('maps the view to the window, scope and options', () => {
    const report = buildReport({ history, people, live, view: { kind: 'channel', channelId: GAMING, page: 'people', days: 7 }, now: NOW });
    const [, opts] = vi.mocked(computeReport).mock.calls[0]!;
    expect(opts).toEqual({
      window: { from: NOW - 7 * DAY_MS, to: NOW, days: 7 },
      scope: { kind: 'channel', channelId: GAMING },
      timeZone: STATS_TIMEZONE,
      oldestEventAt: T0,
    });
    expect(report.window).toEqual({ from: NOW - 7 * DAY_MS, to: NOW, days: 7 });
    // Only Bob was in Gaming, for 30 minutes.
    expect(report.people.map((p) => p.userId)).toEqual([BOB]);
    expect(report.totals.personMs).toBe(30 * MINUTE_MS);
  });

  it('uses server scope for the user card', () => {
    const report = buildReport({ history, people, live, view: { kind: 'user', userId: BOB, days: 1 }, now: NOW });
    expect(report.scope).toEqual({ kind: 'server' });
    expect(report.window.days).toBe(1);
    // The session two days ago is outside a one-day window.
    expect(report.people).toEqual([]);
  });
});
