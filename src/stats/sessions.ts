/**
 * Session reconstruction: parsed voice notices + known voice snapshots -> continuous per-user
 * sessions, repairing missed leaves. Pure and deterministic.
 *
 * Per user u: an open session S (current channel + segment start) and L(u), the last evidence
 * u was in voice (their last event touching S, or a checkpoint that saw them present).
 * lastNoticeAt is the latest event (anyone) processed so far: it approximates "the bot was up".
 * Events and checkpoints are merged by time; at equal times events come first.
 *
 * Real notices are trusted. The missed-leave cap only applies where a leave was missed: when
 * "gap" (t - L(u) > cap) holds and the notice does not confirm S, S is closed at L(u) + cap,
 * estimated ("capped" below).
 *
 * Events at t:
 * - connect C: gap -> capped, open a new session in C (even when C is S's channel).
 *   No gap: S in C -> duplicate (L = t); S elsewhere -> close S at t (estimated) and open a new
 *   session in C. No S -> open in C.
 * - disconnect: S open -> close at t, not estimated, even after a gap, unless the gap holds
 *   and the leave is from another channel (it does not confirm S): capped, and the leave is
 *   unmatched. No S -> unmatched.
 * - move A -> B: S in A -> confirmed: new segment in B at t, same session, L = t, even after a
 *   gap. S in B -> duplicate (L = t), or after a gap: capped, open a new session in B. S
 *   elsewhere -> missed move: new segment in B at t (the old segment's end is inferred), or after
 *   a gap: capped, open a new session in B.
 *   No S -> open in B (time in A is unknown).
 * Checkpoints at T:
 * - present with S, no gap -> follow a channel change (the new segment's start is inferred),
 *   L = T. Present with S after a gap -> capped; a startup checkpoint then opens a new session
 *   at T, the final one (now) does not.
 * - absent with S -> missed leave: close at min(max(lastNoticeAt, L), L + cap), estimated.
 * - present without S -> open at T, except at the final checkpoint (now), whose joins we
 *   never saw: those are left out rather than counted from `now`.
 * Sessions still open after the final checkpoint end at now, live.
 *
 * Segment flags: startInferred is true when the segment starts at a checkpoint (a session it
 * opened, or a channel change it noticed). endInferred is true on the last segment of an
 * estimated session and on a segment left by an unseen move (a channel change noticed at a
 * checkpoint, or a move notice from another channel). Notice-confirmed boundaries and live ends
 * at now are observed. Merged same-channel segments keep the first start flag and the last end
 * flag.
 */
import type { Checkpoint, Ms, ReconstructOptions, Reconstruction, Segment, Session, VoiceEvent } from './types.js';

interface OpenSession {
  readonly userId: string;
  /** Finished segments, in order. */
  readonly segments: Segment[];
  channelId: string;
  segmentStart: Ms;
  /** Whether segmentStart came from a checkpoint rather than a notice. */
  segmentStartInferred: boolean;
  /** L(u): last evidence the user was in voice. */
  lastSeen: Ms;
}

/** Snowflake order (numeric strings: shorter is smaller), falling back to string order. */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a: VoiceEvent, b: VoiceEvent): number {
  return a.at - b.at || compareIds(a.id, b.id);
}

/** Drop empty segments and merge adjacent ones in the same channel (input is contiguous). */
function normalizeSegments(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.end <= seg.start) continue;
    const prev = out.at(-1);
    if (prev && prev.channelId === seg.channelId && prev.end === seg.start) {
      out[out.length - 1] = {
        ...prev,
        end: seg.end,
        endInferred: seg.endInferred,
      };
    } else {
      out.push(seg);
    }
  }
  return out;
}

