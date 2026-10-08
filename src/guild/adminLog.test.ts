import type { TextChannel } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AdminLogEvent, FailureReason, LibrarySound, SourceSummary, TrackInfo, UserRef } from '../types.js';
import { createAdminLog, formatAdminLogEvent } from './adminLog.js';

const at = new Date('2026-03-04T05:06:07.000Z');
const ts = `<t:${Math.floor(at.getTime() / 1000)}:f>`;
const user: UserRef = { id: '200000000000000002', displayName: 'Mark_*the*_Shark' };
const VC = '600000000000000006';

const upload: SourceSummary = {
  type: 'attachment',
  label: 'honk.mp3',
  url: 'https://cdn.discordapp.com/attachments/1/2/honk.mp3?ex=1',
  libraryName: null,
};
const url: SourceSummary = { type: 'url', label: 'https://youtu.be/abc', url: 'https://youtu.be/abc', libraryName: null };
const library: SourceSummary = { type: 'library', label: 'Airhorn', url: null, libraryName: 'Airhorn' };

const track = (over: Partial<TrackInfo> = {}): TrackInfo => ({
  id: 't1',
  title: 'Never Gonna Give You Up',
  source: url,
  requester: user,
  volume: 100,
  requestedAt: at,
  playlistIndex: 0,
  playlistSize: 1,
  ...over,
});

const fileSound: LibrarySound = {
  id: '700000000000000007',
  guildId: '400000000000000004',
  kind: 'file',
  name: 'Airhorn',
  addedBy: '300000000000000003',
  addedAt: at,
  filename: 'airhorn.mp3',
};
const linkSound: LibrarySound = {
  id: '700000000000000008',
  guildId: '400000000000000004',
  kind: 'link',
  name: 'Rick',
  addedBy: '300000000000000003',
  addedAt: at,
  url: 'https://youtu.be/dQw4w9WgXcQ',
};

