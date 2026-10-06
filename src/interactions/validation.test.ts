import { describe, expect, it } from 'vitest';
import type { LibraryErrorCode, PlaybackErrorCode } from '../errors.js';
import type { LibrarySound, PlayResult, SourceSummary, TrackInfo } from '../types.js';
import {
  MESSAGE_CONTENT_LIMIT,
  autocompleteChoices,
  busyElsewhereMessage,
  clampVolume,
  describeLibraryError,
  firstAudioAttachment,
  formatPlaySuccess,
  formatSkipReply,
  formatStopReply,
  formatVolumeReply,
  parsePlayMode,
  pickExactlyOne,
  playbackFailureReason,
  resolveSoundOption,
  truncate,
} from './validation.js';

const makeSound = (id: string, name: string): LibrarySound => ({
  kind: 'file',
  id,
  guildId: 'g',
  name,
  addedBy: 'u',
  addedAt: new Date(0),
  filename: `${name}.mp3`,
});

const summary: SourceSummary = { type: 'url', label: 'https://x.test/a', url: 'https://x.test/a', libraryName: null };

const track = (title: string, extra: Partial<TrackInfo> = {}): TrackInfo => ({
  id: title,
  title,
  source: summary,
  requester: { id: 'u', displayName: 'User' },
  volume: 100,
  requestedAt: new Date(0),
  playlistIndex: 0,
  playlistSize: 1,
  ...extra,
});

describe('pickExactlyOne', () => {
  const names = ['attachment', 'url', 'sound'] as const;

  it('accepts exactly one given value', () => {
    expect(pickExactlyOne({ attachment: null, url: 'https://a', sound: null }, names)).toEqual({ ok: true, key: 'url' });
    expect(pickExactlyOne({ attachment: { any: 1 }, url: null, sound: null }, names)).toEqual({
      ok: true,
      key: 'attachment',
    });
    expect(pickExactlyOne({ sound: 'abc' }, names)).toEqual({ ok: true, key: 'sound' });
  });

  it('rejects none, listing every option', () => {
    const r = pickExactlyOne({ attachment: null, url: null, sound: null }, names);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Provide one of `attachment`, `url` or `sound`.');
  });

  it('treats blank strings as not given', () => {
    const r = pickExactlyOne({ attachment: null, url: '   ', sound: '' }, names);
    expect(r.ok).toBe(false);
    expect(pickExactlyOne({ url: '  ', sound: 'x' }, names)).toEqual({ ok: true, key: 'sound' });
  });

  it('rejects more than one, naming the ones given', () => {
    const r = pickExactlyOne({ attachment: {}, url: 'https://a', sound: null }, names);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('you gave `attachment` and `url`');
    const all = pickExactlyOne({ attachment: {}, url: 'https://a', sound: 's' }, names);
    if (!all.ok) expect(all.error).toContain('you gave `attachment`, `url` and `sound`');
  });

  it('works for the two-option /sound add case', () => {
    const r = pickExactlyOne({ attachment: null, url: null }, ['attachment', 'url'] as const);
    if (!r.ok) expect(r.error).toBe('Provide one of `attachment` or `url`.');
  });
});

describe('parsePlayMode', () => {
  it('defaults to interrupt', () => {
    expect(parsePlayMode(null)).toBe('interrupt');
    expect(parsePlayMode(undefined)).toBe('interrupt');
    expect(parsePlayMode('garbage')).toBe('interrupt');
  });
  it('passes through valid modes', () => {
    expect(parsePlayMode('queue')).toBe('queue');
    expect(parsePlayMode('interrupt')).toBe('interrupt');
  });
});

describe('clampVolume', () => {
  it('defaults to 100', () => {
    expect(clampVolume(null)).toBe(100);
    expect(clampVolume(undefined)).toBe(100);
    expect(clampVolume(Number.NaN)).toBe(100);
  });
  it('clamps to 0-200 and rounds', () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(200)).toBe(200);
    expect(clampVolume(999)).toBe(200);
    expect(clampVolume(49.6)).toBe(50);
  });
});

