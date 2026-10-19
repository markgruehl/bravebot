import type { VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../types.js';
import { describeVoiceChange, handleVoiceNotice, parseVoiceNotice } from './notices.js';

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

describe('parseVoiceNotice', () => {
  const ids = ['1', '42', '81384788765712384', '123456789012345678', '1234567890123456789', '18446744073709551615'];
  const user = (id: string) => ({ mention: `<@${id}>`, name: 'u' });
  const chan = (id: string) => ({ mention: `<#${id}>`, name: 'c' });

  it('round-trips every notice describeVoiceChange writes', () => {
    for (const u of ids) {
      for (const a of ids) {
        const b = ids[(ids.indexOf(a) + 1) % ids.length]!;
        const connect = describeVoiceChange(user(u), null, chan(a))!;
        const disconnect = describeVoiceChange(user(u), chan(a), null)!;
        const move = describeVoiceChange(user(u), chan(a), chan(b))!;
        expect(parseVoiceNotice(connect.mentions)).toEqual({ kind: 'connect', userId: u, from: null, to: a });
        expect(parseVoiceNotice(disconnect.mentions)).toEqual({ kind: 'disconnect', userId: u, from: a, to: null });
        expect(parseVoiceNotice(move.mentions)).toEqual({ kind: 'move', userId: u, from: a, to: b });
      }
    }
  });

  it('accepts the legacy nickname mention and surrounding whitespace', () => {
    expect(parseVoiceNotice('<@!123456789012345678> has connected to <#10>')).toEqual({
      kind: 'connect',
      userId: '123456789012345678',
      from: null,
      to: '10',
    });
    expect(parseVoiceNotice('  <@1> has disconnected from <#10>\n')).toEqual({
      kind: 'disconnect',
      userId: '1',
      from: '10',
      to: null,
    });
  });

  it.each([
    '',
    'ping',
    'alice has connected to General', // the Slack text
    '<@&1> has connected to <#10>', // role mention
    '<#1> has connected to <#10>',
    '<@1> has connected to <@10>',
    '<@1> has connected to <#10> !',
    'hey <@1> has connected to <#10>',
    '<@1>  has connected to <#10>',
    '<@1> has Connected to <#10>',
    '<@1> has connected to <#10> to <#20>',
    '<@1> has changed channels from <#10>',
    '<@1> has changed channels from <#10> to <#20> to <#30>',
    '<@1> has disconnected from <#10>\n<@2> has connected to <#10>',
    '<@x1> has connected to <#10>',
    '<@1> has connected to <#1x0>',
    '<@> has connected to <#10>',
    '<@123456789012345678901> has connected to <#10>', // 21 digits
    '<@１> has connected to <#10>', // non-ASCII digit
  ])('rejects %j', (content) => {
    expect(parseVoiceNotice(content)).toBeNull();
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
  const sent = { id: '900', content: 'sent' };
  const send = vi.fn().mockResolvedValue(sent);
  const record = vi.fn();
  const guild = { id: '5', systemChannel: opts.systemChannel === false ? null : { send } };
  const member = { user: { bot: opts.bot ?? false, username: 'alice' }, toString: () => '<@1>' };
  const channel = (c: { id: string; name: string } | null | undefined) =>
    c ? { id: c.id, name: c.name, toString: () => `<#${c.id}>` } : null;
  const state = (c: { id: string; name: string } | null | undefined) =>
    ({ guild, member, channelId: c?.id ?? null, channel: channel(c) }) as unknown as VoiceState;
  const ctx = {
    config: { discordToken: 't', slackWebhook: opts.slackWebhook ?? null },
    stats: {
      record,
      load: vi.fn(),
      forget: vi.fn(),
      noteStartup: vi.fn(),
      dropGuild: vi.fn(),
      people: vi.fn(),
      status: vi.fn(),
    },
  } as unknown as BotContext;
  return { send, sent, record, ctx, oldState: state(opts.before), newState: state(opts.after) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleVoiceNotice', () => {
  const general = { id: '10', name: 'General' };
  const gaming = { id: '20', name: 'Gaming' };

  it('sends the mention text to the system channel and records the sent message', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { send, sent, record, ctx, oldState, newState } = setup({ before: null, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).toHaveBeenCalledWith('<@1> has connected to <#10>');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('5', sent);
    expect(fetchMock).not.toHaveBeenCalled(); // no SLACK_WEBHOOK configured
  });

  it('records the notice without waiting for a slow Slack mirror', async () => {
    let finishSlack: (res: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => (finishSlack = resolve))));
    const { record, ctx, oldState, newState } = setup({
      before: general,
      after: null,
      slackWebhook: 'https://hooks.slack.com/x',
    });
    const done = handleVoiceNotice(ctx, oldState, newState);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    finishSlack(new Response('ok'));
    await done;
  });

  it('records nothing when the send fails', async () => {
    const { send, record, ctx, oldState, newState } = setup({ before: null, after: general });
    send.mockRejectedValueOnce(new Error('Missing Permissions'));
    await expect(handleVoiceNotice(ctx, oldState, newState)).rejects.toThrow('Missing Permissions');
    expect(record).not.toHaveBeenCalled();
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
    const { send, record, ctx, oldState, newState } = setup({ bot: true, before: null, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
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
    const { send, record, ctx, oldState, newState } = setup({ before: general, after: general });
    await handleVoiceNotice(ctx, oldState, newState);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
