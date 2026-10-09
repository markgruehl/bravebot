/**
 * /stats button custom ids. PURE.
 *
 * Layout (all <= 100 chars; the longest is ~50):
 *   st:<action>:server:<page>:<days>
 *   st:<action>:channel:<page>:<days>:<channelId>
 *   st:<action>:user:<days>:<userId>
 *
 * action is "page" (show that view in place) or "share" (post that view publicly). A page
 * button and the Share button for the same view differ by action, and the page buttons of
 * one message all target different pages, so ids stay unique within a message.
 */
import { STATS_DAYS_MAX, STATS_DAYS_MIN } from '../constants.js';
import type { StatsPage, StatsView } from './types.js';

/** All stats custom ids start with this prefix (the soundboard panel uses "sb:"). */
export const STATS_CUSTOM_ID_PREFIX = 'st:';

export type StatsButtonAction = 'page' | 'share';

export interface StatsCustomId {
  readonly action: StatsButtonAction;
  readonly view: StatsView;
}

const CUSTOM_ID_MAX_LENGTH = 100;
const SNOWFLAKE = /^\d{1,20}$/;
const DAYS = /^[1-9]\d{0,2}$/;
const PAGES: readonly StatsPage[] = ['overview', 'people', 'social', 'channels', 'times', 'records'];

export function isStatsCustomId(customId: string): boolean {
  return customId.startsWith(STATS_CUSTOM_ID_PREFIX);
}

export function encodeStatsCustomId(action: StatsButtonAction, view: StatsView): string {
  const head = `${STATS_CUSTOM_ID_PREFIX}${action}:${view.kind}`;
  switch (view.kind) {
    case 'server':
      return `${head}:${view.page}:${view.days}`;
    case 'channel':
      return `${head}:${view.page}:${view.days}:${view.channelId}`;
    case 'user':
      return `${head}:${view.days}:${view.userId}`;
  }
}

function parseDays(text: string | undefined): number | null {
  if (text === undefined || !DAYS.test(text)) return null;
  const days = Number(text);
  return days >= STATS_DAYS_MIN && days <= STATS_DAYS_MAX ? days : null;
}

function parsePage(text: string | undefined): StatsPage | null {
  return PAGES.find((page) => page === text) ?? null;
}

/** Parse a stats custom id; null for anything malformed, out of range or unknown. */
export function decodeStatsCustomId(customId: string): StatsCustomId | null {
  if (!isStatsCustomId(customId) || customId.length > CUSTOM_ID_MAX_LENGTH) return null;
  const parts = customId.slice(STATS_CUSTOM_ID_PREFIX.length).split(':');
  const [action, kind] = parts;
  if (action !== 'page' && action !== 'share') return null;

  switch (kind) {
    case 'server': {
      if (parts.length !== 4) return null;
      const page = parsePage(parts[2]);
      const days = parseDays(parts[3]);
      if (page === null || days === null) return null;
      return { action, view: { kind, page, days } };
    }
    case 'channel': {
      if (parts.length !== 5) return null;
      const page = parsePage(parts[2]);
      const days = parseDays(parts[3]);
      const channelId = parts[4];
      // A channel view has no Channels page.
      if (page === null || page === 'channels' || days === null) return null;
      if (channelId === undefined || !SNOWFLAKE.test(channelId)) return null;
      return { action, view: { kind, channelId, page, days } };
    }
    case 'user': {
      if (parts.length !== 4) return null;
      const days = parseDays(parts[2]);
      const userId = parts[3];
      if (days === null || userId === undefined || !SNOWFLAKE.test(userId)) return null;
      return { action, view: { kind, userId, days } };
    }
    default:
      return null;
  }
}
