/**
 * Typed errors shared across modules. Owned by SCAFFOLD (fully implemented).
 *
 * Throw these from library/playback code for EXPECTED failures (bad input, missing
 * permissions, not found). Interaction handlers map `code` to a user-facing ephemeral
 * message and an admin-log `failure` event. Anything else is an unexpected error.
 */

export type LibraryErrorCode =
  | 'invalid-name' // fails names.ts validation
  | 'name-taken' // case-insensitive collision with another sound in the guild
  | 'not-found' // no sound with that id/name (or its library message vanished)
  | 'download-failed' // could not download the user's attachment for re-upload
  | 'too-large' // attachment exceeds the guild's upload limit
  | 'upload-timeout' // re-uploading the sound to the library channel timed out
  | 'not-audio' // attachment is not an audio file
  | 'invalid-url' // url is not http(s) / not parseable
  | 'channel-unavailable' // library channel missing or bot lacks access
  | 'not-ready'; // guild library not loaded yet

export class LibraryError extends Error {
  override readonly name = 'LibraryError';
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type PlaybackErrorCode =
  | 'invalid-url' // not an http(s) URL
  | 'unsupported-source' // e.g. attachment is not audio
  | 'extraction-failed' // yt-dlp failed / returned nothing playable
  | 'empty-playlist' // playlist resolved to zero entries
  | 'busy-elsewhere' // bot is connected/playing in a different voice channel of the guild
  | 'join-failed' // could not join / become ready in the voice channel
  | 'playback-failed'; // ffmpeg / audio player error

export class PlaybackError extends Error {
  override readonly name = 'PlaybackError';
  /**
   * Operator-only detail (e.g. yt-dlp/ffmpeg stderr). Goes to the admin log, never to the
   * user, so tool output cannot be used to probe hosts reachable from the bot.
   */
  readonly detail: string | null;
  constructor(
    readonly code: PlaybackErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: string | null },
  ) {
    super(message, options);
    this.detail = options?.detail ?? null;
  }
}

/** Best-effort conversion of an unknown thrown value into a short message for logs. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
