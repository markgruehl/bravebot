/**
 * Channel occupancy sweep for voice stats (pure): who was in each channel with whom, and calls.
 *
 * compute.ts feeds it every scoped segment UNCLIPPED (so calls that began before the window
 * keep their real start) and the window to credit. Per channel, segment starts and ends are
 * swept in time order. All points at one instant are applied as a batch, ends before starts,
 * so a leave and a join at the same millisecond never create a zero-length state (no fake
 * records) and never split a call: a call only ends when the channel is still empty after
 * the whole batch.
 *
 * Party starter / closer credit is only given for OBSERVED boundaries. A start opened by a
 * checkpoint means the user was already there for an unknown time, and an inferred end (missed
 * leave) has an unknown real time, so when any boundary in the batch that took the channel
 * 0 -> 1 (or emptied it) is inferred, nobody can be credited and the starter (closer) is null.
 * Among observed boundaries at one instant, the smallest id starts and the largest id closes.
 */
import type { CallRecord, Ms } from './types.js';

/** Snowflake order: shorter ids are older; equal lengths compare lexicographically. */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export interface SweepSegment {
  readonly userId: string;
  readonly channelId: string;
  readonly start: Ms;
  readonly end: Ms;
  /** The start was inferred (checkpoint), not seen in a notice. */
  readonly startInferred: boolean;
  /** The end was inferred (missed leave), not seen in a notice. */
  readonly endInferred: boolean;
  /** This segment ends a live session (the user is still in this channel at `now`). */
  readonly liveTail: boolean;
}

/** A call over all the data (unclipped). */
export interface SweepCall extends CallRecord {
  /**
   * The join that made the channel non-empty (smallest id among same-time joins); null when
   * any of those joins was inferred.
   */
  readonly starter: string | null;
  /**
   * The leave that emptied it (largest id among same-time leaves); null when any of those
   * leaves was inferred.
   */
  readonly closer: string | null;
  /** Still running at the end of the data: one of its last occupants is live. */
  readonly open: boolean;
}

export interface ChannelSweep {
  readonly channelId: string;
  /** Window-credited person-ms and wall-clock occupied ms. */
  personMs: number;
  occupiedMs: number;
  /** Most people at once within the window (earliest wins); null when never occupied in it. */
  record: { size: number; at: Ms } | null;
}

export interface SweepResult {
  readonly channels: Map<string, ChannelSweep>;
  /** Window ms each user spent alone in a channel. */
  readonly soloMs: Map<string, number>;
  /** Window pair co-time summed over partners (person-ms). */
  readonly coMs: Map<string, number>;
  /** a -> b -> window ms together, a before b in snowflake order. */
  readonly pairs: Map<string, Map<string, number>>;
  /** Exact sets of 3+ people, keyed by their sorted ids joined with ','. */
  readonly groups: Map<string, { readonly userIds: readonly string[]; ms: number }>;
  /** Every call in the data (not only those overlapping the window), by channel then start. */
  readonly calls: SweepCall[];
}

const END = 0;
const START = 1;

interface Point {
  readonly at: Ms;
  readonly kind: typeof END | typeof START;
  readonly userId: string;
  readonly inferred: boolean;
  readonly liveTail: boolean;
}

const add = (map: Map<string, number>, key: string, ms: number) => map.set(key, (map.get(key) ?? 0) + ms);

/** Sweep `segments` (zero-length ones are ignored), crediting only time inside [from, to). */
export function sweep(segments: readonly SweepSegment[], from: Ms, to: Ms): SweepResult {
  const byChannel = new Map<string, Point[]>();
  for (const seg of segments) {
    if (seg.end <= seg.start) continue;
    let points = byChannel.get(seg.channelId);
    if (!points) byChannel.set(seg.channelId, (points = []));
    points.push({ at: seg.start, kind: START, userId: seg.userId, inferred: seg.startInferred, liveTail: false });
    points.push({ at: seg.end, kind: END, userId: seg.userId, inferred: seg.endInferred, liveTail: seg.liveTail });
  }

  const result: SweepResult = {
    channels: new Map(),
    soloMs: new Map(),
    coMs: new Map(),
    pairs: new Map(),
    groups: new Map(),
    calls: [],
  };
  const channelIds = [...byChannel.keys()].sort(compareIds);
  for (const channelId of channelIds) {
    const points = byChannel.get(channelId) ?? [];
    points.sort((x, y) => x.at - y.at || x.kind - y.kind || compareIds(x.userId, y.userId));
    sweepChannel(channelId, points, from, to, result);
  }
  return result;
}

