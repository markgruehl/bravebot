/**
 * Text helpers for the voice stats embeds. PURE.
 *
 * Durations stay in hours (never days) so totals compare at a glance. Names are user-chosen,
 * so safeName() escapes markdown and defuses "<@id>"-style text before it reaches an embed.
 * fieldValueFromLines() and fitEmbed() keep every embed inside Discord's limits however
 * large the server or however hostile the names.
 */
import { escapeMarkdown, type APIEmbed, type APIEmbedField } from 'discord.js';
import {
  EMBED_DESCRIPTION_LIMIT,
  EMBED_FIELD_NAME_LIMIT,
  EMBED_FIELD_VALUE_LIMIT,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_LIMIT,
  EMBED_TITLE_LIMIT,
  EMBED_TOTAL_LIMIT,
} from '../constants.js';
import { DAY_MS, MINUTE_MS } from './time.js';
import type { Ms } from './types.js';

/** Shown for ids with no resolved name. */
export const FORMER_MEMBER = 'Former member';
/** Visible length cap for names in embed bodies. */
export const NAME_MAX_LENGTH = 32;

const ELLIPSIS = '…';

/** Monday = 0 ... Sunday = 6 (matches Weekday). */
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "3h 12m", "3h", "45m", "<1m", "0m"; big totals stay in hours ("312h 5m"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms < MINUTE_MS) return '<1m';
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Change vs the previous period: "▲ 18%", "▼ 5%", "±0%", "new" (previous 0, current > 0),
 * '' when there is no previous period to compare with.
 */
export function formatTrend(current: number, previous: number | null): string {
  if (previous === null || !Number.isFinite(previous) || !Number.isFinite(current)) return '';
  if (previous <= 0) return current > 0 ? 'new' : '±0%';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return '±0%';
  return pct > 0 ? `▲ ${pct}%` : `▼ ${-pct}%`;
}

/** A 0-1 share as "38%"; small non-zero shares show as "<1%". */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const pct = Math.round(share * 100);
  return pct === 0 ? '<1%' : `${Math.min(pct, 100)}%`;
}

/** Local hour 0-23 as "12 am", "9 am", "12 pm", "9 pm". */
export function formatHour(hour: number): string {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? 'am' : 'pm'}`;
}

/** "1 session", "14 sessions". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "last 30 days", "last day". */
export function lastDays(days: number): string {
  return days === 1 ? 'last day' : `last ${days} days`;
}

/** Discord timestamp markup (renders in the viewer's own time zone): f = date + time, D = date. */
export function discordTimestamp(ms: Ms, style: 'f' | 'D'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** A local 'YYYY-MM-DD' key as "Thu, Oct 8, 2026" (plain text: the date is already local). */
export function formatDateKey(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  // 1970-01-05 (day 4) was a Monday.
  const weekday = ((((utc / DAY_MS - 4) % 7) + 7) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  return `${WEEKDAY_SHORT[weekday]}, ${MONTH_SHORT[m - 1] ?? '?'} ${d}, ${y}`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The longest prefix of whole grapheme clusters (emoji, accents, ZWJ sequences) with .length <= max. */
function graphemePrefix(text: string, max: number): string {
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/**
 * Truncate so the result's .length (UTF-16 units, an upper bound on what Discord counts) is
 * at most `max`, ending with "…" when cut. Cuts only between grapheme clusters, so an emoji
 * is never split into a lone surrogate or a broken ZWJ sequence.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= ELLIPSIS.length) return graphemePrefix(text, Math.max(0, max));
  return `${graphemePrefix(text, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** Bidi embedding/override/isolate controls and directional marks: they could reorder the text after a name. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/**
 * A user-chosen name as safe plain text: bidi controls stripped, whitespace collapsed, cut to
 * `max` visible chars, markdown escaped (including masked links, headings, a leading
 * blockquote ">"/">>>" and subtext "-#") and "<" defused so text like "<@123>" or "<#1>"
 * can't render as a mention. Empty names become "Former member".
 */
export function safeName(name: string, max = NAME_MAX_LENGTH): string {
  const collapsed = name.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  const cut = truncateText(collapsed.length > 0 ? collapsed : FORMER_MEMBER, max);
  const escaped = escapeMarkdown(cut, { heading: true, bulletedList: true, numberedList: true, maskedLink: true })
    .replace(/^>/, '\\>')
    .replace(/^-#/, '\\-#');
  return escaped.replace(/</g, '<​');
}

/**
 * Join lines with "\n", keeping only whole lines that fit in `limit`; when lines had to be
 * dropped the value ends with "…". A first line that alone exceeds the limit is cut.
 */
export function fieldValueFromLines(lines: readonly string[], limit = EMBED_FIELD_VALUE_LIMIT): string {
  if (lines.length === 0 || limit <= 0) return '';
  const all = lines.join('\n');
  if (all.length <= limit) return all;

  const marker = `\n${ELLIPSIS}`;
  let value = '';
  for (const line of lines) {
    const next = value === '' ? line : `${value}\n${line}`;
    if (next.length + marker.length > limit) break;
    value = next;
  }
  if (value === '') return truncateText(lines[0] ?? '', limit);
  return `${value}${marker}`;
}

/** Characters Discord counts toward the 6000 total for an embed. */
export function embedLength(embed: APIEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  total += (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
  for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  return total;
}

/**
 * Enforce every embed limit: per-part lengths, at most 25 fields, and the 6000 total. Over
 * the total, trailing fields are trimmed by whole lines and then dropped; the description is
 * cut only as a last resort. Returns a new embed.
 */
export function fitEmbed(embed: APIEmbed): APIEmbed {
  const out: APIEmbed = { ...embed };
  if (out.title !== undefined) out.title = truncateText(out.title, EMBED_TITLE_LIMIT);
  if (out.description !== undefined) out.description = truncateText(out.description, EMBED_DESCRIPTION_LIMIT);
  if (out.footer) out.footer = { ...out.footer, text: truncateText(out.footer.text, EMBED_FOOTER_LIMIT) };
  if (out.author) out.author = { ...out.author, name: truncateText(out.author.name, EMBED_TITLE_LIMIT) };

  const fields: APIEmbedField[] = (embed.fields ?? []).slice(0, EMBED_FIELDS_MAX).map((field) => ({
    ...field,
    name: truncateText(field.name, EMBED_FIELD_NAME_LIMIT),
    value: fieldValueFromLines(field.value.split('\n'), EMBED_FIELD_VALUE_LIMIT),
  }));

  let budget = EMBED_TOTAL_LIMIT - embedLength({ ...out, fields: [] });
  if (budget < 0 && out.description !== undefined) {
    // Fields can't help if the rest is already too big: cut the description first.
    out.description = truncateText(out.description, Math.max(0, out.description.length + budget));
    budget = EMBED_TOTAL_LIMIT - embedLength({ ...out, fields: [] });
  }

  const kept: APIEmbedField[] = [];
  for (const field of fields) {
    const size = field.name.length + field.value.length;
    if (size <= budget) {
      kept.push(field);
      budget -= size;
      continue;
    }
    // Keep as many whole lines of this field as still fit, then stop.
    const value = fieldValueFromLines(field.value.split('\n'), budget - field.name.length);
    if (value.length > ELLIPSIS.length) kept.push({ ...field, value });
    break;
  }
  if (embed.fields !== undefined) out.fields = kept;
  return out;
}
