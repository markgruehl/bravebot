import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { LibrarySound } from '../types.js';
import { canAddSounds, canControlPlayback, canModifySound, canPlay } from './permissions.js';

const perms = (...flags: bigint[]) => new PermissionsBitField(flags);

const sound = (addedBy: string): LibrarySound => ({
  kind: 'file',
  id: '111',
  guildId: 'g',
  name: 'Airhorn',
  addedBy,
  addedAt: new Date(0),
  filename: 'airhorn.mp3',
});

describe('canPlay', () => {
  it('requires Use Soundboard', () => {
    expect(canPlay(perms(PermissionFlagsBits.UseSoundboard))).toBe(true);
    expect(canPlay(perms(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak))).toBe(false);
    expect(canPlay(perms())).toBe(false);
  });
  it('treats null permissions as denied', () => {
    expect(canPlay(null)).toBe(false);
  });
  it('lets Administrators play', () => {
    expect(canPlay(perms(PermissionFlagsBits.Administrator))).toBe(true);
  });
  it('is not satisfied by expression permissions alone', () => {
    expect(canPlay(perms(PermissionFlagsBits.ManageGuildExpressions))).toBe(false);
  });
});

describe('canAddSounds', () => {
  it('accepts Create Expressions', () => {
    expect(canAddSounds(perms(PermissionFlagsBits.CreateGuildExpressions))).toBe(true);
  });
  it('rejects Manage Expressions without Create Expressions', () => {
    expect(canAddSounds(perms(PermissionFlagsBits.ManageGuildExpressions))).toBe(false);
  });
  it('accepts Manage plus Create Expressions', () => {
    expect(
      canAddSounds(perms(PermissionFlagsBits.ManageGuildExpressions, PermissionFlagsBits.CreateGuildExpressions)),
    ).toBe(true);
  });
  it('accepts Administrator', () => {
    expect(canAddSounds(perms(PermissionFlagsBits.Administrator))).toBe(true);
  });
  it('rejects Use Soundboard only, empty and null', () => {
    expect(canAddSounds(perms(PermissionFlagsBits.UseSoundboard))).toBe(false);
    expect(canAddSounds(perms())).toBe(false);
    expect(canAddSounds(null)).toBe(false);
  });
});

describe('canModifySound', () => {
  it('Manage Expressions can modify any sound', () => {
    const p = perms(PermissionFlagsBits.ManageGuildExpressions);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('someone-else'))).toBe(true);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('u1'))).toBe(true);
  });
  it('Create Expressions can modify only own sounds', () => {
    const p = perms(PermissionFlagsBits.CreateGuildExpressions);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('u1'))).toBe(true);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('u2'))).toBe(false);
  });
  it('without expression permissions even own sounds are denied', () => {
    const p = perms(PermissionFlagsBits.UseSoundboard);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('u1'))).toBe(false);
    expect(canModifySound({ id: 'u1', permissions: null }, sound('u1'))).toBe(false);
  });
  it('Administrator can modify any sound', () => {
    const p = perms(PermissionFlagsBits.Administrator);
    expect(canModifySound({ id: 'u1', permissions: p }, sound('u2'))).toBe(true);
  });
  it('works for link sounds too', () => {
    const link: LibrarySound = { ...sound('u1'), kind: 'link', url: 'https://example.com/a.mp3' } as LibrarySound;
    expect(canModifySound({ id: 'u1', permissions: perms(PermissionFlagsBits.CreateGuildExpressions) }, link)).toBe(
      true,
    );
  });
});

describe('canControlPlayback', () => {
  it('requires being in the same channel as the bot', () => {
    expect(canControlPlayback('vc1', 'vc1')).toBe(true);
    expect(canControlPlayback('vc1', 'vc2')).toBe(false);
  });
  it('denies when either side is not in voice', () => {
    expect(canControlPlayback(null, 'vc1')).toBe(false);
    expect(canControlPlayback('vc1', null)).toBe(false);
    expect(canControlPlayback(null, null)).toBe(false);
  });
});
