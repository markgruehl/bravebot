/**
 * PURE helpers for interaction handlers (INTERACTIONS implementer): option validation,
 * error-code mapping and user-facing message formatting. No Discord API calls here
 * so everything is unit-testable.
 */
import { escapeMarkdown } from 'discord.js';
import { AUTOCOMPLETE_LIMIT, DEFAULT_PLAY_MODE, VOLUME_DEFAULT, VOLUME_MAX, VOLUME_MIN } from '../constants.js';
import type { LibraryErrorCode, PlaybackErrorCode } from '../errors.js';
import type {
  AudioSource,
  FailureReason,
  LibrarySound,
  LibraryStore,
  PlayEntryPoint,
  PlayMode,
  PlayResult,
  SkipResult,
  StopResult,
  TrackInfo,
  VolumeResult,
} from '../types.js';

/** Discord message content limit. */
export const MESSAGE_CONTENT_LIMIT = 2000;

export const MESSAGES = {
  notReady:
    "The soundboard isn't ready for this server yet (setup is in progress or being retried). " +
    "Please try again shortly; if this persists, ask an admin to check the bot's permissions.",
  notInVoice: 'Join a voice channel first. Sounds play into the voice channel you are in.',
  stageNotSupported: "Sounds can't be played into Stage channels. Join a regular voice channel.",
  missingUseSoundboard: 'You need the **Use Soundboard** permission in your voice channel to play sounds.',
  missingCreateExpressions: 'You need the **Create Expressions** permission to add sounds.',
  nothingPlaying: 'Nothing is playing right now.',
  cancelledLoading: 'Cancelled the sound that was still loading.',
  notAudioAttachment: 'That attachment does not look like an audio file.',
  noAudioInMessage: 'That message has no audio attachment to play.',
  invalidUrl: 'That is not a valid http(s) link.',
  soundNotFound: 'No saved sound matches that. Pick one from the suggestions.',
  panelSoundGone: 'That sound no longer exists. Run /soundboard again to refresh the panel.',
  staleButton: 'This button is no longer valid. Run /soundboard again.',
  unknownCommand: 'Unknown command. It may have been removed; please try again later.',
  internalError: 'Something went wrong while handling that. The error has been logged.',
} as const;

/** Log "action" label per play entry point. */
export const PLAY_ACTION_BY_VIA: Readonly<Record<PlayEntryPoint, string>> = {
  slash: '/play',
  panel: 'panel button',
  'context-menu': 'context menu',
};

/** Truncate to Discord's content limit (or `max`), appending an ellipsis when cut. */
export function truncate(text: string, max: number = MESSAGE_CONTENT_LIMIT): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** Bold, markdown-escaped, length-capped label for user-facing text. */
export function bold(text: string, max = 200): string {
  return `**${escapeMarkdown(truncate(text, max))}**`;
}

