import { describe, expect, it } from 'vitest';
import { computeReport } from './compute.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';
import type { ComputeOptions, Ms, PersonSummary, Reconstruction, Session, StatsReport } from './types.js';

const TZ = 'America/Toronto';

/** Mon 2026-01-05 00:00 EST (UTC-5). */
const T0 = Date.UTC(2026, 0, 5, 5);
const h = (n: number): Ms => T0 + n * HOUR_MS;
/** Local wall time in winter (EST, UTC-5). */
const est = (month: number, day: number, hour = 0, minute = 0): Ms => Date.UTC(2026, month - 1, day, hour + 5, minute);

type Part = readonly [channelId: string, start: Ms, end: Ms];

interface Flags {
  readonly estimated?: boolean;
  readonly live?: boolean;
  /** The session was opened by a checkpoint (first segment's start inferred). */
  readonly startInferred?: boolean;
  /** Last segment's end inferred; defaults to `estimated`, as sessions.ts does. */
  readonly endInferred?: boolean;
}

function session(userId: string, parts: readonly Part[], flags: Flags = {}): Session {
  const segments = parts.map(([channelId, start, end], i) => ({
    userId,
    channelId,
    start,
    end,
    startInferred: i === 0 && (flags.startInferred ?? false),
    endInferred: i === parts.length - 1 && (flags.endInferred ?? flags.estimated ?? false),
  }));
  return {
    userId,
    start: segments[0]?.start ?? 0,
    end: segments[segments.length - 1]?.end ?? 0,
    segments,
    estimated: flags.estimated ?? false,
    live: flags.live ?? false,
  };
}

/** One single-channel session. */
const s = (userId: string, channelId: string, start: Ms, end: Ms, flags?: Flags) =>
  session(userId, [[channelId, start, end]], flags);

function recon(...sessions: Session[]): Reconstruction {
  return {
    sessions: [...sessions].sort((a, b) => a.start - b.start || a.userId.localeCompare(b.userId)),
    unmatchedEvents: 0,
  };
}

function compute(sessions: Session[], from: Ms, to: Ms, extra: Partial<ComputeOptions> = {}): StatsReport {
  return computeReport(recon(...sessions), {
    window: { from, to, days: Math.round((to - from) / DAY_MS) },
    scope: { kind: 'server' },
    timeZone: TZ,
    oldestEventAt: null,
    ...extra,
  });
}

function personOf(report: StatsReport, userId: string): PersonSummary {
  const p = report.people.find((x) => x.userId === userId);
  if (!p) throw new Error(`no person ${userId}`);
  return p;
}

