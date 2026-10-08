/**
 * Discord-backed LibraryStore (LIBRARY implementer). See LibraryStore in src/types.ts.
 * - One bot-authored message per sound in the guild's library channel.
 * - File sounds: download the user's attachment at add time and RE-UPLOAD the bytes.
 * - Link sounds: store the link only.
 * - freshAttachmentUrl(): always re-fetch the message; never cache attachment URLs.
 * - Mutations are serialized per store. Throws LibraryError for expected failures.
 */
import { randomBytes } from 'node:crypto';
import { GuildPremiumTier, MessageFlags, RESTJSONErrorCodes } from 'discord.js';
import type { Message, TextChannel } from 'discord.js';
import { AUTOCOMPLETE_LIMIT, HISTORY_PAGE_SIZE } from '../constants.js';
import { LibraryError, errorMessage } from '../errors.js';
import { isAudioAttachment } from '../playback/sources.js';
import type { AddSoundInput, LibrarySound, LibrarySoundMetadata, LibraryStore } from '../types.js';
import { MESSAGE_CONTENT_LIMIT, metadataToSound, parseSoundMetadata, serializeSoundMetadata, soundToMetadata } from './format.js';
import { nameKey, validateSoundName } from './names.js';

const MiB = 1024 * 1024;

/** Longest filename we keep in metadata / on the re-uploaded attachment. */
const MAX_FILENAME_LENGTH = 200;

/** Max time to download a user's attachment for re-upload. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * File upload limit for a guild by boost tier (bots get the guild's limit).
 * Tier 0/1: 10 MiB, tier 2: 50 MiB, tier 3: 100 MiB.
 */
