/**
 * Voice stats computation (pure, deterministic): Reconstruction + window/scope -> StatsReport.
 *
 * - Scope: server = every segment; channel = only that channel's segments, where a "session"
 *   is a maximal run of a Session's consecutive segments in the channel.
 * - Everything is clipped to the window [from, to) except call detection (sweep.ts), which
 *   sees whole segments so a call that began before the window keeps its real start.
 * - Local-time stats (heatmap, prime time, night owl, signature hour, busiest day, streaks)
 *   slice each clipped segment at local hour boundaries. Heatmap and prime-time averages
 *   divide by the wall-clock time of the window in each (weekday, hour), so they stay
 *   correct across DST changes and partial weeks. That denominator is at least
 *   MIN_BUCKET_WALL_MS, so a sliver of an hour at a window edge (a few seconds before `to`)
 *   cannot post a huge average and win prime time.
 * - Streaks are the exception to window clipping: they run over ALL cached history up to `to`
 *   (segments clipped to (-inf, to) only), so a 7-day window still shows a 40-day streak and
 *   a longest streak that ended before the window. Only people with time in the window get
 *   a summary, so only they are considered for the streak record.
 * - Party starter / closer credit needs an observed boundary (see sweep.ts).
 * - The previous period [from - (to - from), from) only feeds the trend (totals and each
 *   person's previousTotalMs), and only when history reaches its start.
 */
import {
  STATS_MIN_SESSIONS,
  STATS_MIN_TOTAL_MS,
  STATS_NIGHT_END_HOUR,
  STATS_NIGHT_START_HOUR,
  STATS_STREAK_MIN_MS,
} from '../constants.js';
import { compareIds, sweep, type SweepCall, type SweepSegment } from './sweep.js';
import { addDays, dateKeyOf, daysBetween, forEachLocalHourSlice, MINUTE_MS } from './time.js';
import type {
  ChannelStat,
  ComputeOptions,
  GroupStat,
  Ms,
  PairStat,
  PersonSummary,
  Reconstruction,
  Records,
  Segment,
  StatsReport,
  Totals,
  UserMs,
  Weekday,
} from './types.js';

/** A scoped session: the Session itself (server) or one run of it in the channel. */
interface Run {
  readonly userId: string;
  readonly start: Ms;
  readonly end: Ms;
  readonly segments: readonly Segment[];
  /** The run ends where its session ends and that end was inferred. */
  readonly estimated: boolean;
}

interface PersonAcc {
  totalMs: number;
  sessions: number;
  longestSessionMs: number;
  nightMs: number;
  readonly channelMs: Map<string, number>;
  readonly hourMs: number[];
  readonly dayMs: Map<string, number>;
  partyStarts: number;
  closes: number;
  estimatedSessions: number;
}

interface Streak {
  readonly current: number;
  readonly longest: number;
  /** Local date the (earliest) longest run ends on; null when there is no qualifying day. */
  readonly longestEnd: string | null;
}

const HOURS = 24;
const BLOCKS = 12;
/** Floor for the wall-clock denominator of a heatmap cell or prime-time bucket with any wall time. */
const MIN_BUCKET_WALL_MS = 30 * MINUTE_MS;

const add = (map: Map<string, number>, key: string, ms: number) => map.set(key, (map.get(key) ?? 0) + ms);
const bump = (values: number[], i: number, ms: number) => (values[i] = (values[i] ?? 0) + ms);
const overlap = (start: Ms, end: Ms, from: Ms, to: Ms) => Math.max(0, Math.min(end, to) - Math.max(start, from));

