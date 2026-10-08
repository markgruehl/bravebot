/**
 * Channel discovery / creation (LIBRARY implementer).
 * - Discover by topic marker (LIBRARY_TOPIC_MARKER / LOG_TOPIC_MARKER) among guild text
 *   channels; fall back to creating "#soundboard-library" / "#soundboard-log" ONLY when no
 *   marked channel exists at all. A marked channel that @everyone can view is never used
 *   (one-time, read-only check at setup), so the private library/log can never be redirected
 *   into a public channel. If every marked channel is public (e.g. an admin opened it up),
 *   setup fails closed with an actionable LibraryError instead of silently creating a new,
 *   empty channel; the guild stays "not ready" until an admin makes it private again.
 * - Only create channels after an authoritative channel fetch (guild available + fetch
 *   succeeded); otherwise throw so we never create duplicates of channels we could not see.
 * - Overwrites on create: deny ViewChannel for @everyone (role id === guild id); explicit
 *   allow for the bot user (ViewChannel, SendMessages, AttachFiles, EmbedLinks,
 *   ReadMessageHistory). Admins see it implicitly. NO role sync; never rewrite overwrites
 *   of an existing discovered channel (admins may add their own).
 * - Without Manage Channels the bot cannot create missing channels: ensureChannels throws
 *   LibraryError('channel-unavailable') with an actionable message; index.ts logs it and
 *   the guild stays "not ready" (interactions answer with a clear not-ready reply and
 *   trigger a rate-limited setup retry).
 */
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildBasedChannel, OverwriteResolvable, TextChannel } from 'discord.js';
import {
  LIBRARY_CHANNEL_NAME,
  LIBRARY_TOPIC_MARKER,
  LOG_CHANNEL_NAME,
  LOG_TOPIC_MARKER,
} from '../constants.js';
import { LibraryError, errorMessage } from '../errors.js';
import type { GuildChannels } from '../types.js';

/** Permissions the bot needs in its own private channels. */
export const BOT_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

const PERMISSION_LABELS = new Map<bigint, string>([
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
]);

interface ChannelSpec {
  readonly name: string;
  readonly marker: string;
  readonly topic: string;
  readonly reason: string;
}

const LIBRARY_SPEC: ChannelSpec = {
  name: LIBRARY_CHANNEL_NAME,
  marker: LIBRARY_TOPIC_MARKER,
  topic: `Saved soundboard sounds, managed by the bot. Do not post here or edit this marker: ${LIBRARY_TOPIC_MARKER}`,
  reason: 'bravebot: private storage for saved soundboard sounds',
};

const LOG_SPEC: ChannelSpec = {
  name: LOG_CHANNEL_NAME,
  marker: LOG_TOPIC_MARKER,
  topic: `Soundboard activity log for admins, written by the bot. Do not edit this marker: ${LOG_TOPIC_MARKER}`,
  reason: 'bravebot: private soundboard activity log for admins',
};

function snowflakeLess(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b;
}

/** True when @everyone can view the channel (i.e. it is not private). */
export function isVisibleToEveryone(channel: TextChannel): boolean {
  return channel.permissionsFor(channel.guild.roles.everyone).has(PermissionFlagsBits.ViewChannel);
}

/** Text channels whose topic contains `marker` (any visibility). */
function markedTextChannels(channels: Iterable<GuildBasedChannel>, marker: string): TextChannel[] {
  const found: TextChannel[] = [];
  for (const channel of channels) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (!channel.topic?.includes(marker)) continue;
    found.push(channel);
  }
  return found;
}

/**
 * Pure-ish: first PRIVATE text channel (hidden from @everyone) whose topic contains
 * `marker`. When several match, the oldest channel (smallest snowflake) wins so the
 * choice is stable across restarts.
 */
export function findMarkedChannel(channels: Iterable<GuildBasedChannel>, marker: string): TextChannel | undefined {
  let best: TextChannel | undefined;
  for (const channel of markedTextChannels(channels, marker)) {
    if (isVisibleToEveryone(channel)) continue;
    if (!best || snowflakeLess(channel.id, best.id)) best = channel;
  }
  return best;
}

/** Pure: permission overwrites for a new private bot channel. */
export function privateChannelOverwrites(guildId: string, botUserId: string): OverwriteResolvable[] {
  return [
    { id: guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botUserId, type: OverwriteType.Member, allow: [...BOT_CHANNEL_PERMISSIONS] },
  ];
}

