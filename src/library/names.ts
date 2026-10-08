/**
 * Sound name validation (LIBRARY implementer). PURE.
 * Rules: trimmed, 1-32 chars (SOUND_NAME_MIN/MAX_LENGTH), no control characters / newlines.
 * Uniqueness is case-insensitive per guild: compare via nameKey().
 */
import { SOUND_NAME_MAX_LENGTH, SOUND_NAME_MIN_LENGTH } from '../constants.js';

export type NameValidation = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string };

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const CONTROL_CHAR = /\p{Cc}/u;

/** Trim, collapse internal whitespace runs to a single space, and NFC-normalize. */
function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Length in user-visible code points (not UTF-16 units). */
function codePointLength(value: string): number {
  return [...value].length;
}

/** Normalizes (trim, collapse internal whitespace) and validates. `error` is user-facing. */
export function validateSoundName(raw: string): NameValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Sound name is required.' };
  }
  if (LINE_BREAK.test(raw)) {
    return { ok: false, error: 'Sound names must be a single line.' };
  }
  const name = normalizeName(raw);
  if (CONTROL_CHAR.test(name)) {
    return { ok: false, error: 'Sound names cannot contain control characters.' };
  }
  const length = codePointLength(name);
  if (length < SOUND_NAME_MIN_LENGTH) {
    return { ok: false, error: 'Sound name cannot be empty.' };
  }
  if (length > SOUND_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Sound names can be at most ${SOUND_NAME_MAX_LENGTH} characters (got ${length}).`,
    };
  }
  return { ok: true, name };
}

/** Case-insensitive comparison key for uniqueness / lookup. */
export function nameKey(name: string): string {
  return normalizeName(name).normalize('NFKC').toLowerCase();
}
