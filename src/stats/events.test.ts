import { describe, expect, it } from 'vitest';
import { compareEvents, compareSnowflakes, eventFromMessage, mergeEvents, trimBefore, withoutEvents } from './events.js';
import type { NoticeMessage, VoiceEvent } from './types.js';

const BOT = '999';

function message(over: Partial<NoticeMessage> & { authorId?: string } = {}): NoticeMessage {
  return {
    id: over.id ?? '100',
    channelId: over.channelId ?? '50',
    content: over.content ?? '<@1> has connected to <#10>',
    createdTimestamp: over.createdTimestamp ?? 1_000,
    author: { id: over.authorId ?? BOT },
  };
}

/** A connect event; only id and at matter to the helpers. */
function ev(id: string, at: number, userId = '1'): VoiceEvent {
  return { id, at, kind: 'connect', userId, from: null, to: '10' };
}

const ids = (events: readonly VoiceEvent[]) => events.map((e) => e.id);

describe('compareSnowflakes', () => {
  it('orders by length, then text', () => {
    expect(compareSnowflakes('9', '10')).toBeLessThan(0);
    expect(compareSnowflakes('81384788765712384', '123456789012345678')).toBeLessThan(0);
    expect(compareSnowflakes('123456789012345679', '123456789012345678')).toBeGreaterThan(0);
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});

describe('compareEvents', () => {
  it('orders by time, then snowflake id', () => {
    expect(compareEvents(ev('5', 1), ev('1', 2))).toBeLessThan(0);
    expect(compareEvents(ev('10', 1), ev('9', 1))).toBeGreaterThan(0);
    expect(compareEvents(ev('9', 1), ev('10', 1))).toBeLessThan(0);
    expect(compareEvents(ev('9', 1), ev('9', 1))).toBe(0);
  });
});

describe('eventFromMessage', () => {
  it('parses a notice the bot wrote', () => {
    expect(eventFromMessage(message({ id: '123', createdTimestamp: 5_000 }), BOT)).toEqual({
      id: '123',
      at: 5_000,
      kind: 'connect',
      userId: '1',
      from: null,
      to: '10',
    });
    expect(eventFromMessage(message({ content: '<@!1> has changed channels from <#10> to <#20>' }), BOT)).toMatchObject({
      kind: 'move',
      userId: '1',
      from: '10',
      to: '20',
    });
  });

  it('ignores notices written by anyone else', () => {
    expect(eventFromMessage(message({ authorId: '1' }), BOT)).toBeNull();
  });

  it('ignores bot messages that are not notices', () => {
    expect(eventFromMessage(message({ content: 'pong' }), BOT)).toBeNull();
    expect(eventFromMessage(message({ content: 'alice has connected to General' }), BOT)).toBeNull();
  });
});

describe('mergeEvents', () => {
  const base = [ev('1', 10), ev('2', 20), ev('3', 30)];

  it('appends newer events', () => {
    const merged = mergeEvents(base, [ev('5', 50), ev('4', 40)]);
    expect(ids(merged)).toEqual(['1', '2', '3', '4', '5']);
    expect(ids(base)).toEqual(['1', '2', '3']); // inputs untouched
  });

  it('interleaves older and overlapping events', () => {
    expect(ids(mergeEvents(base, [ev('25', 25), ev('0', 5), ev('35', 35)]))).toEqual(['0', '1', '2', '25', '3', '35']);
  });

  it('breaks equal times by snowflake order', () => {
    expect(ids(mergeEvents([ev('9', 10), ev('11', 10)], [ev('10', 10)]))).toEqual(['9', '10', '11']);
  });

  it('keeps the existing copy of a duplicate id', () => {
    const merged = mergeEvents(base, [ev('2', 20, 'other'), ev('4', 40)]);
    expect(ids(merged)).toEqual(['1', '2', '3', '4']);
    expect(merged[1]!.userId).toBe('1');
  });

  it('dedupes within the added events, first wins', () => {
    const merged = mergeEvents([], [ev('7', 70, 'first'), ev('6', 60), ev('7', 70, 'second')]);
    expect(ids(merged)).toEqual(['6', '7']);
    expect(merged[1]!.userId).toBe('first');
  });

  it('handles empty inputs and returns a new array', () => {
    expect(mergeEvents([], [])).toEqual([]);
    const copy = mergeEvents(base, []);
    expect(copy).toEqual(base);
    expect(copy).not.toBe(base);
    expect(ids(mergeEvents([], [ev('2', 2), ev('1', 1)]))).toEqual(['1', '2']);
  });

  it('sorts an unsorted existing array', () => {
    expect(ids(mergeEvents([ev('3', 30), ev('1', 10)], [ev('2', 20)]))).toEqual(['1', '2', '3']);
    expect(ids(mergeEvents([ev('3', 30), ev('1', 10)], []))).toEqual(['1', '3']);
  });

  it('matches a full dedupe + sort on random input', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 48_271) % 2_147_483_647; // Park-Miller: exact in doubles
      return seed % n;
    };
    for (let round = 0; round < 50; round++) {
      const pool = Array.from({ length: 30 }, (_, i) => ev(String(1_000 + i * 7), rand(20) * 10));
      const pick = (n: number) => Array.from({ length: n }, () => pool[rand(pool.length)]!);
      const existing = mergeEvents([], pick(rand(25)));
      const added = pick(rand(10));
      const expected = new Map<string, VoiceEvent>();
      for (const e of [...existing, ...added]) if (!expected.has(e.id)) expected.set(e.id, e);
      expect(mergeEvents(existing, added)).toEqual([...expected.values()].sort(compareEvents));
    }
  });
});

describe('withoutEvents', () => {
  const events = [ev('1', 10), ev('2', 20), ev('3', 30)];

  it('drops the given ids and keeps order', () => {
    expect(ids(withoutEvents(events, new Set(['2', '404'])))).toEqual(['1', '3']);
  });

  it('returns a copy when nothing is removed', () => {
    const out = withoutEvents(events, new Set());
    expect(out).toEqual(events);
    expect(out).not.toBe(events);
  });
});

describe('trimBefore', () => {
  const events = [ev('1', 10), ev('2', 20), ev('3', 30)];

  it('keeps events at or after the cutoff', () => {
    expect(ids(trimBefore(events, 20))).toEqual(['2', '3']);
    expect(ids(trimBefore(events, 0))).toEqual(['1', '2', '3']);
    expect(trimBefore(events, 31)).toEqual([]);
  });
});
