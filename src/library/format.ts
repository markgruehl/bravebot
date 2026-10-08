/**
 * Library message content <-> metadata (LIBRARY implementer). PURE.
 *
 * Message layout (one bot-authored message per sound):
 *
 *   🔊 **Airhorn** · added by <@123> · <t:1700000000:f>
 *   ```json
 *   {"bravebot":"sound","v":1,"kind":"link","name":"Airhorn",...}
 *   ```
 *
 * The first line is cosmetic for admins browsing the channel. The fenced JSON block is
 * the machine-readable part. Backticks inside JSON strings are escaped as ` so a
 * name/URL/filename can never close the fence early, and the header escapes markdown.
 * parseSoundMetadata() scans every fenced block (and finally the raw content) and
 * returns the first valid bravebot payload, or null. It never throws.
 */
import { escapeMarkdown } from 'discord.js';
import type { LibrarySound, LibrarySoundMetadata } from '../types.js';
import { validateSoundName } from './names.js';

/** Discord message content limit. */
export const MESSAGE_CONTENT_LIMIT = 2000;

/** Tag inside the JSON payload so unrelated JSON in the channel is never mistaken for a sound. */
const PAYLOAD_TAG = 'sound';

const SNOWFLAKE = /^\d{5,25}$/;
const FENCED_BLOCK = /```[ \t]*([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

function payloadJson(meta: LibrarySoundMetadata): string {
  const base = {
    bravebot: PAYLOAD_TAG,
    v: meta.v,
    kind: meta.kind,
    name: meta.name,
    addedBy: meta.addedBy,
    addedAt: meta.addedAt,
  };
  const payload = meta.kind === 'file' ? { ...base, filename: meta.filename } : { ...base, url: meta.url };
  return JSON.stringify(payload).replace(/`/g, '\\u0060');
}

function headerLine(meta: LibrarySoundMetadata): string {
  const icon = meta.kind === 'file' ? '🔊' : '🔗';
  const parts = [`${icon} **${escapeMarkdown(meta.name)}**`, `added by <@${meta.addedBy}>`];
  const addedAtMs = Date.parse(meta.addedAt);
  if (Number.isFinite(addedAtMs)) parts.push(`<t:${Math.floor(addedAtMs / 1000)}:f>`);
  return parts.join(' · ');
}

/**
 * Render metadata as message content. If the human header would push the content over
 * Discord's 2000-char limit it is dropped; callers must still check the final length
 * (see MESSAGE_CONTENT_LIMIT) because a very long URL can exceed it on its own.
 */
export function serializeSoundMetadata(meta: LibrarySoundMetadata): string {
  const block = '```json\n' + payloadJson(meta) + '\n```';
  const full = `${headerLine(meta)}\n${block}`;
  return full.length <= MESSAGE_CONTENT_LIMIT ? full : block;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validatePayload(value: unknown): LibrarySoundMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.bravebot !== PAYLOAD_TAG || obj.v !== 1) return null;
  if (typeof obj.name !== 'string' || typeof obj.addedBy !== 'string' || typeof obj.addedAt !== 'string') return null;

  const name = validateSoundName(obj.name);
  if (!name.ok) return null;
  if (!SNOWFLAKE.test(obj.addedBy)) return null;
  const addedAtMs = Date.parse(obj.addedAt);
  if (!Number.isFinite(addedAtMs)) return null;
  const addedAt = new Date(addedAtMs).toISOString();

  if (obj.kind === 'file') {
    if (typeof obj.filename !== 'string' || obj.filename.trim() === '') return null;
    return { v: 1, kind: 'file', name: name.name, addedBy: obj.addedBy, addedAt, filename: obj.filename };
  }
  if (obj.kind === 'link') {
    if (typeof obj.url !== 'string' || !isHttpUrl(obj.url)) return null;
    return { v: 1, kind: 'link', name: name.name, addedBy: obj.addedBy, addedAt, url: obj.url };
  }
  return null;
}

function tryParse(json: string): LibrarySoundMetadata | null {
  try {
    return validatePayload(JSON.parse(json.trim()));
  } catch {
    return null;
  }
}

export function parseSoundMetadata(content: string): LibrarySoundMetadata | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  try {
    for (const match of content.matchAll(FENCED_BLOCK)) {
      const lang = (match[1] ?? '').toLowerCase();
      if (lang !== '' && lang !== 'json') continue;
      const meta = tryParse(match[2] ?? '');
      if (meta) return meta;
    }
    // Tolerate a bare JSON object (e.g. an admin re-posting without the fence).
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) return tryParse(content.slice(start, end + 1));
    return null;
  } catch {
    return null;
  }
}

export function metadataToSound(meta: LibrarySoundMetadata, ids: { id: string; guildId: string }): LibrarySound {
  const base = {
    id: ids.id,
    guildId: ids.guildId,
    name: meta.name,
    addedBy: meta.addedBy,
    addedAt: new Date(meta.addedAt),
  };
  return meta.kind === 'file'
    ? { ...base, kind: 'file', filename: meta.filename }
    : { ...base, kind: 'link', url: meta.url };
}

export function soundToMetadata(sound: LibrarySound): LibrarySoundMetadata {
  const base = {
    v: 1 as const,
    name: sound.name,
    addedBy: sound.addedBy,
    addedAt: sound.addedAt.toISOString(),
  };
  return sound.kind === 'file'
    ? { ...base, kind: 'file', filename: sound.filename }
    : { ...base, kind: 'link', url: sound.url };
}