describe('computeReport: window clipping and totals', () => {
  const report = compute(
    [
      s('100', 'c1', h(8), h(12)),
      s('200', 'c1', h(11), h(14)),
      s('300', 'c2', h(19), h(22)),
      s('400', 'c1', h(1), h(3)), // entirely before the window
    ],
    h(10),
    h(20),
  );

  it('clips totals to the window', () => {
    expect(report.totals).toEqual({ personMs: 6 * HOUR_MS, people: 3, calls: 2, sessions: 3 });
    expect(report.previousTotals).toBeNull();
    expect(report.estimatedSessions).toBe(0);
  });

  it('ranks people by time in the window', () => {
    expect(report.people.map((p) => [p.userId, p.rank, p.totalMs])).toEqual([
      ['200', 1, 3 * HOUR_MS],
      ['100', 2, 2 * HOUR_MS],
      ['300', 3, HOUR_MS],
    ]);
    expect(personOf(report, '100')).toMatchObject({
      sessions: 1,
      avgSessionMs: 2 * HOUR_MS,
      longestSessionMs: 2 * HOUR_MS,
      soloMs: HOUR_MS,
      coMs: HOUR_MS,
      previousTotalMs: null,
      bestFriend: { userId: '200', ms: HOUR_MS },
      topFriends: [{ userId: '200', ms: HOUR_MS }],
      topChannel: { channelId: 'c1', ms: 2 * HOUR_MS },
      channelsVisited: 1,
    });
    expect(personOf(report, '200')).toMatchObject({ soloMs: 2 * HOUR_MS, coMs: HOUR_MS, closes: 1, partyStarts: 0 });
    expect(personOf(report, '300')).toMatchObject({ soloMs: HOUR_MS, coMs: 0, bestFriend: null, topFriends: [] });
  });

  it('reports channels, pairs and records', () => {
    expect(report.channels).toEqual([
      { channelId: 'c1', personMs: 5 * HOUR_MS, occupiedMs: 4 * HOUR_MS, calls: 1, record: { size: 2, at: h(11) } },
      { channelId: 'c2', personMs: HOUR_MS, occupiedMs: HOUR_MS, calls: 1, record: { size: 1, at: h(19) } },
    ]);
    expect(report.pairs).toEqual([{ a: '100', b: '200', ms: HOUR_MS }]);
    expect(report.groups).toEqual([]);
    expect(report.records.longestCall).toEqual({ channelId: 'c1', start: h(10), end: h(14), peak: 2 });
    expect(report.records.biggestParty).toEqual({ channelId: 'c1', size: 2, at: h(11) });
    expect(report.records.longestSession).toEqual({ userId: '200', start: h(11), ms: 3 * HOUR_MS });
    expect(report.records.busiestDay).toEqual({ date: '2026-01-05', personMs: 6 * HOUR_MS });
  });

  it('returns an empty report when nothing is in the window', () => {
    const empty = compute([s('100', 'c1', h(1), h(2))], h(10), h(20));
    expect(empty.totals).toEqual({ personMs: 0, people: 0, calls: 0, sessions: 0 });
    expect(empty.people).toEqual([]);
    expect(empty.channels).toEqual([]);
    expect(empty.primeTime).toBeNull();
    expect(empty.records).toEqual({
      longestCall: null,
      biggestParty: null,
      busiestDay: null,
      longestSession: null,
      longestStreak: null,
    });
    expect(empty.heatmap.flat().every((v) => v === 0)).toBe(true);
  });
});

describe('computeReport: previous period', () => {
  const sessions = [
    s('100', 'c1', h(2), h(4)),
    s('300', 'c1', h(5), h(6)),
    s('200', 'c1', h(22), h(26)), // spans the boundary: 2h before, 2h after
    s('100', 'c1', h(30), h(31)),
  ];

  it('computes the previous equal-length period when history reaches it', () => {
    const report = compute(sessions, h(24), h(48), { oldestEventAt: h(0) });
    expect(report.totals).toEqual({ personMs: 3 * HOUR_MS, people: 2, calls: 2, sessions: 2 });
    expect(report.previousTotals).toEqual({ personMs: 5 * HOUR_MS, people: 3, calls: 3, sessions: 3 });
    expect(personOf(report, '100').previousTotalMs).toBe(2 * HOUR_MS);
    expect(personOf(report, '200').previousTotalMs).toBe(2 * HOUR_MS);
  });

  it('reports 0 for a person absent from the previous period', () => {
    const report = compute([...sessions, s('500', 'c2', h(40), h(41))], h(24), h(48), { oldestEventAt: h(0) });
    expect(personOf(report, '500').previousTotalMs).toBe(0);
  });

  it('omits the trend when history starts after the previous period', () => {
    const report = compute(sessions, h(24), h(48), { oldestEventAt: h(0) + 1 });
    expect(report.previousTotals).toBeNull();
    expect(report.people.every((p) => p.previousTotalMs === null)).toBe(true);
  });
});

