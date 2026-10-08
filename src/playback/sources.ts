/**
 * Source validation + resolution (PLAYBACK implementer).
 *
 * - resolveSource(): turns an AudioSource into one ResolvedTrack per playable item.
 *   URLs: direct audio links become {kind:'direct'}; anything else goes through
 *   yt-dlp (`--flat-playlist -J`) and playlists expand to EVERY entry as {kind:'ytdlp'}.
 *   Library file sounds become {kind:'library-file'} (fresh URL fetched at play time);
 *   library link sounds resolve exactly like a UrlSource (title may use the sound name).
 * - openTrackInput(): spawns ffmpeg (and yt-dlp where needed) at PLAY time and returns
 *   raw PCM (s16le, 48 kHz, stereo) suitable for createAudioResource(StreamType.Raw,
 *   inlineVolume: true).
 * Throws PlaybackError (src/errors.ts) for expected failures.
 * Binaries: `ffmpeg` and `yt-dlp` are on PATH (Docker image / local install).
 *
 * Security:
 * - Only absolute http(s) URLs are accepted (no file:, data:, concat:, ...).
 * - User-supplied URLs (one-off and saved links, checked on every resolve) whose host is,
 *   or resolves to, a loopback/private/link-local/CGNAT/ULA/multicast/unspecified address
 *   are rejected. NOT covered: DNS rebinding between the check and the fetch, redirects
 *   that yt-dlp/ffmpeg follow to private hosts, and URLs inside extractor output. Run the
 *   container on an egress-restricted network if that matters.
 * - Raw yt-dlp/ffmpeg stderr is never shown to users (PlaybackError.detail is admin-log only).
 * - ffmpeg gets `-protocol_whitelist` so a remote playlist/manifest cannot pull in
 *   local files or other protocols.
 * - yt-dlp gets `--` before the URL so a URL can never be parsed as an option.
 * - Processes are spawned directly (argv array), never through a shell.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';
import { errorMessage, PlaybackError, type PlaybackErrorCode } from '../errors.js';
import type { AudioSource, LibrarySound, ResolvedTrack, SourceSummary, TrackInput } from '../types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FFMPEG_BIN = 'ffmpeg';
const YTDLP_BIN = 'yt-dlp';

/** Upper bound for a URL we hand to ffmpeg / yt-dlp. */
const MAX_URL_LENGTH = 4096;
/** Max time for `yt-dlp -J` (resolution, incl. large flat playlists). */
const RESOLVE_TIMEOUT_MS = 120_000;
/** Max JSON size accepted from `yt-dlp -J` (huge playlists can be several MB). */
const RESOLVE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/** Max time between spawning the pipeline and the first PCM bytes. */
const OPEN_TIMEOUT_MS = 60_000;
/** Max title length kept from extractors (titles end up in Discord messages). */
const MAX_TITLE_LENGTH = 200;
/** Bytes of stderr kept per child process for error messages. */
const STDERR_TAIL_BYTES = 4096;
/** Max length of an error detail derived from tool output. */
const MAX_DETAIL_LENGTH = 300;

/** ffmpeg protocols allowed when reading a URL directly. */
export const FFMPEG_URL_PROTOCOLS = 'http,https,tls,tcp,crypto';
/** ffmpeg protocols allowed when reading from yt-dlp's stdout. */
export const FFMPEG_PIPE_PROTOCOLS = 'pipe';

/**
 * Audio file extensions accepted for ATTACHMENTS (one-off and /sound add). Single source
 * of truth (library/store.ts uses it too). webm is included because audio-only webm is
 * common (browsers / Discord voice messages label it that way). Video-only containers are not.
 */
const AUDIO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'wave',
  'ogg',
  'oga',
  'opus',
  'flac',
  'm4a',
  'aac',
  'weba',
  'webm',
  'wma',
  'aif',
  'aiff',
  'amr',
  'caf',
  'mka',
  'mp2',
  'ac3',
]);

