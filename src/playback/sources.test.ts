import { describe, expect, it, vi } from 'vitest';
import { PlaybackError } from '../errors.js';
import type { LibraryFileSound, LibraryLinkSound } from '../types.js';
import {
  buildFfmpegArgs,
  buildYtDlpResolveArgs,
  buildYtDlpStreamArgs,
  fileExtension,
  isAudioAttachment,
  isDirectMediaUrl,
  isHttpUrl,
  isPrivateAddress,
  normalizeHttpUrl,
  resolveSourceWith,
  summarizeSource,
  summarizeToolError,
  titleFromUrl,
  tracksFromYtDlpInfo,
} from './sources.js';

const fileSound: LibraryFileSound = {
  kind: 'file',
  id: '111',
  guildId: 'g1',
  name: 'Airhorn',
  addedBy: 'u1',
  addedAt: new Date('2026-01-01T00:00:00Z'),
  filename: 'airhorn.mp3',
};

const linkSound: LibraryLinkSound = {
  kind: 'link',
  id: '222',
  guildId: 'g1',
  name: 'Theme',
  addedBy: 'u1',
  addedAt: new Date('2026-01-01T00:00:00Z'),
  url: 'https://www.youtube.com/watch?v=abc',
};

async function expectPlaybackError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PlaybackError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('isHttpUrl / normalizeHttpUrl', () => {
  it.each([
    'http://example.com',
    'https://example.com/a.mp3',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://cdn.discordapp.com/attachments/1/2/a.ogg?ex=1&is=2&hm=3',
    'HTTPS://EXAMPLE.COM/x',
  ])('accepts %s', (url) => {
    expect(isHttpUrl(url)).toBe(true);
  });

  it.each([
    '',
    'example.com/a.mp3',
    '/etc/passwd',
    'file:///etc/passwd',
    'data:audio/mp3;base64,AAAA',
    'ftp://example.com/a.mp3',
    'concat:http://a|http://b',
    'subfile,,start,0,end,0,,:file:///etc/passwd',
    'javascript:alert(1)',
    'rtmp://example.com/live',
    'tcp://127.0.0.1:1234',
    'pipe:0',
    '-i',
    '--exec=touch /tmp/pwned',
    'https://exa mple.com',
    'https://example.com/a b.mp3',
    ' https://example.com',
    'https://example.com/\nfoo',
    'http://',
    `https://example.com/${'a'.repeat(5000)}`,
  ])('rejects %j', (url) => {
    expect(isHttpUrl(url)).toBe(false);
    expect(normalizeHttpUrl(url)).toBeNull();
  });

  it('normalizes the URL', () => {
    expect(normalizeHttpUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });
});

describe('fileExtension', () => {
  it.each([
    ['song.MP3', 'mp3'],
    ['a/b/c.tar.ogg', 'ogg'],
    ['/path/to/file.webm', 'webm'],
    ['noext', ''],
    ['.hidden', ''],
    ['trailing.', ''],
  ])('%s -> %s', (name, ext) => {
    expect(fileExtension(name)).toBe(ext);
  });
});

describe('isAudioAttachment', () => {
  it('accepts audio/* content types regardless of extension', () => {
    expect(isAudioAttachment({ contentType: 'audio/mpeg', filename: 'blob' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'audio/ogg; codecs=opus', filename: 'voice-message' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'AUDIO/WAV', filename: 'x' })).toBe(true);
  });

  it('accepts known audio extensions (not video-only containers) when content type is missing or generic', () => {
    expect(isAudioAttachment({ contentType: null, filename: 'clip.mp3' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'application/octet-stream', filename: 'clip.FLAC' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'video/mp4', filename: 'clip.mp4' })).toBe(false);
    expect(isAudioAttachment({ contentType: null, filename: 'clip.mov' })).toBe(false);
    expect(isAudioAttachment({ contentType: null, filename: 'clip.mkv' })).toBe(false);
    expect(isAudioAttachment({ contentType: null, filename: 'clip.m4v' })).toBe(false);
    expect(isAudioAttachment({ contentType: 'video/webm', filename: 'voice.webm' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'audio/ogg; codecs=opus', filename: 'x.bin' })).toBe(true);
    expect(isAudioAttachment({ contentType: null, filename: 'voice.opus' })).toBe(true);
  });

  it('rejects non-audio files', () => {
    expect(isAudioAttachment({ contentType: 'image/png', filename: 'cat.png' })).toBe(false);
    expect(isAudioAttachment({ contentType: 'text/plain', filename: 'notes.txt' })).toBe(false);
    expect(isAudioAttachment({ contentType: null, filename: 'noext' })).toBe(false);
    expect(isAudioAttachment({ contentType: 'application/pdf', filename: 'mp3.pdf' })).toBe(false);
  });
});

describe('isDirectMediaUrl', () => {
  it('detects media extensions on the path only', () => {
    expect(isDirectMediaUrl('https://example.com/sounds/boom.mp3')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/boom.ogg?token=abc')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/page?file=boom.mp3')).toBe(false);
    expect(isDirectMediaUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isDirectMediaUrl('file:///tmp/boom.mp3')).toBe(false);
  });
});

