import { describe, expect, it } from 'vitest';
import { addDays, dateKeyOf, daysBetween, forEachLocalHourSlice, HOUR_MS, localParts, nextLocalHour } from './time.js';

const TZ = 'America/Toronto';

describe('localParts', () => {
  it('converts to Toronto local time (EDT, UTC-4)', () => {
    // 2026-07-06 is a Monday.
    const p = localParts(Date.UTC(2026, 6, 6, 3, 30, 15), TZ);
    expect(p).toMatchObject({ year: 2026, month: 7, day: 5, hour: 23, minute: 30, second: 15, dateKey: '2026-07-05' });
    expect(p.weekday).toBe(6); // Sunday
  });

  it('handles EST (UTC-5) and Monday = 0', () => {
    const p = localParts(Date.UTC(2026, 0, 5, 17, 0), TZ); // Mon 2026-01-05 12:00 EST
    expect(p).toMatchObject({ hour: 12, dateKey: '2026-01-05', weekday: 0 });
  });

  it('reports hour 0 at local midnight', () => {
    expect(localParts(Date.UTC(2026, 0, 6, 5, 0), TZ).hour).toBe(0);
  });
});

describe('hour slicing', () => {
  it('finds the next local hour', () => {
    const t = Date.UTC(2026, 0, 5, 17, 20, 30, 500);
    expect(nextLocalHour(t, TZ)).toBe(Date.UTC(2026, 0, 5, 18));
  });

  it('splits an interval at local hour boundaries', () => {
    const slices: [number, number, number][] = [];
    forEachLocalHourSlice(Date.UTC(2026, 0, 5, 17, 30), Date.UTC(2026, 0, 5, 19, 15), TZ, (s, e, p) =>
      slices.push([s, e, p.hour]),
    );
    expect(slices).toEqual([
      [Date.UTC(2026, 0, 5, 17, 30), Date.UTC(2026, 0, 5, 18), 12],
      [Date.UTC(2026, 0, 5, 18), Date.UTC(2026, 0, 5, 19), 13],
      [Date.UTC(2026, 0, 5, 19), Date.UTC(2026, 0, 5, 19, 15), 14],
    ]);
  });

  it('covers the whole interval across a DST change', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT in Toronto.
    const start = Date.UTC(2026, 2, 8, 5, 0);
    const end = start + 4 * HOUR_MS;
    let total = 0;
    const hours: number[] = [];
    forEachLocalHourSlice(start, end, TZ, (s, e, p) => {
      total += e - s;
      hours.push(p.hour);
    });
    expect(total).toBe(4 * HOUR_MS);
    expect(hours).toEqual([0, 1, 3, 4]);
  });

  it('does nothing for an empty interval', () => {
    let calls = 0;
    forEachLocalHourSlice(10, 10, TZ, () => calls++);
    expect(calls).toBe(0);
  });
});

describe('date keys', () => {
  it('shifts and diffs calendar days across months', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(dateKeyOf(Date.UTC(2026, 0, 1, 4, 59), TZ)).toBe('2025-12-31');
  });
});
