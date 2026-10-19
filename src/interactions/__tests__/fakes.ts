/**
 * Minimal fakes of discord.js interactions / BotContext for handler tests.
 * Only the members our handlers touch are implemented.
 */
import { MessageFlags, MessageFlagsBitField, PermissionsBitField } from 'discord.js';
import { vi, type Mock } from 'vitest';
import type { GuildVoiceHistory, PersonInfo, StatsService } from '../../stats/types.js';
import type { AdminLogEvent, BotContext, GuildState, LibrarySound, LibraryStore, PlayerManager } from '../../types.js';

export const GUILD_ID = 'guild-1';

export function makeSound(id: string, name: string, addedBy = 'u1'): LibrarySound {
  return { kind: 'file', id, guildId: GUILD_ID, name, addedBy, addedAt: new Date(0), filename: `${name}.mp3` };
}

export function makeLibrary(sounds: LibrarySound[] = []): LibraryStore & {
  add: Mock<LibraryStore['add']>;
  rename: Mock<LibraryStore['rename']>;
  delete: Mock<LibraryStore['delete']>;
} {
  const byId = (id: string) => sounds.find((s) => s.id === id);
  const byName = (name: string) => sounds.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  return {
    guildId: GUILD_ID,
    loaded: true,
    load: vi.fn(async () => undefined),
    list: () => [...sounds],
    search: (q: string, limit = 25) => sounds.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())).slice(0, limit),
    getById: byId,
    getByName: byName,
    add: vi.fn<LibraryStore['add']>(),
    rename: vi.fn<LibraryStore['rename']>(),
    delete: vi.fn<LibraryStore['delete']>(),
    freshAttachmentUrl: vi.fn<LibraryStore['freshAttachmentUrl']>(),
    forget: vi.fn<LibraryStore['forget']>(),
  };
}

export type StatsMock = { [K in keyof StatsService]: Mock<StatsService[K]> };

export const EMPTY_HISTORY: GuildVoiceHistory = { channelId: 'sys-1', events: [], checkpoints: [], oldestEventAt: null };

/**
 * StatsService fake: an empty history, every id resolves to a human named "Name <id>",
 * nothing cached. Override per test with statsMock.<method>.mockResolvedValue(...).
 */
export function makeStatsMock(): StatsMock {
  return {
    load: vi.fn<StatsService['load']>(async () => EMPTY_HISTORY),
    record: vi.fn<StatsService['record']>(),
    forget: vi.fn<StatsService['forget']>(),
    noteStartup: vi.fn<StatsService['noteStartup']>(),
    dropGuild: vi.fn<StatsService['dropGuild']>(),
    people: vi.fn<StatsService['people']>(
      async (_guild, ids) => new Map<string, PersonInfo>([...ids].map((id) => [id, { name: `Name ${id}`, bot: false }])),
    ),
    status: vi.fn<StatsService['status']>(() => null),
  };
}

export interface FakeCtx extends BotContext {
  readonly logged: AdminLogEvent[];
  readonly playersMock: { [K in keyof PlayerManager]: ReturnType<typeof vi.fn> };
  readonly statsMock: StatsMock;
}