describe('computeReport: channel scope', () => {
  const sessions = [
    session('100', [['c1', h(0), h(1)], ['c2', h(1), h(2)], ['c1', h(2), h(3)]], { estimated: true }),
    s('200', 'c2', h(0), h(3)),
  ];

  it('splits sessions into runs in the channel', () => {
    const report = compute(sessions, h(0), h(24), { scope: { kind: 'channel', channelId: 'c1' } });
    expect(report.totals).toEqual({ personMs: 2 * HOUR_MS, people: 1, calls: 2, sessions: 2 });
    expect(report.channels).toEqual([
      { channelId: 'c1', personMs: 2 * HOUR_MS, occupiedMs: 2 * HOUR_MS, calls: 2, record: { size: 1, at: h(0) } },
    ]);
    expect(report.pairs).toEqual([]);
    expect(personOf(report, '100')).toMatchObject({
      sessions: 2,
      avgSessionMs: HOUR_MS,
      longestSessionMs: HOUR_MS,
      channelsVisited: 1,
      soloMs: 2 * HOUR_MS,
    });
    // Only the last run ends where the estimated session ends.
    expect(report.estimatedSessions).toBe(1);
  });

  it('returns no channels when the channel had no time', () => {
    const report = compute(sessions, h(0), h(24), { scope: { kind: 'channel', channelId: 'c9' } });
    expect(report.channels).toEqual([]);
    expect(report.people).toEqual([]);
  });

  it('keeps moves inside one session for server scope', () => {
    const report = compute(sessions, h(0), h(24));
    expect(personOf(report, '100')).toMatchObject({ sessions: 1, longestSessionMs: 3 * HOUR_MS, channelsVisited: 2 });
    expect(report.pairs).toEqual([{ a: '100', b: '200', ms: HOUR_MS }]);
    expect(report.channels.map((c) => [c.channelId, c.personMs])).toEqual([
      ['c2', 4 * HOUR_MS],
      ['c1', 2 * HOUR_MS],
    ]);
    expect(report.estimatedSessions).toBe(1);
  });
});

describe('computeReport: co-presence', () => {
  it('does not fake a record when one leaves as another joins', () => {
    const report = compute([s('100', 'c1', h(0), h(1)), s('200', 'c1', h(1), h(2))], h(0), h(24));
    expect(report.channels[0]?.record).toEqual({ size: 1, at: h(0) });
    expect(report.pairs).toEqual([]);
    expect(report.records.biggestParty).toEqual({ channelId: 'c1', size: 1, at: h(0) });
    // The channel was never empty, so it stays one call (and never reached 2 people).
    expect(report.totals.calls).toBe(1);
    expect(report.records.longestCall).toBeNull();
  });

  it('separates solo, pair and group time', () => {
    const report = compute(
      [
        s('100', 'c1', h(0), h(4)),
        s('200', 'c1', h(1), h(4)),
        s('300', 'c1', h(2), h(3)),
      ],
      h(0),
      h(24),
    );
    expect(personOf(report, '100')).toMatchObject({ soloMs: HOUR_MS, coMs: 2 * HOUR_MS + 2 * HOUR_MS });
    expect(personOf(report, '300')).toMatchObject({ soloMs: 0, coMs: 2 * HOUR_MS });
    expect(report.pairs).toEqual([
      { a: '100', b: '200', ms: 3 * HOUR_MS },
      { a: '100', b: '300', ms: HOUR_MS },
      { a: '200', b: '300', ms: HOUR_MS },
    ]);
    expect(report.groups).toEqual([{ userIds: ['100', '200', '300'], ms: HOUR_MS }]);
  });

  it('counts the exact set of people as one group, not every triple', () => {
    const five = ['100', '200', '300', '400', '500'];
    const report = compute(
      [...five.map((u) => s(u, 'c1', h(0), u === '500' ? h(1) : h(2)))],
      h(0),
      h(24),
    );
    expect(report.groups).toEqual([
      { userIds: ['100', '200', '300', '400'], ms: HOUR_MS },
      { userIds: five, ms: HOUR_MS },
    ]);
    expect(report.pairs).toHaveLength(10);
    expect(report.pairs[0]).toEqual({ a: '100', b: '200', ms: 2 * HOUR_MS });
    expect(report.pairs[report.pairs.length - 1]).toEqual({ a: '400', b: '500', ms: HOUR_MS });
    expect(personOf(report, '100').coMs).toBe(4 * HOUR_MS + 3 * HOUR_MS);
    expect(report.records.biggestParty).toEqual({ channelId: 'c1', size: 5, at: h(0) });
  });

  it('only counts people in the same channel as together', () => {
    const report = compute([s('100', 'c1', h(0), h(1)), s('200', 'c2', h(0), h(1))], h(0), h(24));
    expect(report.pairs).toEqual([]);
    expect(personOf(report, '100').soloMs).toBe(HOUR_MS);
  });
});

