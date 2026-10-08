import { Collection, GuildPremiumTier } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { LibraryError } from '../errors.js';
import { serializeSoundMetadata } from './format.js';
import { createLibraryStore, looksLikeAudio, sanitizeFilename, searchSounds, uploadLimitBytes } from './store.js';
import type { LibrarySound } from '../types.js';

const BOT = '100000000000000001';
const USER = '200000000000000002';
const OTHER = '300000000000000003';
const GUILD = '400000000000000004';

interface FakeMessage {
  id: string;
  content: string;
  author: { id: string };
  attachments: Collection<string, { url: string; name: string }>;
  edit: (opts: { content: string }) => Promise<FakeMessage>;
}

function unknownMessage(): Error {
  return Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
}

function fakeChannel(opts: { premiumTier?: GuildPremiumTier } = {}) {
  let nextId = 500000000000000000n;
  const messages: FakeMessage[] = []; // ascending by id
  let urlVersion = 0;

  function make(content: string, authorId: string, withAttachment: boolean): FakeMessage {
    const id = String(nextId++);
    const attachments = new Collection<string, { url: string; name: string }>();
    if (withAttachment) {
      attachments.set('a' + id, {
        name: 'f',
        get url() {
          return `https://cdn.example/${id}?v=${urlVersion}`;
        },
      });
    }
    const msg: FakeMessage = {
      id,
      content,
      author: { id: authorId },
      attachments,
      edit: vi.fn(async (o: { content: string }) => {
        msg.content = o.content;
        return msg;
      }),
    };
    messages.push(msg);
    return msg;
  }

  const fetchMock = vi.fn(async (arg: { message?: string; limit?: number; before?: string }) => {
    if (arg.message !== undefined) {
      const found = messages.find((m) => m.id === arg.message);
      if (!found) throw unknownMessage();
      return found;
    }
    const limit = arg.limit ?? 50;
    const older = messages.filter((m) => arg.before === undefined || BigInt(m.id) < BigInt(arg.before));
    const page = older.slice(-limit).reverse(); // newest first, like Discord
    return new Collection(page.map((m) => [m.id, m]));
  });

  const sendMock = vi.fn(async (o: { content: string; files?: unknown[] }) => make(o.content, BOT, Boolean(o.files?.length)));

  const channel = {
    guildId: GUILD,
    guild: { premiumTier: opts.premiumTier ?? GuildPremiumTier.None },
    send: sendMock,
    messages: {
      fetch: fetchMock,
      delete: vi.fn(async (id: string) => {
        const i = messages.findIndex((m) => m.id === id);
        if (i === -1) throw unknownMessage();
        messages.splice(i, 1);
      }),
    },
  };

  return {
    channel: channel as unknown as TextChannel,
    raw: channel,
    messages,
    make,
    bumpUrls: () => urlVersion++,
  };
}

function soundContent(name: string, kind: 'file' | 'link', addedBy = USER): string {
  return kind === 'file'
    ? serializeSoundMetadata({ v: 1, kind, name, addedBy, addedAt: '2026-01-01T00:00:00.000Z', filename: `${name}.mp3` })
    : serializeSoundMetadata({ v: 1, kind, name, addedBy, addedAt: '2026-01-01T00:00:00.000Z', url: `https://example.com/${name}` });
}

function okFetch(bytes = 1000, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers }));
}