export function makeCtx(opts: { ready?: boolean; library?: LibraryStore; botChannelId?: string | null } = {}): FakeCtx {
  const logged: AdminLogEvent[] = [];
  const guilds = new Map<string, GuildState>();
  if (opts.ready ?? true) {
    guilds.set(GUILD_ID, { channels: {} as GuildState['channels'], library: opts.library ?? makeLibrary() });
  }
  const botChannelId = opts.botChannelId ?? null;
  const playersMock = {
    play: vi.fn(),
    stop: vi.fn(),
    skip: vi.fn(),
    setVolume: vi.fn(),
    getStatus: vi.fn(),
    currentChannelId: vi.fn(() => botChannelId),
    isBusyElsewhere: vi.fn((_g: string, ch: string) => botChannelId !== null && botChannelId !== ch),
    hasPendingPlay: vi.fn(() => false),
    handleVoiceStateUpdate: vi.fn(),
    destroyGuild: vi.fn(),
    destroyAll: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  const statsMock = makeStatsMock();
  return {
    client: {} as BotContext['client'],
    config: { discordToken: 't', slackWebhook: null },
    players: playersMock as unknown as PlayerManager,
    playersMock,
    guilds,
    adminLog: {
      log: vi.fn(async (_guildId: string, event: AdminLogEvent) => {
        logged.push(event);
      }),
    },
    logged,
    stats: statsMock,
    statsMock,
  };
}

export interface FakeInteractionOptions {
  readonly userId?: string;
  readonly voiceChannelId?: string | null;
  /** ChannelType of the user's voice channel (default: plain object without a type). */
  readonly voiceChannelType?: number;
  /** Permissions in the user's voice channel. */
  readonly channelPerms?: bigint[];
  /** Guild-level permissions (member.permissions). */
  readonly guildPerms?: bigint[];
  readonly options?: Record<string, unknown>;
  readonly subcommand?: string;
  readonly commandName?: string;
  /** Guild voice states (guild.voiceStates.cache). */
  readonly voiceStates?: readonly FakeVoiceState[];
  /** Guild channels by id -> name (guild.channels.cache). */
  readonly channels?: Readonly<Record<string, string>>;
}

export interface FakeVoiceState {
  readonly id: string;
  readonly channelId: string | null;
  readonly member: { readonly user: { readonly bot: boolean } } | null;
}

export interface FakeReply {
  kind: 'reply' | 'editReply' | 'followUp';
  content?: string;
  flags?: unknown;
  embeds?: unknown[];
  components?: unknown[];
}

interface FakePayload {
  content?: string;
  flags?: unknown;
  embeds?: unknown[];
  components?: unknown[];
  allowedMentions?: unknown;
}

/** Record a reply, keeping only the keys the payload actually set (so toEqual stays exact). */
function record(kind: FakeReply['kind'], p: FakePayload, keys: readonly (keyof FakePayload)[]): FakeReply {
  const entry: FakeReply = { kind, content: p.content as string };
  for (const key of keys) if (p[key] !== undefined) (entry as unknown as Record<string, unknown>)[key] = p[key];
  return entry;
}

export function makeInteraction(o: FakeInteractionOptions = {}) {
  const voiceChannelId = o.voiceChannelId === undefined ? 'vc-1' : o.voiceChannelId;
  const opts = o.options ?? {};
  const replies: FakeReply[] = [];
  const get = (name: string) => (name in opts ? opts[name] : null);
  const required = (name: string, req?: boolean) => {
    const v = get(name);
    if (req && v === null) throw new Error(`missing required option ${name}`);
    return v;
  };
  const interaction = {
    guildId: GUILD_ID,
    commandName: o.commandName ?? 'test',
    user: { id: o.userId ?? 'u1', username: 'user1', bot: false },
    member: {
      displayName: 'User One',
      permissions: new PermissionsBitField(o.guildPerms ?? []),
      voice: {
        channelId: voiceChannelId,
        channel: voiceChannelId ? { id: voiceChannelId, type: o.voiceChannelType } : null,
      },
      permissionsIn: vi.fn(() => new PermissionsBitField(o.channelPerms ?? [])),
    },
    guild: {
      id: GUILD_ID,
      voiceStates: { cache: new Map((o.voiceStates ?? []).map((v) => [v.id, v])) },
      channels: { cache: new Map(Object.entries(o.channels ?? {}).map(([id, name]) => [id, { id, name }])) },
      members: { me: { id: 'bot-self' } },
    },
    deferred: false,
    replied: false,
    ephemeral: null as boolean | null,
    options: {
      getString: (n: string, req?: boolean) => required(n, req) as string | null,
      getInteger: (n: string, req?: boolean) => required(n, req) as number | null,
      getAttachment: (n: string, req?: boolean) => required(n, req),
      getUser: (n: string, req?: boolean) => required(n, req) as { id: string; bot: boolean } | null,
      getChannel: (n: string, req?: boolean) => required(n, req) as { id: string } | null,
      getSubcommand: () => o.subcommand ?? null,
    },
    replies,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isRepliable: () => true,
    inGuild: () => true,
    inCachedGuild: () => true,
    deferReply: vi.fn(async (p?: { flags?: unknown }) => {
      interaction.deferred = true;
      interaction.ephemeral = p?.flags === MessageFlags.Ephemeral;
    }),
    reply: vi.fn(async (p: FakePayload) => {
      interaction.replied = true;
      replies.push(record('reply', p, ['flags', 'embeds', 'components']));
    }),
    editReply: vi.fn(async (p: FakePayload) => {
      interaction.replied = true;
      replies.push(record('editReply', p, ['embeds', 'components']));
    }),
    followUp: vi.fn(async (p: FakePayload) => {
      replies.push(record('followUp', p, ['flags', 'embeds', 'components']));
    }),
  };
  return interaction;
}

/** A button click on a message (ephemeral or public) carrying `customId`. */
export function makeButtonInteraction(o: FakeInteractionOptions & { customId: string; ephemeralMessage?: boolean }) {
  const base = makeInteraction(o);
  const interaction = Object.assign(base, {
    customId: o.customId,
    message: { flags: new MessageFlagsBitField(o.ephemeralMessage ? MessageFlags.Ephemeral : 0) },
    isChatInputCommand: () => false,
    isButton: () => true,
    deferUpdate: vi.fn(async () => {
      base.deferred = true;
    }),
  });
  return interaction;
}

/** Let fire-and-forget admin-log promises settle. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
