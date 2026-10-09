import { describe, expect, it } from 'vitest';
import { reconstructSessions } from './sessions.js';
import { HOUR_MS, MINUTE_MS } from './time.js';
import type { Checkpoint, Ms, ReconstructOptions, Session, VoiceEvent } from './types.js';

const CAP = 12 * HOUR_MS;
const T0 = Date.UTC(2026, 0, 5, 17); // arbitrary base instant
const h = (n: number): Ms => T0 + n * HOUR_MS;

let nextId = 1000;
const id = () => String(nextId++);

const connect = (userId: string, to: string, at: Ms, eventId = id()): VoiceEvent => ({
  kind: 'connect',
  userId,
  from: null,
  to,
  at,
  id: eventId,
});
const disconnect = (userId: string, from: string, at: Ms, eventId = id()): VoiceEvent => ({
  kind: 'disconnect',
  userId,
  from,
  to: null,
  at,
  id: eventId,
});
const move = (userId: string, from: string, to: string, at: Ms, eventId = id()): VoiceEvent => ({
  kind: 'move',
  userId,
  from,
  to,
  at,
  id: eventId,
});
const checkpoint = (at: Ms, present: Record<string, string> = {}): Checkpoint => ({
  at,
  present: new Map(Object.entries(present)),
});

function run(events: VoiceEvent[], now: Ms, checkpoints: Checkpoint[] = [checkpoint(now)]) {
  const opts: ReconstructOptions = { now, capMs: CAP, checkpoints };
  return reconstructSessions(events, opts);
}

/** A session as a plain object with segments as [channel, start, end] tuples. */
const brief = (s: Session) => ({
  user: s.userId,
  start: s.start,
  end: s.end,
  segs: s.segments.map((g) => [g.channelId, g.start, g.end]),
  estimated: s.estimated,
  live: s.live,
});

/** Each segment's [startInferred, endInferred]. */
const flags = (s: Session) => s.segments.map((g) => [g.startInferred, g.endInferred]);

