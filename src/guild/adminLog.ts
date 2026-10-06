/**
 * Admin log (LIBRARY implementer). Posts one message per AdminLogEvent to the guild's
 * #soundboard-log. Uses Discord timestamps (<t:unix:f>) and user/channel mentions with
 * allowedMentions: { parse: [] } (no pings). One-off uploads: filename + link only.
 * log() never throws.
 */
import { MessageFlags, escapeMarkdown } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { errorMessage } from '../errors.js';
import type {
  AdminLog,
  AdminLogEvent,
  FailureReason,
  LibrarySound,
  PlayEntryPoint,
  SourceSummary,
  TrackInfo,
  UserRef,
} from '../types.js';
import { MESSAGE_CONTENT_LIMIT } from '../library/format.js';

const MAX_TEXT = 100;
const MAX_URL = 400;
const MAX_DETAIL = 400;

const FAILURE_LABELS: Record<FailureReason, string> = {
  'not-in-voice': 'not in a voice channel',
  'unsupported-channel': 'Stage channels are not supported',
  'missing-permission': 'missing permission',
  'not-in-bot-channel': "not in the bot's voice channel",
  'nothing-playing': 'nothing playing',
  'busy-elsewhere': 'bot busy in another voice channel',
  'bad-url': 'bad URL',
  'bad-attachment': 'bad attachment',
  'extraction-failed': 'extraction failed',
  'playback-failed': 'playback failed',
  'join-failed': 'could not join voice channel',
  'sound-not-found': 'sound not found',
  'invalid-name': 'invalid sound name',
  'name-taken': 'sound name already taken',
  'library-error': 'library error',
  'not-ready': 'bot not ready in this server',
  'internal-error': 'internal error',
};

const VIA_LABELS: Record<PlayEntryPoint, string> = {
  slash: '/play',
  panel: '/soundboard panel',
  'context-menu': 'message menu',
};

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : chars.slice(0, max - 1).join('') + '…';
}

/** Escaped, single-line, length-capped user text. */
function text(value: string, max = MAX_TEXT): string {
  return escapeMarkdown(truncate(value.replace(/\s+/g, ' ').trim(), max));
}

/** Link wrapped in <> so Discord does not embed it. */
function link(url: string): string {
  const safe = truncate(url.trim(), MAX_URL).replace(/[<>\s]/g, (c) => encodeURIComponent(c));
  return `<${safe}>`;
}

function timestamp(at: Date): string {
  const ms = at.getTime();
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : 'unknown time';
}

function user(ref: UserRef): string {
  return `<@${ref.id}> (${text(ref.displayName, 64)})`;
}

function voice(channelId: string): string {
  return `<#${channelId}>`;
}

function describeSource(source: SourceSummary): string {
  switch (source.type) {
    case 'attachment':
      return source.url
        ? `uploaded file \`${text(source.label).replace(/`/g, "'")}\` ${link(source.url)}`
        : `uploaded file \`${text(source.label).replace(/`/g, "'")}\``;
    case 'url':
      return `URL ${link(source.url ?? source.label)}`;
    case 'library': {
      const name = `library sound **${text(source.libraryName ?? source.label)}**`;
      return source.url ? `${name} (${link(source.url)})` : name;
    }
  }
}

function describeTrack(track: TrackInfo): string {
  const title = `**${text(track.title)}**`;
  const playlist = track.playlistSize > 1 ? ` [playlist ${track.playlistIndex + 1}/${track.playlistSize}]` : '';
  const requester = track.requester ? `, requested by ${user(track.requester)}` : '';
  return `${title}${playlist} (${describeSource(track.source)}${requester})`;
}

function describeSound(sound: LibrarySound): string {
  const what = sound.kind === 'file' ? `file \`${text(sound.filename).replace(/`/g, "'")}\`` : `link ${link(sound.url)}`;
  return `**${text(sound.name)}** (${what}, added by <@${sound.addedBy}>)`;
}

function body(event: AdminLogEvent): string {
  switch (event.type) {
    case 'play': {
      const items = event.itemCount > 1 ? ` · playlist of ${event.itemCount} items` : '';
      return (
        `▶️ **Play** · ${user(event.user)} in ${voice(event.voiceChannelId)} · ${describeSource(event.source)}` +
        ` · mode: ${event.mode} · volume: ${event.volume}%${items} · via ${VIA_LABELS[event.via] ?? event.via}`
      );
    }
    case 'stop': {
      const stopped = event.stopped
        ? `stopped ${describeTrack(event.stopped)}`
        : event.cleared === 0
          ? 'cancelled before anything started playing'
          : 'nothing was playing';
      return `⏹️ **Stop** · ${user(event.user)} in ${voice(event.voiceChannelId)} · ${stopped} · cleared ${event.cleared} queued item${event.cleared === 1 ? '' : 's'}`;
    }
    case 'skip': {
      const skipped = event.skipped ? `skipped ${describeTrack(event.skipped)}` : 'nothing was playing';
      const next = event.next ? `next: ${describeTrack(event.next)}` : 'queue empty, playback ended';
      return `⏭️ **Skip** · ${user(event.user)} in ${voice(event.voiceChannelId)} · ${skipped} · ${next}`;
    }
    case 'volume':
      return `🔉 **Volume** · ${user(event.user)} in ${voice(event.voiceChannelId)} · ${event.from}% → ${event.to}% on ${describeTrack(event.track)}`;
    case 'library-add':
      return `➕ **Sound added** · ${user(event.user)} · ${describeSound(event.sound)}`;
    case 'library-rename':
      return `✏️ **Sound renamed** · ${user(event.user)} · **${text(event.oldName)}** → ${describeSound(event.sound)}`;
    case 'library-delete':
      return `🗑️ **Sound deleted** · ${user(event.user)} · ${describeSound(event.sound)}`;
    case 'failure': {
      const parts = [
        `⚠️ **Failed: ${FAILURE_LABELS[event.reason] ?? event.reason}**`,
        event.user ? user(event.user) : 'system',
        `action: ${text(event.action, 64)}`,
      ];
      if (event.voiceChannelId) parts.push(`in ${voice(event.voiceChannelId)}`);
      if (event.source) parts.push(describeSource(event.source));
      if (event.detail) parts.push(`detail: ${text(event.detail, MAX_DETAIL)}`);
      return parts.join(' · ');
    }
  }
}

/** Pure: render an event as message content (<= 2000 chars). */
export function formatAdminLogEvent(event: AdminLogEvent): string {
  const line = `${timestamp(event.at)} ${body(event)}`;
  // Cap by UTF-16 length (>= code points), which is what the 2000 limit is safest against.
  return line.length <= MESSAGE_CONTENT_LIMIT ? line : line.slice(0, MESSAGE_CONTENT_LIMIT - 1) + '…';
}

export function createAdminLog(getLogChannel: (guildId: string) => TextChannel | undefined): AdminLog {
  return {
    async log(guildId, event) {
      try {
        const channel = getLogChannel(guildId);
        if (!channel) {
          console.warn(`[admin-log] guild ${guildId}: no log channel; dropped ${event.type} event`);
          return;
        }
        await channel.send({
          content: formatAdminLogEvent(event),
          allowedMentions: { parse: [] },
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (err) {
        console.error(`[admin-log] guild ${guildId}: failed to log ${event?.type ?? 'unknown'} event: ${errorMessage(err)}`);
      }
    },
  };
}
