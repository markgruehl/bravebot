/**
 * "Play in my voice channel" message context menu (INTERACTIONS implementer).
 * Plays the FIRST audio attachment of the target message (isAudioAttachment from
 * playback/sources.ts) with default mode/volume via executePlay(..., via: 'context-menu').
 */
import type { MessageContextMenuCommandInteraction } from 'discord.js';
import { DEFAULT_PLAY_MODE, VOLUME_DEFAULT } from '../constants.js';
import { isAudioAttachment } from '../playback/sources.js';
import type { BotContext } from '../types.js';
import { executePlay } from './play.js';
import { deny, userRefOf } from './reply.js';
import { MESSAGES, PLAY_ACTION_BY_VIA, firstAudioAttachment } from './validation.js';

export async function handlePlayContextMenu(
  ctx: BotContext,
  interaction: MessageContextMenuCommandInteraction<'cached'>,
): Promise<void> {
  const message = interaction.targetMessage;
  const attachment = firstAudioAttachment(message.attachments.values(), isAudioAttachment);
  if (!attachment) {
    await deny(ctx, interaction, MESSAGES.noAudioInMessage, {
      reason: 'bad-attachment',
      action: PLAY_ACTION_BY_VIA['context-menu'],
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: `message ${message.url} has ${message.attachments.size} attachment(s), none audio`,
    });
    return;
  }
  await executePlay(ctx, interaction, {
    source: {
      type: 'attachment',
      url: attachment.url,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
    },
    mode: DEFAULT_PLAY_MODE,
    volume: VOLUME_DEFAULT,
    via: 'context-menu',
  });
}