describe('pure helpers', () => {
  it('uploadLimitBytes follows boost tiers', () => {
    expect(uploadLimitBytes(GuildPremiumTier.None)).toBe(10 * 1024 * 1024);
    expect(uploadLimitBytes(GuildPremiumTier.Tier1)).toBe(10 * 1024 * 1024);
    expect(uploadLimitBytes(GuildPremiumTier.Tier2)).toBe(50 * 1024 * 1024);
    expect(uploadLimitBytes(GuildPremiumTier.Tier3)).toBe(100 * 1024 * 1024);
    expect(uploadLimitBytes(undefined)).toBe(10 * 1024 * 1024);
  });

  it('looksLikeAudio uses content type or extension', () => {
    expect(looksLikeAudio('x.bin', 'audio/mpeg')).toBe(true);
    expect(looksLikeAudio('x.bin', 'audio/ogg; codecs=opus')).toBe(true);
    expect(looksLikeAudio('clip.webm', 'video/webm')).toBe(true);
    expect(looksLikeAudio('song.FLAC', null)).toBe(true);
    expect(looksLikeAudio('image.png', 'image/png')).toBe(false);
    expect(looksLikeAudio('mp3', null)).toBe(false);
    // Same rule as the /play and /sound add handler check (isAudioAttachment).
    expect(looksLikeAudio('clip.amr', null)).toBe(true);
    expect(looksLikeAudio('clip.mp4', 'video/mp4')).toBe(false);
    expect(looksLikeAudio('clip.mp4', null)).toBe(false);
  });

  it('sanitizeFilename strips paths and caps length keeping the extension', () => {
    expect(sanitizeFilename('../../etc/passwd.mp3')).toBe('_.._etc_passwd.mp3');
    expect(sanitizeFilename('')).toBe('sound');
    const long = sanitizeFilename('a'.repeat(300) + '.mp3');
    expect(long.length).toBe(200);
    expect(long.endsWith('.mp3')).toBe(true);
  });

  it('searchSounds puts prefix matches before substring matches and caps at 25', () => {
    const s = (name: string): LibrarySound => ({
      id: name,
      guildId: GUILD,
      name,
      addedBy: USER,
      addedAt: new Date(0),
      kind: 'link',
      url: 'https://x.y',
    });
    const sorted = ['airhorn', 'big horn', 'Horn', 'horns', 'kazoo'].map(s);
    expect(searchSounds(sorted, 'HOR', 25).map((x) => x.name)).toEqual(['Horn', 'horns', 'airhorn', 'big horn']);
    expect(searchSounds(sorted, '', 2).map((x) => x.name)).toEqual(['airhorn', 'big horn']);
    expect(searchSounds(sorted, 'zzz', 25)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => s(`snd${String(i).padStart(2, '0')}`));
    expect(searchSounds(many, 'snd', 100)).toHaveLength(25);
  });
});