describe('summarizeSource', () => {
  it('attachment: filename + link', () => {
    expect(
      summarizeSource({
        type: 'attachment',
        url: 'https://cdn.discordapp.com/a/b/boom.mp3',
        filename: 'boom.mp3',
        contentType: 'audio/mpeg',
        size: 10,
      }),
    ).toEqual({ type: 'attachment', label: 'boom.mp3', url: 'https://cdn.discordapp.com/a/b/boom.mp3', libraryName: null });
  });

  it('url', () => {
    expect(summarizeSource({ type: 'url', url: 'https://x.test/a' })).toEqual({
      type: 'url',
      label: 'https://x.test/a',
      url: 'https://x.test/a',
      libraryName: null,
    });
  });

  it('library file sound has no (expiring) url', () => {
    expect(summarizeSource({ type: 'library', sound: fileSound })).toEqual({
      type: 'library',
      label: 'Airhorn',
      url: null,
      libraryName: 'Airhorn',
    });
  });

  it('library link sound carries its saved link', () => {
    expect(summarizeSource({ type: 'library', sound: linkSound })).toEqual({
      type: 'library',
      label: 'Theme',
      url: linkSound.url,
      libraryName: 'Theme',
    });
  });
});

describe('argument safety', () => {
  const nasty = 'https://example.com/--exec=rm';

  it('yt-dlp resolve args end with "--" then the URL', () => {
    const args = buildYtDlpResolveArgs(nasty);
    expect(args.slice(-2)).toEqual(['--', nasty]);
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('--dump-single-json');
  });

  it('yt-dlp stream args end with "--" then the URL and write to stdout', () => {
    const args = buildYtDlpStreamArgs(nasty);
    expect(args.slice(-2)).toEqual(['--', nasty]);
    const out = args.indexOf('--output');
    expect(args[out + 1]).toBe('-');
    expect(args).toContain('--no-playlist');
  });

  it('ffmpeg URL input is protocol-whitelisted before -i', () => {
    const args = buildFfmpegArgs({ kind: 'url', url: 'https://example.com/a.mp3' });
    const wl = args.indexOf('-protocol_whitelist');
    const input = args.indexOf('-i');
    expect(wl).toBeGreaterThanOrEqual(0);
    expect(wl).toBeLessThan(input);
    expect(args[wl + 1]).toBe('http,https,tls,tcp,crypto');
    expect(args[wl + 1]).not.toMatch(/file|pipe|concat|data/);
    expect(args[input + 1]).toBe('https://example.com/a.mp3');
  });

  it('ffmpeg pipe input only allows the pipe protocol', () => {
    const args = buildFfmpegArgs({ kind: 'pipe' });
    const wl = args.indexOf('-protocol_whitelist');
    expect(args[wl + 1]).toBe('pipe');
    expect(args[args.indexOf('-i') + 1]).toBe('pipe:0');
  });

  it('ffmpeg outputs s16le 48kHz stereo PCM to stdout', () => {
    const args = buildFfmpegArgs({ kind: 'pipe' });
    expect(args.join(' ')).toContain('-f s16le -ar 48000 -ac 2 pipe:1');
  });
});

