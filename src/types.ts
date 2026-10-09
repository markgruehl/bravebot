/**
 * Shared contracts between the PLAYBACK, LIBRARY, INTERACTIONS, VOICE-ACTIVITY and PING modules.
 * Owned by SCAFFOLD. Change only by agreement: every module codes against these.
 *
 * Conventions
 * - Volume is a percentage (0-200, default 100) everywhere in this API. Only
 *   playback/player.ts converts it to a linear factor (percent / 100).
 * - Ids are Discord snowflake strings.
 * - Nothing here is persisted locally; Discord is the source of truth.
 */

import type { Client, TextChannel, VoiceState } from 'discord.js';
import type { Config } from './config.js';
import type { StatsService } from './stats/types.js';
import type { PlaybackErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Minimal identity of a Discord user, enough for logs and replies. */
export interface UserRef {
  readonly id: string;
  /** Human-readable name (member display name, falling back to username). */
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// Audio sources (what the user ASKED to play, before resolution)
// ---------------------------------------------------------------------------

export type PlayMode = 'interrupt' | 'queue';

/** Where the play request came from (for logs only). */
export type PlayEntryPoint = 'slash' | 'panel' | 'context-menu';

/** One-off uploaded attachment (from /play attachment or the message context menu). */
export interface AttachmentSource {
  readonly type: 'attachment';
  /** The attachment CDN URL as received in the interaction (fresh at request time). */
  readonly url: string;
  readonly filename: string;
  readonly contentType: string | null;
  /** Bytes, if known. */
  readonly size: number | null;
}

/** One-off URL: a direct audio link OR any page yt-dlp understands (incl. playlists). */
export interface UrlSource {
  readonly type: 'url';
  readonly url: string;
}

/** Saved library sound. Resolved at play time (never cache attachment URLs). */
export interface LibrarySource {
  readonly type: 'library';
  readonly sound: LibrarySound;
}

export type AudioSource = AttachmentSource | UrlSource | LibrarySource;

/**
 * Loggable, non-expiring description of a source. For one-off uploads this is
 * filename + link (the admin log must NOT re-attach the file).
 */
export interface SourceSummary {
  readonly type: AudioSource['type'];
  /** Short human label: filename, URL, or library sound name. */
  readonly label: string;
  /** Link for the admin log (attachment URL, page URL or saved link). Optional for library files. */
  readonly url: string | null;
  /** Library sound name, when played from the library. */
  readonly libraryName: string | null;
}

// ---------------------------------------------------------------------------
// Resolved tracks (what the player actually plays)
// ---------------------------------------------------------------------------

/**
 * How to obtain audio for a single track AT PLAY TIME. Resolution is lazy so that
 * expiring URLs (Discord CDN attachments, googlevideo URLs) are fetched fresh right
 * before ffmpeg starts, even for items that sat in the queue for a long time.
 */
export type TrackInput =
  /** ffmpeg reads this URL directly (one-off attachment, direct audio link). */
  | { readonly kind: 'direct'; readonly url: string }
  /** A page URL; yt-dlp extracts the media at play time. */
  | { readonly kind: 'ytdlp'; readonly url: string }
  /** A library file sound; the player re-fetches the library message for a fresh attachment URL. */
  | { readonly kind: 'library-file'; readonly guildId: string; readonly soundId: string };

/** Output of sources.ts resolution: one entry per playable item (playlists expand to many). */
export interface ResolvedTrack {
  /** Display title (yt-dlp title, filename, or library name). */
  readonly title: string;
  readonly input: TrackInput;
  /** Duration in seconds if known (informational only; there is no length cap). */
  readonly durationSec: number | null;
}

/** Public, immutable info about a queued/playing track. Safe to log and to show users. */
export interface TrackInfo {
  /** Unique id for this queue entry (e.g. crypto.randomUUID()). */
  readonly id: string;
  readonly title: string;
  readonly source: SourceSummary;
  readonly requester: UserRef;
  /** Requested volume percent for this track (0-200). /volume updates the CURRENT track only. */
  readonly volume: number;
  readonly requestedAt: Date;
  /** Index within a playlist expansion (0-based) and its size; 0/1 for single tracks. */
  readonly playlistIndex: number;
  readonly playlistSize: number;
}

/** A queue entry: public info + how to get the audio. This is what queue.ts stores. */
export interface QueueItem extends TrackInfo {
  readonly input: TrackInput;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PlayRequest {
  readonly guildId: string;
  /** The voice channel the REQUESTER is currently in (validated by interactions). */
  readonly voiceChannelId: string;
  readonly requester: UserRef;
  readonly source: AudioSource;
  readonly mode: PlayMode;
  /** Percent 0-200. The player clamps defensively. */
  readonly volume: number;
  readonly via: PlayEntryPoint;
}

export type PlayResult =
  | {
      readonly ok: true;
      /** Every enqueued track, in order (length > 1 for playlists). */
      readonly tracks: readonly TrackInfo[];
      /** True when the first track started immediately (interrupt, or queue was idle). */
      readonly startedNow: boolean;
      /** 1-based position of the first track in the upcoming queue when not started now, else 0. */
      readonly queuePosition: number;
      readonly source: SourceSummary;
    }
  | {
      readonly ok: false;
      readonly code: PlaybackErrorCode;
      /** User-facing explanation (short, no stack traces). */
      readonly message: string;
      /** Operator-only detail for the admin log (tool stderr etc.); never shown to users. */
      readonly detail?: string | null;
      readonly source: SourceSummary;
    };

export type PlaybackState = 'idle' | 'connecting' | 'playing';

export interface GuildPlaybackStatus {
  readonly guildId: string;
  /** Voice channel the bot is connected (or connecting) to in this guild, else null. */
  readonly channelId: string | null;
  readonly state: PlaybackState;
  readonly current: TrackInfo | null;
  /** Live volume percent of the current track, else null. */
  readonly currentVolume: number | null;
  readonly upcoming: readonly TrackInfo[];
}

export interface StopResult {
  /** Track that was playing, if any (null e.g. when stopped while still joining). */
  readonly stopped: TrackInfo | null;
  /** Number of upcoming items removed. */
  readonly cleared: number;
}

export interface SkipResult {
  readonly skipped: TrackInfo | null;
  /** What starts next, or null if playback ended (bot leaves). */
  readonly next: TrackInfo | null;
}

export interface VolumeResult {
  readonly track: TrackInfo;
  readonly from: number;
  readonly to: number;
}

/** Events the player emits so index.ts can forward them to the admin log. */
export interface PlayerEvents {
  /** A track actually began producing audio. */
  trackStart: [event: { guildId: string; channelId: string; track: TrackInfo }];
  /** A track failed at play time (yt-dlp/ffmpeg/fresh-URL errors). Playback advances to the next item. */
  trackError: [
    event: {
      guildId: string;
      channelId: string;
      track: TrackInfo;
      code: PlaybackErrorCode;
      error: Error;
    },
  ];
  /** Queue drained (or stopped / bot disconnected) and the bot left the voice channel. */
  idle: [event: { guildId: string; channelId: string | null }];
}

export type PlayerEventName = keyof PlayerEvents;
export type PlayerEventListener<E extends PlayerEventName> = (...args: PlayerEvents[E]) => void;

/**
 * Per-guild playback manager on top of @discordjs/voice. One voice connection per
 * guild. Semantics (see the confirmed spec):
 * - play(): reject with code 'busy-elsewhere' if the bot is connected in a DIFFERENT
 *   channel of that guild (both modes). Check before AND after (slow) source resolution.
 * - mode 'interrupt' replaces ONLY the current track; upcoming items remain.
 * - Playlists: the mode applies to the FIRST item; remaining items are APPENDED to the
 *   END of the upcoming queue.
 * - Leave the voice channel immediately when nothing is left to play.
 */
export interface PlayerManager {
  /** Resolves once the source is resolved and enqueued (NOT when playback finishes). Never throws for expected failures. */
  play(request: PlayRequest): Promise<PlayResult>;
  /**
   * Stop playback AND clear the queue; leaves the channel (also while still joining).
   * Also cancels plays that are still resolving their source. Null only when the bot had
   * no session in the guild (not connected / connecting).
   */
  stop(guildId: string): StopResult | null;
  /** Skip to the next upcoming item; if none, ends playback (leaves). Null when nothing was playing. */
  skip(guildId: string): SkipResult | null;
  /** Change the live volume of the CURRENT track (percent, clamped 0-200). Null when nothing is playing. */
  setVolume(guildId: string, percent: number): VolumeResult | null;
  getStatus(guildId: string): GuildPlaybackStatus;
  /** Voice channel the bot currently occupies in the guild (connected or connecting), else null. */
  currentChannelId(guildId: string): string | null;
  /**
   * True when the bot is connected/playing in a voice channel of this guild that is
   * NOT `channelId`. Cheap pre-check for interactions before deferring.
   */
  isBusyElsewhere(guildId: string, channelId: string): boolean;
  /**
   * True while a play() targeting `channelId` is still resolving/joining (not yet enqueued
   * or failed). Lets /stop cancel it before the bot has joined any channel.
   */
  hasPendingPlay(guildId: string, channelId: string): boolean;
  /** Bookkeeping for the bot's OWN voice state (forcibly disconnected / moved by an admin). Ignores other members. */
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void;
  /** Tear down a guild (guildDelete). */
  destroyGuild(guildId: string): void;
  /** Tear down everything (shutdown). */
  destroyAll(): void;
  on<E extends PlayerEventName>(event: E, listener: PlayerEventListener<E>): this;
  off<E extends PlayerEventName>(event: E, listener: PlayerEventListener<E>): this;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export type LibrarySoundKind = 'file' | 'link';

interface LibrarySoundBase {
  /** The library message id (stable identity of the sound). */
  readonly id: string;
  readonly guildId: string;
  /** Display name, case preserved. Uniqueness is case-insensitive. */
  readonly name: string;
  /** User id of whoever added it (used for Create Expressions rename/delete rights). */
  readonly addedBy: string;
  readonly addedAt: Date;
}

/** Audio was re-uploaded by the bot as the library message's attachment. */
export interface LibraryFileSound extends LibrarySoundBase {
  readonly kind: 'file';
  readonly filename: string;
}

/** Only the link is stored; resolved fresh (direct fetch or yt-dlp, playlists expand) on every play. */
export interface LibraryLinkSound extends LibrarySoundBase {
  readonly kind: 'link';
  readonly url: string;
}

export type LibrarySound = LibraryFileSound | LibraryLinkSound;

/**
 * Metadata serialized into the library message CONTENT by library/format.ts.
 * `id` and `guildId` come from the message itself, not the content.
 */
export type LibrarySoundMetadata =
  | {
      readonly v: 1;
      readonly kind: 'file';
      readonly name: string;
      readonly addedBy: string;
      /** ISO-8601 */
      readonly addedAt: string;
      readonly filename: string;
    }
  | {
      readonly v: 1;
      readonly kind: 'link';
      readonly name: string;
      readonly addedBy: string;
      readonly addedAt: string;
      readonly url: string;
    };

export type AddSoundInput =
  | {
      readonly kind: 'file';
      readonly name: string;
      readonly addedBy: string;
      /** The user's attachment URL; the store downloads it NOW and re-uploads the bytes. */
      readonly attachmentUrl: string;
      readonly filename: string;
      readonly contentType: string | null;
      readonly size: number | null;
    }
  | {
      readonly kind: 'link';
      readonly name: string;
      readonly addedBy: string;
      readonly url: string;
    };

/**
 * Discord-backed, per-guild sound library. The in-memory index is a cache; the
 * library channel's bot-authored messages are the source of truth.
 * Mutations throw LibraryError (src/errors.ts) for expected failures.
 * Implementations serialize mutations per guild so uniqueness checks are race-free.
 */
export interface LibraryStore {
  readonly guildId: string;
  /** (Re)build the index by paginating the full channel history (100/page), bot-authored messages only. */
  load(): Promise<void>;
  /** True once load() has completed at least once. */
  readonly loaded: boolean;
  /** All sounds, sorted by name (case-insensitive). */
  list(): readonly LibrarySound[];
  /** Case-insensitive match on name (prefix matches first, then substring); at most `limit` (default 25). */
  search(query: string, limit?: number): readonly LibrarySound[];
  getById(id: string): LibrarySound | undefined;
  /** Case-insensitive exact name lookup. */
  getByName(name: string): LibrarySound | undefined;
  add(input: AddSoundInput): Promise<LibrarySound>;
  /** Returns the updated sound. Throws LibraryError('name-taken' | 'invalid-name' | 'not-found'). */
  rename(id: string, newName: string): Promise<LibrarySound>;
  /** Deletes the library message; returns the removed sound. */
  delete(id: string): Promise<LibrarySound>;
  /**
   * Re-fetch the library message and return its CURRENT attachment URL. Never cached.
   * Throws LibraryError('not-found') (and drops it from the index) if the message is gone.
   */
  freshAttachmentUrl(id: string): Promise<string>;
  /**
   * Drop sounds from the index whose library messages were deleted outside the bot
   * (e.g. an admin deleted the message by hand). Unknown ids are ignored. Synchronous.
   */
  forget(ids: Iterable<string>): void;
}

// ---------------------------------------------------------------------------
// Guild channels / per-guild state
// ---------------------------------------------------------------------------

export interface GuildChannels {
  /** Private #soundboard-library (topic contains LIBRARY_TOPIC_MARKER). */
  readonly library: TextChannel;
  /** Private #soundboard-log (topic contains LOG_TOPIC_MARKER). */
  readonly log: TextChannel;
}

export interface GuildState {
  readonly channels: GuildChannels;
  readonly library: LibraryStore;
}

/** In-memory registry, rebuilt on ready/guildCreate. */
export type GuildRegistry = Map<string, GuildState>;

// ---------------------------------------------------------------------------
// Admin log
// ---------------------------------------------------------------------------

export type FailureReason =
  | 'not-in-voice' // requester is not in a voice channel
  | 'unsupported-channel' // requester is in a Stage channel (bot would join suppressed)
  | 'missing-permission' // lacks Use Soundboard / Create / Manage Expressions
  | 'not-in-bot-channel' // control command from someone not in the bot's voice channel
  | 'nothing-playing'
  | 'busy-elsewhere'
  | 'bad-url'
  | 'bad-attachment'
  | 'extraction-failed'
  | 'playback-failed'
  | 'join-failed'
  | 'sound-not-found'
  | 'invalid-name'
  | 'name-taken'
  | 'library-error'
  | 'not-ready'
  | 'stats-unavailable' // /stats could not read the system channel history
  | 'internal-error';

interface LogEventBase {
  readonly at: Date;
}

export type AdminLogEvent =
  | (LogEventBase & {
      readonly type: 'play';
      readonly user: UserRef;
      readonly voiceChannelId: string;
      readonly source: SourceSummary;
      readonly mode: PlayMode;
      readonly volume: number;
      /** Number of items enqueued (> 1 for playlists). */
      readonly itemCount: number;
      readonly via: PlayEntryPoint;
    })
  | (LogEventBase & {
      readonly type: 'stop';
      readonly user: UserRef;
      readonly voiceChannelId: string;
      readonly stopped: TrackInfo | null;
      readonly cleared: number;
    })
  | (LogEventBase & {
      readonly type: 'skip';
      readonly user: UserRef;
      readonly voiceChannelId: string;
      readonly skipped: TrackInfo | null;
      readonly next: TrackInfo | null;
    })
  | (LogEventBase & {
      readonly type: 'volume';
      readonly user: UserRef;
      readonly voiceChannelId: string;
      readonly track: TrackInfo;
      readonly from: number;
      readonly to: number;
    })
  | (LogEventBase & {
      readonly type: 'library-add';
      readonly user: UserRef;
      readonly sound: LibrarySound;
    })
  | (LogEventBase & {
      readonly type: 'library-rename';
      readonly user: UserRef;
      readonly sound: LibrarySound;
      readonly oldName: string;
    })
  | (LogEventBase & {
      readonly type: 'library-delete';
      readonly user: UserRef;
      readonly sound: LibrarySound;
    })
  | (LogEventBase & {
      readonly type: 'failure';
      /** Null for failures not tied to a user action (rare). */
      readonly user: UserRef | null;
      readonly reason: FailureReason;
      /** What was attempted, e.g. "/play", "panel button", "/sound add", "track playback". */
      readonly action: string;
      readonly voiceChannelId: string | null;
      readonly source: SourceSummary | null;
      /** Short detail (error message, missing permission name, ...). */
      readonly detail: string | null;
    });

export type AdminLogEventType = AdminLogEvent['type'];

/**
 * Posts events to the guild's #soundboard-log. Must never throw (log + swallow).
 * Must send with allowedMentions: { parse: [] } so log lines never ping anyone.
 */
export interface AdminLog {
  log(guildId: string, event: AdminLogEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// App context (built in index.ts, passed to interaction, voice-activity and ping handlers)
// ---------------------------------------------------------------------------

export interface BotContext {
  readonly client: Client;
  readonly config: Config;
  readonly players: PlayerManager;
  readonly guilds: GuildRegistry;
  readonly adminLog: AdminLog;
  /** Voice stats: in-memory event cache built from system-channel notices (src/stats/cache.ts). */
  readonly stats: StatsService;
  /**
   * Fire-and-forget: re-run guild setup (channels + library index) when the guild has no
   * GuildState, no setup is pending and the per-guild retry cooldown has elapsed. Never
   * throws or blocks, so it is safe within the 3s interaction ack deadline. Optional so
   * tests can omit it.
   */
  readonly ensureGuild?: (guildId: string) => void;
}
