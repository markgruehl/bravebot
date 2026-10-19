import { describe, expect, it } from 'vitest';
import { STATS_DAYS_MAX } from '../constants.js';
import { decodeStatsCustomId, encodeStatsCustomId, isStatsCustomId, STATS_CUSTOM_ID_PREFIX } from './customId.js';
import type { StatsView } from './types.js';

const ID = '123456789012345678';
const LONGEST_ID = '18446744073709551615';

describe('stats custom ids', () => {
  it('uses the st: prefix', () => {
    expect(STATS_CUSTOM_ID_PREFIX).toBe('st:');
    expect(isStatsCustomId(encodeStatsCustomId('page', { kind: 'server', page: 'people', days: 30 }))).toBe(true);
    expect(isStatsCustomId('sb:page:1')).toBe(false);
  });

  it('round-trips every view kind and action', () => {
    const views: StatsView[] = [
      { kind: 'server', page: 'overview', days: 30 },
      { kind: 'server', page: 'channels', days: 1 },
      { kind: 'channel', channelId: ID, page: 'times', days: 365 },
      { kind: 'user', userId: ID, days: 7 },
    ];
    for (const view of views) {
      for (const action of ['page', 'share'] as const) {
        expect(decodeStatsCustomId(encodeStatsCustomId(action, view))).toEqual({ action, view });
      }
    }
  });

  it('gives page and share buttons for the same view different ids', () => {
    const view: StatsView = { kind: 'server', page: 'social', days: 30 };
    expect(encodeStatsCustomId('page', view)).not.toBe(encodeStatsCustomId('share', view));
  });

  it('stays within 100 chars', () => {
    expect(encodeStatsCustomId('share', { kind: 'channel', channelId: LONGEST_ID, page: 'overview', days: STATS_DAYS_MAX }).length).toBeLessThanOrEqual(100);
    expect(encodeStatsCustomId('share', { kind: 'user', userId: LONGEST_ID, days: STATS_DAYS_MAX }).length).toBeLessThanOrEqual(100);
  });

  it('rejects malformed ids', () => {
    const bad = [
      '',
      'st:',
      'st:page',
      'st:page:server',
      'st:page:server:overview',
      'st:nope:server:overview:30',
      'st:page:galaxy:overview:30',
      'st:page:server:wat:30',
      'st:page:server:overview:0',
      'st:page:server:overview:366',
      'st:page:server:overview:030',
      'st:page:server:overview:3.5',
      'st:page:server:overview:-1',
      'st:page:server:overview:30:extra',
      `st:page:channel:channels:30:${ID}`,
      'st:page:channel:people:30:abc',
      'st:page:channel:people:30:',
      `st:page:channel:people:30:${'1'.repeat(21)}`,
      'st:page:user:30:',
      'st:page:user:30:12x',
      `st:page:user:abc:${ID}`,
      `sb:page:user:30:${ID}`,
      `st:page:user:30:${'1'.repeat(200)}`,
    ];
    for (const id of bad) expect(decodeStatsCustomId(id), id).toBeNull();
  });
});
