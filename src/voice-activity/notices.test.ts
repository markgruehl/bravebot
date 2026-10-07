import type { VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../types.js';
import { describeVoiceChange, handleVoiceNotice } from './notices.js';

const alice = { mention: '<@1>', name: 'alice' };
const general = { mention: '<#10>', name: 'General' };
const gaming = { mention: '<#20>', name: 'Gaming' };

describe('describeVoiceChange', () => {
  it('announces a connect', () => {
    expect(describeVoiceChange(alice, null, general)).toEqual({
      mentions: '<@1> has connected to <#10>',
      names: 'alice has connected to General',
    });
  });

  it('announces a disconnect', () => {
    expect(describeVoiceChange(alice, general, null)).toEqual({
      mentions: '<@1> has disconnected from <#10>',
      names: 'alice has disconnected from General',
    });
  });

  it('announces a move', () => {
    expect(describeVoiceChange(alice, general, gaming)).toEqual({
      mentions: '<@1> has changed channels from <#10> to <#20>',
      names: 'alice has changed channels from General to Gaming',
    });
  });

  it('escapes Slack control sequences in names but not in the Discord text', () => {
    const evil = { mention: '<#30>', name: '<!channel> & co' };
    expect(describeVoiceChange(alice, null, evil)).toEqual({
      mentions: '<@1> has connected to <#30>',
      names: 'alice has connected to &lt;!channel&gt; &amp; co',
    });
  });

  it('ignores same-channel updates and no-channel updates', () => {
    expect(describeVoiceChange(alice, general, { ...general })).toBeNull();
    expect(describeVoiceChange(alice, null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleVoiceNotice with minimal fakes
// ---------------------------------------------------------------------------

interface FakeOpts {
  bot?: boolean;
  systemChannel?: boolean;
  before?: { id: string; name: string } | null;
  after?: { id: string; name: string } | null;
  slackWebhook?: string | null;
}

function setup(opts: FakeOpts) {
  const send = vi.fn().mockResolvedValue(undefined);
  const guild = { systemChannel: opts.systemChannel === false ? null : { send } };
  const member = { user: { bot: opts.bot ?? false, username: 'alice' }, toString: () => '<@1>' };
  const channel = (c: { id: string; name: string } | null | undefined) =>
    c ? { id: c.id, name: c.name, toString: () => `<#${c.id}>` } : null;
  const state = (c: { id: string; name: string } | null | undefined) =>
    ({ guild, member, channelId: c?.id ?? null, channel: channel(c) }) as unknown as VoiceState;
  const ctx = { config: { discordToken: 't', slackWebhook: opts.slackWebhook ?? null } } as unknown as BotContext;
  return { send, ctx, oldState: state(opts.before), newState: state(opts.after) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleVoiceNotice', () => {
  const general = { id: '10', name: 'General' };
  const gaming = { id: '20', name: 'Gaming' };

  it('sends the mention text to the system channel', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { send, ctx, oldState, newState } = setup({ before: null, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).toHaveBeenCalledWith('<@1> has connected to <#10>');
    expect(fetchMock).not.toHaveBeenCalled(); // no SLACK_WEBHOOK configured
  });

  it('mirrors names to Slack when a webhook is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const { send, ctx, oldState, newState } = setup({
      before: general,
      after: gaming,
      slackWebhook: 'https://hooks.slack.com/x',
    });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).toHaveBeenCalledWith('<@1> has changed channels from <#10> to <#20>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ text: 'alice has changed channels from General to Gaming' });
  });

  it('skips bots even when a system channel exists', async () => {
    const { send, ctx, oldState, newState } = setup({ bot: true, before: null, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the guild has no system channel', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { send, ctx, oldState, newState } = setup({
      systemChannel: false,
      before: general,
      after: null,
      slackWebhook: 'https://hooks.slack.com/x',
    });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores mute/deafen (same channel)', async () => {
    const { send, ctx, oldState, newState } = setup({ before: general, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).not.toHaveBeenCalled();
  });
});