function sweepChannel(channelId: string, points: readonly Point[], from: Ms, to: Ms, out: SweepResult): void {
  const channel: ChannelSweep = { channelId, personMs: 0, occupiedMs: 0, record: null };
  // Per-user segment count (tolerates a user overlapping themselves) and the distinct
  // occupants in snowflake order.
  const counts = new Map<string, number>();
  const active: string[] = [];
  let groupKey: string | null = null;
  let call: { start: Ms; starter: string | null; peak: number } | null = null;

  const credit = (start: Ms, end: Ms) => {
    const dt = Math.min(end, to) - Math.max(start, from);
    const n = active.length;
    if (dt <= 0 || n === 0) return;
    channel.occupiedMs += dt;
    channel.personMs += n * dt;
    if (!channel.record || n > channel.record.size) channel.record = { size: n, at: Math.max(start, from) };
    if (n === 1) {
      add(out.soloMs, active[0] as string, dt);
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = active[i] as string;
      add(out.coMs, a, dt * (n - 1));
      let partners = out.pairs.get(a);
      if (!partners) out.pairs.set(a, (partners = new Map()));
      for (let j = i + 1; j < n; j++) add(partners, active[j] as string, dt);
    }
    if (n >= 3) {
      groupKey ??= active.join(',');
      const group = out.groups.get(groupKey);
      if (group) group.ms += dt;
      else out.groups.set(groupKey, { userIds: [...active], ms: dt });
    }
  };

  let prev = 0;
  let i = 0;
  while (i < points.length) {
    const t = (points[i] as Point).at;
    credit(prev, t);
    prev = t;

    let closer: string | null = null;
    let closerInferred = false;
    let liveEnd = false;
    // Flags are taken from every point in the batch (not only the one that changes the
    // occupant set), so a user overlapping themselves cannot make the result input-order
    // dependent. They only matter when the batch empties (or opens) the channel.
    for (let p = points[i]; p && p.at === t && p.kind === END; p = points[++i]) {
      if (p.inferred) closerInferred = true;
      if (p.liveTail) liveEnd = true;
      const left = (counts.get(p.userId) ?? 0) - 1;
      if (left > 0) {
        counts.set(p.userId, left);
        continue;
      }
      counts.delete(p.userId);
      const at = active.indexOf(p.userId);
      if (at >= 0) active.splice(at, 1);
      groupKey = null;
      closer = p.userId;
    }

    let starter: string | null = null;
    let starterInferred = false;
    for (let p = points[i]; p && p.at === t; p = points[++i]) {
      if (p.inferred) starterInferred = true;
      const had = counts.get(p.userId) ?? 0;
      counts.set(p.userId, had + 1);
      if (had > 0) continue;
      let at = 0;
      while (at < active.length && compareIds(active[at] as string, p.userId) < 0) at++;
      active.splice(at, 0, p.userId);
      groupKey = null;
      starter ??= p.userId;
    }

    if (active.length === 0) {
      if (call) {
        out.calls.push({
          channelId,
          start: call.start,
          end: t,
          peak: call.peak,
          starter: call.starter,
          // Something left in this batch (the channel was occupied before it).
          closer: closerInferred ? null : closer,
          open: liveEnd,
        });
        call = null;
      }
    } else {
      // Something joined in this batch (the channel was empty before it).
      call ??= { start: t, starter: starterInferred ? null : starter, peak: 0 };
      call.peak = Math.max(call.peak, active.length);
    }
  }

  if (channel.record) out.channels.set(channelId, channel);
}
