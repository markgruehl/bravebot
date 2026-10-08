import { describe, expect, it } from 'vitest';
import type { LibrarySoundMetadata } from '../types.js';
import { MESSAGE_CONTENT_LIMIT, metadataToSound, parseSoundMetadata, serializeSoundMetadata, soundToMetadata } from './format.js';

const fileMeta: LibrarySoundMetadata = {
  v: 1,
  kind: 'file',
  name: 'Airhorn',
  addedBy: '123456789012345678',
  addedAt: '2026-01-02T03:04:05.000Z',
  filename: 'airhorn.mp3',
};

const linkMeta: LibrarySoundMetadata = {
  v: 1,
  kind: 'link',
  name: 'Rickroll',
  addedBy: '123456789012345678',
  addedAt: '2026-01-02T03:04:05.000Z',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};

describe('serializeSoundMetadata / parseSoundMetadata', () => {
  it('round-trips file and link metadata', () => {
    expect(parseSoundMetadata(serializeSoundMetadata(fileMeta))).toEqual(fileMeta);
    expect(parseSoundMetadata(serializeSoundMetadata(linkMeta))).toEqual(linkMeta);
  });

  it('renders a human-readable header with a mention and Discord timestamp', () => {
    const content = serializeSoundMetadata(fileMeta);
    const [header] = content.split('\n');
    expect(header).toContain('**Airhorn**');
    expect(header).toContain('<@123456789012345678>');
    expect(header).toContain(`<t:${Date.parse(fileMeta.addedAt) / 1000}:f>`);
    expect(content).toContain('```json\n');
  });

  it('survives backticks and markdown in names, filenames and urls', () => {
    const tricky: LibrarySoundMetadata = {
      ...fileMeta,
      name: '```json {"x":1}``` *bold*',
      filename: 'a```b.mp3',
    };
    const content = serializeSoundMetadata(tricky);
    // Exactly one opening and one closing fence.
    expect(content.match(/```/g)).toHaveLength(2);
    expect(parseSoundMetadata(content)).toEqual(tricky);

    const trickyLink: LibrarySoundMetadata = { ...linkMeta, url: 'https://example.com/a?b=`c`' };
    expect(parseSoundMetadata(serializeSoundMetadata(trickyLink))).toEqual(trickyLink);
  });

  it('drops the header when content would exceed 2000 chars', () => {
    const long: LibrarySoundMetadata = { ...linkMeta, url: `https://example.com/${'a'.repeat(1800)}` };
    const content = serializeSoundMetadata(long);
    expect(content.startsWith('```json')).toBe(true);
    expect(content.length).toBeLessThanOrEqual(MESSAGE_CONTENT_LIMIT);
    expect(parseSoundMetadata(content)).toEqual(long);
  });

  it('tolerates CRLF, a missing language tag, extra text and bare JSON', () => {
    const json = serializeSoundMetadata(linkMeta).split('\n')[2]!;
    expect(parseSoundMetadata(`header\r\n\`\`\`json\r\n${json}\r\n\`\`\``)).toEqual(linkMeta);
    expect(parseSoundMetadata(`\`\`\`\n${json}\n\`\`\``)).toEqual(linkMeta);
    expect(parseSoundMetadata(`some note\n\`\`\`js\nnope\n\`\`\`\n\`\`\`json\n${json}\n\`\`\`\ntrailing`)).toEqual(linkMeta);
    expect(parseSoundMetadata(`legacy ${json}`)).toEqual(linkMeta);
  });

  it('ignores unknown extra fields and normalizes the name and date', () => {
    const json = JSON.stringify({
      bravebot: 'sound',
      v: 1,
      kind: 'file',
      name: '  Air   horn ',
      addedBy: '123456789012345678',
      addedAt: '2026-01-02T03:04:05Z',
      filename: 'x.ogg',
      extra: true,
    });
    expect(parseSoundMetadata('```json\n' + json + '\n```')).toEqual({
      v: 1,
      kind: 'file',
      name: 'Air horn',
      addedBy: '123456789012345678',
      addedAt: '2026-01-02T03:04:05.000Z',
      filename: 'x.ogg',
    });
  });

  it('returns null (never throws) for malformed or foreign content', () => {
    const wrap = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';
    const base = { bravebot: 'sound', v: 1, kind: 'link', name: 'x', addedBy: '123456789012345678', addedAt: '2026-01-01T00:00:00Z', url: 'https://a.b' };
    expect(parseSoundMetadata(wrap(base))).not.toBeNull();
    const cases: string[] = [
      '',
      'hello world',
      '```json\n{not json\n```',
      '```json\n[]\n```',
      '```json\nnull\n```',
      wrap({ ...base, bravebot: undefined }),
      wrap({ ...base, v: 2 }),
      wrap({ ...base, kind: 'video' }),
      wrap({ ...base, name: '' }),
      wrap({ ...base, name: 'x'.repeat(40) }),
      wrap({ ...base, addedBy: 'not-a-snowflake' }),
      wrap({ ...base, addedAt: 'yesterday' }),
      wrap({ ...base, url: 'ftp://a.b' }),
      wrap({ ...base, url: 42 }),
      wrap({ ...base, kind: 'file', url: undefined }),
      wrap({ ...base, kind: 'file', filename: '   ' }),
    ];
    for (const content of cases) expect(parseSoundMetadata(content), content).toBeNull();
    expect(parseSoundMetadata(undefined as unknown as string)).toBeNull();
  });
});

describe('metadataToSound / soundToMetadata', () => {
  it('converts both ways', () => {
    const sound = metadataToSound(fileMeta, { id: '999', guildId: '111' });
    expect(sound).toEqual({
      id: '999',
      guildId: '111',
      kind: 'file',
      name: 'Airhorn',
      addedBy: fileMeta.addedBy,
      addedAt: new Date(fileMeta.addedAt),
      filename: 'airhorn.mp3',
    });
    expect(soundToMetadata(sound)).toEqual(fileMeta);

    const link = metadataToSound(linkMeta, { id: '1', guildId: '2' });
    expect(link.kind).toBe('link');
    expect(soundToMetadata(link)).toEqual(linkMeta);
  });
});
