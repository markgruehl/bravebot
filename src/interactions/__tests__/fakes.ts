/**
 * Minimal fakes of discord.js interactions / BotContext for handler tests.
 * Only the members our handlers touch are implemented.
 */
import { PermissionsBitField } from 'discord.js';
import { vi, type Mock } from 'vitest';
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

export interface FakeCtx extends BotContext {
  readonly logged: AdminLogEvent[];
  readonly playersMock: { [K in keyof PlayerManager]: ReturnType<typeof vi.fn> };
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
}

export function makeInteraction(o: FakeInteractionOptions = {}) {
  const voiceChannelId = o.voiceChannelId === undefined ? 'vc-1' : o.voiceChannelId;
  const opts = o.options ?? {};
  const replies: { kind: 'reply' | 'editReply' | 'followUp'; content: string; flags?: unknown }[] = [];
  const get = (name: string) => (name in opts ? opts[name] : null);
  const required = (name: string, req?: boolean) => {
    const v = get(name);
    if (req && v === null) throw new Error(`missing required option ${name}`);
    return v;
  };
  const interaction = {
    guildId: GUILD_ID,
    user: { id: o.userId ?? 'u1', username: 'user1' },
    member: {
      displayName: 'User One',
      permissions: new PermissionsBitField(o.guildPerms ?? []),
      voice: {
        channelId: voiceChannelId,
        channel: voiceChannelId ? { id: voiceChannelId, type: o.voiceChannelType } : null,
      },
      permissionsIn: vi.fn(() => new PermissionsBitField(o.channelPerms ?? [])),
    },
    deferred: false,
    replied: false,
    options: {
      getString: (n: string, req?: boolean) => required(n, req) as string | null,
      getInteger: (n: string, req?: boolean) => required(n, req) as number | null,
      getAttachment: (n: string, req?: boolean) => required(n, req),
      getSubcommand: () => o.subcommand ?? null,
    },
    replies,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(async (p: { content: string; flags?: unknown }) => {
      interaction.replied = true;
      replies.push({ kind: 'reply', content: p.content, flags: p.flags });
    }),
    editReply: vi.fn(async (p: { content: string }) => {
      interaction.replied = true;
      replies.push({ kind: 'editReply', content: p.content });
    }),
    followUp: vi.fn(async (p: { content: string; flags?: unknown }) => {
      replies.push({ kind: 'followUp', content: p.content, flags: p.flags });
    }),
  };
  return interaction;
}

/** Let fire-and-forget admin-log promises settle. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