describe('summarizeToolError', () => {
  it('prefers the last ERROR: line', () => {
    const stderr = '[youtube] abc: Downloading webpage\nERROR: first\nsomething\nERROR: [youtube] abc: Video unavailable\n';
    expect(summarizeToolError(stderr)).toBe('[youtube] abc: Video unavailable');
  });

  it('falls back to the last non-empty line', () => {
    expect(summarizeToolError('a\nb\n\n')).toBe('b');
  });

  it('returns null for empty output', () => {
    expect(summarizeToolError('  \n')).toBeNull();
  });

  it('truncates long messages', () => {
    expect(summarizeToolError(`ERROR: ${'x'.repeat(1000)}`)?.length).toBeLessThanOrEqual(300);
  });
});

describe('titleFromUrl', () => {
  it('uses the decoded last path segment', () => {
    expect(titleFromUrl('https://example.com/a/My%20Song.mp3')).toBe('My Song.mp3');
  });
  it('falls back to the hostname', () => {
    expect(titleFromUrl('https://example.com/')).toBe('example.com');
  });
});

describe('tracksFromYtDlpInfo', () => {
  it('single video', () => {
    const tracks = tracksFromYtDlpInfo(
      { _type: 'video', title: 'Song', duration: 123, webpage_url: 'https://www.youtube.com/watch?v=abc' },
      'https://youtu.be/abc',
    );
    expect(tracks).toEqual([
      { title: 'Song', input: { kind: 'ytdlp', url: 'https://www.youtube.com/watch?v=abc' }, durationSec: 123 },
    ]);
  });

  it('single item falls back to the requested URL and a URL-derived title', () => {
    const tracks = tracksFromYtDlpInfo({}, 'https://example.com/stream');
    expect(tracks).toEqual([
      { title: 'stream', input: { kind: 'ytdlp', url: 'https://example.com/stream' }, durationSec: null },
    ]);
  });

  it('expands every playlist entry, in order', () => {
    const tracks = tracksFromYtDlpInfo(
      {
        _type: 'playlist',
        title: 'Mix',
        entries: [
          { url: 'https://www.youtube.com/watch?v=1', title: 'One', duration: 10 },
          { url: 'https://www.youtube.com/watch?v=2', title: 'Two' },
          { url: 'https://www.youtube.com/watch?v=3' },
        ],
      },
      'https://www.youtube.com/playlist?list=PL1',
    );
    expect(tracks.map((t) => t.title)).toEqual(['One', 'Two', 'https://www.youtube.com/watch?v=3']);
    expect(tracks.map((t) => t.input)).toEqual([
      { kind: 'ytdlp', url: 'https://www.youtube.com/watch?v=1' },
      { kind: 'ytdlp', url: 'https://www.youtube.com/watch?v=2' },
      { kind: 'ytdlp', url: 'https://www.youtube.com/watch?v=3' },
    ]);
    expect(tracks[0]?.durationSec).toBe(10);
    expect(tracks[1]?.durationSec).toBeNull();
  });

  it('skips entries without a usable http(s) URL, and uses webpage_url as a fallback', () => {
    const tracks = tracksFromYtDlpInfo(
      {
        _type: 'playlist',
        entries: [
          null,
          'junk',
          { url: 'file:///etc/passwd', title: 'evil' },
          { url: 'abc123', webpage_url: 'https://soundcloud.com/a/b', title: 'SC' },
        ],
      },
      'https://soundcloud.com/a/sets/s',
    );
    expect(tracks).toEqual([{ title: 'SC', input: { kind: 'ytdlp', url: 'https://soundcloud.com/a/b' }, durationSec: null }]);
  });

  it('throws empty-playlist when no entry is playable', () => {
    expect(() => tracksFromYtDlpInfo({ _type: 'playlist', entries: [] }, 'https://x.test/p')).toThrow(
      expect.objectContaining({ code: 'empty-playlist' }),
    );
  });

  it('throws extraction-failed on non-object output', () => {
    expect(() => tracksFromYtDlpInfo(null, 'https://x.test')).toThrow(expect.objectContaining({ code: 'extraction-failed' }));
    expect(() => tracksFromYtDlpInfo([1, 2], 'https://x.test')).toThrow(
      expect.objectContaining({ code: 'extraction-failed' }),
    );
  });

  it('clamps very long titles', () => {
    const [track] = tracksFromYtDlpInfo({ title: 'x'.repeat(1000) }, 'https://x.test/a');
    expect(track?.title.length).toBeLessThanOrEqual(200);
  });
});

