import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  InteractionContextType,
  type APIApplicationCommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  OPTIONS,
  PLAY_CONTEXT_MENU_NAME,
  SOUND_SUBCOMMANDS,
  STATS_SUBCOMMANDS,
  buildCommandDefinitions,
  registerCommands,
} from './commands.js';

const defs = buildCommandDefinitions();
const byName = (name: string) => defs.find((d) => d.name === name)!;
const optionsOf = (name: string) => ((byName(name) as RESTPostAPIChatInputApplicationCommandsJSONBody).options ?? []) as APIApplicationCommandOption[];

describe('buildCommandDefinitions', () => {
  it('defines every command plus the context menu', () => {
    expect(defs.map((d) => d.name).sort()).toEqual(
      [...Object.values(COMMANDS), PLAY_CONTEXT_MENU_NAME].sort(),
    );
  });

  it('makes every command guild-only', () => {
    for (const d of defs) expect(d.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('does not use default_member_permissions (runtime checks only)', () => {
    for (const d of defs) expect(d.default_member_permissions ?? null).toBeNull();
  });

  it('/play has all optional source options, mode choices and a bounded volume', () => {
    const opts = optionsOf(COMMANDS.play);
    expect(opts.map((o) => o.name)).toEqual([OPTIONS.attachment, OPTIONS.url, OPTIONS.sound, OPTIONS.mode, OPTIONS.volume]);
    expect(opts.every((o) => !o.required)).toBe(true);
    const sound = opts.find((o) => o.name === OPTIONS.sound) as { autocomplete?: boolean };
    expect(sound.autocomplete).toBe(true);
    const mode = opts.find((o) => o.name === OPTIONS.mode) as { choices?: { value: string }[] };
    expect(mode.choices?.map((c) => c.value)).toEqual(['interrupt', 'queue']);
    const volume = opts.find((o) => o.name === OPTIONS.volume) as { type: number; min_value?: number; max_value?: number };
    expect(volume.type).toBe(ApplicationCommandOptionType.Integer);
    expect([volume.min_value, volume.max_value]).toEqual([0, 200]);
  });

  it('/volume takes a required integer level 0-200', () => {
    const [level] = optionsOf(COMMANDS.volume) as { name: string; required?: boolean; min_value?: number; max_value?: number }[];
    expect(level).toMatchObject({ name: OPTIONS.level, required: true, min_value: 0, max_value: 200 });
  });

  it('/sound has add, rename, delete subcommands', () => {
    const subs = optionsOf(COMMANDS.sound) as { name: string; type: number; options?: { name: string; required?: boolean; autocomplete?: boolean; max_length?: number }[] }[];
    expect(subs.map((s) => s.name)).toEqual(Object.values(SOUND_SUBCOMMANDS));
    expect(subs.every((s) => s.type === ApplicationCommandOptionType.Subcommand)).toBe(true);
    const add = subs.find((s) => s.name === 'add')!;
    expect(add.options?.map((o) => o.name)).toEqual([OPTIONS.name, OPTIONS.attachment, OPTIONS.url]);
    expect(add.options?.[0]).toMatchObject({ required: true, max_length: 32 });
    const rename = subs.find((s) => s.name === 'rename')!;
    expect(rename.options?.[0]).toMatchObject({ name: OPTIONS.sound, required: true, autocomplete: true });
    const del = subs.find((s) => s.name === 'delete')!;
    expect(del.options?.[0]).toMatchObject({ name: OPTIONS.sound, required: true, autocomplete: true });
  });

  it('/stats has server, user, channel subcommands, each with an optional days 1-365', () => {
    type Opt = { name: string; type: number; required?: boolean; min_value?: number; max_value?: number; channel_types?: number[]; description: string };
    const subs = optionsOf(COMMANDS.stats) as { name: string; type: number; options?: Opt[] }[];
    expect(subs.map((s) => s.name)).toEqual(Object.values(STATS_SUBCOMMANDS));
    expect(subs.every((s) => s.type === ApplicationCommandOptionType.Subcommand)).toBe(true);
    for (const sub of subs) {
      const days = sub.options?.find((o) => o.name === OPTIONS.days);
      expect(days, sub.name).toMatchObject({ type: ApplicationCommandOptionType.Integer, min_value: 1, max_value: 365 });
      expect(days?.required ?? false).toBe(false);
      expect(days?.description).toContain('default 30');
    }
    const server = subs.find((s) => s.name === 'server')!;
    expect(server.options?.map((o) => o.name)).toEqual([OPTIONS.days]);
    const user = subs.find((s) => s.name === 'user')!;
    expect(user.options?.map((o) => o.name)).toEqual([OPTIONS.user, OPTIONS.days]);
    expect(user.options?.[0]).toMatchObject({ type: ApplicationCommandOptionType.User });
    expect(user.options?.[0]?.required ?? false).toBe(false);
    const channel = subs.find((s) => s.name === 'channel')!;
    expect(channel.options?.map((o) => o.name)).toEqual([OPTIONS.channel, OPTIONS.days]);
    expect(channel.options?.[0]).toMatchObject({
      type: ApplicationCommandOptionType.Channel,
      required: true,
      channel_types: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
    });
  });

  it('/info takes no options', () => {
    expect(optionsOf(COMMANDS.info)).toEqual([]);
  });

  it('keeps descriptions within Discord limits', () => {
    const walk = (opts: { description: string; options?: unknown[] }[]): void => {
      for (const o of opts) {
        expect(o.description.length).toBeGreaterThan(0);
        expect(o.description.length).toBeLessThanOrEqual(100);
        walk((o.options ?? []) as { description: string; options?: unknown[] }[]);
      }
    };
    walk(defs.filter((d) => d.type !== ApplicationCommandType.Message) as { description: string; options?: unknown[] }[]);
  });

  it('defines the message context menu', () => {
    expect(byName(PLAY_CONTEXT_MENU_NAME).type).toBe(ApplicationCommandType.Message);
  });
});

describe('registerCommands', () => {
  it('sets global commands', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await registerCommands({ application: { commands: { set } } } as never);
    expect(set).toHaveBeenCalledWith(buildCommandDefinitions());
  });
});