/** A value counts as "given" when it is not null/undefined and (for strings) not blank. */
function isGiven(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function listNames(names: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  const quoted = names.map((n) => `\`${n}\``);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} ${conjunction} ${quoted[quoted.length - 1]}`;
}

export type ExactlyOneResult<K extends string> =
  | { readonly ok: true; readonly key: K }
  | { readonly ok: false; readonly error: string };

/**
 * Exactly-one-of validation (e.g. /play attachment|url|sound, /sound add attachment|url).
 * `names` fixes the order used in messages.
 */
export function pickExactlyOne<K extends string>(
  values: Readonly<Partial<Record<K, unknown>>>,
  names: readonly K[],
): ExactlyOneResult<K> {
  const given = names.filter((name) => isGiven(values[name]));
  if (given.length === 1) return { ok: true, key: given[0] as K };
  if (given.length === 0) return { ok: false, error: `Provide one of ${listNames(names)}.` };
  return { ok: false, error: `Provide only one of ${listNames(names)} (you gave ${listNames(given, 'and')}).` };
}

/** /play mode option -> PlayMode (default interrupt). */
export function parsePlayMode(value: string | null | undefined): PlayMode {
  return value === 'queue' || value === 'interrupt' ? value : DEFAULT_PLAY_MODE;
}

/** Volume percent: null/NaN -> default, rounded, clamped to 0-200. */
export function clampVolume(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return VOLUME_DEFAULT;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(value)));
}

/** Resolve an autocomplete value (sound id) or a typed name to a library sound. */
export function resolveSoundOption(
  library: Pick<LibraryStore, 'getById' | 'getByName'>,
  value: string,
): LibrarySound | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return library.getById(trimmed) ?? library.getByName(trimmed);
}

/** Autocomplete choices (value = sound id), at most AUTOCOMPLETE_LIMIT. */
export function autocompleteChoices(
  library: Pick<LibraryStore, 'search' | 'list'>,
  query: string,
): { name: string; value: string }[] {
  const q = query.trim();
  const sounds = q ? library.search(q, AUTOCOMPLETE_LIMIT) : library.list();
  return sounds.slice(0, AUTOCOMPLETE_LIMIT).map((sound) => ({ name: sound.name, value: sound.id }));
}

/** First attachment the predicate accepts (context menu: first AUDIO attachment). */
export function firstAudioAttachment<T extends { readonly name: string; readonly contentType: string | null }>(
  attachments: Iterable<T>,
  isAudio: (attachment: { contentType: string | null; filename: string }) => boolean,
): T | undefined {
  for (const attachment of attachments) {
    if (isAudio({ contentType: attachment.contentType, filename: attachment.name })) return attachment;
  }
  return undefined;
}

/** PlaybackErrorCode -> admin-log FailureReason. */
export function playbackFailureReason(code: PlaybackErrorCode, sourceType: AudioSource['type']): FailureReason {
  switch (code) {
    case 'invalid-url':
      return 'bad-url';
    case 'unsupported-source':
      return sourceType === 'attachment' ? 'bad-attachment' : 'bad-url';
    case 'extraction-failed':
    case 'empty-playlist':
      return 'extraction-failed';
    case 'busy-elsewhere':
      return 'busy-elsewhere';
    case 'join-failed':
      return 'join-failed';
    case 'playback-failed':
      return 'playback-failed';
  }
}

/** LibraryError -> admin-log reason + user-facing message. */
export function describeLibraryError(error: { readonly code: LibraryErrorCode; readonly message: string }): {
  reason: FailureReason;
  message: string;
} {
  switch (error.code) {
    case 'invalid-name':
      return { reason: 'invalid-name', message: error.message || 'That sound name is not valid.' };
    case 'name-taken':
      return { reason: 'name-taken', message: 'A sound with that name already exists (names are case-insensitive).' };
    case 'not-found':
      return { reason: 'sound-not-found', message: 'That sound no longer exists.' };
    case 'download-failed':
      return { reason: 'library-error', message: 'Could not download that attachment. Please try uploading it again.' };
    case 'too-large':
      return { reason: 'bad-attachment', message: 'That file is too large to save in this server.' };
    case 'upload-timeout':
      return {
        reason: 'library-error',
        message: 'Uploading that sound to Discord timed out. Try a smaller file or try again.',
      };
    case 'not-audio':
      return { reason: 'bad-attachment', message: MESSAGES.notAudioAttachment };
    case 'invalid-url':
      return { reason: 'bad-url', message: MESSAGES.invalidUrl };
    case 'channel-unavailable':
      return {
        reason: 'library-error',
        message: 'The sound library channel is unavailable. An administrator should check the bot can access it.',
      };
    case 'not-ready':
      return { reason: 'not-ready', message: MESSAGES.notReady };
  }
}

export function busyElsewhereMessage(botChannelId: string | null): string {
  return botChannelId
    ? `I'm already busy in <#${botChannelId}>. Join that channel, or wait until it finishes.`
    : `I'm already busy in another voice channel. Wait until it finishes.`;
}

export function notInBotChannelMessage(botChannelId: string): string {
  return `Join <#${botChannelId}> to control playback there.`;
}

function playlistNote(tracks: readonly TrackInfo[]): string {
  if (tracks.length <= 1) return '';
  return ` Playlist: ${tracks.length} items (${tracks.length - 1} more queued after it).`;
}

/** User-facing reply for a successful play. */
export function formatPlaySuccess(
  result: Extract<PlayResult, { ok: true }>,
  voiceChannelId: string,
  volume: number,
): string {
  const first = result.tracks[0];
  const title = bold(first?.title ?? result.source.label);
  const head = result.startedNow
    ? `Now playing ${title} in <#${voiceChannelId}> at ${volume}% volume.`
    : `Queued ${title} at position ${result.queuePosition} in <#${voiceChannelId}> (${volume}% volume).`;
  return truncate(head + playlistNote(result.tracks));
}

export function formatStopReply(result: StopResult): string {
  if (result.stopped === null && result.cleared === 0) {
    return 'Stopped playback (nothing had started playing yet).';
  }
  const what = result.stopped ? `Stopped ${bold(result.stopped.title)}` : 'Stopped playback';
  const cleared = result.cleared === 1 ? '1 queued item' : `${result.cleared} queued items`;
  return truncate(`${what} and cleared ${cleared}.`);
}

export function formatSkipReply(result: SkipResult): string {
  const what = result.skipped ? `Skipped ${bold(result.skipped.title)}.` : 'Skipped.';
  const next = result.next ? ` Now playing ${bold(result.next.title)}.` : ' Nothing left in the queue, so I left the channel.';
  return truncate(what + next);
}

export function formatVolumeReply(result: VolumeResult): string {
  return truncate(`Volume for ${bold(result.track.title)} changed from ${result.from}% to ${result.to}%.`);
}
