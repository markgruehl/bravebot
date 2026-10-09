import { describe, expect, it } from 'vitest';
import { pickPersona } from './persona.js';
import { HOUR_MS } from './time.js';
import type { PersonSummary, StatsReport } from './types.js';

/** A qualified, unremarkable person: no trait clears its floor. */
function person(userId: string, overrides: Partial<PersonSummary> = {}): PersonSummary {
  return {
    userId,
    rank: 1,
    totalMs: 10 * HOUR_MS,
    previousTotalMs: null,
    sessions: 10,
    avgSessionMs: HOUR_MS,
    longestSessionMs: 2 * HOUR_MS,
    channelsVisited: 2,
    soloMs: HOUR_MS,
    coMs: 2 * HOUR_MS,
    nightMs: HOUR_MS,
    nightShare: 0.1,
    currentStreak: 0,
    longestStreak: 2,
    partyStarts: 1,
    closes: 1,
    bestFriend: null,
    topFriends: [],
    topChannel: null,
    signatureHour: 21,
    estimatedSessions: 0,
    qualified: true,
    ...overrides,
  };
}

function report(people: PersonSummary[]): StatsReport {
  return { people } as unknown as StatsReport;
}

function personaOf(p: PersonSummary, others: PersonSummary[] = []) {
  return pickPersona(p, report([p, ...others]));
}

describe('pickPersona', () => {
  it('calls unqualified people a Drop-in', () => {
    const p = person('1', { qualified: false, sessions: 2, totalMs: 45 * 60_000, nightShare: 0.9 });
    expect(personaOf(p)).toEqual({ emoji: '👋', title: 'Drop-in', line: 'Drops in now and then: 2 sessions, 45m in voice.' });
  });

  it('falls back to Regular', () => {
    expect(personaOf(person('1'))).toMatchObject({ emoji: '🎧', title: 'Regular' });
    expect(personaOf(person('1')).line).toContain('10 sessions');
  });

  it.each([
    [{ nightShare: 0.38, nightMs: 3.8 * HOUR_MS }, '🦉', 'Night Owl', '38% of their voice time is between midnight and 6 am.'],
    [{ longestSessionMs: 7 * HOUR_MS + 12 * 60_000 }, '🏃', 'Marathoner', 'Once stayed in voice for 7h 12m straight.'],
    [{ channelsVisited: 6 }, '🦋', 'Social Butterfly', 'Hopped between 6 different channels.'],
    [{ partyStarts: 5 }, '🎉', 'Party Starter', 'Started 5 calls that others joined.'],
    [{ closes: 6 }, '🚪', 'Last One Out', 'Was the last to leave 6 calls.'],
    [{ soloMs: 6.2 * HOUR_MS }, '🐺', 'Lone Wolf', '62% of their voice time is solo.'],
    [{ coMs: 40 * HOUR_MS }, '🧲', 'Social Glue', 'Racked up 40h with friends, counted per friend.'],
    [{ currentStreak: 7 }, '🔥', 'On Fire', 'In voice 7 days in a row and counting.'],
  ] as const)('picks %o', (overrides, emoji, title, line) => {
    expect(personaOf(person('1', overrides))).toEqual({ emoji, title, line });
  });

  it('ignores traits below their absolute floor', () => {
    expect(personaOf(person('1', { currentStreak: 4, nightShare: 0.2, partyStarts: 2 })).title).toBe('Regular');
  });

  it('prefers the trait where the person leads the group', () => {
    // Night share is only half of the leader's, but nobody beats their party starts.
    const p = person('1', { nightShare: 0.3, partyStarts: 4 });
    const leader = person('2', { nightShare: 0.6, partyStarts: 1 });
    expect(personaOf(p, [leader]).title).toBe('Party Starter');
    expect(personaOf(leader, [p]).title).toBe('Night Owl');
  });

  it('only compares against qualified people', () => {
    const p = person('1', { nightShare: 0.3, partyStarts: 4 });
    const dropIn = person('3', { qualified: false, partyStarts: 40 });
    // The drop-in's 40 starts don't count, so both traits score 1: the margin over the
    // floor decides (4/3 starts vs 0.3/0.25 night share).
    expect(personaOf(p, [dropIn]).title).toBe('Party Starter');
  });

  it('is deterministic regardless of the order of people', () => {
    const a = person('1', { nightShare: 0.3, longestSessionMs: 5 * HOUR_MS, channelsVisited: 5 });
    const b = person('2', { nightShare: 0.5, longestSessionMs: 9 * HOUR_MS, channelsVisited: 4 });
    const c = person('3', { nightShare: 0.4, longestSessionMs: 6 * HOUR_MS, channelsVisited: 8 });
    const first = pickPersona(a, report([a, b, c]));
    expect(pickPersona(a, report([c, b, a]))).toEqual(first);
    expect(pickPersona(a, report([b, a, c]))).toEqual(first);
    expect(pickPersona(a, report([a, b, c]))).toEqual(first);
  });

  it('survives non-finite values', () => {
    const p = person('1', { nightShare: Number.NaN, totalMs: 0, soloMs: 0 });
    expect(personaOf(p, [person('2', { nightShare: Number.NaN })]).title).toBe('Regular');
  });
});
