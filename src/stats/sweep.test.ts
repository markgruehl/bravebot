import { describe, expect, it } from 'vitest';
import { compareIds, sweep, type SweepSegment } from './sweep.js';

const seg = (
  userId: string,
  channelId: string,
  start: number,
  end: number,
  liveTail = false,
  inferred: { start?: boolean; end?: boolean } = {},
): SweepSegment => ({
  userId,
  channelId,
  start,
  end,
  startInferred: inferred.start ?? false,
  endInferred: inferred.end ?? false,
  liveTail,
});

describe('compareIds', () => {
  it('orders snowflakes by length, then lexicographically', () => {
    expect(['200', '99', '1000', '100'].sort(compareIds)).toEqual(['99', '100', '200', '1000']);
  });
});

describe('sweep', () => {
  it('finds calls with starter, closer, peak and open flag', () => {
    const { calls } = sweep(
      [
        seg('2', 'c', 0, 30),
        seg('1', 'c', 10, 40),
        // Later call still running at the end of the data.
        seg('3', 'c', 50, 100, true),
        seg('4', 'c', 60, 100),
      ],
      0,
      100,
    );
    expect(calls).toEqual([
      { channelId: 'c', start: 0, end: 40, peak: 2, starter: '2', closer: '1', open: false },
      { channelId: 'c', start: 50, end: 100, peak: 2, starter: '3', closer: '4', open: true },
    ]);
  });

  it('keeps a call going through a leave and join at the same instant', () => {
    const result = sweep([seg('1', 'c', 0, 10), seg('2', 'c', 10, 20), seg('1', 'c', 20, 30)], 0, 30);
    expect(result.calls).toEqual([
      { channelId: 'c', start: 0, end: 30, peak: 1, starter: '1', closer: '1', open: false },
    ]);
    expect(result.channels.get('c')?.record).toEqual({ size: 1, at: 0 });
    expect(result.pairs.size).toBe(0);
  });

  it('counts a user overlapping themselves once', () => {
    const result = sweep([seg('1', 'c', 0, 20), seg('1', 'c', 10, 30), seg('2', 'c', 15, 25)], 0, 30);
    expect(result.channels.get('c')).toEqual({
      channelId: 'c',
      personMs: 40,
      occupiedMs: 30,
      record: { size: 2, at: 15 },
    });
    expect(result.pairs.get('1')?.get('2')).toBe(10);
    expect(result.calls).toHaveLength(1);
  });

  it('credits only the window but sees whole calls', () => {
    const result = sweep([seg('1', 'c', 0, 100), seg('2', 'c', 20, 80)], 50, 70);
    expect(result.channels.get('c')).toEqual({
      channelId: 'c',
      personMs: 40,
      occupiedMs: 20,
      record: { size: 2, at: 50 },
    });
    expect(result.calls[0]).toMatchObject({ start: 0, end: 100, peak: 2 });
  });

  it('credits no starter when the same-time joins that opened the call were inferred', () => {
    const { calls } = sweep(
      [seg('1', 'c', 0, 30, false, { start: true }), seg('2', 'c', 0, 20, false, { start: true })],
      0,
      30,
    );
    expect(calls).toEqual([{ channelId: 'c', start: 0, end: 30, peak: 2, starter: null, closer: '1', open: false }]);
  });

  it('credits no starter when one of the same-time joins was inferred', () => {
    const { calls } = sweep([seg('1', 'c', 0, 30), seg('2', 'c', 0, 20, false, { start: true })], 0, 30);
    expect(calls[0]).toMatchObject({ starter: null, closer: '1' });
  });

  it('credits no closer when the same-time leaves that emptied the call were inferred', () => {
    const { calls } = sweep(
      [seg('1', 'c', 0, 30, false, { end: true }), seg('2', 'c', 10, 30, false, { end: true })],
      0,
      30,
    );
    expect(calls).toEqual([{ channelId: 'c', start: 0, end: 30, peak: 2, starter: '1', closer: null, open: false }]);
  });

  it('only looks at the boundaries that opened and emptied the call', () => {
    // 2's inferred start and 1's inferred end happen mid-call; the call's own edges are observed.
    const { calls } = sweep(
      [seg('1', 'c', 0, 20, false, { end: true }), seg('2', 'c', 10, 30, false, { start: true })],
      0,
      30,
    );
    expect(calls[0]).toMatchObject({ starter: '1', closer: '2' });
  });

  it('treats a self-overlapping user the same in any input order', () => {
    // 1 has an observed and an inferred start at the opening instant: no starter either way.
    const opening = [seg('1', 'c', 0, 20), seg('1', 'c', 0, 10, false, { start: true }), seg('2', 'c', 5, 20)];
    expect(sweep(opening, 0, 20).calls[0]).toMatchObject({ starter: null });
    expect(sweep([...opening].reverse(), 0, 20).calls[0]).toMatchObject({ starter: null });
    // Its inferred start mid-call does not matter.
    const later = [seg('1', 'c', 0, 20), seg('1', 'c', 5, 10, false, { start: true }), seg('2', 'c', 5, 20)];
    expect(sweep(later, 0, 20).calls[0]).toMatchObject({ starter: '1', closer: '2' });
    expect(sweep([...later].reverse(), 0, 20).calls[0]).toMatchObject({ starter: '1', closer: '2' });
  });

  it('ignores zero-length segments', () => {
    const result = sweep([seg('1', 'c', 5, 5)], 0, 10);
    expect(result.calls).toEqual([]);
    expect(result.channels.size).toBe(0);
  });
});