/** Fake DNS: every hostname resolves to a public address (no real lookups in tests). */
const publicLookup = vi.fn(async () => ['93.184.216.34']);

describe('resolveSourceWith', () => {
  const neverCalled = {
    ytDlpResolve: vi.fn(() => Promise.reject(new Error('should not be called'))),
    lookupHost: publicLookup,
  };

  it('attachment -> direct track named after the file', async () => {
    const tracks = await resolveSourceWith(
      {
        type: 'attachment',
        url: 'https://cdn.discordapp.com/attachments/1/2/boom.mp3?ex=1',
        filename: 'boom.mp3',
        contentType: 'audio/mpeg',
        size: 100,
      },
      neverCalled,
    );
    expect(tracks).toEqual([
      {
        title: 'boom.mp3',
        input: { kind: 'direct', url: 'https://cdn.discordapp.com/attachments/1/2/boom.mp3?ex=1' },
        durationSec: null,
      },
    ]);
    expect(neverCalled.ytDlpResolve).not.toHaveBeenCalled();
  });

  it('rejects non-audio attachments', async () => {
    await expectPlaybackError(
      resolveSourceWith(
        { type: 'attachment', url: 'https://cdn.discordapp.com/x.png', filename: 'x.png', contentType: 'image/png', size: 1 },
        neverCalled,
      ),
      'unsupported-source',
    );
  });

  it('rejects attachments with a non-http URL', async () => {
    await expectPlaybackError(
      resolveSourceWith(
        { type: 'attachment', url: 'file:///etc/passwd', filename: 'a.mp3', contentType: 'audio/mpeg', size: 1 },
        neverCalled,
      ),
      'invalid-url',
    );
  });

  it.each(['file:///etc/passwd', 'data:audio/mp3;base64,AA', 'not a url', 'ftp://x.test/a.mp3'])(
    'rejects url source %j without running yt-dlp',
    async (url) => {
      await expectPlaybackError(resolveSourceWith({ type: 'url', url }, neverCalled), 'invalid-url');
      expect(neverCalled.ytDlpResolve).not.toHaveBeenCalled();
    },
  );

  it('direct audio links skip yt-dlp', async () => {
    const tracks = await resolveSourceWith({ type: 'url', url: 'https://example.com/a/boom.ogg' }, neverCalled);
    expect(tracks).toEqual([
      { title: 'boom.ogg', input: { kind: 'direct', url: 'https://example.com/a/boom.ogg' }, durationSec: null },
    ]);
  });

  it('trims surrounding whitespace from pasted URLs', async () => {
    const tracks = await resolveSourceWith({ type: 'url', url: '  https://example.com/boom.mp3 ' }, neverCalled);
    expect(tracks[0]?.input).toEqual({ kind: 'direct', url: 'https://example.com/boom.mp3' });
  });

  it('page URLs go through yt-dlp (normalized URL)', async () => {
    const ytDlpResolve = vi.fn(() =>
      Promise.resolve({ title: 'Song', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 5 }),
    );
    const tracks = await resolveSourceWith({ type: 'url', url: 'https://youtu.be/abc' }, { ytDlpResolve, lookupHost: publicLookup });
    expect(ytDlpResolve).toHaveBeenCalledWith('https://youtu.be/abc', undefined);
    expect(tracks).toEqual([
      { title: 'Song', input: { kind: 'ytdlp', url: 'https://www.youtube.com/watch?v=abc' }, durationSec: 5 },
    ]);
  });

  it('propagates yt-dlp failures', async () => {
    const ytDlpResolve = vi.fn(() => Promise.reject(new PlaybackError('extraction-failed', 'nope')));
    await expectPlaybackError(
      resolveSourceWith({ type: 'url', url: 'https://example.com/page' }, { ytDlpResolve, lookupHost: publicLookup }),
      'extraction-failed',
    );
  });

  it('library file sound -> library-file input (fresh URL fetched at play time)', async () => {
    const tracks = await resolveSourceWith({ type: 'library', sound: fileSound }, neverCalled);
    expect(tracks).toEqual([
      { title: 'Airhorn', input: { kind: 'library-file', guildId: 'g1', soundId: '111' }, durationSec: null },
    ]);
  });

  it('library link sound resolves like a URL, titled with the sound name', async () => {
    const ytDlpResolve = vi.fn(() => Promise.resolve({ title: 'Original', webpage_url: linkSound.url }));
    const tracks = await resolveSourceWith({ type: 'library', sound: linkSound }, { ytDlpResolve, lookupHost: publicLookup });
    expect(ytDlpResolve).toHaveBeenCalledWith(linkSound.url, undefined);
    expect(tracks).toEqual([{ title: 'Theme', input: { kind: 'ytdlp', url: linkSound.url }, durationSec: null }]);
  });

  it('library link playlist expands every item with their own titles', async () => {
    const ytDlpResolve = vi.fn(() =>
      Promise.resolve({
        _type: 'playlist',
        entries: [
          { url: 'https://www.youtube.com/watch?v=1', title: 'One' },
          { url: 'https://www.youtube.com/watch?v=2', title: 'Two' },
        ],
      }),
    );
    const tracks = await resolveSourceWith(
      { type: 'library', sound: { ...linkSound, url: 'https://www.youtube.com/playlist?list=PL' } },
      { ytDlpResolve, lookupHost: publicLookup },
    );
    expect(tracks.map((t) => t.title)).toEqual(['One', 'Two']);
  });

  it.each([
    'http://127.0.0.1/a.mp3',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.mp3',
    'http://[::ffff:10.0.0.1]/x',
    'http://localhost:8080/a.mp3',
    'http://foo.localhost/',
  ])('rejects private/local host %s without running yt-dlp', async (url) => {
    await expectPlaybackError(resolveSourceWith({ type: 'url', url }, neverCalled), 'invalid-url');
    expect(neverCalled.ytDlpResolve).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to a private address (incl. saved links)', async () => {
    const lookupHost = vi.fn(async () => ['8.8.8.8', '10.1.2.3']);
    await expectPlaybackError(
      resolveSourceWith({ type: 'url', url: 'https://intranet.example/page' }, { ...neverCalled, lookupHost }),
      'invalid-url',
    );
    await expectPlaybackError(
      resolveSourceWith({ type: 'library', sound: linkSound }, { ...neverCalled, lookupHost }),
      'invalid-url',
    );
    expect(neverCalled.ytDlpResolve).not.toHaveBeenCalled();
  });

  it('passes the abort signal through to yt-dlp', async () => {
    const ytDlpResolve = vi.fn(() => Promise.resolve({ title: 'Song', webpage_url: 'https://youtu.be/abc' }));
    const signal = new AbortController().signal;
    await resolveSourceWith({ type: 'url', url: 'https://youtu.be/abc' }, { ytDlpResolve, lookupHost: publicLookup, signal });
    expect(ytDlpResolve).toHaveBeenCalledWith('https://youtu.be/abc', signal);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});
