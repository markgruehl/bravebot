/**
 * In-memory voice stats history (StatsService, see src/stats/types.ts).
 * - Built lazily per guild by scanning the system channel newest -> oldest for the join/leave
 *   notices the bot posted, back to STATS_CACHE_DAYS. Nothing is persisted.
 * - One scan per guild at a time; callers share it. A failed scan caches nothing.
 * - Kept current by record() (each notice the bot posts) and forget() (deleted messages).
 * - Startup checkpoints (who was in voice when the bot came up) are kept even without a cache.
 * - people() resolves names in batches and caches them for a while.
 */
import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { Client, Guild, GuildMember, TextChannel } from 'discord.js';
import { HISTORY_PAGE_SIZE, STATS_CACHE_DAYS } from '../constants.js';
import { StatsError, errorMessage } from '../errors.js';
import { eventFromMessage, mergeEvents, trimBefore, withoutEvents } from './events.js';
import { DAY_MS, HOUR_MS } from './time.js';
import type { Checkpoint, GuildVoiceHistory, Ms, PersonInfo, StatsService, VoiceEvent } from './types.js';

/** Startup checkpoints kept per guild (one per ready/available; older ones add little). */
const MAX_CHECKPOINTS = 5;

/** guild.members.fetch({ user }) accepts at most 100 ids per gateway request. */
const MEMBER_BATCH_SIZE = 100;

/** Per-call cap on one-by-one user API lookups (former members), so a huge list cannot stall /stats. */
const MAX_USER_LOOKUPS = 100;

const FORMER_MEMBER: PersonInfo = { name: 'Former member', bot: false };

/**
 * How far after the cutoff a horizon-reaching history's oldest notice may be and still count as
 * covering the whole horizon (quiet stretches with no notices are normal).
 */
const STATS_COVERAGE_SLACK_MS = 7 * DAY_MS;

export interface StatsServiceDeps {
  readonly client: Client;
  /** Injected for tests. Defaults to Date.now. */
  readonly now?: () => Ms;
  /** History horizon in days. Defaults to STATS_CACHE_DAYS. */
  readonly cacheDays?: number;
  /** How long resolved names stay cached. Defaults to 1 hour. */
  readonly peopleTtlMs?: number;
}

interface GuildCache {
  readonly channelId: string;
  events: readonly VoiceEvent[];
  /**
   * The scan stopped at the horizon: the channel has messages older than it (of any kind, so
   * this alone does not prove notices reach back that far; see coverageStart).
   */
  readonly reachedHorizon: boolean;
}

interface Build {
  readonly channelId: string;
  /** Notices recorded while scanning; merged in when the scan succeeds. */
  buffer: VoiceEvent[];
  /** Message ids deleted while scanning (the scan may already have read them). */
  readonly forgotten: Set<string>;
  /** Set right after the build is registered (so a synchronous failure still unregisters it). */
  promise: Promise<GuildVoiceHistory> | null;
}

interface CachedPerson {
  readonly info: PersonInfo;
  readonly at: Ms;
}

/** Numeric Discord API error code (DiscordAPIError.code), if any. */
function discordErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/** Older snowflake first (numeric compare on the string). */
function snowflakeLess(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b;
}

function missingAccess(channelId: string, cause?: unknown): StatsError {
  return new StatsError(
    'missing-access',
    `I need View Channel and Read Message History in <#${channelId}> to read the join/leave notices.`,
    cause === undefined ? undefined : { cause },
  );
}

/** Map Discord API failures while reading the system channel to StatsError. */
function toStatsError(err: unknown, channelId: string): StatsError {
  if (err instanceof StatsError) return err;
  const code = discordErrorCode(err);
  if (
    code === RESTJSONErrorCodes.MissingAccess ||
    code === RESTJSONErrorCodes.MissingPermissions ||
    code === RESTJSONErrorCodes.UnknownChannel
  ) {
    return missingAccess(channelId, err);
  }
  return new StatsError('history-failed', 'Reading the join/leave history failed. Try again in a minute.', {
    cause: err,
  });
}

/**
 * GuildVoiceHistory.oldestEventAt: where cached history starts.
 * - No events: null.
 * - The scan reached the horizon and the oldest notice is within STATS_COVERAGE_SLACK_MS after
 *   the cutoff: the cutoff (notices run right up to the horizon, so the history covers all of it;
 *   otherwise the 365-day trend could never have a covered previous period).
 * - Otherwise the oldest notice's time. Older non-notice messages (chat in a shared system
 *   channel) do not extend coverage: the notices may only have started recently.
 * Every load recomputes this after trimming to its own cutoff.
 */
export function coverageStart(events: readonly VoiceEvent[], reachedHorizon: boolean, cutoff: Ms): Ms | null {
  const oldest = events[0]?.at;
  if (oldest === undefined) return null;
  return reachedHorizon && oldest - cutoff <= STATS_COVERAGE_SLACK_MS ? cutoff : oldest;
}

