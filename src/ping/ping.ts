/**
 * "ping" -> "pong". Requires the MessageContent privileged intent.
 * Ignores only our own messages (as the old bot; other bots still get "pong").
 * Exact match on content "ping" (as the old bot).
 */
import type { Message } from 'discord.js';

export function isPing(content: string): boolean {
  return content === 'ping';
}

export async function handlePingMessage(message: Message): Promise<void> {
  if (message.author.id === message.client.user.id) return;
  if (!isPing(message.content)) return;
  if (!message.channel.isSendable()) return;
  console.log(`[ping] ${message.author.tag} pong`);
  await message.channel.send('pong');
}