describe('formatAdminLogEvent', () => {
  it('formats a play from an upload as filename + link with a Discord timestamp', () => {
    const out = formatAdminLogEvent({
      type: 'play',
      at,
      user,
      voiceChannelId: VC,
      source: upload,
      mode: 'interrupt',
      volume: 150,
      itemCount: 1,
      via: 'slash',
    });
    expect(out.startsWith(ts)).toBe(true);
    expect(out).toContain('<@200000000000000002>');
    expect(out).toContain('Mark\\_\\*the\\*\\_Shark'); // markdown escaped
    expect(out).toContain(`<#${VC}>`);
    expect(out).toContain('honk.mp3');
    expect(out).toContain('<https://cdn.discordapp.com/attachments/1/2/honk.mp3?ex=1>');
    expect(out).toContain('interrupt');
    expect(out).toContain('150%');
    expect(out).toContain('/play');
    expect(out).not.toContain('playlist');
  });

  it('notes playlist item counts, queue mode and entry point', () => {
    const out = formatAdminLogEvent({
      type: 'play',
      at,
      user,
      voiceChannelId: VC,
      source: url,
      mode: 'queue',
      volume: 100,
      itemCount: 12,
      via: 'panel',
    });
    expect(out).toContain('playlist of 12 items');
    expect(out).toContain('queue');
    expect(out).toContain('<https://youtu.be/abc>');
    expect(out).toContain('panel');
    const lib = formatAdminLogEvent({
      type: 'play',
      at,
      user,
      voiceChannelId: VC,
      source: library,
      mode: 'interrupt',
      volume: 100,
      itemCount: 1,
      via: 'context-menu',
    });
    expect(lib).toContain('library sound **Airhorn**');
    expect(lib).toContain('message menu');
  });

  it('formats stop / skip / volume', () => {
    const stop = formatAdminLogEvent({ type: 'stop', at, user, voiceChannelId: VC, stopped: track(), cleared: 3 });
    expect(stop).toContain('Stop');
    expect(stop).toContain('Never Gonna Give You Up');
    expect(stop).toContain('cleared 3 queued items');
    expect(formatAdminLogEvent({ type: 'stop', at, user, voiceChannelId: VC, stopped: null, cleared: 1 })).toContain(
      'cleared 1 queued item',
    );

    const skip = formatAdminLogEvent({
      type: 'skip',
      at,
      user,
      voiceChannelId: VC,
      skipped: track({ playlistIndex: 1, playlistSize: 5 }),
      next: null,
    });
    expect(skip).toContain('Skip');
    expect(skip).toContain('[playlist 2/5]');
    expect(skip).toContain('playback ended');
    const skipNext = formatAdminLogEvent({
      type: 'skip',
      at,
      user,
      voiceChannelId: VC,
      skipped: track(),
      next: track({ title: 'Second' }),
    });
    expect(skipNext).toContain('next: **Second**');

    const vol = formatAdminLogEvent({ type: 'volume', at, user, voiceChannelId: VC, track: track(), from: 100, to: 40 });
    expect(vol).toContain('100% → 40%');
    expect(vol).toContain('Never Gonna Give You Up');
  });

  it('formats library changes', () => {
    const add = formatAdminLogEvent({ type: 'library-add', at, user, sound: fileSound });
    expect(add).toContain('Sound added');
    expect(add).toContain('**Airhorn**');
    expect(add).toContain('airhorn.mp3');
    expect(add).toContain('<@300000000000000003>');
    const rename = formatAdminLogEvent({ type: 'library-rename', at, user, sound: linkSound, oldName: 'rickroll' });
    expect(rename).toContain('**rickroll** → **Rick**');
    expect(rename).toContain('<https://youtu.be/dQw4w9WgXcQ>');
    expect(formatAdminLogEvent({ type: 'library-delete', at, user, sound: fileSound })).toContain('Sound deleted');
  });

  it('formats every failure reason', () => {
    const reasons: FailureReason[] = [
      'not-in-voice',
      'missing-permission',
      'not-in-bot-channel',
      'nothing-playing',
      'busy-elsewhere',
      'bad-url',
      'bad-attachment',
      'extraction-failed',
      'playback-failed',
      'join-failed',
      'sound-not-found',
      'invalid-name',
      'name-taken',
      'library-error',
      'not-ready',
      'internal-error',
    ];
    for (const reason of reasons) {
      const out = formatAdminLogEvent({
        type: 'failure',
        at,
        user,
        reason,
        action: '/play',
        voiceChannelId: VC,
        source: upload,
        detail: 'yt-dlp exited with code 1',
      });
      expect(out).toContain('Failed:');
      expect(out).not.toContain('undefined');
      expect(out).toContain('/play');
    }
    const system = formatAdminLogEvent({
      type: 'failure',
      at,
      user: null,
      reason: 'playback-failed',
      action: 'track playback',
      voiceChannelId: null,
      source: null,
      detail: null,
    });
    expect(system).toContain('system');
    expect(system).not.toContain('detail');
  });

  it('never exceeds 2000 characters and keeps output single-line', () => {
    const huge = 'x'.repeat(5000);
    const events: AdminLogEvent[] = [
      {
        type: 'failure',
        at,
        user: { id: '1', displayName: huge },
        reason: 'internal-error',
        action: huge,
        voiceChannelId: VC,
        source: { type: 'url', label: huge, url: `https://a.b/${huge}`, libraryName: null },
        detail: `line1\nline2 ${huge}`,
      },
      {
        type: 'skip',
        at,
        user,
        voiceChannelId: VC,
        skipped: track({ title: huge, source: { type: 'url', label: huge, url: `https://a.b/${huge}`, libraryName: null } }),
        next: track({ title: huge, source: { type: 'url', label: huge, url: `https://a.b/${huge}`, libraryName: null } }),
      },
    ];
    for (const e of events) {
      const out = formatAdminLogEvent(e);
      expect(out.length).toBeLessThanOrEqual(2000);
      expect(out).not.toContain('\n');
    }
  });

  it('wraps urls so they are not embedded and cannot break out of <>', () => {
    const out = formatAdminLogEvent({
      type: 'play',
      at,
      user,
      voiceChannelId: VC,
      source: { type: 'url', label: 'x', url: 'https://a.b/x>y z', libraryName: null },
      mode: 'interrupt',
      volume: 100,
      itemCount: 1,
      via: 'slash',
    });
    expect(out).toContain('<https://a.b/x%3Ey%20z>');
  });
});

describe('createAdminLog', () => {
  const event: AdminLogEvent = { type: 'library-delete', at, user, sound: fileSound };

  it('sends to the log channel without pings or embeds', async () => {
    const send = vi.fn(async () => ({}));
    const log = createAdminLog(() => ({ send }) as unknown as TextChannel);
    await log.log('g', event);
    expect(send).toHaveBeenCalledWith({
      content: formatAdminLogEvent(event),
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  });

  it('never throws when the channel is missing or sending fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createAdminLog(() => undefined).log('g', event)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const send = vi.fn(async () => {
      throw new Error('Missing Access');
    });
    await expect(
      createAdminLog(() => ({ send }) as unknown as TextChannel).log('g', event),
    ).resolves.toBeUndefined();
    await expect(
      createAdminLog(() => {
        throw new Error('lookup failed');
      }).log('g', event),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