describe('reconstructSessions: events', () => {
  it('pairs a join with a leave', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(2))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(2),
        segs: [['A', h(0), h(2)]],
        estimated: false,
        live: false,
      },
    ]);
    expect(r.unmatchedEvents).toBe(0);
  });

  it('keeps one session across a move, with one segment per channel', () => {
    const r = run([connect('u', 'A', h(0)), move('u', 'A', 'B', h(1)), disconnect('u', 'B', h(3))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(3),
        segs: [
          ['A', h(0), h(1)],
          ['B', h(1), h(3)],
        ],
        estimated: false,
        live: false,
      },
    ]);
  });

  it.each([
    ['connect', [connect('u', 'A', h(0)), connect('u', 'A', h(1)), disconnect('u', 'A', h(2))], [['A', h(0), h(2)]]],
    [
      'move',
      [connect('u', 'A', h(0)), move('u', 'A', 'B', h(1)), move('u', 'A', 'B', h(1.5)), disconnect('u', 'B', h(2))],
      [
        ['A', h(0), h(1)],
        ['B', h(1), h(2)],
      ],
    ],
  ])('ignores a duplicate %s', (_, events, segs) => {
    const r = run(events, h(10));
    expect(r.sessions).toHaveLength(1);
    expect(brief(r.sessions[0]!)).toMatchObject({
      start: h(0),
      end: h(2),
      segs,
      estimated: false,
    });
  });

  it('closes an open session (estimated) when the user connects elsewhere', () => {
    const r = run([connect('u', 'A', h(0)), connect('u', 'B', h(1)), disconnect('u', 'B', h(2))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(1),
        segs: [['A', h(0), h(1)]],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(1),
        end: h(2),
        segs: [['B', h(1), h(2)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('closes on a disconnect from a different channel, keeping the segment channel', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'B', h(1))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(1),
        segs: [['A', h(0), h(1)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('counts a leave with no join as unmatched', () => {
    const r = run([disconnect('u', 'A', h(1)), connect('v', 'A', h(2)), disconnect('v', 'A', h(3))], h(10));
    expect(r.unmatchedEvents).toBe(1);
    expect(r.sessions.map((s) => s.userId)).toEqual(['v']);
  });

  it('opens a session in the destination on a move with no open session', () => {
    const r = run([move('u', 'A', 'B', h(1)), disconnect('u', 'B', h(2))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(1),
        end: h(2),
        segs: [['B', h(1), h(2)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('merges a bounce back to the same channel at one instant into one segment', () => {
    const r = run(
      [connect('u', 'A', h(0)), move('u', 'A', 'B', h(1)), move('u', 'B', 'A', h(1)), disconnect('u', 'A', h(2))],
      h(10),
    );
    expect(r.sessions.map((s) => brief(s).segs)).toEqual([[['A', h(0), h(2)]]]);
  });
});

describe('reconstructSessions: missed-leave gap cap', () => {
  it('closes at L + cap and starts fresh when the next event is more than cap later', () => {
    const r = run([connect('u', 'A', h(0)), connect('u', 'A', h(13)), disconnect('u', 'A', h(14))], h(20));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(13),
        end: h(14),
        segs: [['A', h(13), h(14)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('measures the gap from the latest evidence (duplicates and moves refresh it)', () => {
    const r = run(
      [connect('u', 'A', h(0)), connect('u', 'A', h(10)), move('u', 'A', 'B', h(20)), disconnect('u', 'B', h(30))],
      h(40),
    );
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(30),
        segs: [
          ['A', h(0), h(20)],
          ['B', h(20), h(30)],
        ],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('does not close at exactly the cap', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(12))], h(20));
    expect(r.sessions.map(brief)).toMatchObject([{ start: h(0), end: h(12), estimated: false }]);
  });

  it('trusts a disconnect after a long gap: closes at the notice, not estimated', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(12) + MINUTE_MS)], h(20));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12) + MINUTE_MS,
        segs: [['A', h(0), h(12) + MINUTE_MS]],
        estimated: false,
        live: false,
      },
    ]);
    expect(r.unmatchedEvents).toBe(0);
  });

  it('caps a disconnect from another channel after a long gap (it does not confirm S)', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'B', h(72))], h(80));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
    ]);
    expect(r.unmatchedEvents).toBe(1);
  });

  it('trusts a disconnect from another channel without a gap', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'B', h(3))], h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(3),
        segs: [['A', h(0), h(3)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('caps and starts fresh on a connect to another channel after a long gap', () => {
    const r = run([connect('u', 'A', h(0)), connect('u', 'B', h(20)), disconnect('u', 'B', h(21))], h(30));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(20),
        end: h(21),
        segs: [['B', h(20), h(21)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('trusts a move out of the current channel after a long gap: same session', () => {
    const r = run([connect('u', 'A', h(0)), move('u', 'A', 'B', h(20)), disconnect('u', 'B', h(21))], h(30));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(21),
        segs: [
          ['A', h(0), h(20)],
          ['B', h(20), h(21)],
        ],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('caps and starts fresh on a move from another channel after a long gap', () => {
    const r = run([connect('u', 'A', h(0)), move('u', 'C', 'B', h(20)), disconnect('u', 'B', h(21))], h(30));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(20),
        end: h(21),
        segs: [['B', h(20), h(21)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('follows a move from another channel within the cap (missed move)', () => {
    const r = run([connect('u', 'A', h(0)), move('u', 'C', 'B', h(5)), disconnect('u', 'B', h(6))], h(30));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(6),
        segs: [
          ['A', h(0), h(5)],
          ['B', h(5), h(6)],
        ],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('caps and starts fresh on a duplicate move into the current channel after a long gap', () => {
    const r = run(
      [connect('u', 'A', h(0)), move('u', 'A', 'B', h(1)), move('u', 'C', 'B', h(20)), disconnect('u', 'B', h(21))],
      h(30),
    );
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(13),
        segs: [
          ['A', h(0), h(1)],
          ['B', h(1), h(13)],
        ],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(20),
        end: h(21),
        segs: [['B', h(20), h(21)]],
        estimated: false,
        live: false,
      },
    ]);
  });
});

describe('reconstructSessions: checkpoints', () => {
  it('opens sessions at a startup checkpoint for people already in voice', () => {
    const r = run([disconnect('u', 'A', h(5))], h(10), [checkpoint(h(2), { u: 'A' }), checkpoint(h(10))]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(2),
        end: h(5),
        segs: [['A', h(2), h(5)]],
        estimated: false,
        live: false,
      },
    ]);
    expect(r.unmatchedEvents).toBe(0);
  });

  it('keeps an open session for someone present at startup and refreshes their evidence', () => {
    // Without the checkpoint at 10h the 20h disconnect would be past the cap.
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(20))], h(30), [
      checkpoint(h(10), { u: 'A' }),
      checkpoint(h(30)),
    ]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(20),
        segs: [['A', h(0), h(20)]],
        estimated: false,
        live: false,
      },
    ]);
  });

  it('splits the segment when a checkpoint sees someone in another channel', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'B', h(3))], h(10), [
      checkpoint(h(2), { u: 'B' }),
      checkpoint(h(10)),
    ]);
    expect(r.sessions.map((s) => brief(s).segs)).toEqual([
      [
        ['A', h(0), h(2)],
        ['B', h(2), h(3)],
      ],
    ]);
  });

  it('closes people absent from a checkpoint at the last notice before it', () => {
    const r = run([connect('u', 'A', h(0)), connect('v', 'B', h(3))], h(20), [checkpoint(h(10)), checkpoint(h(20))]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(3),
        segs: [['A', h(0), h(3)]],
        estimated: true,
        live: false,
      },
      // v's own join was the last notice: zero length, dropped.
    ]);
  });

  it('caps the absent close at L + cap', () => {
    const r = run([connect('u', 'A', h(0)), connect('v', 'B', h(20)), connect('w', 'B', h(21))], h(30), [
      checkpoint(h(25)),
      checkpoint(h(30)),
    ]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
      {
        user: 'v',
        start: h(20),
        end: h(21),
        segs: [['B', h(20), h(21)]],
        estimated: true,
        live: false,
      },
    ]);
  });

  it('uses a confirmed presence, not the latest notice, as the evidence for an absent close', () => {
    const r = run([connect('u', 'A', h(0))], h(10), [
      checkpoint(h(4), { u: 'A' }),
      checkpoint(h(8)),
      checkpoint(h(10)),
    ]);
    expect(r.sessions.map(brief)).toMatchObject([{ start: h(0), end: h(4), estimated: true }]);
  });

  it('ends sessions of people present at the final checkpoint at now, live', () => {
    const r = run([connect('u', 'A', h(0)), connect('v', 'A', h(1))], h(10), [checkpoint(h(10), { u: 'A', v: 'B' })]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(10),
        segs: [['A', h(0), h(10)]],
        estimated: false,
        live: true,
      },
      {
        user: 'v',
        start: h(1),
        end: h(10),
        // The switch to B at now is zero-length and dropped.
        segs: [['A', h(1), h(10)]],
        estimated: false,
        live: true,
      },
    ]);
  });

  it('caps someone present at a startup checkpoint after a long gap and reopens them there', () => {
    const r = run([connect('u', 'A', h(0))], h(30), [checkpoint(h(20), { u: 'A' }), checkpoint(h(30), { u: 'A' })]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
      {
        user: 'u',
        start: h(20),
        end: h(30),
        segs: [['A', h(20), h(30)]],
        estimated: false,
        live: true,
      },
    ]);
    expect(r.sessions.map(flags)).toEqual([[[false, true]], [[true, false]]]);
  });

  it('caps someone present at the final checkpoint after a long gap without reopening them', () => {
    const r = run([connect('u', 'A', h(0))], h(20), [checkpoint(h(20), { u: 'B' })]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(12),
        segs: [['A', h(0), h(12)]],
        estimated: true,
        live: false,
      },
    ]);
  });

  it('does not open sessions for people first seen at the final checkpoint', () => {
    const r = run([], h(10), [checkpoint(h(10), { u: 'A' })]);
    expect(r.sessions).toEqual([]);
  });

  it('treats a missing final checkpoint as nobody present now', () => {
    const r = run([connect('u', 'A', h(0)), connect('v', 'B', h(2))], h(10), []);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(2),
        segs: [['A', h(0), h(2)]],
        estimated: true,
        live: false,
      },
    ]);
  });

  it('only treats a checkpoint at now as final', () => {
    // The 5h checkpoint is a startup snapshot; with no checkpoint at now, both close as absent.
    const r = run([connect('v', 'B', h(7))], h(10), [checkpoint(h(5), { u: 'A' })]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(5),
        end: h(7),
        segs: [['A', h(5), h(7)]],
        estimated: true,
        live: false,
      },
    ]);
  });
});