function memberInfo(member: GuildMember): PersonInfo {
  return { name: member.displayName || member.user.username, bot: member.user.bot };
}

export function createStatsService(deps: StatsServiceDeps): StatsService {
  const { client } = deps;
  const now = deps.now ?? Date.now;
  const horizonMs = (deps.cacheDays ?? STATS_CACHE_DAYS) * DAY_MS;
  const peopleTtlMs = deps.peopleTtlMs ?? HOUR_MS;

  const caches = new Map<string, GuildCache>();
  const builds = new Map<string, Build>();
  const checkpoints = new Map<string, Checkpoint[]>();
  const peopleCaches = new Map<string, Map<string, CachedPerson>>();

  function history(
    guildId: string,
    channelId: string,
    events: readonly VoiceEvent[],
    reachedHorizon: boolean,
    cutoff: Ms,
  ): GuildVoiceHistory {
    return {
      channelId,
      events,
      checkpoints: [...(checkpoints.get(guildId) ?? [])],
      oldestEventAt: coverageStart(events, reachedHorizon, cutoff),
    };
  }

  async function scan(guild: Guild, channel: TextChannel, build: Build): Promise<GuildVoiceHistory> {
    const botUserId = client.user?.id;
    const startedAt = Date.now();
    console.log(`[stats] ${guild.name} (${guild.id}): scanning join/leave history in #${channel.name}`);

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    // Unknown own member: let the API answer instead (MissingAccess maps to the same error).
    if (me && !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw missingAccess(channel.id);
    }

    const cutoff = now() - horizonMs;
    const scanned: VoiceEvent[] = [];
    let pages = 0;
    let reachedHorizon = false;
    let before: string | undefined;
    try {
      for (;;) {
        const page = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
        pages++;
        let oldestAt = Infinity;
        for (const message of page.values()) {
          const event = botUserId ? eventFromMessage(message, botUserId) : null;
          if (event) scanned.push(event);
          if (before === undefined || snowflakeLess(message.id, before)) before = message.id;
          oldestAt = Math.min(oldestAt, message.createdTimestamp);
        }
        if (oldestAt < cutoff) reachedHorizon = true;
        if (page.size < HISTORY_PAGE_SIZE || reachedHorizon) break;
      }
    } catch (err) {
      throw toStatsError(err, channel.id);
    }

    // Pages run newest -> oldest; reversed they are (nearly) sorted, which keeps the merge linear.
    const events = trimBefore(withoutEvents(mergeEvents(scanned.reverse(), build.buffer), build.forgotten), cutoff);
    console.log(
      `[stats] ${guild.name} (${guild.id}): ${events.length} event(s) from ${pages} page(s) in ${Date.now() - startedAt}ms`,
    );
    // Install only if this scan is still current (not dropped or superseded by a channel change).
    if (builds.get(guild.id) === build) caches.set(guild.id, { channelId: channel.id, events, reachedHorizon });
    return history(guild.id, channel.id, events, reachedHorizon, cutoff);
  }

  function startBuild(guild: Guild, channel: TextChannel): Promise<GuildVoiceHistory> {
    const build: Build = { channelId: channel.id, buffer: [], forgotten: new Set(), promise: null };
    caches.delete(guild.id);
    builds.set(guild.id, build);
    const promise = (async () => {
      try {
        return await scan(guild, channel, build);
      } catch (err) {
        console.error(`[stats] ${guild.name} (${guild.id}): history scan failed: ${errorMessage(err)}`);
        throw toStatsError(err, channel.id);
      } finally {
        if (builds.get(guild.id) === build) builds.delete(guild.id);
      }
    })();
    build.promise = promise;
    return promise;
  }

  /** The cache or in-progress build that notices from `channelId` belong to, if any. */
  function target(guildId: string, channelId: string): GuildCache | Build | undefined {
    const build = builds.get(guildId);
    if (build) return build.channelId === channelId ? build : undefined;
    const cache = caches.get(guildId);
    return cache?.channelId === channelId ? cache : undefined;
  }

  async function resolvePeople(guild: Guild, ids: readonly string[]): Promise<Map<string, PersonInfo>> {
    const found = new Map<string, PersonInfo>();
    let batchFailed = false;
    for (let i = 0; i < ids.length && !batchFailed; i += MEMBER_BATCH_SIZE) {
      const chunk = ids.slice(i, i + MEMBER_BATCH_SIZE);
      try {
        const members = await guild.members.fetch({ user: chunk });
        for (const member of members.values()) found.set(member.id, memberInfo(member));
      } catch (err) {
        console.warn(`[stats] ${guild.name} (${guild.id}): member batch fetch failed: ${errorMessage(err)}`);
        batchFailed = true;
      }
    }

    // Leftovers are former members (or everyone, if the gateway request failed): one by one.
    let lookups = 0;
    for (const id of ids) {
      if (found.has(id)) continue;
      if (lookups++ >= MAX_USER_LOOKUPS) break;
      if (batchFailed) {
        try {
          found.set(id, memberInfo(await guild.members.fetch(id)));
          continue;
        } catch {
          // Not a member (or the API failed): try the user instead.
        }
      }
      try {
        const user = await client.users.fetch(id);
        // User#displayName is the global display name, else the username.
        found.set(id, { name: user.displayName || user.username, bot: user.bot });
      } catch {
        found.set(id, FORMER_MEMBER);
      }
    }
    return found;
  }

  return {
    load(guild) {
      const channel = guild.systemChannel;
      if (!channel) {
        return Promise.reject(
          new StatsError(
            'no-system-channel',
            'This server has no system channel, so there are no join/leave notices to read. Set one in Server Settings → Overview → System Messages Channel.',
          ),
        );
      }
      const build = builds.get(guild.id);
      if (build?.promise && build.channelId === channel.id) return build.promise;
      const cache = caches.get(guild.id);
      if (!build && cache?.channelId === channel.id) {
        const cutoff = now() - horizonMs;
        cache.events = trimBefore(cache.events, cutoff);
        return Promise.resolve(history(guild.id, cache.channelId, cache.events, cache.reachedHorizon, cutoff));
      }
      if (cache || build) {
        console.log(`[stats] ${guild.name} (${guild.id}): system channel changed, rescanning`);
      }
      return startBuild(guild, channel);
    },

    record(guildId, message) {
      try {
        const into = target(guildId, message.channelId);
        const botUserId = client.user?.id;
        if (!into || !botUserId) return;
        const event = eventFromMessage(message, botUserId);
        if (!event) return;
        if ('buffer' in into) into.buffer.push(event);
        else into.events = mergeEvents(into.events, [event]);
      } catch (err) {
        console.error(`[stats] guild ${guildId}: recording a notice failed:`, err);
      }
    },

    forget(guildId, channelId, messageIds) {
      try {
        const into = target(guildId, channelId);
        if (!into) return;
        const ids = new Set(messageIds);
        if (ids.size === 0) return;
        if ('buffer' in into) {
          for (const id of ids) into.forgotten.add(id);
          into.buffer = into.buffer.filter((event) => !ids.has(event.id));
        } else {
          into.events = withoutEvents(into.events, ids);
        }
      } catch (err) {
        console.error(`[stats] guild ${guildId}: forgetting messages failed:`, err);
      }
    },

    noteStartup(guild) {
      try {
        const present = new Map<string, string>();
        for (const state of guild.voiceStates.cache.values()) {
          // Uncached members are kept: bots among them are filtered by people() later.
          if (state.channelId && state.member?.user.bot !== true) present.set(state.id, state.channelId);
        }
        const list = [...(checkpoints.get(guild.id) ?? []), { at: now(), present }];
        list.sort((a, b) => a.at - b.at);
        checkpoints.set(guild.id, list.slice(-MAX_CHECKPOINTS));
      } catch (err) {
        console.error(`[stats] ${guild.name} (${guild.id}): startup snapshot failed:`, err);
      }
    },

    dropGuild(guildId) {
      caches.delete(guildId);
      builds.delete(guildId);
      checkpoints.delete(guildId);
      peopleCaches.delete(guildId);
    },

    async people(guild, userIds) {
      const ids = [...new Set(userIds)];
      const result = new Map<string, PersonInfo>();
      try {
        const at = now();
        let cache = peopleCaches.get(guild.id);
        if (!cache) {
          cache = new Map();
          peopleCaches.set(guild.id, cache);
        }
        const missing: string[] = [];
        for (const id of ids) {
          const hit = cache.get(id);
          if (hit && at - hit.at < peopleTtlMs) result.set(id, hit.info);
          else missing.push(id);
        }
        if (missing.length > 0) {
          const resolved = await resolvePeople(guild, missing);
          for (const id of missing) {
            const info = resolved.get(id);
            if (!info) {
              result.set(id, FORMER_MEMBER); // over the lookup cap: answer, but retry next time
              continue;
            }
            result.set(id, info);
            peopleCaches.get(guild.id)?.set(id, { info, at });
          }
        }
      } catch (err) {
        console.error(`[stats] ${guild.name} (${guild.id}): resolving names failed:`, err);
      }
      for (const id of ids) if (!result.has(id)) result.set(id, FORMER_MEMBER);
      return result;
    },

    status(guildId) {
      const cache = caches.get(guildId);
      const building = builds.has(guildId);
      if (cache) return { events: cache.events.length, oldestEventAt: cache.events[0]?.at ?? null, building };
      if (building) return { events: 0, oldestEventAt: null, building };
      return null;
    },
  };
}
