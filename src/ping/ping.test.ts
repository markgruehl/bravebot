import type { Message } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { handlePingMessage, isPing } from './ping.js';

function fakeMessage(content: string, authorId = 'alice', bot = false, sendable = true) {
  const send = vi.fn().mockResolvedValue(undefined);
  const message = {
    content,
    author: { id: authorId, bot, tag: `${authorId}#0` },
    client: { user: { id: 'self' } },
    channel: { isSendable: () => sendable, send },
  } as unknown as Message;
  return { message, send };
}

describe('isPing', () => {
  it('matches exactly "ping"', () => {
    expect(isPing('ping')).toBe(true);
    expect(isPing('Ping')).toBe(false);
    expect(isPing('ping!')).toBe(false);
    expect(isPing(' ping')).toBe(false);
  });
});

describe('handlePingMessage', () => {
  it('replies pong to ping', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { message, send } = fakeMessage('ping');
    await handlePingMessage(message);
    expect(send).toHaveBeenCalledWith('pong');
  });

  it('ignores its own messages and other content', async () => {
    const self = fakeMessage('ping', 'self', true);
    await handlePingMessage(self.message);
    expect(self.send).not.toHaveBeenCalled();

    const other = fakeMessage('hello');
    await handlePingMessage(other.message);
    expect(other.send).not.toHaveBeenCalled();
  });

  it('answers other bots, as the original Python bot did', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const other = fakeMessage('ping', 'uptime-bot', true);
    await handlePingMessage(other.message);
    expect(other.send).toHaveBeenCalledWith('pong');
  });

  it('does nothing in a channel it cannot send to', async () => {
    const { message, send } = fakeMessage('ping', 'alice', false, false);
    await handlePingMessage(message);
    expect(send).not.toHaveBeenCalled();
  });
});