export function uploadLimitBytes(premiumTier: GuildPremiumTier | number | null | undefined): number {
  switch (premiumTier) {
    case GuildPremiumTier.Tier3:
      return 100 * MiB;
    case GuildPremiumTier.Tier2:
      return 50 * MiB;
    default:
      return 10 * MiB;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(bytes % MiB === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Audio by content type (audio/*) or a known audio extension: same rule as /play (isAudioAttachment). */
export function looksLikeAudio(filename: string, contentType: string | null): boolean {
  return isAudioAttachment({ filename, contentType });
}

/** Keep the original name but strip path separators/control chars and cap the length (preserving the extension). */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\p{Cc}/\\]/gu, '_')
    .trim()
    .replace(/^\.+/, '');
  const name = cleaned === '' ? 'sound' : cleaned;
  const chars = [...name];
  if (chars.length <= MAX_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  if (ext.length > 0 && ext.length < 16) {
    return chars.slice(0, MAX_FILENAME_LENGTH - ext.length).join('') + ext.join('');
  }
  return chars.slice(0, MAX_FILENAME_LENGTH).join('');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Numeric Discord API error code (DiscordAPIError.code), if any. */
function discordErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function isUnknownMessage(err: unknown): boolean {
  return discordErrorCode(err) === RESTJSONErrorCodes.UnknownMessage;
}

/** True for the AbortError @discordjs/rest throws when a request exceeds its REST timeout. */
function isAbortError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if (typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError') return true;
  }
  return false;
}

/**
 * Unique message nonce (<= 25 chars). Sent with enforceNonce so a send that @discordjs/rest
 * retries after a timeout returns the already-created message instead of posting a duplicate.
 */
function messageNonce(): string {
  return randomBytes(12).toString('hex');
}

/** Map Discord API failures on the library channel to LibraryError. */
function toLibraryError(err: unknown, action: string): LibraryError {
  if (err instanceof LibraryError) return err;
  if (isAbortError(err)) {
    return new LibraryError(
      'upload-timeout',
      `Timed out trying to ${action} in the sound library. Try a smaller file or try again.`,
      { cause: err },
    );
  }
  const code = discordErrorCode(err);
  if (
    code === RESTJSONErrorCodes.UnknownChannel ||
    code === RESTJSONErrorCodes.MissingAccess ||
    code === RESTJSONErrorCodes.MissingPermissions
  ) {
    return new LibraryError(
      'channel-unavailable',
      'The sound library channel is missing or I no longer have access to it. Ask an admin to check #soundboard-library.',
      { cause: err },
    );
  }
  if (code === RESTJSONErrorCodes.RequestEntityTooLarge || httpStatus(err) === 413) {
    return new LibraryError('too-large', "That file is larger than this server's upload limit.", { cause: err });
  }
  return new LibraryError('channel-unavailable', `Could not ${action} in the sound library: ${errorMessage(err)}`, {
    cause: err,
  });
}

function compareSounds(a: LibrarySound, b: LibrarySound): number {
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Older snowflake first (numeric compare on the string). */
function snowflakeLess(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b;
}

/** Pure: prefix matches first, then substring matches, each sorted by name. */
export function searchSounds(sorted: readonly LibrarySound[], query: string, limit: number): LibrarySound[] {
  const max = Math.max(0, Math.min(Math.floor(limit), AUTOCOMPLETE_LIMIT));
  if (max === 0) return [];
  const q = nameKey(query);
  if (q === '') return sorted.slice(0, max);
  const prefix: LibrarySound[] = [];
  const substring: LibrarySound[] = [];
  for (const sound of sorted) {
    const key = nameKey(sound.name);
    if (key.startsWith(q)) prefix.push(sound);
    else if (key.includes(q)) substring.push(sound);
  }
  return [...prefix, ...substring].slice(0, max);
}

export interface LibraryStoreOptions {
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function createLibraryStore(
  channel: TextChannel,
  botUserId: string,
  options: LibraryStoreOptions = {},
): LibraryStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const guildId = channel.guildId;
  const byId = new Map<string, LibrarySound>();
  const byKey = new Map<string, LibrarySound>();
  /**
   * Same-name duplicates found by load() (oldest first) that lost to the indexed sound.
   * Not visible, but when the indexed sound is deleted/renamed away the next one is
   * promoted, so the in-memory index always matches what a restart would load.
   */
  const shadowed = new Map<string, LibrarySound[]>();
  let sortedCache: LibrarySound[] | null = null;
  let loaded = false;
  let tail: Promise<unknown> = Promise.resolve();

  /** Surface the oldest shadowed duplicate for `key` if the name is free again. */
  function promote(key: string): void {
    if (byKey.has(key)) return;
    const queue = shadowed.get(key);
    const next = queue?.shift();
    if (queue?.length === 0) shadowed.delete(key);
    if (!next) return;
    console.warn(`[library] guild ${guildId}: surfacing duplicate sound "${next.name}" (message ${next.id})`);
    byId.set(next.id, next);
    byKey.set(key, next);
    sortedCache = null;
  }

  function index(sound: LibrarySound): void {
    const previous = byId.get(sound.id);
    const previousKey = previous ? nameKey(previous.name) : null;
    if (previousKey !== null && byKey.get(previousKey)?.id === sound.id) byKey.delete(previousKey);
    byId.set(sound.id, sound);
    byKey.set(nameKey(sound.name), sound);
    sortedCache = null;
    if (previousKey !== null) promote(previousKey); // renamed away from a name with duplicates
  }

  function unindex(id: string): LibrarySound | undefined {
    for (const [key, queue] of shadowed) {
      const at = queue.findIndex((s) => s.id === id);
      if (at === -1) continue;
      queue.splice(at, 1);
      if (queue.length === 0) shadowed.delete(key);
    }
    const sound = byId.get(id);
    if (!sound) return undefined;
    byId.delete(id);
    const key = nameKey(sound.name);
    if (byKey.get(key)?.id === id) byKey.delete(key);
    sortedCache = null;
    promote(key);
    return sound;
  }

  function sorted(): LibrarySound[] {
    sortedCache ??= [...byId.values()].sort(compareSounds);
    return sortedCache;
  }

  /** Run mutations one at a time so uniqueness checks cannot race. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  function requireLoaded(): void {
    if (!loaded) throw new LibraryError('not-ready', 'The sound library is still loading. Try again in a moment.');
  }

  function requireSound(id: string): LibrarySound {
    const sound = byId.get(id);
    if (!sound) throw new LibraryError('not-found', 'That sound does not exist (it may have been deleted).');
    return sound;
  }

  function validName(raw: string, exceptId: string | null): string {
    const result = validateSoundName(raw);
    if (!result.ok) throw new LibraryError('invalid-name', result.error);
    const existing = byKey.get(nameKey(result.name));
    if (existing && existing.id !== exceptId) {
      throw new LibraryError('name-taken', `A sound named "${existing.name}" already exists.`);
    }
    return result.name;
  }

  function contentFor(meta: LibrarySoundMetadata): string {
    const content = serializeSoundMetadata(meta);
    if (content.length > MESSAGE_CONTENT_LIMIT) {
      throw meta.kind === 'link'
        ? new LibraryError('invalid-url', 'That URL is too long to save.')
        : new LibraryError('invalid-name', 'That sound cannot be saved: its metadata is too long.');
    }
    return content;
  }

  /** Sound from a bot-authored library message, or null if it is not a valid sound message. */
  function soundFromMessage(message: Pick<Message, 'id' | 'content' | 'author' | 'attachments'>): LibrarySound | null {
    if (message.author.id !== botUserId) return null;
    const meta = parseSoundMetadata(message.content);
    if (!meta) return null;
    if (meta.kind === 'file' && message.attachments.size === 0) return null;
    return metadataToSound(meta, { id: message.id, guildId });
  }

  async function download(input: Extract<AddSoundInput, { kind: 'file' }>, limit: number): Promise<Buffer> {
    const tooLarge = (size: number) =>
      new LibraryError(
        'too-large',
        `That file is ${formatBytes(size)}, which exceeds this server's ${formatBytes(limit)} upload limit.`,
      );
    if (input.size !== null && input.size > limit) throw tooLarge(input.size);
    if (!isHttpUrl(input.attachmentUrl)) {
      throw new LibraryError('download-failed', 'Could not download that attachment (invalid URL).');
    }
    let response: Response;
    try {
      response = await fetchImpl(input.attachmentUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new LibraryError('download-failed', 'Could not download that attachment. Try uploading it again.', {
        cause: err,
      });
    }
    if (!response.ok) {
      throw new LibraryError('download-failed', `Could not download that attachment (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw tooLarge(declared);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      throw new LibraryError('download-failed', 'Downloading that attachment failed part-way. Try again.', {
        cause: err,
      });
    }
    if (bytes.length > limit) throw tooLarge(bytes.length);
    if (bytes.length === 0) throw new LibraryError('download-failed', 'That attachment is empty.');
    return bytes;
  }

  async function fetchMessage(id: string): Promise<Message<true>> {
    try {
      return await channel.messages.fetch({ message: id, force: true, cache: false });
    } catch (err) {
      if (isUnknownMessage(err)) {
        unindex(id);
        throw new LibraryError('not-found', 'That sound no longer exists (its library message was deleted).', {
          cause: err,
        });
      }
      throw toLibraryError(err, 'read the sound');
    }
  }

  const store: LibraryStore = {
    guildId,

    get loaded() {
      return loaded;
    },

    load() {
      return serialized(async () => {
        const found: LibrarySound[] = [];
        let before: string | undefined;
        try {
          for (;;) {
            const page = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
            for (const message of page.values()) {
              const sound = soundFromMessage(message);
              if (sound) found.push(sound);
              if (before === undefined || snowflakeLess(message.id, before)) before = message.id;
            }
            if (page.size < HISTORY_PAGE_SIZE) break;
          }
        } catch (err) {
          throw toLibraryError(err, 'read the library history');
        }

        // Oldest message wins a (case-insensitive) name collision; later duplicates are shadowed.
        found.sort((a, b) => (snowflakeLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
        byId.clear();
        byKey.clear();
        shadowed.clear();
        sortedCache = null;
        for (const sound of found) {
          const key = nameKey(sound.name);
          const existing = byKey.get(key);
          if (existing) {
            console.warn(
              `[library] guild ${guildId}: ignoring duplicate sound name "${sound.name}" (message ${sound.id}; kept ${existing.id})`,
            );
            const queue = shadowed.get(key) ?? [];
            queue.push(sound);
            shadowed.set(key, queue);
            continue;
          }
          index(sound);
        }
        loaded = true;
      });
    },

    list() {
      return sorted();
    },

    search(query, limit = AUTOCOMPLETE_LIMIT) {
      return searchSounds(sorted(), query, limit);
    },

    getById(id) {
      return byId.get(id);
    },

    getByName(name) {
      return byKey.get(nameKey(name));
    },

    add(input) {
      return serialized(async () => {
        requireLoaded();
        const name = validName(input.name, null);
        const addedAt = new Date().toISOString();

        if (input.kind === 'link') {
          const url = input.url.trim();
          if (!isHttpUrl(url)) throw new LibraryError('invalid-url', 'That is not a valid http(s) URL.');
          const content = contentFor({ v: 1, kind: 'link', name, addedBy: input.addedBy, addedAt, url });
          let message: Message<true>;
          try {
            message = await channel.send({
              content,
              nonce: messageNonce(),
              enforceNonce: true,
              allowedMentions: { parse: [] },
              flags: MessageFlags.SuppressEmbeds,
            });
          } catch (err) {
            throw toLibraryError(err, 'save the sound');
          }
          const sound = metadataToSound({ v: 1, kind: 'link', name, addedBy: input.addedBy, addedAt, url }, {
            id: message.id,
            guildId,
          });
          index(sound);
          return sound;
        }

        if (!looksLikeAudio(input.filename, input.contentType)) {
          throw new LibraryError('not-audio', 'That attachment does not look like an audio file.');
        }
        const filename = sanitizeFilename(input.filename);
        const meta: LibrarySoundMetadata = { v: 1, kind: 'file', name, addedBy: input.addedBy, addedAt, filename };
        const content = contentFor(meta);
        const bytes = await download(input, uploadLimitBytes(channel.guild.premiumTier));
        let message: Message<true>;
        try {
          message = await channel.send({
            content,
            files: [{ attachment: bytes, name: filename }],
            nonce: messageNonce(),
            enforceNonce: true,
            allowedMentions: { parse: [] },
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (err) {
          throw toLibraryError(err, 'upload the sound');
        }
        const sound = metadataToSound(meta, { id: message.id, guildId });
        index(sound);
        return sound;
      });
    },

    rename(id, newName) {
      return serialized(async () => {
        requireLoaded();
        const sound = requireSound(id);
        const name = validName(newName, id);
        const renamed: LibrarySound = { ...sound, name };
        const content = contentFor(soundToMetadata(renamed));
        const message = await fetchMessage(id);
        try {
          await message.edit({ content, allowedMentions: { parse: [] } });
        } catch (err) {
          if (isUnknownMessage(err)) {
            unindex(id);
            throw new LibraryError('not-found', 'That sound no longer exists (its library message was deleted).', {
              cause: err,
            });
          }
          throw toLibraryError(err, 'rename the sound');
        }
        index(renamed);
        return renamed;
      });
    },

    delete(id) {
      return serialized(async () => {
        requireLoaded();
        const sound = requireSound(id);
        try {
          await channel.messages.delete(id);
        } catch (err) {
          // Already gone (e.g. an admin deleted the message by hand): treat as deleted.
          if (!isUnknownMessage(err)) throw toLibraryError(err, 'delete the sound');
        }
        unindex(id);
        return sound;
      });
    },

    async freshAttachmentUrl(id) {
      const sound = requireSound(id);
      if (sound.kind !== 'file') {
        throw new LibraryError('not-found', `"${sound.name}" is a saved link, not an uploaded file.`);
      }
      const message = await fetchMessage(id);
      const attachment = message.attachments.first();
      if (!attachment) {
        throw new LibraryError('not-found', `The audio file for "${sound.name}" is missing from the library.`);
      }
      return attachment.url;
    },

    forget(ids) {
      // Not serialized: an externally deleted message is gone regardless of pending mutations.
      for (const id of ids) unindex(id);
    },
  };

  return store;
}