describe('resolveSoundOption', () => {
  const a = makeSound('123', 'Airhorn');
  const library = {
    getById: (id: string) => (id === a.id ? a : undefined),
    getByName: (name: string) => (name.toLowerCase() === 'airhorn' ? a : undefined),
  };
  it('prefers id (autocomplete value)', () => {
    expect(resolveSoundOption(library, '123')).toBe(a);
  });
  it('falls back to a typed name', () => {
    expect(resolveSoundOption(library, '  AIRHORN ')).toBe(a);
  });
  it('returns undefined for unknown or blank', () => {
    expect(resolveSoundOption(library, 'nope')).toBeUndefined();
    expect(resolveSoundOption(library, '   ')).toBeUndefined();
  });
});

describe('autocompleteChoices', () => {
  const sounds = Array.from({ length: 40 }, (_, i) => makeSound(String(1000 + i), `sound-${i}`));
  const library = {
    list: () => sounds,
    search: (q: string, limit = 25) => sounds.filter((s) => s.name.includes(q)).slice(0, limit),
  };
  it('lists the first 25 for an empty query', () => {
    const choices = autocompleteChoices(library, '  ');
    expect(choices).toHaveLength(25);
    expect(choices[0]).toEqual({ name: 'sound-0', value: '1000' });
  });
  it('uses search for a query and returns id values', () => {
    expect(autocompleteChoices(library, 'sound-3')).toEqual([
      { name: 'sound-3', value: '1003' },
      ...[30, 31, 32, 33, 34, 35, 36, 37, 38, 39].map((i) => ({ name: `sound-${i}`, value: String(1000 + i) })),
    ]);
  });
  it('never exceeds 25 even if search ignores the limit', () => {
    expect(autocompleteChoices({ list: () => sounds, search: () => sounds }, 'x')).toHaveLength(25);
  });
});

describe('firstAudioAttachment', () => {
  const isAudio = (a: { contentType: string | null; filename: string }) =>
    (a.contentType?.startsWith('audio/') ?? false) || /\.(mp3|ogg|wav)$/i.test(a.filename);

  it('returns the first audio attachment, skipping non-audio', () => {
    const atts = [
      { name: 'pic.png', contentType: 'image/png' },
      { name: 'clip.mp3', contentType: null },
      { name: 'other.ogg', contentType: 'audio/ogg' },
    ];
    expect(firstAudioAttachment(atts, isAudio)?.name).toBe('clip.mp3');
  });
  it('returns undefined when none are audio', () => {
    expect(firstAudioAttachment([{ name: 'a.txt', contentType: 'text/plain' }], isAudio)).toBeUndefined();
    expect(firstAudioAttachment([], isAudio)).toBeUndefined();
  });
  it('passes name as filename to the predicate', () => {
    const seen: string[] = [];
    firstAudioAttachment([{ name: 'x.bin', contentType: null }], (a) => {
      seen.push(a.filename);
      return false;
    });
    expect(seen).toEqual(['x.bin']);
  });
});

describe('playbackFailureReason', () => {
  const cases: [PlaybackErrorCode, 'attachment' | 'url', string][] = [
    ['invalid-url', 'url', 'bad-url'],
    ['unsupported-source', 'attachment', 'bad-attachment'],
    ['unsupported-source', 'url', 'bad-url'],
    ['extraction-failed', 'url', 'extraction-failed'],
    ['empty-playlist', 'url', 'extraction-failed'],
    ['busy-elsewhere', 'url', 'busy-elsewhere'],
    ['join-failed', 'url', 'join-failed'],
    ['playback-failed', 'url', 'playback-failed'],
  ];
  it.each(cases)('%s (%s) -> %s', (code, type, reason) => {
    expect(playbackFailureReason(code, type)).toBe(reason);
  });
});

