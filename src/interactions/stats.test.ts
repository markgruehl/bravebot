import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { StatsError } from '../errors.js';
import { encodeStatsCustomId } from '../stats/customId.js';
import { buildReport } from '../stats/pipeline.js';
import { renderStats } from '../stats/render.js';
import type { StatsMessage, StatsReport, StatsView } from '../stats/types.js';
import { EMPTY_HISTORY, flush, makeButtonInteraction, makeCtx, makeInteraction } from './__tests__/fakes.js';
import {
  STATS_MESSAGES,
  channelIdsOf,
  clampDays,
  handleStatsButton,
  handleStatsCommand,
  liveCheckpointOf,
  namesOf,
  viewFromCommand,
} from './stats.js';
import type * as PipelineModule from '../stats/pipeline.js';

vi.mock('../stats/render.js', () => ({ renderStats: vi.fn() }));
vi.mock('../stats/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineModule>();
  return { ...actual, buildReport: vi.fn() };
});

const REPORT = {
  scope: { kind: 'server' },
  people: [{ userId: 'u2', topChannel: { channelId: 'vc-top', ms: 1 } }],
  channels: [{ channelId: 'vc-1' }],
  records: { longestCall: { channelId: 'vc-long' }, biggestParty: null },
} as unknown as StatsReport;

const MESSAGE: StatsMessage = { embeds: [{ title: 'Stats' }], components: [] };

function setup() {
  vi.mocked(buildReport).mockReturnValue(REPORT);
  vi.mocked(renderStats).mockReturnValue(MESSAGE);
}

const command = (o: Parameters<typeof makeInteraction>[0] = {}) =>
  makeInteraction({
    commandName: 'stats',
    voiceStates: [
      { id: 'u1', channelId: 'vc-1', member: { user: { bot: false } } },
      { id: 'bot-self', channelId: 'vc-1', member: { user: { bot: true } } },
      { id: 'u3', channelId: null, member: { user: { bot: false } } },
    ],
    channels: { 'vc-1': 'General', 'vc-top': 'Gaming', 'text-1': 'chat' },
    ...o,
  });

describe('pure helpers', () => {
  it('clampDays defaults to 30 and clamps to 1-365', () => {
    expect(clampDays(null)).toBe(30);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(7.9)).toBe(7);
    expect(clampDays(9999)).toBe(365);
  });

  it('viewFromCommand builds the first page of each subcommand', () => {
    const args = { days: 14, userId: 'u5', channelId: 'vc-9' };
    expect(viewFromCommand('server', args)).toEqual({ kind: 'server', page: 'overview', days: 14 });
    expect(viewFromCommand('user', args)).toEqual({ kind: 'user', userId: 'u5', days: 14 });
    expect(viewFromCommand('channel', args)).toEqual({ kind: 'channel', channelId: 'vc-9', page: 'overview', days: 14 });
    expect(viewFromCommand('channel', { ...args, channelId: null })).toBeNull();
    expect(viewFromCommand('nope', args)).toBeNull();
  });

  it('liveCheckpointOf keeps humans that are in a channel', () => {
    const cp = liveCheckpointOf(
      [
        { id: 'a', channelId: 'vc-1', member: { user: { bot: false } } },
        { id: 'b', channelId: 'vc-2', member: null },
        { id: 'bot', channelId: 'vc-1', member: { user: { bot: true } } },
        { id: 'c', channelId: null, member: { user: { bot: false } } },
      ],
      42,
    );
    expect(cp.at).toBe(42);
    expect([...cp.present]).toEqual([
      ['a', 'vc-1'],
      ['b', 'vc-2'],
    ]);
  });

  it('namesOf skips bots', () => {
    const names = namesOf(new Map([['a', { name: 'Al', bot: false }], ['b', { name: 'Robo', bot: true }]]));
    expect([...names]).toEqual([['a', 'Al']]);
  });

  it('channelIdsOf collects every channel a report mentions', () => {
    expect([...channelIdsOf(REPORT)].sort()).toEqual(['vc-1', 'vc-long', 'vc-top']);
    const scoped = { ...REPORT, scope: { kind: 'channel', channelId: 'vc-scope' } } as StatsReport;
    expect(channelIdsOf(scoped)).toContain('vc-scope');
  });
});