/** Extensions ffmpeg can read straight from a one-off/saved URL (audio + audio-bearing video). */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...AUDIO_ATTACHMENT_EXTENSIONS,
  // video containers with audio tracks
  'mp4',
  'm4v',
  'mov',
  'mkv',
  '3gp',
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
const FORBIDDEN_URL_CHARS = /[\s\u0000-\u001f\u007f]/;

/** Parse and normalize an absolute http(s) URL; null when invalid or another scheme. */
export function normalizeHttpUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (FORBIDDEN_URL_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  return url.href;
}

/** True for absolute http: / https: URLs. */
export function isHttpUrl(value: string): boolean {
  return normalizeHttpUrl(value) !== null;
}

/** Lower-cased extension of a filename or path ('' when none). */
export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * THE audio check for attachments (used by /play, the context menu, /sound add and the
 * library store): audio/* content type (MIME params ignored), or a known audio extension.
 */
export function isAudioAttachment(attachment: { contentType: string | null; filename: string }): boolean {
  const type = attachment.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('audio/')) return true;
  return AUDIO_ATTACHMENT_EXTENSIONS.has(fileExtension(attachment.filename));
}

// ---------------------------------------------------------------------------
// Private-address guard (SSRF hardening for user-supplied URLs)
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const PRIVATE_V4_RANGES: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this" network / unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable: treat as unsafe
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base)!;
    return value >= start && value < start + size;
  });
}