describe('describeLibraryError', () => {
  const codes: LibraryErrorCode[] = [
    'invalid-name',
    'name-taken',
    'not-found',
    'download-failed',
    'too-large',
    'upload-timeout',
    'not-audio',
    'invalid-url',
    'channel-unavailable',
    'not-ready',
  ];
  it.each(codes)('maps %s to a reason and non-empty message', (code) => {
    const r = describeLibraryError({ code, message: 'm' });
    expect(r.message.length).toBeGreaterThan(0);
    expect(typeof r.reason).toBe('string');
  });
  it('uses specific reasons', () => {
    expect(describeLibraryError({ code: 'name-taken', message: '' }).reason).toBe('name-taken');
    expect(describeLibraryError({ code: 'not-found', message: '' }).reason).toBe('sound-not-found');
    expect(describeLibraryError({ code: 'too-large', message: '' }).reason).toBe('bad-attachment');
    expect(describeLibraryError({ code: 'invalid-url', message: '' }).reason).toBe('bad-url');
  });
  it('passes through the user-facing invalid-name message', () => {
    expect(describeLibraryError({ code: 'invalid-name', message: 'Too long' }).message).toBe('Too long');
  });
});

describe('formatting', () => {
  const ok = (overrides: Partial<Extract<PlayResult, { ok: true }>>): Extract<PlayResult, { ok: true }> => ({
    ok: true,
    tracks: [track('Song')],
    startedNow: true,
    queuePosition: 0,
    source: summary,
    ...overrides,
  });

  it('formats now playing', () => {
    expect(formatPlaySuccess(ok({}), 'vc1', 150)).toBe('Now playing **Song** in <#vc1> at 150% volume.');
  });
  it('formats queued with position', () => {
    expect(formatPlaySuccess(ok({ startedNow: false, queuePosition: 3 }), 'vc1', 100)).toBe(
      'Queued **Song** at position 3 in <#vc1> (100% volume).',
    );
  });
  it('notes playlist size', () => {
    const tracks = [track('A'), track('B'), track('C')];
    expect(formatPlaySuccess(ok({ tracks }), 'vc', 100)).toContain('Playlist: 3 items (2 more queued after it).');
  });
  it('escapes markdown in titles', () => {
    expect(formatPlaySuccess(ok({ tracks: [track('a*b*_c_')] }), 'vc', 100)).toContain('**a\\*b\\*\\_c\\_**');
  });
  it('stays within the content limit for huge titles', () => {
    const text = formatPlaySuccess(ok({ tracks: [track('x'.repeat(5000))] }), 'vc', 100);
    expect(text.length).toBeLessThanOrEqual(MESSAGE_CONTENT_LIMIT);
  });
  it('formats stop/skip/volume', () => {
    expect(formatStopReply({ stopped: track('A'), cleared: 2 })).toBe('Stopped **A** and cleared 2 queued items.');
    expect(formatStopReply({ stopped: null, cleared: 1 })).toBe('Stopped playback and cleared 1 queued item.');
    expect(formatStopReply({ stopped: null, cleared: 0 })).toBe('Stopped playback (nothing had started playing yet).');
    expect(formatSkipReply({ skipped: track('A'), next: track('B') })).toBe('Skipped **A**. Now playing **B**.');
    expect(formatSkipReply({ skipped: track('A'), next: null })).toContain('Nothing left in the queue');
    expect(formatVolumeReply({ track: track('A'), from: 100, to: 50 })).toBe(
      'Volume for **A** changed from 100% to 50%.',
    );
  });
  it('busy-elsewhere message names the channel when known', () => {
    expect(busyElsewhereMessage('vc9')).toContain('<#vc9>');
    expect(busyElsewhereMessage(null)).not.toContain('<#');
  });
  it('truncate', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 4)).toHaveLength(4);
  });
});
