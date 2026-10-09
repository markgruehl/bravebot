/**
 * Voice stats contracts. Every stats module codes against these; change only by agreement.
 *
 * Pipeline (all pure except cache.ts and the interaction handler):
 *   system-channel messages ──events.ts──▶ VoiceEvent[]   (+ live notices appended by cache.ts)
 *   VoiceEvent[] + Checkpoint[] ──sessions.ts──▶ Reconstruction (Session[] over ALL cached history)
 *   Reconstruction + window/scope ──compute.ts──▶ StatsReport
 *   StatsReport + names + view ──render.ts──▶ StatsMessage (embeds + components)
 *
 * Conventions
 * - Times are epoch milliseconds (`Ms`). "Local" means STATS_TIMEZONE (America/Toronto); only
 *   time.ts talks to Intl.
 * - Ids are Discord snowflake strings. Bot users are filtered out BEFORE reconstruction.
 * - Nothing is persisted: events are rebuilt from the system channel on first use per guild.
 */
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, Guild } from 'discord.js';

/** Epoch milliseconds. */
export type Ms = number;

// ---------------------------------------------------------------------------
// Events (parsed join/leave/move notices)
// ---------------------------------------------------------------------------

export type VoiceEventKind = 'connect' | 'disconnect' | 'move';

/** The pure inverse of describeVoiceChange (src/voice-activity/notices.ts parseVoiceNotice). */
export interface ParsedVoiceNotice {
  readonly kind: VoiceEventKind;
  readonly userId: string;
  /** Voice channel left (disconnect, move); null for connect. */
  readonly from: string | null;
  /** Voice channel joined (connect, move); null for disconnect. */
  readonly to: string | null;
}

export interface VoiceEvent extends ParsedVoiceNotice {
  /** Source message id (dedupe + MessageDelete). Synthetic events never come from messages. */
  readonly id: string;
  /** message.createdTimestamp. */
  readonly at: Ms;
}

/**
 * A known snapshot of who was in voice (userId -> voice channelId, bots excluded) at a time:
 * the bot's startup in this process, and "now" at query time (from guild.voiceStates).
 * See sessions.ts for how it repairs missed leaves.
 */