describe('computeReport: party starters and closers', () => {
  const report = compute(
    [
      // c1: 200 starts, 100 joins, 200 leaves, 100 closes.
      s('200', 'c1', h(0), h(2)),
      s('100', 'c1', h(1), h(3)),
      // c2: nobody joins, so no credit.
      s('300', 'c2', h(0), h(1)),
      // c3: same-time joins and leaves -> smallest id starts, largest id closes.
      s('300', 'c3', h(5), h(6)),
      s('400', 'c3', h(5), h(6)),
      // c4: still running (500 is live): starter credited, nobody closed it.
      s('500', 'c4', h(10), h(12), { live: true }),
      s('600', 'c4', h(11), h(12)),
      // c5: began before the window: no starter credit, closer credited.
      s('700', 'c5', h(-2), h(1)),
      s('800', 'c5', h(-1), h(1)),
    ],
    h(0),
    h(12),
  );

  it('credits starts and closes', () => {
    const credit = Object.fromEntries(report.people.map((p) => [p.userId, [p.partyStarts, p.closes]]));
    expect(credit).toEqual({
      '100': [0, 1],
      '200': [1, 0],
      '300': [1, 0],
      '400': [0, 1],
      '500': [1, 0],
      '600': [0, 0],
      '700': [0, 0],
      '800': [0, 1],
    });
  });

  it('counts calls overlapping the window and picks the longest', () => {
    expect(report.totals.calls).toBe(5);
    // c1 (3h) beats c5 (clipped to 1h) and c4 (2h).
    expect(report.records.longestCall).toEqual({ channelId: 'c1', start: h(0), end: h(3), peak: 2 });
  });

  it('gives no starter credit when the call was opened by a checkpoint', () => {
    // Both were found in c1 by the startup checkpoint at h(1): nobody saw who joined first.
    const report = compute(
      [s('100', 'c1', h(1), h(3), { startInferred: true }), s('200', 'c1', h(1), h(2), { startInferred: true })],
      h(0),
      h(12),
    );
    expect(report.people.map((p) => [p.userId, p.partyStarts, p.closes])).toEqual([
      ['100', 0, 1],
      ['200', 0, 0],
    ]);
    expect(report.totals.calls).toBe(1);
  });

  it('gives no starter credit when an observed join ties with a checkpoint-opened one', () => {
    const report = compute(
      [s('100', 'c1', h(1), h(3)), s('200', 'c1', h(1), h(2), { startInferred: true })],
      h(0),
      h(12),
    );
    expect(personOf(report, '100').partyStarts).toBe(0);
    expect(personOf(report, '200').partyStarts).toBe(0);
  });

  it('gives no closer credit when the call was emptied by inferred ends', () => {
    // Both missed leaves were closed at the same ms (e.g. by a checkpoint).
    const report = compute(
      [s('100', 'c1', h(1), h(3), { estimated: true }), s('200', 'c1', h(2), h(3), { estimated: true })],
      h(0),
      h(12),
    );
    expect(report.people.map((p) => [p.userId, p.partyStarts, p.closes, p.estimatedSessions])).toEqual([
      ['100', 1, 0, 1],
      ['200', 0, 0, 1],
    ]);
    expect(report.estimatedSessions).toBe(2);
  });

  it('still credits observed boundaries next to inferred ones elsewhere', () => {
    const report = compute(
      [
        // c1: 200 was found by a checkpoint (no starter); 100's missed leave is estimated,
        // but 200 left last, observed, so 200 closes.
        s('100', 'c1', h(1), h(3), { estimated: true }),
        s('200', 'c1', h(0), h(4), { startInferred: true }),
        s('300', 'c2', h(5), h(6)),
        s('400', 'c2', h(5), h(6)),
      ],
      h(0),
      h(12),
    );
    // c2 is all observed: same-time joins and leaves, smallest id starts, largest closes.
    const credit = Object.fromEntries(report.people.map((p) => [p.userId, [p.partyStarts, p.closes]]));
    expect(credit).toEqual({ '100': [0, 0], '200': [0, 1], '300': [1, 0], '400': [0, 1] });
  });

  it('does not credit a closer after the window ends', () => {
    const later = compute([s('100', 'c1', h(0), h(5)), s('200', 'c1', h(1), h(5))], h(0), h(4));
    expect(personOf(later, '200').closes).toBe(0);
    expect(personOf(later, '100').partyStarts).toBe(1);
    expect(later.records.longestCall).toEqual({ channelId: 'c1', start: h(0), end: h(4), peak: 2 });
  });
});