describe('createLibraryStore.load', () => {
  it('paginates the full history and indexes only valid bot-authored sounds', async () => {
    const fake = fakeChannel();
    for (let i = 0; i < 230; i++) fake.make(soundContent(`s${i}`, 'link'), BOT, false);
    fake.make(soundContent('fromuser', 'link'), OTHER, false); // not bot-authored
    fake.make('random chatter', BOT, false); // malformed
    fake.make(soundContent('nofile', 'file'), BOT, false); // file sound without attachment
    fake.make(soundContent('withfile', 'file'), BOT, true);

    const store = createLibraryStore(fake.channel, BOT);
    expect(store.loaded).toBe(false);
    expect(store.list()).toEqual([]);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.list()).toHaveLength(231);
    expect(store.getByName('S229')?.kind).toBe('link');
    expect(store.getByName('withfile')?.kind).toBe('file');
    expect(store.getByName('fromuser')).toBeUndefined();
    expect(store.getByName('nofile')).toBeUndefined();
    // 234 messages / 100 per page = 3 pages
    expect(fake.raw.messages.fetch).toHaveBeenCalledTimes(3);
    for (const call of fake.raw.messages.fetch.mock.calls) expect(call[0].limit).toBe(100);
  });

  it('keeps the oldest sound on a case-insensitive name collision', async () => {
    const fake = fakeChannel();
    const first = fake.make(soundContent('Horn', 'link'), BOT, false);
    fake.make(soundContent('HORN', 'link'), BOT, false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createLibraryStore(fake.channel, BOT);
    await store.load();
    expect(store.list()).toHaveLength(1);
    expect(store.getByName('horn')?.id).toBe(first.id);
    expect(warn).toHaveBeenCalled();
  });

  it('lists sorted case-insensitively', async () => {
    const fake = fakeChannel();
    for (const n of ['zeta', 'Alpha', 'beta']) fake.make(soundContent(n, 'link'), BOT, false);
    const store = createLibraryStore(fake.channel, BOT);
    await store.load();
    expect(store.list().map((s) => s.name)).toEqual(['Alpha', 'beta', 'zeta']);
    expect(store.search('a').map((s) => s.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('maps missing access to channel-unavailable', async () => {
    const fake = fakeChannel();
    fake.raw.messages.fetch.mockRejectedValueOnce(Object.assign(new Error('Missing Access'), { code: 50001 }));
    const store = createLibraryStore(fake.channel, BOT);
    await expect(store.load()).rejects.toMatchObject({ code: 'channel-unavailable' });
    expect(store.loaded).toBe(false);
  });
});

describe('createLibraryStore mutations', () => {
  async function loadedStore(fetchImpl = okFetch(), premiumTier?: GuildPremiumTier) {
    const fake = fakeChannel(premiumTier === undefined ? {} : { premiumTier });
    const store = createLibraryStore(fake.channel, BOT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await store.load();
    return { fake, store, fetchImpl };
  }

  it('rejects mutations before load', async () => {
    const fake = fakeChannel();
    const store = createLibraryStore(fake.channel, BOT);
    await expect(store.add({ kind: 'link', name: 'x', addedBy: USER, url: 'https://a.b' })).rejects.toMatchObject({
      code: 'not-ready',
    });
  });

  it('adds a link sound (link only, no attachment, no pings)', async () => {
    const { fake, store } = await loadedStore();
    const sound = await store.add({ kind: 'link', name: '  Rick  Roll ', addedBy: USER, url: ' https://youtu.be/x ' });
    expect(sound).toMatchObject({ kind: 'link', name: 'Rick Roll', url: 'https://youtu.be/x', addedBy: USER, guildId: GUILD });
    const sent = fake.raw.send.mock.calls[0]![0] as { content: string; files?: unknown; allowedMentions: unknown };
    expect(sent.files).toBeUndefined();
    expect(sent.allowedMentions).toEqual({ parse: [] });
    expect(store.getById(sound.id)).toEqual(sound);
    expect(store.getByName('rick roll')).toEqual(sound);

    // A fresh store rebuilt from history sees the same sound.
    const again = createLibraryStore(fake.channel, BOT);
    await again.load();
    expect(again.getById(sound.id)).toEqual(sound);
  });

  it('forget() drops externally deleted sounds and frees their names', async () => {
    const { fake, store } = await loadedStore();
    const sound = await store.add({ kind: 'link', name: 'Gone', addedBy: USER, url: 'https://a.b' });
    fake.messages.splice(fake.messages.findIndex((m) => m.id === sound.id), 1); // admin deleted it by hand
    store.forget([sound.id, 'unknown-id']);
    expect(store.getById(sound.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.search('gone')).toEqual([]);
    const again = await store.add({ kind: 'link', name: 'gone', addedBy: USER, url: 'https://a.b' });
    expect(again.name).toBe('gone');
  });

  it('validates names and urls', async () => {
    const { store } = await loadedStore();
    await expect(store.add({ kind: 'link', name: '', addedBy: USER, url: 'https://a.b' })).rejects.toMatchObject({
      code: 'invalid-name',
    });
    await expect(store.add({ kind: 'link', name: 'x', addedBy: USER, url: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'invalid-url',
    });
    await expect(
      store.add({ kind: 'link', name: 'x', addedBy: USER, url: `https://a.b/${'x'.repeat(2000)}` }),
    ).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('enforces case-insensitive uniqueness even under concurrent adds', async () => {
    const { store } = await loadedStore();
    const results = await Promise.allSettled([
      store.add({ kind: 'link', name: 'Horn', addedBy: USER, url: 'https://a.b/1' }),
      store.add({ kind: 'link', name: 'HORN', addedBy: USER, url: 'https://a.b/2' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const rejected = results[1] as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LibraryError);
    expect(rejected.reason.code).toBe('name-taken');
    expect(store.list()).toHaveLength(1);
  });

  it('downloads and re-uploads file sounds', async () => {
    const { fake, store, fetchImpl } = await loadedStore();
    const sound = await store.add({
      kind: 'file',
      name: 'Airhorn',
      addedBy: USER,
      attachmentUrl: 'https://cdn.discordapp.com/attachments/1/2/airhorn.mp3?ex=abc',
      filename: 'airhorn.mp3',
      contentType: 'audio/mpeg',
      size: 1000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sound).toMatchObject({ kind: 'file', filename: 'airhorn.mp3', name: 'Airhorn' });
    const sent = fake.raw.send.mock.calls[0]![0] as { files: { attachment: Buffer; name: string }[] };
    expect(sent.files).toHaveLength(1);
    expect(Buffer.isBuffer(sent.files[0]!.attachment)).toBe(true);
    expect(sent.files[0]!.attachment.length).toBe(1000);
    expect(sent.files[0]!.name).toBe('airhorn.mp3');
  });

  it('rejects non-audio and oversized files before uploading', async () => {
    const { fake, store, fetchImpl } = await loadedStore(okFetch(11 * 1024 * 1024));
    const base = { kind: 'file' as const, name: 'x', addedBy: USER, attachmentUrl: 'https://cdn.example/x' };
    await expect(store.add({ ...base, filename: 'x.png', contentType: 'image/png', size: 10 })).rejects.toMatchObject({
      code: 'not-audio',
    });
    await expect(
      store.add({ ...base, filename: 'x.mp3', contentType: 'audio/mpeg', size: 11 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Unknown declared size: enforced after download.
    await expect(store.add({ ...base, filename: 'x.mp3', contentType: 'audio/mpeg', size: null })).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(fake.raw.send).not.toHaveBeenCalled();
  });

  it('allows larger files on boosted guilds', async () => {
    const { store } = await loadedStore(okFetch(11 * 1024 * 1024), GuildPremiumTier.Tier2);
    const sound = await store.add({
      kind: 'file',
      name: 'big',
      addedBy: USER,
      attachmentUrl: 'https://cdn.example/x',
      filename: 'big.wav',
      contentType: 'audio/wav',
      size: 11 * 1024 * 1024,
    });
    expect(sound.kind).toBe('file');
  });

  it('maps download failures and Discord 40005 to typed errors', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 404 }));
    const { store } = await loadedStore(failing);
    const input = {
      kind: 'file' as const,
      name: 'x',
      addedBy: USER,
      attachmentUrl: 'https://cdn.example/x',
      filename: 'x.mp3',
      contentType: 'audio/mpeg',
      size: 10,
    };
    await expect(store.add(input)).rejects.toMatchObject({ code: 'download-failed' });

    const throwing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const second = await loadedStore(throwing);
    await expect(second.store.add(input)).rejects.toMatchObject({ code: 'download-failed' });

    const third = await loadedStore();
    third.fake.raw.send.mockRejectedValueOnce(Object.assign(new Error('Request entity too large'), { code: 40005 }));
    await expect(third.store.add(input)).rejects.toMatchObject({ code: 'too-large' });
    expect(third.store.list()).toHaveLength(0);
  });

  it('renames by editing the message, allowing case-only changes', async () => {
    const { fake, store } = await loadedStore();
    const a = await store.add({ kind: 'link', name: 'horn', addedBy: USER, url: 'https://a.b/1' });
    await store.add({ kind: 'link', name: 'kazoo', addedBy: USER, url: 'https://a.b/2' });

    await expect(store.rename(a.id, 'KAZOO')).rejects.toMatchObject({ code: 'name-taken' });
    await expect(store.rename(a.id, '   ')).rejects.toMatchObject({ code: 'invalid-name' });
    await expect(store.rename('nope', 'x')).rejects.toMatchObject({ code: 'not-found' });

    const cased = await store.rename(a.id, 'Horn');
    expect(cased.name).toBe('Horn');
    const renamed = await store.rename(a.id, 'Air Horn');
    expect(renamed).toMatchObject({ id: a.id, name: 'Air Horn', addedBy: USER, kind: 'link' });
    expect(store.getByName('horn')).toBeUndefined();
    expect(store.getByName('air horn')?.id).toBe(a.id);

    const msg = fake.messages.find((m) => m.id === a.id)!;
    expect(msg.content).toContain('Air Horn');
    const reloaded = createLibraryStore(fake.channel, BOT);
    await reloaded.load();
    expect(reloaded.getById(a.id)?.name).toBe('Air Horn');
  });

  it('rename drops a sound whose message vanished', async () => {
    const { fake, store } = await loadedStore();
    const a = await store.add({ kind: 'link', name: 'horn', addedBy: USER, url: 'https://a.b/1' });
    fake.messages.length = 0;
    await expect(store.rename(a.id, 'x')).rejects.toMatchObject({ code: 'not-found' });
    expect(store.getById(a.id)).toBeUndefined();
  });

  it('deletes the message and the index entry (tolerating an already-deleted message)', async () => {
    const { fake, store } = await loadedStore();
    const a = await store.add({ kind: 'link', name: 'horn', addedBy: USER, url: 'https://a.b/1' });
    const b = await store.add({ kind: 'link', name: 'kazoo', addedBy: USER, url: 'https://a.b/2' });
    expect(await store.delete(a.id)).toEqual(a);
    expect(store.getById(a.id)).toBeUndefined();
    expect(fake.messages.some((m) => m.id === a.id)).toBe(false);
    // Name is free again.
    await store.add({ kind: 'link', name: 'HORN', addedBy: USER, url: 'https://a.b/3' });

    fake.messages.splice(fake.messages.findIndex((m) => m.id === b.id), 1);
    expect(await store.delete(b.id)).toEqual(b);
    await expect(store.delete(b.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('freshAttachmentUrl re-fetches the message every time', async () => {
    const { fake, store } = await loadedStore();
    const sound = await store.add({
      kind: 'file',
      name: 'Airhorn',
      addedBy: USER,
      attachmentUrl: 'https://cdn.example/x',
      filename: 'airhorn.mp3',
      contentType: 'audio/mpeg',
      size: 1000,
    });
    const first = await store.freshAttachmentUrl(sound.id);
    fake.bumpUrls();
    const second = await store.freshAttachmentUrl(sound.id);
    expect(first).not.toBe(second);
    const fetchCalls = fake.raw.messages.fetch.mock.calls.filter((c) => c[0].message === sound.id);
    expect(fetchCalls).toHaveLength(2);
    for (const [arg] of fetchCalls) expect(arg).toMatchObject({ force: true });

    fake.messages.length = 0;
    await expect(store.freshAttachmentUrl(sound.id)).rejects.toMatchObject({ code: 'not-found' });
    expect(store.getById(sound.id)).toBeUndefined();
  });

  it('freshAttachmentUrl rejects link sounds and unknown ids', async () => {
    const { store } = await loadedStore();
    const link = await store.add({ kind: 'link', name: 'horn', addedBy: USER, url: 'https://a.b/1' });
    await expect(store.freshAttachmentUrl(link.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(store.freshAttachmentUrl('123')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a failed mutation does not block later ones', async () => {
    const { fake, store } = await loadedStore();
    fake.raw.send.mockRejectedValueOnce(new Error('boom'));
    await expect(store.add({ kind: 'link', name: 'a', addedBy: USER, url: 'https://a.b' })).rejects.toBeInstanceOf(
      LibraryError,
    );
    await expect(store.add({ kind: 'link', name: 'a', addedBy: USER, url: 'https://a.b' })).resolves.toMatchObject({
      name: 'a',
    });
  });

  it('sends uploads with a unique enforced nonce so REST retries cannot post duplicates', async () => {
    const { fake, store } = await loadedStore();
    await store.add({
      kind: 'file',
      name: 'a',
      addedBy: USER,
      attachmentUrl: 'https://cdn.example/a',
      filename: 'a.mp3',
      contentType: 'audio/mpeg',
      size: 10,
    });
    await store.add({ kind: 'link', name: 'b', addedBy: USER, url: 'https://a.b' });
    const sent = fake.raw.send.mock.calls.map((c) => c[0] as { nonce?: string; enforceNonce?: boolean });
    for (const opts of sent) {
      expect(opts.enforceNonce).toBe(true);
      expect(typeof opts.nonce).toBe('string');
      expect(opts.nonce!.length).toBeLessThanOrEqual(25);
    }
    expect(sent[0]!.nonce).not.toBe(sent[1]!.nonce);
  });

  it('maps a REST timeout (AbortError) to upload-timeout, not channel-unavailable', async () => {
    const { fake, store } = await loadedStore();
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    fake.raw.send.mockRejectedValueOnce(abort);
    await expect(
      store.add({
        kind: 'file',
        name: 'big',
        addedBy: USER,
        attachmentUrl: 'https://cdn.example/x',
        filename: 'big.mp3',
        contentType: 'audio/mpeg',
        size: 10,
      }),
    ).rejects.toMatchObject({ code: 'upload-timeout' });
    expect(store.list()).toHaveLength(0);
  });
});

describe('shadowed duplicate names', () => {
  async function withDuplicates() {
    const fake = fakeChannel();
    const older = fake.make(soundContent('Airhorn', 'link'), BOT, false);
    const newer = fake.make(soundContent('airhorn', 'link'), BOT, false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createLibraryStore(fake.channel, BOT);
    await store.load();
    return { fake, store, older, newer };
  }

  it('promotes the next duplicate when the indexed sound is deleted', async () => {
    const { store, older, newer } = await withDuplicates();
    expect(store.getByName('airhorn')?.id).toBe(older.id);
    await store.delete(older.id);
    expect(store.getByName('airhorn')?.id).toBe(newer.id);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps the name taken while a shadowed duplicate exists', async () => {
    const { store, older } = await withDuplicates();
    await store.delete(older.id);
    await expect(store.add({ kind: 'link', name: 'AIRHORN', addedBy: USER, url: 'https://a.b' })).rejects.toMatchObject({
      code: 'name-taken',
    });
  });

  it('promotes the duplicate when the indexed sound is renamed away', async () => {
    const { store, older, newer } = await withDuplicates();
    await store.rename(older.id, 'Foghorn');
    expect(store.getByName('foghorn')?.id).toBe(older.id);
    expect(store.getByName('airhorn')?.id).toBe(newer.id);
    expect(store.list()).toHaveLength(2);
  });

  it('forget() of a shadowed duplicate keeps the indexed sound and drops the duplicate', async () => {
    const { store, older, newer } = await withDuplicates();
    store.forget([newer.id]);
    expect(store.getByName('airhorn')?.id).toBe(older.id);
    await store.delete(older.id);
    expect(store.getByName('airhorn')).toBeUndefined();
  });
});