export interface Checkpoint {
  readonly at: Ms;
  readonly present: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Continuous time one user spent in ONE voice channel. [start, end). */
export interface Segment {
  readonly userId: string;
  readonly channelId: string;
  readonly start: Ms;
  readonly end: Ms;
  /**
   * True when this boundary was inferred rather than seen in a notice: a start opened by a
   * checkpoint (or a channel change noticed at one), an end from a missed leave. Party
   * starter / closer credit is only given for observed boundaries.
   */
  readonly startInferred: boolean;
  readonly endInferred: boolean;
}

/**
 * Continuous time in voice for one user. Moves do NOT split a session; they add segments.
 * Segments are contiguous, ordered and non-overlapping: segments[0].start === start,
 * segments[i].end === segments[i+1].start, last.end === end.
 */
export interface Session {
  readonly userId: string;
  readonly start: Ms;
  readonly end: Ms;
  readonly segments: readonly Segment[];
  /** True when the end was inferred (missed leave: capped, closed by a checkpoint or by a join elsewhere). */
  readonly estimated: boolean;
  /** True when the session is still running at `now` (user present in the final checkpoint). */
  readonly live: boolean;
}

export interface ReconstructOptions {
  /** Query time; the final checkpoint is at `now`. Sessions never extend past it. */
  readonly now: Ms;
  /** Missed-leave cap (STATS_MISSED_LEAVE_CAP_MS = 12h). */
  readonly capMs: Ms;
  /**
   * Sorted ascending by `at`; all `at` <= now. The caller always includes a checkpoint at
   * `now` (live voice states) and, when known, one at this process's startup.
   */
  readonly checkpoints: readonly Checkpoint[];
}

export interface Reconstruction {
  /** All sessions, sorted by start then userId. */
  readonly sessions: readonly Session[];
  /** Events that matched nothing (leave with no open session). Diagnostic only, not shown. */
  readonly unmatchedEvents: number;
}

// ---------------------------------------------------------------------------
// Report (compute.ts output, render.ts input)
// ---------------------------------------------------------------------------

export interface StatsWindow {
  /** Inclusive start. */
  readonly from: Ms;
  /** Exclusive end (normally `now`). */
  readonly to: Ms;
  readonly days: number;
}

export type StatsScope = { readonly kind: 'server' } | { readonly kind: 'channel'; readonly channelId: string };

export interface ComputeOptions {
  readonly window: StatsWindow;
  readonly scope: StatsScope;
  /** IANA zone, normally STATS_TIMEZONE. */
  readonly timeZone: string;
  /** Where cached history starts (GuildVoiceHistory.oldestEventAt): drives coverage + trend availability. */
  readonly oldestEventAt: Ms | null;
}

export interface Totals {
  /** Sum of every person's time in voice (person-ms). */
  readonly personMs: number;
  /** Distinct people with any time in the window. */
  readonly people: number;
  /** Calls (channel occupied continuously; see Call) that overlap the window. */
  readonly calls: number;
  /** Sessions that overlap the window. */
  readonly sessions: number;
}

export interface UserMs {
  readonly userId: string;
  readonly ms: number;
}

export interface PersonSummary {
  readonly userId: string;
  /** 1-based rank by totalMs (ties broken by userId, renderer re-sorts by name where shown). */
  readonly rank: number;
  readonly totalMs: number;
  /** totalMs in the previous window of equal length; null when history does not cover it. */
  readonly previousTotalMs: number | null;
  readonly sessions: number;
  readonly avgSessionMs: number;
  readonly longestSessionMs: number;
  /** Distinct voice channels with time in the window ("butterflies"). */
  readonly channelsVisited: number;
  /** Time alone in a channel (nobody else in that same channel). */
  readonly soloMs: number;
  /** Sum of pair co-time with everyone else (person-ms, "social glue"). */
  readonly coMs: number;
  /** Time between 00:00 and 06:00 local. */
  readonly nightMs: number;
  /** nightMs / totalMs (0 when totalMs is 0). */
  readonly nightShare: number;
  /** Consecutive local days (>= 1 minute in voice each) ending today or yesterday; 0 otherwise. */
  readonly currentStreak: number;
  /** Streaks count over ALL cached history up to window.to (not just the window). */
  readonly longestStreak: number;
  /** Calls this person started (a join the bot saw, into an empty channel) that reached >= 2 people. */
  readonly partyStarts: number;
  /** Calls that reached >= 2 people where this person was the last to leave. */
  readonly closes: number;
  /** Top co-time partner, null when never with anyone. */
  readonly bestFriend: UserMs | null;
  /** Up to 3 top partners, desc. */
  readonly topFriends: readonly UserMs[];
  readonly topChannel: { readonly channelId: string; readonly ms: number } | null;
  /** Local hour (0-23) with the most of this person's time; null when no time. */
  readonly signatureHour: number | null;
  /** This person's sessions overlapping the window whose end was estimated (user card footer). */
  readonly estimatedSessions: number;
  /** sessions >= STATS_MIN_SESSIONS && totalMs >= STATS_MIN_TOTAL_MS: eligible for ratio/avg rankings. */
  readonly qualified: boolean;
}

export interface PairStat {
  /** Sorted ascending (a < b by snowflake order). */
  readonly a: string;
  readonly b: string;
  readonly ms: number;
}

export interface GroupStat {
  /** The EXACT set of people together in one channel (size >= 3), sorted by snowflake order. */
  readonly userIds: readonly string[];
  readonly ms: number;
}

export interface ChannelStat {
  readonly channelId: string;
  /** Sum of everyone's time in the channel. */
  readonly personMs: number;
  /** Wall-clock time with >= 1 person in the channel. */
  readonly occupiedMs: number;
  readonly calls: number;
  /** Max concurrent people (earliest time it was reached); size 0 never appears. */
  readonly record: { readonly size: number; readonly at: Ms };
}

/** A call: one channel continuously occupied (>= 1 person) from the first join to empty. */
export interface CallRecord {
  readonly channelId: string;
  readonly start: Ms;
  readonly end: Ms;
  /** Max concurrent people during the call. */
  readonly peak: number;
}

export interface Records {
  /** Longest call by wall-clock (clipped to the window), among calls that reached >= 2 people. */
  readonly longestCall: CallRecord | null;
  /** Most people in one channel at once. */
  readonly biggestParty: { readonly channelId: string; readonly size: number; readonly at: Ms } | null;
  /** Local day with the most person-time. date is 'YYYY-MM-DD'. */
  readonly busiestDay: { readonly date: string; readonly personMs: number } | null;
  readonly longestSession: { readonly userId: string; readonly start: Ms; readonly ms: number } | null;
  /** endDate 'YYYY-MM-DD' local. */
  readonly longestStreak: { readonly userId: string; readonly days: number; readonly endDate: string } | null;
}

/** Monday = 0 ... Sunday = 6. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface StatsReport {
  readonly window: StatsWindow;
  readonly scope: StatsScope;
  readonly timeZone: string;
  /** Where cached history starts; render warns when it is after window.from. */
  readonly oldestEventAt: Ms | null;
  /** Sessions overlapping the window whose end was estimated. */
  readonly estimatedSessions: number;
  readonly totals: Totals;
  /** Totals for [from - (to - from), from); null when history does not reach that far back. */
  readonly previousTotals: Totals | null;
  /** Everyone with time in the window, sorted by totalMs desc then userId. */
  readonly people: readonly PersonSummary[];
  /** Sorted by ms desc. Only pairs with ms > 0. */
  readonly pairs: readonly PairStat[];
  /** Sorted by ms desc. */
  readonly groups: readonly GroupStat[];
  /** Sorted by personMs desc. For channel scope: exactly that channel (if it had any time). */
  readonly channels: readonly ChannelStat[];
  /**
   * heatmap[weekday][block]: average people in voice during that local weekday and 2-hour
   * block (block b covers hours 2b..2b+1) across the window.
   */
  readonly heatmap: readonly (readonly number[])[];
  /** Busiest recurring local weekday + hour by average people; null when no time. */
  readonly primeTime: { readonly weekday: Weekday; readonly hour: number; readonly avgPeople: number } | null;
  readonly records: Records;
}