describe('reconstructSessions: inferred boundaries', () => {
  it('marks nothing inferred for notice-driven boundaries and moves', () => {
    const r = run([connect('u', 'A', h(0)), move('u', 'A', 'B', h(1)), disconnect('u', 'B', h(3))], h(10));
    expect(r.sessions.map(flags)).toEqual([
      [
        [false, false],
        [false, false],
      ],
    ]);
  });

  it('marks a start from a startup checkpoint as inferred', () => {
    const r = run([disconnect('u', 'A', h(5))], h(10), [checkpoint(h(2), { u: 'A' }), checkpoint(h(10))]);
    expect(r.sessions.map(flags)).toEqual([[[true, false]]]);
  });

  it('marks both sides of a channel change noticed at a checkpoint as inferred', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'B', h(3))], h(10), [
      checkpoint(h(2), { u: 'B' }),
      checkpoint(h(10)),
    ]);
    expect(r.sessions.map(flags)).toEqual([
      [
        [false, true],
        [true, false],
      ],
    ]);
  });

  it('marks the old segment of a move notice from another channel as an inferred end', () => {
    const r = run(
      [connect('u', 'A', h(0)), move('u', 'P', 'Q', h(1)), move('u', 'Q', 'R', h(2)), disconnect('u', 'R', h(3))],
      h(10),
    );
    expect(r.sessions.map(flags)).toEqual([
      [
        [false, true], // A -> Q: the leave from A was never seen
        [false, false], // Q -> R: confirmed by the notice
        [false, false],
      ],
    ]);
  });

  it.each([
    ['a connect elsewhere', [connect('u', 'A', h(0)), connect('u', 'B', h(1))], [checkpoint(h(10), { u: 'B' })]],
    ['the cap', [connect('u', 'A', h(0)), connect('u', 'A', h(13))], [checkpoint(h(14), { u: 'A' })]],
    ['an absent checkpoint', [connect('u', 'A', h(0)), connect('v', 'B', h(3))], [checkpoint(h(10))]],
  ])('marks the end of a session closed by %s as inferred', (_, events, checkpoints) => {
    const r = run(events, checkpoints.at(-1)!.at, checkpoints);
    const first = r.sessions.find((s) => s.userId === 'u' && s.start === h(0))!;
    expect(first.estimated).toBe(true);
    expect(flags(first)).toEqual([[false, true]]);
  });

  it('does not mark a live end at now as inferred', () => {
    const r = run([connect('u', 'A', h(0))], h(10), [checkpoint(h(10), { u: 'A' })]);
    expect(r.sessions.map(flags)).toEqual([[[false, false]]]);
  });

  it('keeps the first start flag and the last end flag when merging segments', () => {
    // Opened at a checkpoint, bounced A -> B -> A at one instant, then missed the leave.
    const r = run([move('u', 'A', 'B', h(3)), move('u', 'B', 'A', h(3)), connect('v', 'B', h(5))], h(10), [
      checkpoint(h(2), { u: 'A' }),
      checkpoint(h(8)),
      checkpoint(h(10)),
    ]);
    const u = r.sessions.filter((s) => s.userId === 'u');
    expect(u.map(brief)).toMatchObject([{ segs: [['A', h(2), h(5)]], estimated: true }]);
    expect(u.map(flags)).toEqual([[[true, true]]]);
  });

  it('marks the last kept segment inferred when the closing segment is empty', () => {
    // Split into B at 2h, then absent at 4h with no notice since: B is empty, A ends the session.
    const r = run([connect('u', 'A', h(0))], h(10), [
      checkpoint(h(2), { u: 'B' }),
      checkpoint(h(4)),
      checkpoint(h(10)),
    ]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(2),
        segs: [['A', h(0), h(2)]],
        estimated: true,
        live: false,
      },
    ]);
    expect(r.sessions.map(flags)).toEqual([[[false, true]]]);
  });
});

