import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  type APIApplicationCommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, OPTIONS, PLAY_CONTEXT_MENU_NAME, SOUND_SUBCOMMANDS, buildCommandDefinitions, registerCommands } from './commands.js';

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