describe('computeReport: streaks', () => {
  const from = est(1, 25);
  const to = est(2, 3); // "today" is 2026-02-02
  const daily = (userId: string, days: [number, number][], ms = 30 * MINUTE_MS) =>
    days.map(([month, day]) => s(userId, 'c1', est(month, day, 20), est(month, day, 20) + ms));

  const report = compute(
    [
      // Two runs; the current one crosses the month boundary and reaches today.
      ...daily('100', [[1, 26], [1, 27], [1, 30], [1, 31], [2, 1], [2, 2]]),
      // Ends yesterday: still current.
      ...daily('200', [[1, 29], [1, 30], [1, 31], [2, 1]]),
      // Last day two days ago: no current streak.
      ...daily('300', [[1, 26], [1, 27], [1, 28], [1, 31]]),
      // Under a minute does not count; exactly a minute does.
      ...daily('400', [[2, 1], [2, 2]], MINUTE_MS - 1000),
      ...daily('400', [[1, 30]], MINUTE_MS),
      // One session across local midnight counts for both days.
      s('500', 'c2', est(1, 31, 23, 30), est(2, 1, 0, 30)),
    ],
    from,
    to,
  );

  it('computes current and longest streaks', () => {
    const streaks = Object.fromEntries(report.people.map((p) => [p.userId, [p.currentStreak, p.longestStreak]]));
    expect(streaks).toEqual({
      '100': [4, 4],
      '200': [4, 4],
      '300': [0, 3],
      '400': [0, 1],
      '500': [2, 2], // Jan 31 + Feb 1 (yesterday)
    });
  });

  it('prefers the streak that ended earlier on ties', () => {
    expect(report.records.longestStreak).toEqual({ userId: '200', days: 4, endDate: '2026-02-01' });
  });

  it('counts days before the window but not after it', () => {
    // Jan 26-28 are all before `to`; Jan 29 is after it and must not count.
    const narrow = compute(daily('100', [[1, 26], [1, 27], [1, 28], [1, 29]]), est(1, 27), est(1, 29));
    expect(personOf(narrow, '100')).toMatchObject({ longestStreak: 3, currentStreak: 3 });
  });

  it('shows a 40-day streak in a 7-day window', () => {
    const days: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 0, 25 + i)); // Jan 25 .. Mar 5
      days.push([d.getUTCMonth() + 1, d.getUTCDate()]);
    }
    const to = est(3, 6); // today is Mar 5 (EST until Mar 8)
    const report = compute(daily('100', days), to - 7 * DAY_MS, to);
    expect(personOf(report, '100')).toMatchObject({ currentStreak: 40, longestStreak: 40 });
    expect(report.records.longestStreak).toEqual({ userId: '100', days: 40, endDate: '2026-03-05' });
  });

  it('counts a longest streak that ended before the window', () => {
    const report = compute(
      [
        ...daily('100', [[1, 10], [1, 11], [1, 12], [1, 13], [1, 14]]),
        ...daily('100', [[2, 1], [2, 2]]),
        ...daily('200', [[1, 31], [2, 1], [2, 2]]),
      ],
      est(1, 27),
      est(2, 3),
    );
    expect(personOf(report, '100')).toMatchObject({ currentStreak: 2, longestStreak: 5 });
    expect(report.records.longestStreak).toEqual({ userId: '100', days: 5, endDate: '2026-01-14' });
  });

  it('crosses the window start inside one day and one session', () => {
    // 30 s on each side of `from` (Jan 27 12:00): together a full minute on Jan 27.
    const from = est(1, 27, 12);
    const report = compute(
      [...daily('100', [[1, 26]]), s('100', 'c1', from - 30_000, from + 30_000)],
      from,
      est(1, 28),
    );
    expect(personOf(report, '100')).toMatchObject({ currentStreak: 2, longestStreak: 2 });
  });

  it('only uses history in the scope', () => {
    const elsewhere = daily('100', [[1, 25], [1, 26]]).map((x) => ({
      ...x,
      segments: x.segments.map((g) => ({ ...g, channelId: 'c9' })),
    }));
    const report = compute(
      [...elsewhere, ...daily('100', [[1, 27]])],
      est(1, 27),
      est(1, 28),
      { scope: { kind: 'channel', channelId: 'c1' } },
    );
    expect(personOf(report, '100')).toMatchObject({ currentStreak: 1, longestStreak: 1 });
  });
});

