/**
 * Voice join/leave/move notices to the guild system channel.
 * Fixed bugs vs. the Python bot: skip when guild.systemChannel is null OR the member is
 * a bot; ignore same-channel updates (mute/deafen). Mirror to Slack (names, not mentions)
 * only when config.slackWebhook is set. Each posted notice is also recorded in the stats cache,
 * and parseVoiceNotice reads them back (including the Python bot's, which used the same text).
 */
import type { VoiceState } from 'discord.js';
import type { ParsedVoiceNotice } from '../stats/types.js';
import type { BotContext } from '../types.js';
import { escapeSlack, postToSlack } from './slack.js';

// The notice wording, shared by describeVoiceChange and parseVoiceNotice so they cannot drift.
// Stats parse years of history in this exact text: changing it breaks the old notices.
const CONNECTED = ' has connected to ';
const DISCONNECTED = ' has disconnected from ';
const MOVED_FROM = ' has changed channels from ';
const MOVED_TO = ' to ';

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
      mentions: `${member.mention}${MOVED_FROM}${before.mention}${MOVED_TO}${after.mention}`,
      names: `${n(member)}${MOVED_FROM}${n(before)}${MOVED_TO}${n(after)}`,
    };
  }
  if (after) {
    return {
      mentions: `${member.mention}${CONNECTED}${after.mention}`,
      names: `${n(member)}${CONNECTED}${n(after)}`,
    };
  }
  if (before) {
    return {
      mentions: `${member.mention}${DISCONNECTED}${before.mention}`,
      names: `${n(member)}${DISCONNECTED}${n(before)}`,
    };
  }
  return null;
}

/** A literal phrase as a regex source. */
const phrase = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// User mention, also the legacy nickname form <@!id>; role mentions (<@&id>) never match.
const USER = '<@!?(\\d{1,20})>';
const CHANNEL = '<#(\\d{1,20})>';
const CONNECT_RE = new RegExp(`^${USER}${phrase(CONNECTED)}${CHANNEL}$`);
const DISCONNECT_RE = new RegExp(`^${USER}${phrase(DISCONNECTED)}${CHANNEL}$`);
const MOVE_RE = new RegExp(`^${USER}${phrase(MOVED_FROM)}${CHANNEL}${phrase(MOVED_TO)}${CHANNEL}$`);

/**
 * Pure: the inverse of describeVoiceChange's `mentions` text, null for anything else
 * (Slack name text, extra words, role mentions, ...). Surrounding whitespace is ignored.
 */
export function parseVoiceNotice(content: string): ParsedVoiceNotice | null {
  const text = content.trim();
  let m = CONNECT_RE.exec(text);
  if (m) return { kind: 'connect', userId: m[1]!, from: null, to: m[2]! };
  m = DISCONNECT_RE.exec(text);
  if (m) return { kind: 'disconnect', userId: m[1]!, from: m[2]!, to: null };
  m = MOVE_RE.exec(text);
  if (m) return { kind: 'move', userId: m[1]!, from: m[2]!, to: m[3]! };
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

  // Slack mirror never throws; postToSlack is a no-op when the webhook is unset. The sent
  // notice goes to the stats cache as soon as Discord accepts it (record never throws).
  const guildId = newState.guild.id;
  await Promise.all([
    postToSlack(ctx.config.slackWebhook, notice.names),
    systemChannel.send(notice.mentions).then((sent) => ctx.stats.record(guildId, sent)),
  ]);
}
