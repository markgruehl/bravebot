/**
 * /play + the shared play pipeline used by /play, panel buttons and the context menu
 * (INTERACTIONS implementer).
 * Pipeline: require guild state -> requester must be in a (non-Stage) voice channel -> must have
 * UseSoundboard in THAT channel -> isBusyElsewhere pre-check -> deferReply({ ephemeral })
 * -> players.play() -> ephemeral result -> admin log ('play' or 'failure').
 */
import { ChannelType, type ChatInputCommandInteraction, type RepliableInteraction } from 'discord.js';
import { errorMessage } from '../errors.js';
import { isAudioAttachment, isHttpUrl, summarizeSource } from '../playback/sources.js';
import type { AudioSource, BotContext, PlayEntryPoint, PlayMode, PlayResult } from '../types.js';
import { OPTIONS } from './commands.js';
import { canPlay } from './permissions.js';
import { deferEphemeral, deny, guildStateOf, replyEphemeral, userRefOf } from './reply.js';
import {
  MESSAGES,
  PLAY_ACTION_BY_VIA,
  busyElsewhereMessage,
  clampVolume,
  formatPlaySuccess,
  parsePlayMode,
  pickExactlyOne,
  playbackFailureReason,
  resolveSoundOption,
} from './validation.js';

export interface ExecutePlayParams {
  readonly source: AudioSource;
  readonly mode: PlayMode;
  /** Percent 0-200. */
  readonly volume: number;
  readonly via: PlayEntryPoint;
}

export async function executePlay(
  ctx: BotContext,
  interaction: RepliableInteraction<'cached'>,
  params: ExecutePlayParams,
): Promise<void> {
  const { guildId, member } = interaction;
  const action = PLAY_ACTION_BY_VIA[params.via];
  const user = userRefOf(interaction);
  const source = summarizeSource(params.source);
  const volume = clampVolume(params.volume);

  if (!guildStateOf(ctx, guildId)) {
    await deny(ctx, interaction, MESSAGES.notReady, {
      reason: 'not-ready',
      action,
      user,
      voiceChannelId: member.voice.channelId,
      source,
      detail: null,
    });
    return;
  }

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await deny(ctx, interaction, MESSAGES.notInVoice, {
      reason: 'not-in-voice',
      action,
      user,
      voiceChannelId: null,
      source,
      detail: null,
    });
    return;
  }

  if (voiceChannel.type === ChannelType.GuildStageVoice) {
    // The bot would join suppressed and nobody would hear anything.
    await deny(ctx, interaction, MESSAGES.stageNotSupported, {
      reason: 'unsupported-channel',
      action,
      user,
      voiceChannelId: voiceChannel.id,
      source,
      detail: 'Stage channels are not supported',
    });
    return;
  }

  if (!canPlay(member.permissionsIn(voiceChannel))) {
    await deny(ctx, interaction, MESSAGES.missingUseSoundboard, {
      reason: 'missing-permission',
      action,
      user,
      voiceChannelId: voiceChannel.id,
      source,
      detail: 'Use Soundboard',
    });
    return;
  }

  if (ctx.players.isBusyElsewhere(guildId, voiceChannel.id)) {
    const botChannelId = ctx.players.currentChannelId(guildId);
    await deny(ctx, interaction, busyElsewhereMessage(botChannelId), {
      reason: 'busy-elsewhere',
      action,
      user,
      voiceChannelId: voiceChannel.id,
      source,
      detail: botChannelId ? `bot is in <#${botChannelId}>` : null,
    });
    return;
  }

  // Resolution (yt-dlp, playlist expansion, joining voice) can exceed the 3s ack deadline.
  await deferEphemeral(interaction);

  let result: PlayResult;
  try {
    result = await ctx.players.play({
      guildId,
      voiceChannelId: voiceChannel.id,
      requester: user,
      source: params.source,
      mode: params.mode,
      volume,
      via: params.via,
    });
  } catch (err) {
    console.error('[play] unexpected player error:', err);
    await deny(ctx, interaction, MESSAGES.internalError, {
      reason: 'internal-error',
      action,
      user,
      voiceChannelId: voiceChannel.id,
      source,
      detail: errorMessage(err),
    });
    return;
  }

  if (!result.ok) {
    await deny(ctx, interaction, result.message, {
      reason: playbackFailureReason(result.code, params.source.type),
      action,
      user,
      voiceChannelId: voiceChannel.id,
      source: result.source,
      // Tool output (stderr etc.) goes to the admin log only, never to the user.
      detail: `${result.code}: ${result.message}${result.detail ? ` (${result.detail})` : ''}`,
    });
    return;
  }

  void ctx.adminLog
    .log(guildId, {
      type: 'play',
      at: new Date(),
      user,
      voiceChannelId: voiceChannel.id,
      source: result.source,
      mode: params.mode,
      volume,
      itemCount: result.tracks.length,
      via: params.via,
    })
    .catch((err: unknown) => console.error('[play] admin log failed:', err));
  await replyEphemeral(interaction, formatPlaySuccess(result, voiceChannel.id, volume));
}

export async function handlePlayCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const action = PLAY_ACTION_BY_VIA.slash;
  const user = userRefOf(interaction);
  const voiceChannelId = interaction.member.voice.channelId;

  const attachment = interaction.options.getAttachment(OPTIONS.attachment);
  const url = interaction.options.getString(OPTIONS.url);
  const soundValue = interaction.options.getString(OPTIONS.sound);
  const pick = pickExactlyOne({ attachment, url, sound: soundValue }, ['attachment', 'url', 'sound'] as const);
  if (!pick.ok) {
    // Usage error (Discord cannot express "exactly one of" in the command schema).
    await replyEphemeral(interaction, pick.error);
    return;
  }

  const mode = parsePlayMode(interaction.options.getString(OPTIONS.mode));
  const volume = clampVolume(interaction.options.getInteger(OPTIONS.volume));

  let source: AudioSource;
  switch (pick.key) {
    case 'attachment': {
      const att = attachment!;
      source = { type: 'attachment', url: att.url, filename: att.name, contentType: att.contentType, size: att.size };
      if (!isAudioAttachment({ contentType: att.contentType, filename: att.name })) {
        await deny(ctx, interaction, MESSAGES.notAudioAttachment, {
          reason: 'bad-attachment',
          action,
          user,
          voiceChannelId,
          source: summarizeSource(source),
          detail: `content type: ${att.contentType ?? 'unknown'}`,
        });
        return;
      }
      break;
    }
    case 'url': {
      const trimmed = url!.trim();
      source = { type: 'url', url: trimmed };
      if (!isHttpUrl(trimmed)) {
        await deny(ctx, interaction, MESSAGES.invalidUrl, {
          reason: 'bad-url',
          action,
          user,
          voiceChannelId,
          source: summarizeSource(source),
          detail: null,
        });
        return;
      }
      break;
    }
    case 'sound': {
      const state = guildStateOf(ctx, interaction.guildId);
      if (!state) {
        await deny(ctx, interaction, MESSAGES.notReady, {
          reason: 'not-ready',
          action,
          user,
          voiceChannelId,
          source: null,
          detail: null,
        });
        return;
      }
      const sound = resolveSoundOption(state.library, soundValue!);
      if (!sound) {
        await deny(ctx, interaction, MESSAGES.soundNotFound, {
          reason: 'sound-not-found',
          action,
          user,
          voiceChannelId,
          source: null,
          detail: `requested: ${soundValue}`,
        });
        return;
      }
      source = { type: 'library', sound };
      break;
    }
  }

  await executePlay(ctx, interaction, { source, mode, volume, via: 'slash' });
}