describe('computeReport: local time', () => {
  it('measures night time in Toronto across local midnight', () => {
    // 22:00-02:00 EST is 03:00-07:00 UTC; only 00:00-02:00 local is night.
    const report = compute([s('100', 'c1', est(1, 5, 22), est(1, 6, 2))], est(1, 5), est(1, 7));
    const p = personOf(report, '100');
    expect(p.nightMs).toBe(2 * HOUR_MS);
    expect(p.nightShare).toBe(0.5);
    // Every hour has 1h: the earliest hour wins.
    expect(p.signatureHour).toBe(0);
    expect(report.records.busiestDay).toEqual({ date: '2026-01-05', personMs: 2 * HOUR_MS });
  });

  it('picks the signature hour with the most time', () => {
    const report = compute([s('100', 'c1', est(1, 5, 22, 30), est(1, 6, 0))], est(1, 5), est(1, 7));
    expect(personOf(report, '100')).toMatchObject({ signatureHour: 23, nightMs: 0, nightShare: 0 });
  });

  it('averages the heatmap and prime time over the window wall-clock time', () => {
    const data = [
      s('100', 'c1', est(1, 5, 0), est(1, 5, 2)), // Mon 00:00-02:00
      s('200', 'c1', est(1, 5, 1), est(1, 5, 2)), // Mon 01:00-02:00
      s('100', 'c2', est(1, 6, 10), est(1, 6, 10, 30)), // Tue 10:00-10:30
    ];
    const week = compute(data, est(1, 5), est(1, 12));
    expect(week.heatmap).toHaveLength(7);
    expect(week.heatmap.every((row) => row.length === 12)).toBe(true);
    expect(week.heatmap[0]?.[0]).toBe(1.5);
    expect(week.heatmap[1]?.[5]).toBe(0.25);
    expect(week.heatmap.flat().filter((v) => v > 0)).toHaveLength(2);
    expect(week.primeTime).toEqual({ weekday: 0, hour: 1, avgPeople: 2 });

    // Two weeks: each (weekday, hour) happens twice, so the averages halve.
    const twoWeeks = compute(data, est(1, 5), est(1, 19));
    expect(twoWeeks.heatmap[0]?.[0]).toBe(0.75);
    expect(twoWeeks.primeTime).toEqual({ weekday: 0, hour: 1, avgPeople: 1 });
  });

  it('uses only the part of each hour inside the window, floored at 30 minutes', () => {
    const half = compute([s('100', 'c1', est(1, 5, 0, 30), est(1, 5, 1))], est(1, 5, 0, 30), est(1, 12));
    // Mon 00:xx has 30 min of wall time in the window, all occupied; 01:xx has a full hour.
    expect(half.heatmap[0]?.[0]).toBeCloseTo(1 / 3);
    expect(half.primeTime).toEqual({ weekday: 0, hour: 0, avgPeople: 1 });

    // Only 10 min of 00:xx is in the window: the hour divides by 30 min, the block by 70.
    const sliver = compute([s('100', 'c1', est(1, 5, 0, 50), est(1, 5, 1))], est(1, 5, 0, 50), est(1, 12));
    expect(sliver.heatmap[0]?.[0]).toBeCloseTo(1 / 7);
    expect(sliver.primeTime?.avgPeople).toBeCloseTo(1 / 3);
    expect(sliver.primeTime).toMatchObject({ weekday: 0, hour: 0 });
  });

  it.each([1, 2, 3])('does not let a few seconds at the window end win prime time (%i days)', (days) => {
    // `to` is Thu 21:00:05. 100 and 200 are together Thu 20:00 to the end; 300 joins for
    // the last 5 s, which alone would average 3 people over 5 s of Thu 21:xx.
    const to = est(1, 8, 21) + 5000;
    const report = compute(
      [
        s('100', 'c1', est(1, 8, 20), to, { live: true }),
        s('200', 'c1', est(1, 8, 20), to, { live: true }),
        s('300', 'c1', est(1, 8, 21), to, { live: true }),
      ],
      to - days * DAY_MS,
      to,
    );
    expect(report.primeTime).toEqual({ weekday: 3, hour: 20, avgPeople: 2 });
    // Thu 20-22 block: 2h + 15 s of people over 1h + 5 s of wall time.
    expect(report.heatmap[3]?.[10]).toBeCloseTo((2 * HOUR_MS + 15_000) / (HOUR_MS + 5000));
  });

  it('breaks prime-time ties by the earliest weekday and hour', () => {
    const report = compute(
      [s('100', 'c1', est(1, 7, 9), est(1, 7, 10)), s('100', 'c1', est(1, 6, 15), est(1, 6, 16))],
      est(1, 5),
      est(1, 12),
    );
    expect(report.primeTime).toEqual({ weekday: 1, hour: 15, avgPeople: 1 });
  });

  it('handles the spring-forward day (23 hours)', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT in Toronto.
    const from = Date.UTC(2026, 2, 8, 5); // 00:00 EST
    const to = Date.UTC(2026, 2, 9, 4); // next 00:00 EDT
    const report = compute([s('100', 'c1', from, Date.UTC(2026, 2, 8, 8))], from, to); // until 04:00 EDT
    const p = personOf(report, '100');
    expect(p.totalMs).toBe(3 * HOUR_MS);
    expect(p.nightMs).toBe(3 * HOUR_MS);
    // Sunday block 1 (02-03h): hour 2 never happened, so 1h of people over 1h of wall time.
    expect(report.heatmap[6]?.[0]).toBe(1);
    expect(report.heatmap[6]?.[1]).toBe(1);
    expect(report.records.busiestDay).toEqual({ date: '2026-03-08', personMs: 3 * HOUR_MS });
  });

  it('handles the fall-back day (25 hours)', () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:xx happens twice.
    const from = Date.UTC(2026, 10, 1, 4); // 00:00 EDT
    const to = Date.UTC(2026, 10, 2, 5); // next 00:00 EST
    const report = compute([s('100', 'c1', Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 1, 7))], from, to);
    expect(report.heatmap[6]?.[0]).toBeCloseTo(2 / 3);
    expect(report.primeTime).toEqual({ weekday: 6, hour: 1, avgPeople: 1 });
    expect(personOf(report, '100')).toMatchObject({ signatureHour: 1, nightMs: 2 * HOUR_MS });
  });
});