export function reconstructSessions(events: readonly VoiceEvent[], opts: ReconstructOptions): Reconstruction {
  const { now, capMs } = opts;
  const sortedEvents = events.filter((e) => e.at <= now).sort(compareEvents);
  const checkpoints = opts.checkpoints.filter((k) => k.at <= now).sort((a, b) => a.at - b.at);
  // The last checkpoint at `now` is the final one; without one, nobody is known to be present.
  let final: Checkpoint = { at: now, present: new Map() };
  const lastCheckpoint = checkpoints.at(-1);
  if (lastCheckpoint?.at === now) {
    checkpoints.pop();
    final = lastCheckpoint;
  }

  const open = new Map<string, OpenSession>();
  const sessions: Session[] = [];
  let unmatchedEvents = 0;
  let lastNoticeAt = -Infinity;

  const start = (userId: string, channelId: string, at: Ms, inferred: boolean) => {
    open.set(userId, {
      userId,
      segments: [],
      channelId,
      segmentStart: at,
      segmentStartInferred: inferred,
      lastSeen: at,
    });
  };

  /** End the current segment at `at` and continue the session in `channelId`. */
  const switchChannel = (
    s: OpenSession,
    channelId: string,
    at: Ms,
    flags: { readonly startInferred: boolean; readonly endInferred: boolean },
  ) => {
    s.segments.push({
      userId: s.userId,
      channelId: s.channelId,
      start: s.segmentStart,
      end: at,
      startInferred: s.segmentStartInferred,
      endInferred: flags.endInferred,
    });
    s.channelId = channelId;
    s.segmentStart = at;
    s.segmentStartInferred = flags.startInferred;
  };

  const close = (s: OpenSession, at: Ms, estimated: boolean, live: boolean) => {
    open.delete(s.userId);
    const end = Math.min(now, Math.max(at, s.segmentStart));
    const segments = normalizeSegments([
      ...s.segments,
      {
        userId: s.userId,
        channelId: s.channelId,
        start: s.segmentStart,
        end,
        startInferred: s.segmentStartInferred,
        endInferred: estimated,
      },
    ]);
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) return;
    // The session's end is the last segment's end, even when the closing segment was empty.
    if (last.endInferred !== estimated) segments[segments.length - 1] = { ...last, endInferred: estimated };
    sessions.push({
      userId: s.userId,
      start: first.start,
      end: last.end,
      segments,
      estimated,
      live,
    });
  };

  /** Missed leave: close S at L + cap (estimated). */
  const capClose = (s: OpenSession) => close(s, s.lastSeen + capMs, true, false);

  const applyEvent = (e: VoiceEvent) => {
    const t = e.at;
    const s = open.get(e.userId);
    const gap = s !== undefined && t - s.lastSeen > capMs;
    switch (e.kind) {
      case 'connect':
        if (e.to === null) break; // malformed; the parser never produces this
        if (s && !gap && s.channelId === e.to) {
          s.lastSeen = t;
        } else {
          if (s) {
            if (gap) capClose(s);
            else close(s, t, true, false);
          }
          start(e.userId, e.to, t, false);
        }
        break;
      case 'disconnect':
        if (!s) {
          unmatchedEvents++;
        } else if (gap && s.channelId !== e.from) {
          capClose(s);
          unmatchedEvents++;
        } else {
          close(s, t, false, false);
        }
        break;
      case 'move':
        if (e.to === null) break;
        if (!s) {
          start(e.userId, e.to, t, false);
        } else if (s.channelId === e.from || !gap) {
          // Confirmed by the notice (S was in the source), a duplicate, or a missed move.
          // The leave from S's channel was only seen if the notice names it as the source.
          if (s.channelId !== e.to)
            switchChannel(s, e.to, t, {
              startInferred: false,
              endInferred: s.channelId !== e.from,
            });
          s.lastSeen = t;
        } else {
          capClose(s);
          start(e.userId, e.to, t, false);
        }
        break;
    }
    lastNoticeAt = t;
  };

  const applyCheckpoint = (k: Checkpoint, isFinal: boolean) => {
    for (const s of [...open.values()]) {
      const channelId = k.present.get(s.userId);
      if (channelId === undefined) {
        close(s, Math.min(Math.max(lastNoticeAt, s.lastSeen), s.lastSeen + capMs), true, false);
      } else if (k.at - s.lastSeen > capMs) {
        capClose(s); // a startup checkpoint reopens them below
      } else {
        if (channelId !== s.channelId)
          switchChannel(s, channelId, k.at, {
            startInferred: true,
            endInferred: true,
          });
        s.lastSeen = k.at;
      }
    }
    if (isFinal) return;
    for (const [userId, channelId] of k.present) {
      if (!open.has(userId)) start(userId, channelId, k.at, true);
    }
  };

  let next = 0;
  for (const e of sortedEvents) {
    for (let k = checkpoints[next]; k && k.at < e.at; k = checkpoints[++next]) applyCheckpoint(k, false);
    applyEvent(e);
  }
  for (; next < checkpoints.length; next++) {
    const k = checkpoints[next];
    if (k) applyCheckpoint(k, false);
  }
  applyCheckpoint(final, true);
  for (const s of [...open.values()]) close(s, now, false, true);

  sessions.sort((a, b) => a.start - b.start || compareIds(a.userId, b.userId) || a.end - b.end);
  return { sessions, unmatchedEvents };
}
