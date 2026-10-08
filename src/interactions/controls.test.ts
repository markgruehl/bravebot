import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../types.js';
import { flush, makeCtx, makeInteraction } from './__tests__/fakes.js';
import { handleSkipCommand, handleStopCommand, handleVolumeCommand } from './controls.js';

const track = (title: string): TrackInfo => ({
  id: title,
  title,
  source: { type: 'url', label: 'x', url: 'x', libraryName: null },
  requester: { id: 'u9', displayName: 'Someone' },
  volume: 100,
  requestedAt: new Date(0),
  playlistIndex: 0,
  playlistSize: 1,
});

describe('playback controls', () => {
  it('deny with nothing-playing when the bot is not in voice', async () => {
    const ctx = makeCtx({ botChannelId: null });
    const i = makeInteraction();
    await handleStopCommand(ctx, i as never);
    await flush();
    expect(i.replies[0]?.content).toBe('Nothing is playing right now.');
    expect(ctx.logged[0]).toMatchObject({ type: 'failure', reason: 'nothing-playing', action: '/stop' });
    expect(ctx.playersMock.stop).not.toHaveBeenCalled();
  });

  it('deny users who are not in the bot channel', async () => {
    const ctx = makeCtx({ botChannelId: 'vc-bot' });
    for (const vc of ['vc-1', null]) {
      const i = makeInteraction({ voiceChannelId: vc });
      await handleSkipCommand(ctx, i as never);
      expect(i.replies[0]?.content).toContain('<#vc-bot>');
    }
    await flush();
    expect(ctx.logged.map((e) => e.type === 'failure' && e.reason)).toEqual(['not-in-bot-channel', 'not-in-bot-channel']);
    expect(ctx.playersMock.skip).not.toHaveBeenCalled();
  });

  it('/stop works for anyone in the bot channel (no permissions needed) and logs', async () => {
    const ctx = makeCtx({ botChannelId: 'vc-1' });
    ctx.playersMock.stop.mockReturnValue({ stopped: track('A'), cleared: 3 });
    const i = makeInteraction({ guildPerms: [], channelPerms: [] });
    await handleStopCommand(ctx, i as never);
    await flush();
    expect(i.replies[0]?.content).toBe('Stopped **A** and cleared 3 queued items.');
    expect(ctx.logged[0]).toMatchObject({ type: 'stop', voiceChannelId: 'vc-1', cleared: 3 });
  });

  it('/skip reports the next track and logs', async () => {
    const ctx = makeCtx({ botChannelId: 'vc-1' });
    ctx.playersMock.skip.mockReturnValue({ skipped: track('A'), next: track('B') });
    const i = makeInteraction();
    await handleSkipCommand(ctx, i as never);
    await flush();
    expect(i.replies[0]?.content).toBe('Skipped **A**. Now playing **B**.');
    expect(ctx.logged[0]).toMatchObject({ type: 'skip', skipped: { title: 'A' }, next: { title: 'B' } });
  });

  it('/volume clamps the level, changes the current track and logs', async () => {
    const ctx = makeCtx({ botChannelId: 'vc-1' });
    ctx.playersMock.setVolume.mockReturnValue({ track: track('A'), from: 100, to: 200 });
    const i = makeInteraction({ options: { level: 500 } });
    await handleVolumeCommand(ctx, i as never);
    await flush();
    expect(ctx.playersMock.setVolume).toHaveBeenCalledWith('guild-1', 200);
    expect(ctx.logged[0]).toMatchObject({ type: 'volume', from: 100, to: 200 });
  });

  it('/volume with nothing current denies', async () => {
    const ctx = makeCtx({ botChannelId: 'vc-1' });
    ctx.playersMock.setVolume.mockReturnValue(null);
    const i = makeInteraction({ options: { level: 50 } });
    await handleVolumeCommand(ctx, i as never);
    await flush();
    expect(ctx.logged[0]).toMatchObject({ type: 'failure', reason: 'nothing-playing', action: '/volume' });
  });

  it('works even when the guild library is not ready', async () => {
    const ctx = makeCtx({ ready: false, botChannelId: 'vc-1' });
    ctx.playersMock.stop.mockReturnValue({ stopped: null, cleared: 0 });
    const i = makeInteraction();
    await handleStopCommand(ctx, i as never);
    expect(ctx.playersMock.stop).toHaveBeenCalled();
  });

  it('/stop cancels a play still loading into the caller\'s channel before the bot joined', async () => {
    const ctx = makeCtx({ botChannelId: null });
    ctx.playersMock.hasPendingPlay.mockImplementation((_g: string, ch: string) => ch === 'vc-1');
    ctx.playersMock.stop.mockReturnValue(null);
    const i = makeInteraction({ voiceChannelId: 'vc-1' });
    await handleStopCommand(ctx, i as never);
    await flush();
    expect(ctx.playersMock.stop).toHaveBeenCalledWith('guild-1');
    expect(i.replies[0]?.content).toBe('Cancelled the sound that was still loading.');
    expect(ctx.logged[0]).toMatchObject({ type: 'stop', voiceChannelId: 'vc-1', stopped: null, cleared: 0 });
  });

  it('/stop does not cancel a loading play targeting another channel', async () => {
    const ctx = makeCtx({ botChannelId: null });
    ctx.playersMock.hasPendingPlay.mockImplementation((_g: string, ch: string) => ch === 'vc-other');
    for (const vc of ['vc-1', null]) {
      const i = makeInteraction({ voiceChannelId: vc });
      await handleStopCommand(ctx, i as never);
      expect(i.replies[0]?.content).toBe('Nothing is playing right now.');
    }
    expect(ctx.playersMock.stop).not.toHaveBeenCalled();
  });
});