describe('computeReport: qualification', () => {
  it('needs 3 sessions and an hour in the window', () => {
    const sessionsOf = (userId: string, count: number, ms: number) =>
      Array.from({ length: count }, (_, i) => s(userId, 'c1', h(i * 2), h(i * 2) + ms));
    const report = compute(
      [
        ...sessionsOf('100', 3, 20 * MINUTE_MS),
        ...sessionsOf('200', 3, 19 * MINUTE_MS),
        ...sessionsOf('300', 2, HOUR_MS),
      ],
      h(0),
      h(24),
    );
    expect(personOf(report, '100').qualified).toBe(true);
    expect(personOf(report, '200').qualified).toBe(false);
    expect(personOf(report, '300').qualified).toBe(false);
  });
});

describe('computeReport: deterministic ties', () => {
  const sessions = [
    // Equal totals: '99' sorts before '100' (snowflake order).
    s('100', '20', h(0), h(1)),
    s('99', '100', h(0), h(1)),
    // 300 spends equal time in channels '20' and '100', with 100 and 99 respectively.
    session('300', [['100', h(0), h(1)], ['20', h(1), h(2)]]),
    s('100', '20', h(1), h(2)),
  ];
  const report = compute(sessions, h(0), h(24));

  it('orders people, pairs and channels by snowflake order on ties', () => {
    expect(report.people.map((p) => p.userId)).toEqual(['100', '300', '99']);
    expect(report.pairs).toEqual([
      { a: '99', b: '300', ms: HOUR_MS },
      { a: '100', b: '300', ms: HOUR_MS },
    ]);
    expect(personOf(report, '300')).toMatchObject({
      topChannel: { channelId: '20', ms: HOUR_MS },
      bestFriend: { userId: '99', ms: HOUR_MS },
    });
    expect(report.channels.map((c) => c.channelId)).toEqual(['20', '100']);
  });

  it('breaks record ties by the earliest time, then id', () => {
    const tie = compute(
      [s('100', 'c1', h(0), h(1)), s('200', 'c1', h(0), h(1)), s('99', 'c2', h(0), h(1)), s('300', 'c2', h(0), h(1))],
      h(0),
      h(24),
    );
    expect(tie.records.longestSession).toEqual({ userId: '99', start: h(0), ms: HOUR_MS });
    expect(tie.records.biggestParty).toEqual({ channelId: 'c1', size: 2, at: h(0) });
    expect(tie.records.longestCall).toEqual({ channelId: 'c1', start: h(0), end: h(1), peak: 2 });
  });

  it('keeps moves and back-to-back rejoins in one session and call', () => {
    expect(report.records.longestSession).toEqual({ userId: '300', start: h(0), ms: 2 * HOUR_MS });
    expect(report.records.biggestParty).toEqual({ channelId: '100', size: 2, at: h(0) });
    expect(report.records.longestCall).toEqual({ channelId: '20', start: h(0), end: h(2), peak: 2 });
  });

  it('picks the earliest busiest day on ties', () => {
    const tie = compute(
      [s('100', 'c1', est(1, 6, 12), est(1, 6, 13)), s('100', 'c1', est(1, 5, 12), est(1, 5, 13))],
      est(1, 5),
      est(1, 8),
    );
    expect(tie.records.busiestDay).toEqual({ date: '2026-01-05', personMs: HOUR_MS });
  });

  it('does not depend on input order', () => {
    const reversed = computeReport(
      { sessions: [...sessions].reverse(), unmatchedEvents: 0 },
      {
        window: { from: h(0), to: h(24), days: 1 },
        scope: { kind: 'server' },
        timeZone: TZ,
        oldestEventAt: null,
      },
    );
    expect(reversed).toEqual(report);
  });
});

