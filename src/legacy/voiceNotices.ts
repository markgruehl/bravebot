/**
 * Voice join/leave/move notices to the guild system channel.
 * Fixed bugs vs. the Python bot: skip when guild.systemChannel is null OR the member is
 * a bot; ignore same-channel updates (mute/deafen). Mirror to Slack (names, not mentions)
 * only when config.slackWebhook is set.
 */
import type { VoiceState } from 'discord.js';
import type { BotContext } from '../types.js';
import { escapeSlack, postToSlack } from './slack.js';

export interface VoiceNoticeParty {
  readonly mention: string;
  readonly name: string;
}

export interface VoiceNotice {
  /** Discord text, e.g. "<@1> has connected to <#2>". */
  readonly mentions: string;
  /** Slack text, e.g. "alice has connected to General". Names are Slack-escaped. */
  readonly names: string;
}

/** Pure: null when nothing should be announced (same channel / no channel either side). */
export function describeVoiceChange(
  member: VoiceNoticeParty,
  before: VoiceNoticeParty | null,
  after: VoiceNoticeParty | null,
): VoiceNotice | null {
  const n = (party: VoiceNoticeParty) => escapeSlack(party.name);
  if (before && after) {
    // Same channel (mute/deafen/stream toggles): nothing to announce.
    if (before.mention === after.mention) return null;
    return {
      mentions: `${member.mention} has changed channels from ${before.mention} to ${after.mention}`,
      names: `${n(member)} has changed channels from ${n(before)} to ${n(after)}`,
    };
  }
  if (after) {
    return {
      mentions: `${member.mention} has connected to ${after.mention}`,
      names: `${n(member)} has connected to ${n(after)}`,
    };
  }
  if (before) {
    return {
      mentions: `${member.mention} has disconnected from ${before.mention}`,
      names: `${n(member)} has disconnected from ${n(before)}`,
    };
  }
  return null;
}

export async function handleVoiceNotice(ctx: BotContext, oldState: VoiceState, newState: VoiceState): Promise<void> {
  // Mute/deafen/etc. keep the same channel: ignore cheaply before anything else.
  if (oldState.channelId === newState.channelId) return;

  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const systemChannel = newState.guild.systemChannel;
  if (!systemChannel) return;

  const party = (channel: VoiceState['channel']): VoiceNoticeParty | null =>
    channel ? { mention: channel.toString(), name: channel.name } : null;

  const notice = describeVoiceChange(
    { mention: member.toString(), name: member.user.username },
    party(oldState.channel),
    party(newState.channel),
  );
  if (!notice) return;

  // Slack mirror never throws; postToSlack is a no-op when the webhook is unset.
  await Promise.all([postToSlack(ctx.config.slackWebhook, notice.names), systemChannel.send(notice.mentions)]);
}