describe('handleStatsCommand', () => {
  it('defers ephemerally before loading, then edits in the rendered view without pings', async () => {
    setup();
    const ctx = makeCtx();
    const i = command({ subcommand: 'server', options: { days: 7 } });
    ctx.statsMock.load.mockImplementation(async () => {
      expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      return EMPTY_HISTORY;
    });
    await handleStatsCommand(ctx, i as never);
    await flush();

    const view: StatsView = { kind: 'server', page: 'overview', days: 7 };
    const input = vi.mocked(buildReport).mock.calls[0]![0];
    expect(input.view).toEqual(view);
    expect(input.history).toBe(EMPTY_HISTORY);
    expect([...input.live.present]).toEqual([['u1', 'vc-1']]);
    expect(input.now).toBe(input.live.at);

    const [renderedView, report, rctx] = vi.mocked(renderStats).mock.calls[0]!;
    expect(renderedView).toEqual(view);
    expect(report).toBe(REPORT);
    expect(rctx.shareable).toBe(true);
    expect(rctx.names.get('u1')).toBe('Name u1');
    expect([...rctx.channelNames]).toEqual([
      ['vc-1', 'General'],
      ['vc-top', 'Gaming'],
    ]);

    expect(i.editReply).toHaveBeenCalledWith({ embeds: MESSAGE.embeds, components: [], allowedMentions: { parse: [] } });
    // Views are not written to the admin log.
    expect(ctx.logged).toEqual([]);
  });

  it('defaults days to 30 and the user card to the caller', async () => {
    setup();
    const ctx = makeCtx();
    const i = command({ subcommand: 'user', userId: 'u1' });
    await handleStatsCommand(ctx, i as never);
    expect(vi.mocked(buildReport).mock.calls[0]![0].view).toEqual({ kind: 'user', userId: 'u1', days: 30 });
    // The card's subject is always resolved, even with no history.
    expect([...ctx.statsMock.people.mock.calls[0]![1]]).toContain('u1');
  });

  it('uses the chosen user and channel', async () => {
    setup();
    const ctx = makeCtx();
    await handleStatsCommand(ctx, command({ subcommand: 'user', options: { user: { id: 'u9', bot: false } } }) as never);
    await handleStatsCommand(ctx, command({ subcommand: 'channel', options: { channel: { id: 'vc-7' }, days: 90 } }) as never);
    expect(vi.mocked(renderStats).mock.calls.map((c) => c[0])).toEqual([
      { kind: 'user', userId: 'u9', days: 30 },
      { kind: 'channel', channelId: 'vc-7', page: 'overview', days: 90 },
    ]);
  });

  it('rejects a bot as the user card target', async () => {
    setup();
    const ctx = makeCtx();
    const i = command({ subcommand: 'user', options: { user: { id: 'b1', bot: true } } });
    await handleStatsCommand(ctx, i as never);
    expect(i.replies).toEqual([{ kind: 'editReply', content: STATS_MESSAGES.botTarget }]);
    expect(ctx.statsMock.load).not.toHaveBeenCalled();
  });

  it('denies with stats-unavailable on a StatsError and logs it', async () => {
    setup();
    const ctx = makeCtx();
    ctx.statsMock.load.mockRejectedValue(new StatsError('no-system-channel', 'This server has no system channel.'));
    const i = command({ subcommand: 'server' });
    await handleStatsCommand(ctx, i as never);
    await flush();
    expect(i.replies).toEqual([{ kind: 'editReply', content: 'This server has no system channel.' }]);
    expect(ctx.logged).toEqual([
      expect.objectContaining({
        type: 'failure',
        reason: 'stats-unavailable',
        action: '/stats server',
        user: { id: 'u1', displayName: 'User One' },
        voiceChannelId: 'vc-1',
        detail: 'no-system-channel',
      }),
    ]);
  });

  it('lets unexpected errors reach the router', async () => {
    setup();
    const ctx = makeCtx();
    ctx.statsMock.load.mockRejectedValue(new Error('boom'));
    await expect(handleStatsCommand(ctx, command({ subcommand: 'server' }) as never)).rejects.toThrow('boom');
  });
});