describe('computeReport: performance', () => {
  it('handles two years of a busy server quickly', () => {
    // Deterministic LCG.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const now = Date.UTC(2026, 9, 8);
    const start = now - 730 * DAY_MS;
    const users = Array.from({ length: 30 }, (_, i) => String(100_000_000_000_000_000n + BigInt(i)));
    const channels = ['c1', 'c2', 'c3', 'c4'];
    const sessions: Session[] = [];
    // Each user gets back-to-back sessions with gaps; evenings cluster people together.
    for (const userId of users) {
      let t = start + rand() * DAY_MS;
      for (let i = 0; i < 700 && t < now; i++) {
        const length = 10 * MINUTE_MS + rand() * 4 * HOUR_MS;
        const end = Math.min(now, t + length);
        const parts: Part[] = [];
        let cursor = t;
        while (cursor < end) {
          const next = rand() < 0.2 ? Math.min(end, cursor + rand() * (end - cursor)) : end;
          const channelId = channels[Math.floor(rand() * rand() * channels.length)] ?? 'c1';
          parts.push([channelId, cursor, Math.max(next, cursor + 1)]);
          cursor = Math.max(next, cursor + 1);
        }
        sessions.push(session(userId, parts, { estimated: rand() < 0.05, live: end === now }));
        t = end + rand() * 2 * DAY_MS;
      }
    }
    expect(sessions.length).toBeGreaterThan(15_000);

    const began = performance.now();
    const report = computeReport(recon(...sessions), {
      window: { from: now - 365 * DAY_MS, to: now, days: 365 },
      scope: { kind: 'server' },
      timeZone: TZ,
      oldestEventAt: start,
    });
    const elapsed = performance.now() - began;

    expect(report.people.length).toBe(30);
    expect(report.previousTotals).not.toBeNull();
    expect(report.totals.personMs).toBe(report.channels.reduce((sum, c) => sum + c.personMs, 0));
    // Generous for slow CI; an O(n^2) pass over ~20k sessions would still blow through it.
    expect(elapsed).toBeLessThan(5000);
  });
});