// ---------------------------------------------------------------------------
// Views + rendering (render.ts, interactions/stats.ts)
// ---------------------------------------------------------------------------

export type StatsPage = 'overview' | 'people' | 'social' | 'channels' | 'times' | 'records';

export type StatsView =
  | { readonly kind: 'server'; readonly page: StatsPage; readonly days: number }
  | { readonly kind: 'channel'; readonly channelId: string; readonly page: StatsPage; readonly days: number }
  | { readonly kind: 'user'; readonly userId: string; readonly days: number };

/** Ready-to-send payload (raw API objects, like panel.ts). */
export interface StatsMessage {
  readonly embeds: readonly APIEmbed[];
  readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
}

export interface RenderContext {
  /** userId -> display name (already resolved: display name, username, or "Former member"). */
  readonly names: ReadonlyMap<string, string>;
  /** voice channelId -> name; unknown channels render as "deleted channel". */
  readonly channelNames: ReadonlyMap<string, string>;
  /** Show the Share button (true on the private reply, false on the shared public post). */
  readonly shareable: boolean;
  /** Query time (for "today", relative dates). */
  readonly now: Ms;
}

// ---------------------------------------------------------------------------
// Service (cache.ts implements; BotContext.stats)
// ---------------------------------------------------------------------------

/** The parts of a discord.js Message the stats pipeline reads. */
export interface NoticeMessage {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly author: { readonly id: string };
}

/** Cached voice history of one guild (its current system channel). */
export interface GuildVoiceHistory {
  /** The system channel the events were read from. */
  readonly channelId: string;
  /** Sorted by `at`, then id. Covers at most STATS_CACHE_DAYS. */
  readonly events: readonly VoiceEvent[];
  /** Startup snapshot(s) recorded in this process, sorted by `at`. Excludes the "now" one. */
  readonly checkpoints: readonly Checkpoint[];
  /**
   * Where the cached history starts (see coverageStart in cache.ts): null when there are no
   * events; the cache cutoff when the scan reached the horizon and the oldest notice is within
   * 7 days after it; otherwise the oldest cached notice. Older non-notice messages never count.
   */
  readonly oldestEventAt: Ms | null;
}

/** Who a user id is, for display and bot filtering. */
export interface PersonInfo {
  /** Server display name, else username, else "Former member". */
  readonly name: string;
  readonly bot: boolean;
}

export interface StatsService {
  /**
   * The guild's voice history, scanning the system channel on first use (and again when the
   * system channel changed). Concurrent callers share one scan; a failed scan caches nothing.
   * Throws StatsError (no-system-channel / missing-access / history-failed).
   */
  load(guild: Guild): Promise<GuildVoiceHistory>;
  /**
   * A notice the bot just posted in the system channel. Appended when that guild's cache is
   * built or building (deduped by message id); ignored otherwise. Never throws.
   */
  record(guildId: string, message: NoticeMessage): void;
  /** Messages deleted in a guild channel: drop matching cached events. Never throws. */
  forget(guildId: string, channelId: string, messageIds: Iterable<string>): void;
  /** Snapshot who (non-bot) is in voice right now as a startup checkpoint. Never throws. */
  noteStartup(guild: Guild): void;
  /** The bot left the guild: drop everything for it. */
  dropGuild(guildId: string): void;
  /**
   * Resolve user ids to names + bot flags (members fetched in batches, former members via
   * the user API, cached in memory for a while). Never throws: unknown ids become
   * { name: 'Former member', bot: false }.
   */
  people(guild: Guild, userIds: Iterable<string>): Promise<ReadonlyMap<string, PersonInfo>>;
  /** Cache status for /info; null when nothing is cached for the guild. */
  status(guildId: string): { readonly events: number; readonly oldestEventAt: Ms | null; readonly building: boolean } | null;
}