describe('reconstructSessions: ordering and bounds', () => {
  it('applies events before a checkpoint at the same instant', () => {
    // Event first: the session ends at 2h, then the startup checkpoint opens a new one.
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(2))], h(10), [
      checkpoint(h(2), { u: 'A' }),
      checkpoint(h(10), { u: 'A' }),
    ]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(2),
        segs: [['A', h(0), h(2)]],
        estimated: false,
        live: false,
      },
      {
        user: 'u',
        start: h(2),
        end: h(10),
        segs: [['A', h(2), h(10)]],
        estimated: false,
        live: true,
      },
    ]);
  });

  it('orders same-instant events by snowflake (numeric) id, not input order', () => {
    // '9' < '10' numerically: the connect to B (missed leave) runs before the disconnect.
    const events = [disconnect('u', 'B', h(2), '10'), connect('u', 'B', h(2), '9'), connect('u', 'A', h(0), '1')];
    const r = run(events, h(10));
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(2),
        segs: [['A', h(0), h(2)]],
        estimated: true,
        live: false,
      },
    ]);
    expect(events[0]!.id).toBe('10'); // input not mutated
  });

  it('ignores events after now', () => {
    const r = run([connect('u', 'A', h(0)), disconnect('u', 'A', h(11)), connect('v', 'A', h(12))], h(10), [
      checkpoint(h(10), { u: 'A' }),
    ]);
    expect(r.sessions.map(brief)).toEqual([
      {
        user: 'u',
        start: h(0),
        end: h(10),
        segs: [['A', h(0), h(10)]],
        estimated: false,
        live: true,
      },
    ]);
    expect(r.unmatchedEvents).toBe(0);
  });

  it('sorts sessions by start then user id', () => {
    const r = run(
      [connect('20', 'A', h(1)), connect('3', 'A', h(1)), connect('1', 'A', h(2)), disconnect('1', 'A', h(3))],
      h(10),
      [checkpoint(h(10), { '20': 'A', '3': 'A' })],
    );
    expect(r.sessions.map((s) => [s.userId, s.start])).toEqual([
      ['3', h(1)],
      ['20', h(1)],
      ['1', h(2)],
    ]);
  });

  it('keeps the Session invariants on a long random history', () => {
    // Deterministic PRNG (MINSTD) so failures reproduce.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const users = ['1', '2', '3', '4', '5'];
    const channels = ['A', 'B', 'C'];
    const events: VoiceEvent[] = [];
    let t = h(0);
    for (let i = 0; i < 2000; i++) {
      t += rand(4) * rand(6) * HOUR_MS + rand(60) * MINUTE_MS; // includes zero gaps and long gaps
      const user = users[rand(users.length)]!;
      const a = channels[rand(channels.length)]!;
      const b = channels[rand(channels.length)]!;
      const kind = rand(3);
      events.push(kind === 0 ? connect(user, a, t) : kind === 1 ? disconnect(user, a, t) : move(user, a, b, t));
    }
    const now = t - 10 * HOUR_MS; // some events land after now
    const checkpoints = [
      checkpoint(h(500), { '1': 'A', '2': 'B' }),
      checkpoint(h(1500), { '3': 'C' }),
      checkpoint(h(2500), { '1': 'B', '4': 'C' }),
      checkpoint(now, { '4': 'A', '5': 'B' }),
    ];
    const { sessions } = run(events, now, checkpoints);
    expect(sessions.length).toBeGreaterThan(100);

    const lastEnd = new Map<string, Ms>();
    for (const [i, s] of sessions.entries()) {
      const prev = sessions[i - 1];
      if (prev) expect(prev.start <= s.start).toBe(true);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(now);
      expect(s.segments[0]!.start).toBe(s.start);
      expect(s.segments.at(-1)!.end).toBe(s.end);
      for (const [j, g] of s.segments.entries()) {
        expect(g.userId).toBe(s.userId);
        expect(typeof g.startInferred).toBe('boolean');
        // The last segment's end is inferred exactly when the session is estimated; earlier
        // segments may have inferred ends (unseen moves).
        if (j === s.segments.length - 1) expect(g.endInferred).toBe(s.estimated);
        else expect(typeof g.endInferred).toBe('boolean');
        expect(g.end).toBeGreaterThan(g.start);
        const next = s.segments[j + 1];
        if (next) {
          expect(next.start).toBe(g.end);
          expect(next.channelId).not.toBe(g.channelId);
        }
      }
      if (s.live) expect(s.end).toBe(now);
      // A user's sessions never overlap.
      expect(s.start).toBeGreaterThanOrEqual(lastEnd.get(s.userId) ?? -Infinity);
      lastEnd.set(s.userId, s.end);
    }
  });
});
