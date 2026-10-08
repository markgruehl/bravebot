/**
 * Shared constants. Owned by SCAFFOLD; implementers import from here rather than
 * re-declaring magic numbers.
 */

/** Volume is expressed as a percentage everywhere in the public API. */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 200;
export const VOLUME_DEFAULT = 100;

/** Library sound names: unique per guild (case-insensitive), 1-32 chars. */
export const SOUND_NAME_MIN_LENGTH = 1;
export const SOUND_NAME_MAX_LENGTH = 32;

/** Discord limit on autocomplete choices. */
export const AUTOCOMPLETE_LIMIT = 25;

/** Discord message component limits. */
export const MAX_ACTION_ROWS = 5;
export const MAX_BUTTONS_PER_ROW = 5;

/** Discord message history pagination limit (messages per fetch). */
export const HISTORY_PAGE_SIZE = 100;

/** Default channel names (used only when creating; discovery is by topic marker). */
export const LIBRARY_CHANNEL_NAME = 'soundboard-library';
export const LOG_CHANNEL_NAME = 'soundboard-log';

/**
 * Topic markers used to discover the bot's channels. A channel whose topic CONTAINS
 * the marker is considered the bot's channel, so admins may rename the channel or
 * append text to the topic without breaking discovery.
 */
export const LIBRARY_TOPIC_MARKER = 'bravebot:library';
export const LOG_TOPIC_MARKER = 'bravebot:log';

/** Default play mode when none is given (panel buttons, context menu, /play without mode). */
export const DEFAULT_PLAY_MODE = 'interrupt' as const;