/** Expand an IPv6 address into 8 16-bit groups (null when malformed). */
function ipv6Groups(ip: string): number[] | null {
  let address = ip.toLowerCase().split('%')[0] ?? '';
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4).
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (v4) {
    const value = ipv4ToInt(v4[1]!);
    if (value === null) return null;
    address = `${address.slice(0, -v4[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/**
 * Pure: true for addresses the bot must not fetch on a user's behalf: loopback, RFC 1918,
 * link-local, CGNAT, unspecified, multicast/reserved, IPv6 ULA/link-local/multicast, and
 * IPv4-mapped/compatible forms of any private IPv4. Unparseable input counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const allZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): check the embedded IPv4.
  if (allZeroPrefix && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return isPrivateV4(v4);
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0064 && g[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64: check the embedded IPv4.
    return isPrivateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  }
  return false;
}

/** DNS lookup returning every address for a host (injectable for tests). */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

const defaultLookup: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const PRIVATE_HOST_MESSAGE = 'That link points to a private or local address.';

/** Throw PlaybackError('invalid-url') when the URL's host is, or resolves to, a private address. */
export async function assertPublicHost(url: string, lookupHost: HostLookup = defaultLookup): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new PlaybackError('invalid-url', PRIVATE_HOST_MESSAGE);
  }
  let addresses: readonly string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookupHost(hostname);
    } catch (err) {
      throw new PlaybackError('invalid-url', 'Could not find that website (DNS lookup failed).', {
        cause: err,
        detail: `DNS lookup failed for ${hostname}: ${errorMessage(err)}`,
      });
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new PlaybackError('invalid-url', PRIVATE_HOST_MESSAGE, { detail: `host ${hostname} -> ${addresses.join(', ')}` });
  }
}

/** True when the URL path ends in a known media extension (ffmpeg can read it directly). */
export function isDirectMediaUrl(value: string): boolean {
  const normalized = normalizeHttpUrl(value);
  if (normalized === null) return false;
  return MEDIA_EXTENSIONS.has(fileExtension(new URL(normalized).pathname));
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Pure: non-expiring, loggable summary of a source (one-off uploads: filename + link). */
export function summarizeSource(source: AudioSource): SourceSummary {
  switch (source.type) {
    case 'attachment':
      return { type: 'attachment', label: source.filename, url: source.url, libraryName: null };
    case 'url':
      return { type: 'url', label: source.url, url: source.url, libraryName: null };
    case 'library':
      return {
        type: 'library',
        label: source.sound.name,
        url: source.sound.kind === 'link' ? source.sound.url : null,
        libraryName: source.sound.name,
      };
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function clampTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstHttpUrl(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeHttpUrl(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

/** Best-effort title from a URL's last path segment. */
export function titleFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split('/').filter(Boolean).pop();
    if (segment) {
      try {
        return clampTitle(decodeURIComponent(segment));
      } catch {
        return clampTitle(segment);
      }
    }
    return clampTitle(url.hostname);
  } catch {
    return clampTitle(value);
  }
}

/**
 * Pure: turn `yt-dlp -J --flat-playlist` output into tracks.
 * Playlists expand to one {kind:'ytdlp'} track per entry (entries without a usable
 * http(s) URL are skipped). Throws PlaybackError('extraction-failed' | 'empty-playlist').
 */
export function tracksFromYtDlpInfo(info: unknown, requestedUrl: string): ResolvedTrack[] {
  const root = asRecord(info);
  if (!root) throw new PlaybackError('extraction-failed', 'Could not read media information for that link.');

  const isPlaylist = root._type === 'playlist' || root._type === 'multi_video' || Array.isArray(root.entries);
  if (isPlaylist) {
    const entries = Array.isArray(root.entries) ? root.entries : [];
    const tracks: ResolvedTrack[] = [];
    for (const raw of entries) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const url = firstHttpUrl(entry.url, entry.webpage_url, entry.original_url);
      if (url === null) continue;
      tracks.push({
        title: clampTitle(nonEmptyString(entry.title) ?? url),
        input: { kind: 'ytdlp', url },
        durationSec: duration(entry.duration),
      });
    }
    if (tracks.length === 0) throw new PlaybackError('empty-playlist', 'That playlist has no playable items.');
    return tracks;
  }

  const url = firstHttpUrl(root.webpage_url, root.original_url, requestedUrl);
  if (url === null) throw new PlaybackError('extraction-failed', 'Could not find a playable link.');
  return [
    {
      title: clampTitle(nonEmptyString(root.title) ?? titleFromUrl(requestedUrl)),
      input: { kind: 'ytdlp', url },
      durationSec: duration(root.duration),
    },
  ];
}

/** argv for resolving a URL (metadata only, playlists flattened for speed). */
export function buildYtDlpResolveArgs(url: string): string[] {
  return [
    '--dump-single-json',
    '--flat-playlist',
    // A URL that is both a video and a playlist (watch?v=..&list=..) plays just the video.
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-cache-dir',
    '--socket-timeout',
    '20',
    '--',
    url,
  ];
}

/** argv for streaming a single item's best audio to stdout at play time. */
export function buildYtDlpStreamArgs(url: string): string[] {
  return [
    '--format',
    'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-part',
    '--no-cache-dir',
    '--socket-timeout',
    '20',
    '--output',
    '-',
    '--',
    url,
  ];
}

/** argv for ffmpeg: read a URL (or stdin) and write s16le 48 kHz stereo PCM to stdout. */
export function buildFfmpegArgs(input: { kind: 'url'; url: string } | { kind: 'pipe' }): string[] {
  const output = ['-vn', '-sn', '-dn', '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
  const common = ['-hide_banner', '-loglevel', 'error'];
  if (input.kind === 'pipe') {
    return [...common, '-protocol_whitelist', FFMPEG_PIPE_PROTOCOLS, '-i', 'pipe:0', ...output];
  }
  return [
    ...common,
    '-nostdin',
    '-protocol_whitelist',
    FFMPEG_URL_PROTOCOLS,
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-i',
    input.url,
    ...output,
  ];
}

/** Pull the most useful line out of a tool's stderr (yt-dlp "ERROR: ..." lines first). */
export function summarizeToolError(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  const chosen = errorLine?.replace(/^ERROR:\s*/, '') ?? lines.at(-1) ?? null;
  if (chosen === null) return null;
  return chosen.length > MAX_DETAIL_LENGTH ? `${chosen.slice(0, MAX_DETAIL_LENGTH - 1)}…` : chosen;
}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a binary without a shell, collecting output, with a timeout, an stdout cap and an optional abort signal. */
function runProcess(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  maxStdout: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${bin} cancelled`));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const killChild = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const onAbort = (): void => {
      killChild();
      finish(() => reject(new Error(`${bin} cancelled`)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killChild();
      finish(() => reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        killChild();
        finish(() => reject(new Error(`${bin} produced too much output`)));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) =>
      finish(() => resolve({ code, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr })),
    );
  });
}

