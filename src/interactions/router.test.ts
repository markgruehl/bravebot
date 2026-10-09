import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeStatsCustomId } from '../stats/customId.js';
import { flush, makeButtonInteraction, makeCtx, makeInteraction } from './__tests__/fakes.js';
import { handleInfoCommand } from './info.js';
import { handlePanelButton } from './panel.js';
import { describeInteraction, handleInteraction } from './router.js';
import { handleStatsButton, handleStatsCommand } from './stats.js';
import { MESSAGES } from './validation.js';
import type * as PanelModule from './panel.js';
import type * as StatsModule from './stats.js';

vi.mock('./stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StatsModule>();
  return { ...actual, handleStatsCommand: vi.fn(), handleStatsButton: vi.fn() };
});
vi.mock('./info.js', () => ({ handleInfoCommand: vi.fn() }));
vi.mock('./panel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PanelModule>();
  return { ...actual, handlePanelButton: vi.fn() };
});

const statsId = encodeStatsCustomId('page', { kind: 'server', page: 'overview', days: 30 });

beforeEach(() => {
  vi.mocked(handleStatsCommand).mockResolvedValue(undefined);
  vi.mocked(handleStatsButton).mockResolvedValue(undefined);
  vi.mocked(handleInfoCommand).mockResolvedValue(undefined);
  vi.mocked(handlePanelButton).mockResolvedValue(undefined);
});

describe('handleInteraction routing', () => {
  it('routes /stats and /info', async () => {
    const ctx = makeCtx();
    const stats = makeInteraction({ commandName: 'stats', subcommand: 'server' });
    const info = makeInteraction({ commandName: 'info' });
    await handleInteraction(ctx, stats as never);
    await handleInteraction(ctx, info as never);
    expect(handleStatsCommand).toHaveBeenCalledWith(ctx, stats);
    expect(handleInfoCommand).toHaveBeenCalledWith(ctx, info);
  });

  it('routes stats buttons to the stats handler and sb: buttons to the panel', async () => {
    const ctx = makeCtx();
    const stats = makeButtonInteraction({ customId: statsId });
    const panel = makeButtonInteraction({ customId: 'sb:page:1' });
    const other = makeButtonInteraction({ customId: 'someone-else' });
    for (const i of [stats, panel, other]) await handleInteraction(ctx, i as never);
    expect(handleStatsButton).toHaveBeenCalledTimes(1);
    expect(handleStatsButton).toHaveBeenCalledWith(ctx, stats);
    expect(handlePanelButton).toHaveBeenCalledTimes(1);
    expect(handlePanelButton).toHaveBeenCalledWith(ctx, panel);
  });

  it('labels stats buttons for the admin log', () => {
    expect(describeInteraction(makeButtonInteraction({ customId: statsId }) as never)).toBe('stats button');
    expect(describeInteraction(makeButtonInteraction({ customId: 'sb:page:1' }) as never)).toBe('panel button');
    expect(describeInteraction(makeInteraction({ commandName: 'stats', subcommand: 'user' }) as never)).toBe('/stats user');
  });

  it('logs an unexpected error and answers without overwriting a paged message', async () => {
    const ctx = makeCtx();
    const i = makeButtonInteraction({ customId: statsId, ephemeralMessage: true });
    vi.mocked(handleStatsButton).mockImplementation(async () => {
      await i.deferUpdate();
      throw new Error('boom');
    });
    await handleInteraction(ctx, i as never);
    await flush();
    expect(i.editReply).not.toHaveBeenCalled();
    expect(i.replies).toEqual([{ kind: 'followUp', content: MESSAGES.internalError, flags: MessageFlags.Ephemeral }]);
    expect(ctx.logged).toEqual([expect.objectContaining({ reason: 'internal-error', action: 'stats button', detail: 'boom' })]);
  });

  it('answers a failed deferred command through editReply', async () => {
    const ctx = makeCtx();
    const i = makeInteraction({ commandName: 'stats', subcommand: 'server' });
    vi.mocked(handleStatsCommand).mockImplementation(async () => {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      throw new Error('boom');
    });
    await handleInteraction(ctx, i as never);
    expect(i.replies).toEqual([{ kind: 'editReply', content: MESSAGES.internalError }]);
  });
});
