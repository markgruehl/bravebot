import { describe, expect, it } from 'vitest';
import { emptyQueue, enqueue, skip, stop, trackEnded, type QueueState } from './queue.js';

const q = (current: string | null, upcoming: string[] = []): QueueState<string> => ({ current, upcoming });

describe('emptyQueue', () => {
  it('has nothing current or upcoming', () => {
    expect(emptyQueue()).toEqual({ current: null, upcoming: [] });
  });
});

describe('enqueue (interrupt)', () => {
  it('starts immediately when idle', () => {
    const t = enqueue(emptyQueue<string>(), ['a'], 'interrupt');
    expect(t).toEqual({ state: q('a'), start: 'a', stopped: null, idle: false });
  });

  it('replaces only the current track and keeps upcoming items', () => {
    const t = enqueue(q('a', ['b', 'c']), ['x'], 'interrupt');
    expect(t.state).toEqual(q('x', ['b', 'c']));
    expect(t.start).toBe('x');
    expect(t.stopped).toBe('a');
    expect(t.idle).toBe(false);
  });

  it('does not re-queue the interrupted track', () => {
    const t = enqueue(q('a', ['b']), ['x'], 'interrupt');
    expect(t.state.upcoming).not.toContain('a');
  });

  it('playlist: first item interrupts, the rest go to the END of upcoming', () => {
    const t = enqueue(q('a', ['b', 'c']), ['p1', 'p2', 'p3'], 'interrupt');
    expect(t.state).toEqual(q('p1', ['b', 'c', 'p2', 'p3']));
    expect(t.start).toBe('p1');
    expect(t.stopped).toBe('a');
  });

  it('playlist when idle', () => {
    const t = enqueue(emptyQueue<string>(), ['p1', 'p2'], 'interrupt');
    expect(t.state).toEqual(q('p1', ['p2']));
    expect(t.start).toBe('p1');
    expect(t.stopped).toBeNull();
  });
});

describe('enqueue (queue)', () => {
  it('starts immediately when idle', () => {
    const t = enqueue(emptyQueue<string>(), ['a'], 'queue');
    expect(t).toEqual({ state: q('a'), start: 'a', stopped: null, idle: false });
  });

  it('appends to the end without touching current', () => {
    const t = enqueue(q('a', ['b']), ['c'], 'queue');
    expect(t).toEqual({ state: q('a', ['b', 'c']), start: null, stopped: null, idle: false });
  });

  it('playlist appends every item in order', () => {
    const t = enqueue(q('a'), ['p1', 'p2', 'p3'], 'queue');
    expect(t.state).toEqual(q('a', ['p1', 'p2', 'p3']));
    expect(t.start).toBeNull();
  });

  it('playlist when idle: first starts, rest queued', () => {
    const t = enqueue(emptyQueue<string>(), ['p1', 'p2', 'p3'], 'queue');
    expect(t.state).toEqual(q('p1', ['p2', 'p3']));
    expect(t.start).toBe('p1');
  });

  it('does not mutate the input state', () => {
    const upcoming = ['b'];
    const state = q('a', upcoming);
    enqueue(state, ['c'], 'queue');
    enqueue(state, ['x'], 'interrupt');
    expect(state).toEqual(q('a', ['b']));
    expect(upcoming).toEqual(['b']);
  });
});

describe('enqueue with no items', () => {
  it('is a no-op while playing', () => {
    const state = q('a', ['b']);
    expect(enqueue(state, [], 'interrupt')).toEqual({ state, start: null, stopped: null, idle: false });
    expect(enqueue(state, [], 'queue')).toEqual({ state, start: null, stopped: null, idle: false });
  });

  it('reports idle when nothing is playing', () => {
    expect(enqueue(emptyQueue<string>(), [], 'queue').idle).toBe(true);
  });
});

describe('skip', () => {
  it('advances to the next upcoming item', () => {
    const t = skip(q('a', ['b', 'c']));
    expect(t).toEqual({ state: q('b', ['c']), start: 'b', stopped: 'a', idle: false });
  });

  it('becomes idle when nothing is upcoming', () => {
    const t = skip(q('a'));
    expect(t).toEqual({ state: q(null), start: null, stopped: 'a', idle: true });
  });

  it('on an empty queue is idle with nothing stopped', () => {
    expect(skip(emptyQueue<string>())).toEqual({ state: q(null), start: null, stopped: null, idle: true });
  });
});

describe('trackEnded', () => {
  it('advances to the next upcoming item', () => {
    const t = trackEnded(q('a', ['b']));
    expect(t).toEqual({ state: q('b'), start: 'b', stopped: 'a', idle: false });
  });

  it('becomes idle when the queue drains', () => {
    const t = trackEnded(q('a'));
    expect(t.idle).toBe(true);
    expect(t.state).toEqual(q(null));
    expect(t.start).toBeNull();
  });
});

describe('stop', () => {
  it('clears current and upcoming', () => {
    const t = stop(q('a', ['b', 'c']));
    expect(t).toEqual({ state: q(null), start: null, stopped: 'a', idle: true });
  });

  it('on an empty queue', () => {
    expect(stop(emptyQueue<string>())).toEqual({ state: q(null), start: null, stopped: null, idle: true });
  });
});

describe('scenarios', () => {
  it('interrupt mid-queue, then the queue keeps draining in order', () => {
    let s = enqueue(emptyQueue<string>(), ['a'], 'queue').state;
    s = enqueue(s, ['b'], 'queue').state;
    s = enqueue(s, ['c'], 'queue').state;
    s = enqueue(s, ['x'], 'interrupt').state;
    const order: (string | null)[] = [s.current];
    for (;;) {
      const t = trackEnded(s);
      s = t.state;
      if (t.idle) break;
      order.push(t.start);
    }
    expect(order).toEqual(['x', 'b', 'c']);
  });
});