/** Generic user-facing message for resolve failures (tool output goes to `detail` only). */
const COULD_NOT_READ_LINK = 'Could not read that link.';

/** Run `yt-dlp -J --flat-playlist` and parse its JSON. Throws PlaybackError('extraction-failed'). */
export async function runYtDlpResolve(url: string, signal?: AbortSignal): Promise<unknown> {
  let result: ProcessResult;
  try {
    result = await runProcess(YTDLP_BIN, buildYtDlpResolveArgs(url), RESOLVE_TIMEOUT_MS, RESOLVE_MAX_STDOUT_BYTES, signal);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new PlaybackError('extraction-failed', missing ? 'yt-dlp is not installed on the bot host.' : COULD_NOT_READ_LINK, {
      cause: err,
      detail: errorMessage(err),
    });
  }
  if (result.code !== 0) {
    const detail = summarizeToolError(result.stderr) ?? `yt-dlp exited with code ${String(result.code)}`;
    throw new PlaybackError('extraction-failed', COULD_NOT_READ_LINK, { detail });
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (err) {
    throw new PlaybackError('extraction-failed', 'Could not read media information for that link.', { cause: err });
  }
}

export interface ResolveDeps {
  /** Returns parsed `yt-dlp -J --flat-playlist` output for a URL. Kills yt-dlp when `signal` aborts. */
  ytDlpResolve(url: string, signal?: AbortSignal): Promise<unknown>;
  /** DNS lookup for the private-address guard. Defaults to dns.promises.lookup. */
  lookupHost?: HostLookup;
  /** Cancels resolution (e.g. /stop while a playlist is still resolving). */
  signal?: AbortSignal;
}

const defaultResolveDeps: ResolveDeps = { ytDlpResolve: runYtDlpResolve };

async function resolveUrl(rawUrl: string, deps: ResolveDeps): Promise<ResolvedTrack[]> {
  const url = normalizeHttpUrl(rawUrl.trim());
  if (url === null) throw new PlaybackError('invalid-url', 'That is not a valid http(s) link.');
  await assertPublicHost(url, deps.lookupHost);
  if (isDirectMediaUrl(url)) {
    return [{ title: titleFromUrl(url), input: { kind: 'direct', url }, durationSec: null }];
  }
  return tracksFromYtDlpInfo(await deps.ytDlpResolve(url, deps.signal), url);
}

async function resolveLibrarySound(sound: LibrarySound, deps: ResolveDeps): Promise<ResolvedTrack[]> {
  if (sound.kind === 'file') {
    return [
      {
        title: sound.name,
        input: { kind: 'library-file', guildId: sound.guildId, soundId: sound.id },
        durationSec: null,
      },
    ];
  }
  const tracks = await resolveUrl(sound.url, deps);
  // A single saved link is shown under its library name; playlist items keep their own titles.
  if (tracks.length === 1 && tracks[0]) return [{ ...tracks[0], title: sound.name }];
  return tracks;
}

/** resolveSource with injectable dependencies (tests). */
export async function resolveSourceWith(source: AudioSource, deps: ResolveDeps): Promise<ResolvedTrack[]> {
  switch (source.type) {
    case 'attachment': {
      if (!isAudioAttachment(source)) {
        throw new PlaybackError('unsupported-source', 'That attachment does not look like an audio file.');
      }
      const url = normalizeHttpUrl(source.url);
      if (url === null) throw new PlaybackError('invalid-url', 'That attachment has an invalid link.');
      return [{ title: clampTitle(source.filename) || 'attachment', input: { kind: 'direct', url }, durationSec: null }];
    }
    case 'url':
      return resolveUrl(source.url, deps);
    case 'library':
      return resolveLibrarySound(source.sound, deps);
  }
}

/** Resolve to >= 1 tracks or throw PlaybackError('invalid-url' | 'unsupported-source' | 'extraction-failed' | 'empty-playlist'). */
export async function resolveSource(source: AudioSource, signal?: AbortSignal): Promise<ResolvedTrack[]> {
  return resolveSourceWith(source, signal ? { ...defaultResolveDeps, signal } : defaultResolveDeps);
}

// ---------------------------------------------------------------------------
// Opening a track at play time
// ---------------------------------------------------------------------------

export interface OpenTrackDeps {
  /** Fresh attachment URL for a library file sound (LibraryStore.freshAttachmentUrl). */
  freshAttachmentUrl(guildId: string, soundId: string): Promise<string>;
}

export interface TrackStream {
  /** Raw PCM: signed 16-bit little-endian, 48000 Hz, 2 channels. */
  readonly stream: Readable;
  /** Kill spawned child processes (ffmpeg / yt-dlp). Idempotent. */
  kill(): void;
}

type PipelinePlan = { readonly kind: 'url'; readonly url: string } | { readonly kind: 'ytdlp'; readonly url: string };

/** Decide what to spawn for a track; fetches fresh library attachment URLs. */
async function planInput(input: TrackInput, deps: OpenTrackDeps): Promise<PipelinePlan> {
  switch (input.kind) {
    case 'direct': {
      const url = normalizeHttpUrl(input.url);
      if (url === null) throw new PlaybackError('playback-failed', 'Invalid audio link.');
      return { kind: 'url', url };
    }
    case 'ytdlp': {
      const url = normalizeHttpUrl(input.url);
      if (url === null) throw new PlaybackError('extraction-failed', 'Invalid media link.');
      return { kind: 'ytdlp', url };
    }
    case 'library-file': {
      let fresh: string;
      try {
        fresh = await deps.freshAttachmentUrl(input.guildId, input.soundId);
      } catch (err) {
        throw new PlaybackError('playback-failed', `Library sound unavailable: ${errorMessage(err)}`, { cause: err });
      }
      const url = normalizeHttpUrl(fresh);
      if (url === null) throw new PlaybackError('playback-failed', 'Library sound has an invalid attachment link.');
      return { kind: 'url', url };
    }
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function stderrTail(child: ChildProcess): () => string {
  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr?.on('error', () => {});
  return () => tail;
}

function spawnErrorMessage(bin: string, err: Error): string {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
    ? `${bin} is not installed on the bot host.`
    : `Could not start ${bin}: ${err.message}`;
}

/**
 * Spawn [yt-dlp |] ffmpeg and resolve once the first PCM bytes arrive (so failures before
 * any audio surface as a rejected PlaybackError). Errors after that point are emitted as
 * 'error' on the returned stream (the AudioPlayer reports them).
 */
function spawnPipeline(plan: PipelinePlan, signal?: AbortSignal): Promise<TrackStream> {
  return new Promise<TrackStream>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const ytdlp: ChildProcess | null =
      plan.kind === 'ytdlp'
        ? spawn(YTDLP_BIN, buildYtDlpStreamArgs(plan.url), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : null;
    const ytdlpStderr: () => string = ytdlp ? stderrTail(ytdlp) : () => '';

    const ffmpeg = spawn(
      FFMPEG_BIN,
      buildFfmpegArgs(plan.kind === 'ytdlp' ? { kind: 'pipe' } : { kind: 'url', url: plan.url }),
      { stdio: [ytdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const ffmpegStderr = stderrTail(ffmpeg);

    const out = new PassThrough();
    // The AudioResource pipeline handles stream errors; this keeps a stray error from
    // crashing the process if it happens before/after the resource is attached.
    out.on('error', () => {});
    ffmpeg.stdout?.on('error', () => {});
    ffmpeg.stdout?.pipe(out);

    const ytdlpClosed = ytdlp
      ? new Promise<void>((done) => {
          ytdlp.once('close', () => done());
          ytdlp.once('error', () => done());
        })
      : Promise.resolve();
    if (ytdlp && ffmpeg.stdin) {
      ffmpeg.stdin.on('error', () => {}); // EPIPE when ffmpeg exits first
      ytdlp.stdout?.on('error', () => {});
      ytdlp.stdout?.pipe(ffmpeg.stdin);
    }

    let killed = false;
    let settled = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      for (const child of [ytdlp, ffmpeg]) {
        if (child && isRunning(child)) child.kill('SIGKILL');
      }
      ffmpeg.stdout?.unpipe(out);
      out.destroy();
    };

    const onAbort = (): void => fail(cancelledError());
    const fail = (err: PlaybackError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      kill();
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      fail(
        new PlaybackError(
          ytdlp ? 'extraction-failed' : 'playback-failed',
          `Timed out after ${OPEN_TIMEOUT_MS / 1000}s waiting for audio.`,
        ),
      );
    }, OPEN_TIMEOUT_MS);

    ffmpeg.stdout?.once('data', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stream: out, kill });
    });

    const failureFromOutput = (fallbackCode: PlaybackErrorCode, fallback: string): PlaybackError => {
      const ytError = ytdlp ? ytdlpStderr() : '';
      if (ytdlp && (ytdlp.exitCode ?? 0) !== 0) {
        const detail = summarizeToolError(ytError) ?? `yt-dlp exited with code ${String(ytdlp.exitCode)}`;
        return new PlaybackError('extraction-failed', detail);
      }
      return new PlaybackError(fallbackCode, summarizeToolError(ffmpegStderr()) ?? fallback);
    };

    ffmpeg.on('error', (err) => fail(new PlaybackError('playback-failed', spawnErrorMessage(FFMPEG_BIN, err))));
    ytdlp?.on('error', (err) => fail(new PlaybackError('extraction-failed', spawnErrorMessage(YTDLP_BIN, err))));

    ffmpeg.on('close', (code) => {
      if (killed) return;
      if (!settled) {
        // Give yt-dlp a moment to exit so its (more useful) error message wins.
        void Promise.race([ytdlpClosed, new Promise((done) => setTimeout(done, 2000))]).then(() => {
          fail(
            failureFromOutput(
              'playback-failed',
              code === 0 ? 'The source produced no audio.' : `ffmpeg exited with code ${String(code)}`,
            ),
          );
        });
        return;
      }
      if (code !== 0) {
        out.destroy(failureFromOutput('playback-failed', `ffmpeg exited with code ${String(code)}`));
      }
    });

    ytdlp?.on('close', (code) => {
      if (killed || code === 0 || code === null) return;
      const err = failureFromOutput('extraction-failed', `yt-dlp exited with code ${String(code)}`);
      if (!settled) fail(err);
      else out.destroy(err);
    });
  });
}

function cancelledError(): PlaybackError {
  return new PlaybackError('playback-failed', 'Cancelled.');
}

/**
 * Open the audio for a track at play time. Throws PlaybackError('extraction-failed' |
 * 'playback-failed'). When `signal` aborts before the first audio bytes (track superseded
 * by interrupt/skip/stop), spawned processes are killed immediately and it rejects.
 */
export async function openTrackInput(input: TrackInput, deps: OpenTrackDeps, signal?: AbortSignal): Promise<TrackStream> {
  if (signal?.aborted) throw cancelledError();
  const plan = await planInput(input, deps);
  // planInput may await a fresh library attachment URL; re-check before spawning anything.
  if (signal?.aborted) throw cancelledError();
  return spawnPipeline(plan, signal);
}
