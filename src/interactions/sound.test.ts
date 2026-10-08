import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { LibraryError } from '../errors.js';
import { flush, makeCtx, makeInteraction, makeLibrary, makeSound } from './__tests__/fakes.js';

vi.mock('../library/names.js', () => ({
  validateSoundName: (raw: string) => {
    const name = raw.trim();
    return name.length >= 1 && name.length <= 32 ? { ok: true, name } : { ok: false, error: 'Bad name.' };
  },
  nameKey: (n: string) => n.toLowerCase(),
}));
vi.mock('../playback/sources.js', () => ({
  isHttpUrl: (v: string) => /^https?:\/\//.test(v),
  isAudioAttachment: (a: { contentType: string | null }) => a.contentType?.startsWith('audio/') ?? false,
  summarizeSource: () => ({ type: 'url', label: 'x', url: null, libraryName: null }),
}));

const { handleSoundCommand } = await import('./sound.js');

const CREATE = [PermissionFlagsBits.CreateGuildExpressions];
const MANAGE = [PermissionFlagsBits.ManageGuildExpressions];
const audio = { url: 'https://cdn/a.mp3', name: 'a.mp3', contentType: 'audio/mpeg', size: 5 };

describe('/sound add', () => {
  it('requires Create Expressions', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ subcommand: 'add', guildPerms: [PermissionFlagsBits.UseSoundboard], options: { name: 'x', attachment: audio } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'missing-permission', action: '/sound add' });
  });

  it('denies Manage Expressions without Create Expressions', async () => {
    const lib = makeLibrary();
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: MANAGE, options: { name: 'x', url: 'https://a.test' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'missing-permission', action: '/sound add' });
    expect(lib.add).not.toHaveBeenCalled();
  });

  it('denies when the guild is not ready', async () => {
    const ctx = makeCtx({ ready: false });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'x', attachment: audio } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'not-ready' });
  });

  it('requires exactly one of attachment/url', async () => {
    const lib = makeLibrary();
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'x', attachment: audio, url: 'https://a' } });
    await handleSoundCommand(ctx, i as never);
    expect(i.replies[0]?.content).toContain('Provide only one of');
    expect(lib.add).not.toHaveBeenCalled();
  });

  it('rejects a taken name (case-insensitive)', async () => {
    const lib = makeLibrary([makeSound('1', 'Airhorn')]);
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'AIRHORN', url: 'https://a.test' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'name-taken' });
    expect(lib.add).not.toHaveBeenCalled();
  });

  it('rejects non-audio attachments', async () => {
    const lib = makeLibrary();
    const ctx = makeCtx({ library: lib });
    const png = { ...audio, name: 'a.png', contentType: 'image/png' };
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'x', attachment: png } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'bad-attachment' });
  });

  it('adds a file sound (store re-uploads) after deferring, and logs', async () => {
    const lib = makeLibrary();
    const added = makeSound('9', 'Horn');
    lib.add.mockResolvedValue(added);
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: ' Horn ', attachment: audio } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(i.deferReply).toHaveBeenCalled();
    expect(lib.add).toHaveBeenCalledWith({
      kind: 'file',
      name: 'Horn',
      addedBy: 'u1',
      attachmentUrl: audio.url,
      filename: 'a.mp3',
      contentType: 'audio/mpeg',
      size: 5,
    });
    expect(ctx.logged[0]).toMatchObject({ type: 'library-add', sound: added });
    expect(i.replies[0]).toMatchObject({ kind: 'editReply', content: 'Added **Horn** to the soundboard library.' });
  });

  it('adds a link sound', async () => {
    const lib = makeLibrary();
    lib.add.mockResolvedValue({ ...makeSound('9', 'Song'), kind: 'link', url: 'https://yt.test/x' });
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'Song', url: ' https://yt.test/x ' } });
    await handleSoundCommand(ctx, i as never);
    expect(lib.add).toHaveBeenCalledWith({ kind: 'link', name: 'Song', addedBy: 'u1', url: 'https://yt.test/x' });
  });

  it('maps LibraryError from the store', async () => {
    const lib = makeLibrary();
    lib.add.mockRejectedValue(new LibraryError('too-large', 'big'));
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'add', guildPerms: CREATE, options: { name: 'x', attachment: audio } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'bad-attachment', detail: 'too-large: big' });
    expect(i.replies[0]?.content).toContain('too large');
  });
});

describe('/sound rename and delete', () => {
  const mine = makeSound('1', 'Mine', 'u1');
  const theirs = makeSound('2', 'Theirs', 'u2');

  it('Create Expressions can rename own sound', async () => {
    const lib = makeLibrary([mine, theirs]);
    lib.rename.mockResolvedValue({ ...mine, name: 'Renamed' });
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'rename', guildPerms: CREATE, options: { sound: '1', name: 'Renamed' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(lib.rename).toHaveBeenCalledWith('1', 'Renamed');
    expect(ctx.logged[0]).toMatchObject({ type: 'library-rename', oldName: 'Mine', sound: { name: 'Renamed' } });
  });

  it('Create Expressions cannot rename or delete others\' sounds', async () => {
    const lib = makeLibrary([mine, theirs]);
    const ctx = makeCtx({ library: lib });
    const r = makeInteraction({ subcommand: 'rename', guildPerms: CREATE, options: { sound: '2', name: 'X' } });
    await handleSoundCommand(ctx, r as never);
    const d = makeInteraction({ subcommand: 'delete', guildPerms: CREATE, options: { sound: 'theirs' } });
    await handleSoundCommand(ctx, d as never);
    await flush();
    expect(lib.rename).not.toHaveBeenCalled();
    expect(lib.delete).not.toHaveBeenCalled();
    expect(ctx.logged.map((e) => e.type === 'failure' && e.reason)).toEqual(['missing-permission', 'missing-permission']);
  });

  it('Manage Expressions can delete any sound (lookup by typed name)', async () => {
    const lib = makeLibrary([mine, theirs]);
    lib.delete.mockResolvedValue(theirs);
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'delete', guildPerms: MANAGE, options: { sound: 'THEIRS' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(lib.delete).toHaveBeenCalledWith('2');
    expect(ctx.logged[0]).toMatchObject({ type: 'library-delete', sound: theirs });
  });

  it('rename to a name used by another sound is rejected', async () => {
    const lib = makeLibrary([mine, theirs]);
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'rename', guildPerms: MANAGE, options: { sound: '1', name: 'theirs' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'name-taken' });
  });

  it('rename that only changes case is allowed', async () => {
    const lib = makeLibrary([mine]);
    lib.rename.mockResolvedValue({ ...mine, name: 'MINE' });
    const ctx = makeCtx({ library: lib });
    const i = makeInteraction({ subcommand: 'rename', guildPerms: CREATE, options: { sound: '1', name: 'MINE' } });
    await handleSoundCommand(ctx, i as never);
    expect(lib.rename).toHaveBeenCalledWith('1', 'MINE');
  });

  it('unknown sound is reported', async () => {
    const ctx = makeCtx({ library: makeLibrary([mine]) });
    const i = makeInteraction({ subcommand: 'delete', guildPerms: MANAGE, options: { sound: 'nope' } });
    await handleSoundCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'sound-not-found', action: '/sound delete' });
  });
});