describe('handleStatsButton', () => {
  const view: StatsView = { kind: 'server', page: 'people', days: 30 };

  it('pages an ephemeral message in place and keeps it shareable', async () => {
    setup();
    const ctx = makeCtx();
    const i = makeButtonInteraction({ customId: encodeStatsCustomId('page', view), ephemeralMessage: true });
    await handleStatsButton(ctx, i as never);
    expect(i.deferUpdate).toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(vi.mocked(renderStats).mock.calls[0]![0]).toEqual(view);
    expect(vi.mocked(renderStats).mock.calls[0]![2].shareable).toBe(true);
    expect(i.editReply).toHaveBeenCalledWith({ embeds: MESSAGE.embeds, components: [], allowedMentions: { parse: [] } });
  });

  it('pages a public post without a Share button', async () => {
    setup();
    const i = makeButtonInteraction({ customId: encodeStatsCustomId('page', view), ephemeralMessage: false });
    await handleStatsButton(makeCtx(), i as never);
    expect(vi.mocked(renderStats).mock.calls[0]![2].shareable).toBe(false);
  });

  it('shares the view as a new public message', async () => {
    setup();
    const ctx = makeCtx();
    const userView: StatsView = { kind: 'user', userId: '123', days: 7 };
    const i = makeButtonInteraction({ customId: encodeStatsCustomId('share', userView), ephemeralMessage: true });
    await handleStatsButton(ctx, i as never);
    expect(i.deferUpdate).toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(vi.mocked(renderStats).mock.calls[0]![0]).toEqual(userView);
    expect(vi.mocked(renderStats).mock.calls[0]![2].shareable).toBe(false);
    // Public: a follow-up without the Ephemeral flag; the private message is left untouched.
    expect(i.followUp).toHaveBeenCalledWith({ embeds: MESSAGE.embeds, components: [], allowedMentions: { parse: [] } });
    expect(i.editReply).not.toHaveBeenCalled();
  });

  it('answers an invalid custom id privately', async () => {
    const ctx = makeCtx();
    const i = makeButtonInteraction({ customId: 'st:page:server:bogus:30' });
    await handleStatsButton(ctx, i as never);
    expect(i.replies).toEqual([{ kind: 'reply', content: STATS_MESSAGES.staleButton, flags: MessageFlags.Ephemeral }]);
    expect(ctx.statsMock.load).not.toHaveBeenCalled();
  });

  it('reports a StatsError privately and logs it, posting nothing public on share', async () => {
    setup();
    const ctx = makeCtx();
    ctx.statsMock.load.mockRejectedValue(new StatsError('missing-access', 'I cannot read the system channel.'));
    const share = makeButtonInteraction({ customId: encodeStatsCustomId('share', view) });
    await handleStatsButton(ctx, share as never);
    const page = makeButtonInteraction({ customId: encodeStatsCustomId('page', view) });
    await handleStatsButton(ctx, page as never);
    await flush();

    for (const i of [share, page]) {
      expect(i.replies).toEqual([{ kind: 'followUp', content: 'I cannot read the system channel.', flags: MessageFlags.Ephemeral }]);
    }
    expect(ctx.logged).toEqual([
      expect.objectContaining({ type: 'failure', reason: 'stats-unavailable', action: 'stats button', detail: 'missing-access' }),
      expect.objectContaining({ type: 'failure', reason: 'stats-unavailable', action: 'stats button', detail: 'missing-access' }),
    ]);
  });
});

