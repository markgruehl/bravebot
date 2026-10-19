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

// ---------------------------------------------------------------------------
// Voice stats
// ---------------------------------------------------------------------------

/** All local-time stats (heatmap, streaks, night owl, prime time) use this IANA zone. */
export const STATS_TIMEZONE = 'America/Toronto';

/** /stats `days` option. */
export const STATS_DAYS_MIN = 1;
export const STATS_DAYS_MAX = 365;
export const STATS_DAYS_DEFAULT = 30;

/** History kept in memory: twice the max window, so the 365-day trend has a previous period. */
export const STATS_CACHE_DAYS = STATS_DAYS_MAX * 2;

/** A session with no leave notice is capped at this length after the user's last notice. */
export const STATS_MISSED_LEAVE_CAP_MS = 12 * 60 * 60 * 1000;

/** Ratio/average rankings (average session, night owl, starter/closer) need this much activity. */
export const STATS_MIN_SESSIONS = 3;
export const STATS_MIN_TOTAL_MS = 60 * 60 * 1000;

/** A local day counts toward a streak with at least this much time in voice. */
export const STATS_STREAK_MIN_MS = 60 * 1000;

/** Night owl: local hours [start, end). */
export const STATS_NIGHT_START_HOUR = 0;
export const STATS_NIGHT_END_HOUR = 6;

/** List lengths on the stats pages. */
export const STATS_TOP_PEOPLE = 10;
export const STATS_TOP_OTHER = 5;

/** Discord embed limits. */
export const EMBED_TITLE_LIMIT = 256;
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_FIELD_NAME_LIMIT = 256;
export const EMBED_FIELD_VALUE_LIMIT = 1024;
export const EMBED_FIELDS_MAX = 25;
export const EMBED_FOOTER_LIMIT = 2048;
export const EMBED_TOTAL_LIMIT = 6000;