export function computeReport(recon: Reconstruction, opts: ComputeOptions): StatsReport {
  const { window, scope, timeZone, oldestEventAt } = opts;
  const { from, to } = window;
  const prevFrom = from - (to - from);
  const hasPrevious = oldestEventAt !== null && oldestEventAt <= prevFrom;

  // Scoped sessions, and every scoped segment for the occupancy sweep.
  const runs: Run[] = [];
  const sweepSegments: SweepSegment[] = [];
  for (const session of recon.sessions) {
    const segments = session.segments.filter(
      (s) => s.end > s.start && (scope.kind === 'server' || s.channelId === scope.channelId),
    );
    for (const s of segments) {
      sweepSegments.push({ ...s, liveTail: session.live && s.end === session.end });
    }
    if (scope.kind === 'server') {
      if (segments.length > 0) {
        const { userId, start, end, estimated } = session;
        runs.push({ userId, start, end, segments, estimated });
      }
      continue;
    }
    let run: Segment[] = [];
    const flush = () => {
      const first = run[0];
      const last = run[run.length - 1];
      if (first && last) {
        runs.push({
          userId: session.userId,
          start: first.start,
          end: last.end,
          segments: run,
          estimated: session.estimated && last.end === session.end,
        });
      }
      run = [];
    };
    for (const s of segments) {
      const last = run[run.length - 1];
      if (last && last.end !== s.start) flush();
      run.push(s);
    }
    flush();
  }

  // Per-person accumulation over the window, plus window-wide local-time buckets.
  const persons = new Map<string, PersonAcc>();
  const person = (userId: string): PersonAcc => {
    let acc = persons.get(userId);
    if (!acc) {
      acc = {
        totalMs: 0,
        sessions: 0,
        longestSessionMs: 0,
        nightMs: 0,
        channelMs: new Map(),
        hourMs: new Array<number>(HOURS).fill(0),
        dayMs: new Map(),
        partyStarts: 0,
        closes: 0,
        estimatedSessions: 0,
      };
      persons.set(userId, acc);
    }
    return acc;
  };
  const weekdayHourMs = new Array<number>(7 * HOURS).fill(0);
  const dayMs = new Map<string, number>();
  let estimatedSessions = 0;
  let longestSession: Records['longestSession'] = null;
  const previous = { personMs: 0, sessions: 0, byUser: new Map<string, number>() };

  for (const run of runs) {
    const prevMs = overlap(run.start, run.end, prevFrom, from);
    if (prevMs > 0) {
      previous.personMs += prevMs;
      previous.sessions++;
      add(previous.byUser, run.userId, prevMs);
    }

    const clippedStart = Math.max(run.start, from);
    const ms = Math.min(run.end, to) - clippedStart;
    if (ms <= 0) continue;
    const acc = person(run.userId);
    acc.sessions++;
    acc.longestSessionMs = Math.max(acc.longestSessionMs, ms);
    if (run.estimated) {
      estimatedSessions++;
      acc.estimatedSessions++;
    }
    if (
      !longestSession ||
      ms > longestSession.ms ||
      (ms === longestSession.ms &&
        (clippedStart < longestSession.start ||
          (clippedStart === longestSession.start && compareIds(run.userId, longestSession.userId) < 0)))
    ) {
      longestSession = { userId: run.userId, start: clippedStart, ms };
    }

    for (const seg of run.segments) {
      const start = Math.max(seg.start, from);
      const end = Math.min(seg.end, to);
      if (end <= start) continue;
      acc.totalMs += end - start;
      add(acc.channelMs, seg.channelId, end - start);
      forEachLocalHourSlice(start, end, timeZone, (s, e, parts) => {
        const len = e - s;
        bump(weekdayHourMs, parts.weekday * HOURS + parts.hour, len);
        bump(acc.hourMs, parts.hour, len);
        if (parts.hour >= STATS_NIGHT_START_HOUR && parts.hour < STATS_NIGHT_END_HOUR) acc.nightMs += len;
        add(dayMs, parts.dateKey, len);
        add(acc.dayMs, parts.dateKey, len);
      });
    }
  }

  // Occupancy: co-presence, channel records and calls.
  const swept = sweep(sweepSegments, from, to);
  const channelCalls = new Map<string, number>();
  let calls = 0;
  let previousCalls = 0;
  let longestCall: Records['longestCall'] = null;
  for (const call of swept.calls) {
    if (call.start < from && call.end > prevFrom) previousCalls++;
    if (!(call.start < to && call.end > from)) continue;
    calls++;
    add(channelCalls, call.channelId, 1);
    if (call.peak < 2) continue;
    if (call.start >= from && call.starter !== null) person(call.starter).partyStarts++;
    if (!call.open && call.end <= to && call.closer !== null) person(call.closer).closes++;
    longestCall = longerCall(longestCall, call, from, to);
  }

  const channels: ChannelStat[] = [...swept.channels.values()]
    .filter((c) => c.personMs > 0)
    .map((c) => ({
      channelId: c.channelId,
      personMs: c.personMs,
      occupiedMs: c.occupiedMs,
      calls: channelCalls.get(c.channelId) ?? 0,
      record: c.record ?? { size: 0, at: from },
    }))
    .sort((a, b) => b.personMs - a.personMs || compareIds(a.channelId, b.channelId));

  let biggestParty: Records['biggestParty'] = null;
  for (const c of channels) {
    if (
      !biggestParty ||
      c.record.size > biggestParty.size ||
      (c.record.size === biggestParty.size && c.record.at < biggestParty.at)
    ) {
      biggestParty = { channelId: c.channelId, size: c.record.size, at: c.record.at };
    }
  }

  const pairs: PairStat[] = [];
  const friends = new Map<string, UserMs[]>();
  const friend = (userId: string) => {
    let list = friends.get(userId);
    if (!list) friends.set(userId, (list = []));
    return list;
  };
  for (const [a, partners] of swept.pairs) {
    for (const [b, ms] of partners) {
      if (ms <= 0) continue;
      pairs.push({ a, b, ms });
      friend(a).push({ userId: b, ms });
      friend(b).push({ userId: a, ms });
    }
  }
  pairs.sort((x, y) => y.ms - x.ms || compareIds(x.a, y.a) || compareIds(x.b, y.b));

  const groups: GroupStat[] = [...swept.groups.values()]
    .filter((g) => g.ms > 0)
    .map((g) => ({ userIds: g.userIds, ms: g.ms }))
    .sort((x, y) => y.ms - x.ms || compareIdLists(x.userIds, y.userIds));

  // People.
  const ranked = [...persons.entries()]
    .filter(([, acc]) => acc.totalMs > 0)
    .sort(([a, x], [b, y]) => y.totalMs - x.totalMs || compareIds(a, b));

  // Streaks over all cached history up to `to`: each person's in-window days plus their
  // scoped time before the window (only for people with time in the window).
  const historyDayMs = new Map<string, Map<string, number>>();
  for (const [userId, acc] of ranked) historyDayMs.set(userId, new Map(acc.dayMs));
  for (const run of runs) {
    const days = run.start < from ? historyDayMs.get(run.userId) : undefined;
    if (!days) continue;
    for (const seg of run.segments) {
      const end = Math.min(seg.end, from);
      if (end <= seg.start) continue;
      forEachLocalHourSlice(seg.start, end, timeZone, (s, e, parts) => add(days, parts.dateKey, e - s));
    }
  }
  const today = dateKeyOf(to - 1, timeZone);
  const streaks = new Map<string, Streak>();
  for (const [userId, days] of historyDayMs) streaks.set(userId, streakOf(days, today));
  const people: PersonSummary[] = ranked.map(([userId, acc], i) => {
    const streak = streaks.get(userId) ?? { current: 0, longest: 0, longestEnd: null };
    const topFriends = (friends.get(userId) ?? []).sort((x, y) => y.ms - x.ms || compareIds(x.userId, y.userId));
    return {
      userId,
      rank: i + 1,
      totalMs: acc.totalMs,
      previousTotalMs: hasPrevious ? (previous.byUser.get(userId) ?? 0) : null,
      sessions: acc.sessions,
      avgSessionMs: acc.sessions > 0 ? acc.totalMs / acc.sessions : 0,
      longestSessionMs: acc.longestSessionMs,
      channelsVisited: acc.channelMs.size,
      soloMs: swept.soloMs.get(userId) ?? 0,
      coMs: swept.coMs.get(userId) ?? 0,
      nightMs: acc.nightMs,
      nightShare: acc.totalMs > 0 ? acc.nightMs / acc.totalMs : 0,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      partyStarts: acc.partyStarts,
      closes: acc.closes,
      bestFriend: topFriends[0] ?? null,
      topFriends: topFriends.slice(0, 3),
      topChannel: topChannelOf(acc.channelMs),
      signatureHour: argmax(acc.hourMs),
      estimatedSessions: acc.estimatedSessions,
      qualified: acc.sessions >= STATS_MIN_SESSIONS && acc.totalMs >= STATS_MIN_TOTAL_MS,
    };
  });

  let longestStreak: Records['longestStreak'] = null;
  for (const p of people) {
    const end = streaks.get(p.userId)?.longestEnd;
    if (!end) continue;
    if (
      !longestStreak ||
      p.longestStreak > longestStreak.days ||
      (p.longestStreak === longestStreak.days &&
        (end < longestStreak.endDate ||
          (end === longestStreak.endDate && compareIds(p.userId, longestStreak.userId) < 0)))
    ) {
      longestStreak = { userId: p.userId, days: p.longestStreak, endDate: end };
    }
  }

  let busiestDay: Records['busiestDay'] = null;
  for (const [date, ms] of dayMs) {
    if (ms <= 0) continue;
    if (!busiestDay || ms > busiestDay.personMs || (ms === busiestDay.personMs && date < busiestDay.date)) {
      busiestDay = { date, personMs: ms };
    }
  }

  // Average people per local (weekday, hour): person-ms over the window's wall-clock ms there
  // (floored at MIN_BUCKET_WALL_MS when there is any).
  const weekdayHourWall = new Array<number>(7 * HOURS).fill(0);
  forEachLocalHourSlice(from, to, timeZone, (s, e, parts) => {
    bump(weekdayHourWall, parts.weekday * HOURS + parts.hour, e - s);
  });
  const heatmap: number[][] = [];
  let primeTime: StatsReport['primeTime'] = null;
  for (let w = 0; w < 7; w++) {
    const row: number[] = [];
    for (let b = 0; b < BLOCKS; b++) {
      let ms = 0;
      let wall = 0;
      for (const h of [2 * b, 2 * b + 1]) {
        ms += weekdayHourMs[w * HOURS + h] ?? 0;
        wall += weekdayHourWall[w * HOURS + h] ?? 0;
      }
      row.push(wall > 0 ? ms / Math.max(wall, MIN_BUCKET_WALL_MS) : 0);
    }
    heatmap.push(row);
    for (let h = 0; h < HOURS; h++) {
      const ms = weekdayHourMs[w * HOURS + h] ?? 0;
      const wall = weekdayHourWall[w * HOURS + h] ?? 0;
      if (ms <= 0 || wall <= 0) continue;
      const avgPeople = ms / Math.max(wall, MIN_BUCKET_WALL_MS);
      if (!primeTime || avgPeople > primeTime.avgPeople) primeTime = { weekday: w as Weekday, hour: h, avgPeople };
    }
  }

  const totals: Totals = {
    personMs: people.reduce((sum, p) => sum + p.totalMs, 0),
    people: people.length,
    calls,
    sessions: people.reduce((sum, p) => sum + p.sessions, 0),
  };
  const previousTotals: Totals | null = hasPrevious
    ? { personMs: previous.personMs, people: previous.byUser.size, calls: previousCalls, sessions: previous.sessions }
    : null;

  return {
    window,
    scope,
    timeZone,
    oldestEventAt,
    estimatedSessions,
    totals,
    previousTotals,
    people,
    pairs,
    groups,
    channels,
    heatmap,
    primeTime,
    records: { longestCall, biggestParty, busiestDay, longestSession, longestStreak },
  };
}

