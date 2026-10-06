/**
 * PURE queue state machine (PLAYBACK implementer). No I/O, no timers, no Discord.
 *
 * Semantics:
 * - enqueue(mode='interrupt'): items[0] REPLACES current (current is dropped, NOT re-queued);
 *   upcoming is kept; items[1..] are appended to the END of upcoming.
 * - enqueue(mode='queue'): all items appended to the end; if idle, items[0] becomes current.
 * - skip()/trackEnded(): current := upcoming[0] (or null => idle).
 * - stop(): current := null, upcoming := [].
 * Each transition reports what (if anything) must start now and whether playback is idle,
 * so player.ts just executes the transition.
 *
 * Invariant maintained by every transition: current === null implies upcoming is empty.
 */
import type { PlayMode } from '../types.js';

export interface QueueState<T> {
  readonly current: T | null;
  readonly upcoming: readonly T[];
}

export interface QueueTransition<T> {
  readonly state: QueueState<T>;
  /** Item that must start playing now (current changed), else null. */
  readonly start: T | null;
  /** The previous current item that must be stopped/abandoned, else null. */
  readonly stopped: T | null;
  /** True when nothing is left to play (player should leave the channel). */
  readonly idle: boolean;
}

export function emptyQueue<T>(): QueueState<T> {
  return { current: null, upcoming: [] };
}

/** Promote the head of `upcoming` to current (used when nothing is current). */
function advance<T>(state: QueueState<T>, stopped: T | null): QueueTransition<T> {
  const [next, ...rest] = state.upcoming;
  if (next === undefined) {
    return { state: emptyQueue<T>(), start: null, stopped, idle: true };
  }
  return { state: { current: next, upcoming: rest }, start: next, stopped, idle: false };
}

export function enqueue<T>(state: QueueState<T>, items: readonly T[], mode: PlayMode): QueueTransition<T> {
  const [first, ...rest] = items;
  if (first === undefined) {
    // Nothing to add: report the state unchanged.
    return { state, start: null, stopped: null, idle: state.current === null && state.upcoming.length === 0 };
  }

  if (mode === 'interrupt') {
    return {
      state: { current: first, upcoming: [...state.upcoming, ...rest] },
      start: first,
      stopped: state.current,
      idle: false,
    };
  }

  // mode === 'queue'
  const upcoming = [...state.upcoming, ...items];
  if (state.current === null) {
    return advance({ current: null, upcoming }, null);
  }
  return { state: { current: state.current, upcoming }, start: null, stopped: null, idle: false };
}

/** User skip. */
export function skip<T>(state: QueueState<T>): QueueTransition<T> {
  return advance(state, state.current);
}

/** Current track finished naturally or failed; advance. */
export function trackEnded<T>(state: QueueState<T>): QueueTransition<T> {
  return advance(state, state.current);
}

/** Stop + clear. */
export function stop<T>(state: QueueState<T>): QueueTransition<T> {
  return { state: emptyQueue<T>(), start: null, stopped: state.current, idle: true };
}
