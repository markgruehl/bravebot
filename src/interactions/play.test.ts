import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSource, PlayResult, SourceSummary } from '../types.js';
import { GUILD_ID, flush, makeCtx, makeInteraction, makeLibrary, makeSound } from './__tests__/fakes.js';

vi.mock('../playback/sources.js', () => ({
  summarizeSource: (s: AudioSource): SourceSummary => ({
    type: s.type,
    label: s.type === 'library' ? s.sound.name : s.type === 'attachment' ? s.filename : s.url,
    url: s.type === 'library' ? null : s.url,
    libraryName: s.type === 'library' ? s.sound.name : null,
  }),
  isHttpUrl: (v: string) => /^https?:\/\//.test(v),
  isAudioAttachment: (a: { contentType: string | null; filename: string }) =>
    (a.contentType?.startsWith('audio/') ?? false) || a.filename.endsWith('.mp3'),
}));

const { executePlay, handlePlayCommand } = await import('./play.js');

const USE = [PermissionFlagsBits.UseSoundboard];
const urlSource: AudioSource = { type: 'url', url: 'https://example.com/a.mp3' };
const params = { source: urlSource, mode: 'interrupt' as const, volume: 100, via: 'slash' as const };

const okResult = (startedNow = true): PlayResult => ({
  ok: true,
  tracks: [
    {
      id: 't1',
      title: 'Track',
      source: { type: 'url', label: 'x', url: 'x', libraryName: null },
      requester: { id: 'u1', displayName: 'User One' },
      volume: 100,
      requestedAt: new Date(0),
      playlistIndex: 0,
      playlistSize: 1,
    },
  ],
  startedNow,
  queuePosition: startedNow ? 0 : 2,
  source: { type: 'url', label: 'x', url: 'x', libraryName: null },
});

describe('executePlay pipeline', () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('denies when the guild is not ready', async () => {
    ctx = makeCtx({ ready: false });
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(ctx.logged[0]).toMatchObject({ type: 'failure', reason: 'not-ready', action: '/play' });
    expect(ctx.playersMock.play).not.toHaveBeenCalled();
  });

  it('kicks off a guild setup retry when the guild is not ready', async () => {
    const ensureGuild = vi.fn();
    const notReady = { ...makeCtx({ ready: false }), ensureGuild };
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(notReady, i as never, params);
    expect(ensureGuild).toHaveBeenCalledWith(i.guildId);
  });

  it('denies when the user is not in a voice channel', async () => {
    const i = makeInteraction({ voiceChannelId: null, channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.replies[0]?.content).toMatch(/voice channel/);
    expect(ctx.logged[0]).toMatchObject({ reason: 'not-in-voice', voiceChannelId: null });
    expect(i.deferReply).not.toHaveBeenCalled();
  });

  it('rejects Stage channels (the bot would be suppressed and silent)', async () => {
    const i = makeInteraction({ channelPerms: USE, voiceChannelType: ChannelType.GuildStageVoice });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.replies[0]?.content).toMatch(/Stage channels/);
    expect(i.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(ctx.logged[0]).toMatchObject({ type: 'failure', reason: 'unsupported-channel', voiceChannelId: 'vc-1' });
    expect(ctx.playersMock.play).not.toHaveBeenCalled();
  });

  it('logs operator-only failure detail without showing it to the user', async () => {
    ctx.playersMock.play.mockResolvedValue({
      ok: false,
      code: 'extraction-failed',
      message: 'Could not read that link.',
      detail: 'HTTP Error 404: Not Found',
      source: { type: 'url', label: 'x', url: 'x', libraryName: null },
    });
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.replies.at(-1)?.content).toBe('Could not read that link.');
    expect(ctx.logged[0]).toMatchObject({
      reason: 'extraction-failed',
      detail: 'extraction-failed: Could not read that link. (HTTP Error 404: Not Found)',
    });
  });

  it('denies without Use Soundboard in that channel', async () => {
    const i = makeInteraction({ channelPerms: [PermissionFlagsBits.Connect] });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.member.permissionsIn).toHaveBeenCalledWith({ id: 'vc-1' });
    expect(ctx.logged[0]).toMatchObject({ reason: 'missing-permission', voiceChannelId: 'vc-1', detail: 'Use Soundboard' });
    expect(ctx.playersMock.play).not.toHaveBeenCalled();
  });

  it('denies when the bot is busy in another channel, before deferring', async () => {
    ctx = makeCtx({ botChannelId: 'vc-other' });
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(i.replies[0]?.content).toContain('<#vc-other>');
    expect(ctx.logged[0]).toMatchObject({ reason: 'busy-elsewhere' });
  });

  it('allows playing when the bot is already in the same channel', async () => {
    ctx = makeCtx({ botChannelId: 'vc-1' });
    ctx.playersMock.play.mockResolvedValue(okResult(false));
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, { ...params, mode: 'queue' });
    await flush();
    expect(i.replies[0]?.content).toContain('Queued **Track** at position 2');
  });

  it('defers ephemerally, plays into the requester channel and logs the play', async () => {
    ctx.playersMock.play.mockResolvedValue(okResult());
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, { ...params, volume: 250, mode: 'queue' });
    await flush();
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(ctx.playersMock.play).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        voiceChannelId: 'vc-1',
        requester: { id: 'u1', displayName: 'User One' },
        mode: 'queue',
        volume: 200,
        via: 'slash',
      }),
    );
    expect(i.replies).toEqual([{ kind: 'editReply', content: expect.stringContaining('Now playing **Track**') }]);
    expect(ctx.logged[0]).toMatchObject({ type: 'play', voiceChannelId: 'vc-1', mode: 'queue', volume: 200, itemCount: 1 });
  });

  it('reports player failures to the user and the admin log', async () => {
    ctx.playersMock.play.mockResolvedValue({
      ok: false,
      code: 'extraction-failed',
      message: 'Could not extract audio.',
      source: { type: 'url', label: 'x', url: 'x', libraryName: null },
    } satisfies PlayResult);
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(i.replies[0]).toEqual({ kind: 'editReply', content: 'Could not extract audio.' });
    expect(ctx.logged[0]).toMatchObject({ type: 'failure', reason: 'extraction-failed', voiceChannelId: 'vc-1' });
  });

  it('handles an unexpected player throw', async () => {
    ctx.playersMock.play.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const i = makeInteraction({ channelPerms: USE });
    await executePlay(ctx, i as never, params);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'internal-error', detail: 'boom' });
    expect(i.replies[0]?.kind).toBe('editReply');
  });

  it('labels the action by entry point', async () => {
    const i = makeInteraction({ voiceChannelId: null });
    await executePlay(ctx, i as never, { ...params, via: 'context-menu' });
    await flush();
    expect(ctx.logged[0]).toMatchObject({ action: 'context menu' });
  });
});

