/**
 * /stop, /skip, /volume (INTERACTIONS implementer). Allowed for anyone currently in the
 * bot's voice channel; no other permission. Each logs to the admin log.
 *
 * These do not require the guild's library/channels to be ready: playback state lives
 * in the player manager, so stopping a sound always works.
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AdminLogEvent, BotContext, UserRef } from '../types.js';
import { OPTIONS } from './commands.js';
import { canControlPlayback } from './permissions.js';
import { deny, replyEphemeral, userRefOf } from './reply.js';
import {
  MESSAGES,
  clampVolume,
  formatSkipReply,
  formatStopReply,
  formatVolumeReply,
  notInBotChannelMessage,
} from './validation.js';

interface ControlContext {
  readonly user: UserRef;
  readonly botChannelId: string;
}

/** Shared gate: something must be playing and the caller must be in the bot's channel. */
async function checkControl(
  ctx: BotContext,
  interaction: ChatInputCommandInteraction<'cached'>,
  action: string,
): Promise<ControlContext | null> {
  const user = userRefOf(interaction);
  const userChannelId = interaction.member.voice.channelId;
  const botChannelId = ctx.players.currentChannelId(interaction.guildId);

  if (botChannelId === null) {
    await deny(ctx, interaction, MESSAGES.nothingPlaying, {
      reason: 'nothing-playing',
      action,
      user,
      voiceChannelId: userChannelId,
      source: null,
      detail: null,
    });
    return null;
  }
  if (!canControlPlayback(userChannelId, botChannelId)) {
    await deny(ctx, interaction, notInBotChannelMessage(botChannelId), {
      reason: 'not-in-bot-channel',
      action,
      user,
      voiceChannelId: userChannelId,
      source: null,
      detail: `bot is in <#${botChannelId}>`,
    });
    return null;
  }
  return { user, botChannelId };
}

async function denyNothingPlaying(
  ctx: BotContext,
  interaction: ChatInputCommandInteraction<'cached'>,
  action: string,
  control: ControlContext,
): Promise<void> {
  await deny(ctx, interaction, MESSAGES.nothingPlaying, {
    reason: 'nothing-playing',
    action,
    user: control.user,
    voiceChannelId: control.botChannelId,
    source: null,
    detail: null,
  });
}

function logEvent(ctx: BotContext, guildId: string, event: AdminLogEvent): void {
  ctx.adminLog.log(guildId, event).catch((err: unknown) => console.error('[controls] admin log failed:', err));
}

export async function handleStopCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const action = '/stop';
  const guildId = interaction.guildId;
  const userChannelId = interaction.member.voice.channelId;
  // Not joined yet, but a play into the caller's channel is still loading (e.g. a playlist
  // being resolved): only someone in that target channel may cancel it.
  if (
    ctx.players.currentChannelId(guildId) === null &&
    userChannelId !== null &&
    ctx.players.hasPendingPlay(guildId, userChannelId)
  ) {
    ctx.players.stop(guildId); // null: no session yet, but pending resolves are cancelled
    logEvent(ctx, guildId, {
      type: 'stop',
      at: new Date(),
      user: userRefOf(interaction),
      voiceChannelId: userChannelId,
      stopped: null,
      cleared: 0,
    });
    await replyEphemeral(interaction, MESSAGES.cancelledLoading);
    return;
  }
  const control = await checkControl(ctx, interaction, action);
  if (!control) return;
  const result = ctx.players.stop(interaction.guildId);
  if (!result) {
    await denyNothingPlaying(ctx, interaction, action, control);
    return;
  }
  logEvent(ctx, interaction.guildId, {
    type: 'stop',
    at: new Date(),
    user: control.user,
    voiceChannelId: control.botChannelId,
    stopped: result.stopped,
    cleared: result.cleared,
  });
  await replyEphemeral(interaction, formatStopReply(result));
}

export async function handleSkipCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const action = '/skip';
  const control = await checkControl(ctx, interaction, action);
  if (!control) return;
  const result = ctx.players.skip(interaction.guildId);
  if (!result) {
    await denyNothingPlaying(ctx, interaction, action, control);
    return;
  }
  logEvent(ctx, interaction.guildId, {
    type: 'skip',
    at: new Date(),
    user: control.user,
    voiceChannelId: control.botChannelId,
    skipped: result.skipped,
    next: result.next,
  });
  await replyEphemeral(interaction, formatSkipReply(result));
}

export async function handleVolumeCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const action = '/volume';
  const control = await checkControl(ctx, interaction, action);
  if (!control) return;
  const level = clampVolume(interaction.options.getInteger(OPTIONS.level, true));
  const result = ctx.players.setVolume(interaction.guildId, level);
  if (!result) {
    await denyNothingPlaying(ctx, interaction, action, control);
    return;
  }
  logEvent(ctx, interaction.guildId, {
    type: 'volume',
    at: new Date(),
    user: control.user,
    voiceChannelId: control.botChannelId,
    track: result.track,
    from: result.from,
    to: result.to,
  });
  await replyEphemeral(interaction, formatVolumeReply(result));
}