/** Names of BOT_CHANNEL_PERMISSIONS the bot is missing in `channel` (empty when fine or unknown). */
function missingBotPermissions(channel: TextChannel): string[] {
  const me = channel.guild.members.me;
  if (!me) return [];
  const perms = channel.permissionsFor(me);
  return BOT_CHANNEL_PERMISSIONS.filter((flag) => !perms.has(flag)).map(
    (flag) => PERMISSION_LABELS.get(flag) ?? String(flag),
  );
}

async function createPrivateChannel(guild: Guild, spec: ChannelSpec): Promise<TextChannel> {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    throw new LibraryError(
      'channel-unavailable',
      `Cannot create #${spec.name} in "${guild.name}": could not resolve the bot's own member; not creating channels.`,
    );
  }
  const botUserId = me.id;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new LibraryError(
      'channel-unavailable',
      `Cannot create #${spec.name} in "${guild.name}": the bot is missing the Manage Channels permission. ` +
        `Grant it (or create a private text channel whose topic contains "${spec.marker}"); ` +
        'the bot retries setup automatically the next time the soundboard is used (or restart the bot).',
    );
  }
  try {
    const channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      topic: spec.topic,
      permissionOverwrites: privateChannelOverwrites(guild.id, botUserId),
      reason: spec.reason,
    });
    console.log(`[setup] ${guild.name} (${guild.id}): created #${channel.name} (${channel.id})`);
    return channel;
  } catch (err) {
    throw new LibraryError(
      'channel-unavailable',
      `Cannot create #${spec.name} in "${guild.name}": ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

async function ensureChannel(guild: Guild, spec: ChannelSpec): Promise<TextChannel> {
  const marked = markedTextChannels(guild.channels.cache.values(), spec.marker);
  const existing = findMarkedChannel(marked, spec.marker);
  if (existing) {
    // Never touch overwrites of a discovered channel; just warn if the bot cannot use it.
    const missing = missingBotPermissions(existing);
    if (missing.length > 0) {
      console.warn(
        `[setup] ${guild.name} (${guild.id}): bot is missing ${missing.join(', ')} in #${existing.name}; ` +
          'soundboard features using it will fail until an admin fixes the channel permissions',
      );
    }
    return existing;
  }
  // Marked channels exist but @everyone can view all of them: fail closed. Creating a
  // replacement would silently start an empty library (and a second log) next to the old one.
  const exposed = marked.reduce<TextChannel | undefined>(
    (oldest, channel) => (!oldest || snowflakeLess(channel.id, oldest.id) ? channel : oldest),
    undefined,
  );
  if (exposed) {
    throw new LibraryError(
      'channel-unavailable',
      `#${exposed.name} in "${guild.name}" has the "${spec.marker}" marker but @everyone can view it. ` +
        'Deny View Channel for @everyone on that channel (or remove the marker from its topic) to re-enable ' +
        'the soundboard; the bot retries setup automatically the next time the soundboard is used (or restart the bot).',
    );
  }
  return createPrivateChannel(guild, spec);
}

/** Only create channels after an authoritative channel listing (never from a partial cache). */
async function fetchChannelsAuthoritatively(guild: Guild): Promise<void> {
  if (!guild.available) {
    throw new LibraryError(
      'channel-unavailable',
      `Guild ${guild.id} is unavailable (Discord outage); not setting up channels until it becomes available`,
    );
  }
  try {
    await guild.channels.fetch();
  } catch (err) {
    // Never fall back to a possibly incomplete cache: that could create duplicate channels.
    throw new LibraryError(
      'channel-unavailable',
      `Could not list channels in "${guild.name}": ${errorMessage(err)}; not creating channels to avoid duplicates`,
      { cause: err },
    );
  }
}

/** Re-discover (or create) only the admin log channel, e.g. after it was deleted at runtime. */
export async function ensureLogChannel(guild: Guild): Promise<TextChannel> {
  await fetchChannelsAuthoritatively(guild);
  return ensureChannel(guild, LOG_SPEC);
}

export async function ensureChannels(guild: Guild): Promise<GuildChannels> {
  await fetchChannelsAuthoritatively(guild);
  // Sequential: creating both at once would reorder unpredictably and doubles rate-limit pressure.
  const library = await ensureChannel(guild, LIBRARY_SPEC);
  const log = await ensureChannel(guild, LOG_SPEC);
  return { library, log };
}
