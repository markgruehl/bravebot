/**
 * Voice events from system-channel notices, and the sorted-array helpers the cache keeps them
 * in. Pure: cache.ts does the Discord reads and owns the arrays.
 */
import { parseVoiceNotice } from '../voice-activity/notices.js';
import type { Ms, NoticeMessage, VoiceEvent } from './types.js';

/** Snowflake order without BigInt: a shorter id is older, equal lengths compare as text. */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order of cached events: by time, then message id. */
export function compareEvents(a: VoiceEvent, b: VoiceEvent): number {
  return a.at - b.at || compareSnowflakes(a.id, b.id);
}

/** The notice in a message, or null unless the bot itself wrote a voice notice. */
export function eventFromMessage(message: NoticeMessage, botUserId: string): VoiceEvent | null {
  if (message.author.id !== botUserId) return null;
  const parsed = parseVoiceNotice(message.content);
  if (!parsed) return null;
  return { ...parsed, id: message.id, at: message.createdTimestamp };
}

function isSorted(events: readonly VoiceEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (compareEvents(events[i - 1]!, events[i]!) > 0) return false;
  }
  return true;
}

/**
 * `existing` plus `added`, deduped by id (existing wins, then the first of `added`) and sorted
 * with compareEvents. `existing` is assumed free of duplicates, as every result of this is.
 * Linear when `existing` is sorted (appending a few newer events is a plain concat); a full
 * sort otherwise.
 */
export function mergeEvents(existing: readonly VoiceEvent[], added: readonly VoiceEvent[]): VoiceEvent[] {
  const addedIds = new Set<string>();
  let fresh: VoiceEvent[] = [];
  for (const event of added) {
    if (addedIds.has(event.id)) continue;
    addedIds.add(event.id);
    fresh.push(event);
  }
  if (fresh.length > 0) {
    // One pass over existing against the (usually tiny) set of added ids.
    const taken = new Set<string>();
    for (const event of existing) if (addedIds.has(event.id)) taken.add(event.id);
    if (taken.size > 0) fresh = fresh.filter((event) => !taken.has(event.id));
  }
  fresh.sort(compareEvents);

  if (!isSorted(existing)) return [...existing, ...fresh].sort(compareEvents);
  const last = existing.at(-1);
  const first = fresh[0];
  if (!last || !first || compareEvents(last, first) <= 0) return [...existing, ...fresh];

  const merged: VoiceEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < fresh.length) {
    const a = existing[i]!;
    const b = fresh[j]!;
    if (compareEvents(a, b) <= 0) {
      merged.push(a);
      i++;
    } else {
      merged.push(b);
      j++;
    }
  }
  while (i < existing.length) merged.push(existing[i++]!);
  while (j < fresh.length) merged.push(fresh[j++]!);
  return merged;
}

/** Events minus the given message ids (deleted notices). Order is kept. */
export function withoutEvents(events: readonly VoiceEvent[], ids: ReadonlySet<string>): VoiceEvent[] {
  if (ids.size === 0) return [...events];
  return events.filter((event) => !ids.has(event.id));
}

/** Events at or after `cutoff` (the cache horizon). Order is kept. */
export function trimBefore(events: readonly VoiceEvent[], cutoff: Ms): VoiceEvent[] {
  return events.filter((event) => event.at >= cutoff);
}