describe('handlePlayCommand', () => {
  it('rejects when no source is given (no player call)', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ channelPerms: USE, options: {} });
    await handlePlayCommand(ctx, i as never);
    expect(i.replies[0]?.content).toContain('Provide one of');
    expect(ctx.playersMock.play).not.toHaveBeenCalled();
  });

  it('rejects when two sources are given', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ channelPerms: USE, options: { url: 'https://a.test', sound: 'x' } });
    await handlePlayCommand(ctx, i as never);
    expect(i.replies[0]?.content).toContain('Provide only one of');
  });

  it('rejects a non-http url and logs bad-url', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ channelPerms: USE, options: { url: 'ftp://nope' } });
    await handlePlayCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'bad-url' });
  });

  it('rejects a non-audio attachment and logs bad-attachment', async () => {
    const ctx = makeCtx();
    const att = { url: 'https://cdn/x.png', name: 'x.png', contentType: 'image/png', size: 10 };
    const i = makeInteraction({ channelPerms: USE, options: { attachment: att } });
    await handlePlayCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'bad-attachment' });
  });

  it('rejects an unknown library sound', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ channelPerms: USE, options: { sound: 'missing' } });
    await handlePlayCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ reason: 'sound-not-found' });
  });

  it('plays a library sound by autocomplete id with mode/volume options', async () => {
    const sound = makeSound('555', 'Airhorn');
    const ctx = makeCtx({ library: makeLibrary([sound]) });
    ctx.playersMock.play.mockResolvedValue(okResult());
    const i = makeInteraction({ channelPerms: USE, options: { sound: '555', mode: 'queue', volume: 30 } });
    await handlePlayCommand(ctx, i as never);
    expect(ctx.playersMock.play).toHaveBeenCalledWith(
      expect.objectContaining({ source: { type: 'library', sound }, mode: 'queue', volume: 30 }),
    );
  });

  it('plays an audio attachment with default mode and volume', async () => {
    const ctx = makeCtx();
    ctx.playersMock.play.mockResolvedValue(okResult());
    const att = { url: 'https://cdn/x.mp3', name: 'x.mp3', contentType: 'audio/mpeg', size: 10 };
    const i = makeInteraction({ channelPerms: USE, options: { attachment: att } });
    await handlePlayCommand(ctx, i as never);
    expect(ctx.playersMock.play).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { type: 'attachment', url: att.url, filename: 'x.mp3', contentType: 'audio/mpeg', size: 10 },
        mode: 'interrupt',
        volume: 100,
      }),
    );
  });
});
