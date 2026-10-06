import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { Guild, GuildBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { LIBRARY_TOPIC_MARKER, LOG_TOPIC_MARKER } from '../constants.js';
import { ensureChannels, ensureLogChannel, findMarkedChannel, privateChannelOverwrites } from './setup.js';

const GUILD = '400000000000000004';
const BOT = '100000000000000001';

const EVERYONE = { id: GUILD, everyone: true };

/** Fake channel. Private by default (@everyone cannot view); the bot has every permission. */
function chan(id: string, topic: string | null, type = ChannelType.GuildText, isPublic = false) {
  return {
    id,
    name: `c${id}`,
    type,
    topic,
    guild: { roles: { everyone: EVERYONE } },
    permissionsFor: (target: unknown) =>
      target === EVERYONE
        ? new PermissionsBitField(isPublic ? [PermissionFlagsBits.ViewChannel] : [])
        : new PermissionsBitField(PermissionsBitField.All),
  } as unknown as GuildBasedChannel;
}

describe('findMarkedChannel', () => {
  it('matches text channels whose topic contains the marker', () => {
    const channels = [
      chan('5', null),
      chan('6', 'general chat'),
      chan('7', `renamed by admin | ${LIBRARY_TOPIC_MARKER} | extra`),
      chan('8', LOG_TOPIC_MARKER),
    ];
    expect(findMarkedChannel(channels, LIBRARY_TOPIC_MARKER)?.id).toBe('7');
    expect(findMarkedChannel(channels, LOG_TOPIC_MARKER)?.id).toBe('8');
    expect(findMarkedChannel([chan('9', 'nothing')], LOG_TOPIC_MARKER)).toBeUndefined();
  });

  it('ignores non-text channels and prefers the oldest match', () => {
    const channels = [
      chan('300', LIBRARY_TOPIC_MARKER, ChannelType.GuildAnnouncement),
      chan('1000', LIBRARY_TOPIC_MARKER),
      chan('999', LIBRARY_TOPIC_MARKER),
    ];
    expect(findMarkedChannel(channels, LIBRARY_TOPIC_MARKER)?.id).toBe('999');
  });

  it('ignores marked channels that @everyone can view', () => {
    const channels = [chan('100', LIBRARY_TOPIC_MARKER, ChannelType.GuildText, true), chan('500', LIBRARY_TOPIC_MARKER)];
    expect(findMarkedChannel(channels, LIBRARY_TOPIC_MARKER)?.id).toBe('500');
    expect(findMarkedChannel([channels[0]!], LIBRARY_TOPIC_MARKER)).toBeUndefined();
  });
});

describe('privateChannelOverwrites', () => {
  it('hides the channel from @everyone and allows the bot', () => {
    const [everyone, bot] = privateChannelOverwrites(GUILD, BOT) as {
      id: string;
      type: OverwriteType;
      allow?: bigint[];
      deny?: bigint[];
    }[];
    expect(everyone).toEqual({ id: GUILD, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
    expect(bot!.id).toBe(BOT);
    expect(bot!.type).toBe(OverwriteType.Member);
    const allowed = new PermissionsBitField(bot!.allow);
    for (const flag of [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ]) {
      expect(allowed.has(flag)).toBe(true);
    }
    expect(bot!.deny).toBeUndefined();
  });
});

function fakeGuild(existing: GuildBasedChannel[], perms: bigint[], opts: { available?: boolean } = {}) {
  const cache = new Map(existing.map((c) => [c.id, c]));
  let nextId = 2000;
  const create = vi.fn(async (opts: { name: string; topic: string }) => {
    const c = chan(String(nextId++), opts.topic);
    (c as { name: string }).name = opts.name;
    (c as unknown as { guild: unknown }).guild = guild;
    cache.set(c.id, c);
    return c;
  });
  const me = { id: BOT, permissions: new PermissionsBitField(perms) };
  const guild = {
    id: GUILD,
    name: 'Test',
    available: opts.available ?? true,
    roles: { everyone: EVERYONE },
    client: { user: { id: BOT } },
    members: { me, fetchMe: vi.fn(async () => me) },
    channels: { cache, fetch: vi.fn(async () => cache), create },
  };
  for (const c of existing) (c as unknown as { guild: unknown }).guild = guild;
  return { guild: guild as unknown as Guild, create, fetch: guild.channels.fetch };
}

describe('ensureChannels', () => {
  it('reuses discovered channels without touching them', async () => {
    const lib = chan('10', `x ${LIBRARY_TOPIC_MARKER}`);
    const log = chan('11', LOG_TOPIC_MARKER);
    const { guild, create } = fakeGuild([lib, log], [PermissionFlagsBits.ManageChannels]);
    const result = await ensureChannels(guild);
    expect(result.library).toBe(lib);
    expect(result.log).toBe(log);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates missing channels with marker topics and private overwrites', async () => {
    const lib = chan('10', LIBRARY_TOPIC_MARKER);
    const { guild, create } = fakeGuild([lib], [PermissionFlagsBits.ManageChannels]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await ensureChannels(guild);
    expect(result.library).toBe(lib);
    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0]![0] as unknown as {
      name: string;
      type: ChannelType;
      topic: string;
      permissionOverwrites: unknown;
    };
    expect(opts.name).toBe('soundboard-log');
    expect(opts.type).toBe(ChannelType.GuildText);
    expect(opts.topic).toContain(LOG_TOPIC_MARKER);
    expect(opts.permissionOverwrites).toEqual(privateChannelOverwrites(GUILD, BOT));
    expect(result.log.id).toBe('2000');
  });

  it('fails with channel-unavailable when Manage Channels is missing', async () => {
    const { guild, create } = fakeGuild([], []);
    await expect(ensureChannels(guild)).rejects.toMatchObject({
      code: 'channel-unavailable',
      message: expect.stringContaining('Manage Channels'),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed (no replacement channel) when the only marked channel is public', async () => {
    const publicLib = chan('10', LIBRARY_TOPIC_MARKER, ChannelType.GuildText, true);
    const log = chan('11', LOG_TOPIC_MARKER);
    const { guild, create } = fakeGuild([publicLib, log], [PermissionFlagsBits.ManageChannels]);
    await expect(ensureChannels(guild)).rejects.toMatchObject({
      code: 'channel-unavailable',
      message: expect.stringContaining('@everyone can view it'),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('prefers a private marked channel when a public marked one also exists', async () => {
    const publicLib = chan('5', LIBRARY_TOPIC_MARKER, ChannelType.GuildText, true);
    const privateLib = chan('10', LIBRARY_TOPIC_MARKER);
    const log = chan('11', LOG_TOPIC_MARKER);
    const { guild, create } = fakeGuild([publicLib, privateLib, log], [PermissionFlagsBits.ManageChannels]);
    const result = await ensureChannels(guild);
    expect(result.library).toBe(privateLib);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not create channels when the channel fetch fails', async () => {
    const { guild, create, fetch } = fakeGuild([], [PermissionFlagsBits.ManageChannels]);
    fetch.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    await expect(ensureChannels(guild)).rejects.toMatchObject({ code: 'channel-unavailable' });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not create channels while the guild is unavailable', async () => {
    const { guild, create, fetch } = fakeGuild([], [PermissionFlagsBits.ManageChannels], { available: false });
    await expect(ensureChannels(guild)).rejects.toMatchObject({ code: 'channel-unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('wraps creation API errors', async () => {
    const { guild, create } = fakeGuild([], [PermissionFlagsBits.ManageChannels]);
    create.mockRejectedValueOnce(new Error('Missing Permissions'));
    await expect(ensureChannels(guild)).rejects.toMatchObject({ code: 'channel-unavailable' });
  });
});

describe('ensureLogChannel', () => {
  it('re-discovers only the log channel after a fresh channel fetch', async () => {
    const lib = chan('10', LIBRARY_TOPIC_MARKER);
    const log = chan('11', LOG_TOPIC_MARKER);
    const { guild, create, fetch } = fakeGuild([lib, log], [PermissionFlagsBits.ManageChannels]);
    await expect(ensureLogChannel(guild)).resolves.toBe(log);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a new private log channel when none exists', async () => {
    const lib = chan('10', LIBRARY_TOPIC_MARKER);
    const { guild, create } = fakeGuild([lib], [PermissionFlagsBits.ManageChannels]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = await ensureLogChannel(guild);
    expect(create).toHaveBeenCalledTimes(1);
    expect(log.topic).toContain(LOG_TOPIC_MARKER);
  });
});
