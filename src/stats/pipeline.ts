/**
 * Pure glue between the cached history and the report: drop bots, reconstruct sessions over
 * all cached history (so streaks and the previous-period trend see everything), then compute
 * the report for the requested window and scope.
 */
import { STATS_MISSED_LEAVE_CAP_MS, STATS_TIMEZONE } from '../constants.js';
import { computeReport } from './compute.js';
import { reconstructSessions } from './sessions.js';
import { DAY_MS } from './time.js';
import type { Checkpoint, GuildVoiceHistory, Ms, PersonInfo, StatsReport, StatsScope, StatsView } from './types.js';

export interface BuildReportInput {
  readonly history: GuildVoiceHistory;
  /** Resolved people; ids missing here are treated as humans. */
  readonly people: ReadonlyMap<string, PersonInfo>;
  /** Who is in voice right now (the checkpoint at `now`). */
  readonly live: Checkpoint;
  readonly view: StatsView;
  readonly now: Ms;
}

/** Every user id that appears in the history or the live checkpoint (for name/bot lookup). */
export function userIdsOf(history: GuildVoiceHistory, live: Checkpoint): Set<string> {
  const ids = new Set<string>();
  for (const event of history.events) ids.add(event.userId);
  for (const checkpoint of [...history.checkpoints, live]) {
    for (const userId of checkpoint.present.keys()) ids.add(userId);
  }
  return ids;
}

/** A user view covers the whole server; the card picks the user out of the server report. */
export function scopeOf(view: StatsView): StatsScope {
  return view.kind === 'channel' ? { kind: 'channel', channelId: view.channelId } : { kind: 'server' };
}

function withoutBots(checkpoint: Checkpoint, isBot: (userId: string) => boolean): Checkpoint {
  const present = new Map<string, string>();
  for (const [userId, channelId] of checkpoint.present) {
    if (!isBot(userId)) present.set(userId, channelId);
  }
  return { at: checkpoint.at, present };
}

export function buildReport(input: BuildReportInput): StatsReport {
  const { history, people, live, view, now } = input;
  const isBot = (userId: string) => people.get(userId)?.bot === true;

  const events = history.events.filter((event) => !isBot(event.userId));
  const checkpoints = [...history.checkpoints.filter((c) => c.at <= now), live]
    .map((c) => withoutBots(c, isBot))
    .sort((a, b) => a.at - b.at);

  const recon = reconstructSessions(events, { now, capMs: STATS_MISSED_LEAVE_CAP_MS, checkpoints });
  return computeReport(recon, {
    window: { from: now - view.days * DAY_MS, to: now, days: view.days },
    scope: scopeOf(view),
    timeZone: STATS_TIMEZONE,
    oldestEventAt: history.oldestEventAt,
  });
}