/** The longer of two calls by clipped duration (ties: earlier clipped start, then channel). */
function longerCall(best: Records['longestCall'], call: SweepCall, from: Ms, to: Ms): Records['longestCall'] {
  const start = Math.max(call.start, from);
  const end = Math.min(call.end, to);
  if (
    best &&
    (end - start < best.end - best.start ||
      (end - start === best.end - best.start &&
        (start > best.start || (start === best.start && compareIds(call.channelId, best.channelId) >= 0))))
  ) {
    return best;
  }
  return { channelId: call.channelId, start, end, peak: call.peak };
}

/** Streaks over local dates with at least STATS_STREAK_MIN_MS in voice. */
function streakOf(dayMs: ReadonlyMap<string, number>, today: string): Streak {
  const dates = [...dayMs.entries()]
    .filter(([, ms]) => ms >= STATS_STREAK_MIN_MS)
    .map(([date]) => date)
    .sort();
  let longest = 0;
  let longestEnd: string | null = null;
  let run = 0;
  let prev: string | null = null;
  for (const date of dates) {
    run = prev !== null && daysBetween(prev, date) === 1 ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = date;
    }
    prev = date;
  }
  // `run` is now the length of the last run, which ends on `prev`.
  const current = prev === today || prev === addDays(today, -1) ? run : 0;
  return { current, longest, longestEnd };
}

function topChannelOf(channelMs: ReadonlyMap<string, number>): PersonSummary['topChannel'] {
  let best: PersonSummary['topChannel'] = null;
  for (const [channelId, ms] of channelMs) {
    if (!best || ms > best.ms || (ms === best.ms && compareIds(channelId, best.channelId) < 0)) {
      best = { channelId, ms };
    }
  }
  return best;
}

/** Index of the largest positive value (earliest on ties); null when all are 0. */
function argmax(values: readonly number[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (v > 0 && (best === null || v > (values[best] ?? 0))) best = i;
  }
  return best;
}

function compareIdLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareIds(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
