import type { APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  EMBED_DESCRIPTION_LIMIT,
  EMBED_FIELD_NAME_LIMIT,
  EMBED_FIELD_VALUE_LIMIT,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_LIMIT,
  EMBED_TITLE_LIMIT,
  EMBED_TOTAL_LIMIT,
} from '../constants.js';
import {
  discordTimestamp,
  embedLength,
  fieldValueFromLines,
  fitEmbed,
  formatDateKey,
  formatDuration,
  formatHour,
  formatPercent,
  formatTrend,
  lastDays,
  plural,
  safeName,
  truncateText,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
} from './format.js';
import { HOUR_MS, MINUTE_MS } from './time.js';

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(3 * HOUR_MS + 12 * MINUTE_MS)).toBe('3h 12m');
    expect(formatDuration(45 * MINUTE_MS + 59_000)).toBe('45m');
    expect(formatDuration(2 * HOUR_MS)).toBe('2h');
  });
  it('handles tiny, zero and invalid values', () => {
    expect(formatDuration(59_999)).toBe('<1m');
    expect(formatDuration(1)).toBe('<1m');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-5)).toBe('0m');
    expect(formatDuration(Number.NaN)).toBe('0m');
  });
  it('keeps big totals in hours', () => {
    expect(formatDuration(312 * HOUR_MS + 5 * MINUTE_MS)).toBe('312h 5m');
  });
});

describe('formatTrend', () => {
  it('shows up, down and flat changes', () => {
    expect(formatTrend(118, 100)).toBe('▲ 18%');
    expect(formatTrend(95, 100)).toBe('▼ 5%');
    expect(formatTrend(100, 100)).toBe('±0%');
    expect(formatTrend(1001, 1000)).toBe('±0%');
  });
  it('handles a missing or empty previous period', () => {
    expect(formatTrend(5, null)).toBe('');
    expect(formatTrend(5, 0)).toBe('new');
    expect(formatTrend(0, 0)).toBe('±0%');
    expect(formatTrend(0, 10)).toBe('▼ 100%');
  });
});

describe('small formatters', () => {
  it('formats percentages', () => {
    expect(formatPercent(0.38)).toBe('38%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.001)).toBe('<1%');
    expect(formatPercent(1)).toBe('100%');
  });
  it('formats hours as 12-hour clock', () => {
    expect(formatHour(0)).toBe('12 am');
    expect(formatHour(9)).toBe('9 am');
    expect(formatHour(12)).toBe('12 pm');
    expect(formatHour(21)).toBe('9 pm');
    expect(formatHour(23)).toBe('11 pm');
  });
  it('names weekdays Monday first', () => {
    expect(WEEKDAY_NAMES[0]).toBe('Monday');
    expect(WEEKDAY_NAMES[6]).toBe('Sunday');
    expect(WEEKDAY_SHORT[3]).toBe('Thu');
  });
  it('builds Discord timestamps', () => {
    expect(discordTimestamp(1_700_000_000_999, 'f')).toBe('<t:1700000000:f>');
    expect(discordTimestamp(1_700_000_000_000, 'D')).toBe('<t:1700000000:D>');
  });
  it('formats local date keys', () => {
    expect(formatDateKey('2026-10-08')).toBe('Thu, Oct 8, 2026');
    expect(formatDateKey('2026-01-05')).toBe('Mon, Jan 5, 2026');
    expect(formatDateKey('garbage')).toBe('garbage');
  });
  it('pluralises', () => {
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(14, 'session')).toBe('14 sessions');
    expect(plural(2, 'person', 'people')).toBe('2 people');
    expect(lastDays(1)).toBe('last day');
    expect(lastDays(30)).toBe('last 30 days');
  });
});

/** A lone high or low surrogate anywhere in the string. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FAMILY = '👨‍👩‍👧‍👦'; // ZWJ sequence, 11 UTF-16 units

describe('truncateText', () => {
  it('leaves short text alone and marks cuts with an ellipsis', () => {
    expect(truncateText('hello', 5)).toBe('hello');
    expect(truncateText('hello world', 6)).toBe('hello…');
    expect(truncateText('hello', 1)).toBe('h');
    expect(truncateText('hello', 0)).toBe('');
  });

  it('never splits an astral emoji, at any offset', () => {
    const text = `a${'😀🎧'.repeat(20)}`;
    for (let max = 0; max <= text.length + 1; max++) {
      const out = truncateText(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(LONE_SURROGATE.test(out)).toBe(false);
      expect(text.startsWith(out.endsWith('…') ? out.slice(0, -1) : out)).toBe(true);
    }
    // 'a' + 😀 is 3 units; one more unit would split 🎧, so it is dropped instead.
    expect(truncateText(text, 5)).toBe('a😀…');
  });

  it('keeps ZWJ sequences whole', () => {
    const text = `x${FAMILY}${FAMILY}`;
    expect(truncateText(text, 13)).toBe(`x${FAMILY}…`);
    // Not enough room for the family: drop it entirely rather than leave a fragment.
    expect(truncateText(text, 12)).toBe('x…');
    expect(truncateText(FAMILY.repeat(3), 5)).toBe('…');
  });
});

describe('safeName', () => {
  it('escapes markdown and masked links', () => {
    expect(safeName('**bold** _x_')).toBe('\\*\\*bold\\*\\* \\_x\\_');
    expect(safeName('[click](https://x.y)')).toContain('\\[');
  });
  it('defuses mention-looking text', () => {
    expect(safeName('<@123>')).not.toContain('<@');
    expect(safeName('<#1>')).not.toContain('<#');
  });
  it('collapses whitespace and truncates to 32 visible chars', () => {
    expect(safeName('  a \n\t b  ')).toBe('a b');
    const long = safeName('x'.repeat(64));
    expect(long).toHaveLength(32);
    expect(long.endsWith('…')).toBe(true);
  });
  it('falls back for empty names', () => {
    expect(safeName('   ')).toBe('Former member');
    expect(safeName('\u202E\u200F')).toBe('Former member');
  });
  it('escapes a leading blockquote and subtext', () => {
    expect(safeName('>>> hi')).toBe('\\>>> hi');
    expect(safeName('> hi')).toBe('\\> hi');
    expect(safeName('-# tiny')).toBe('\\-# tiny');
    expect(safeName('a > b -# c')).toBe('a > b -# c');
  });
  it('strips bidi controls so a name cannot reorder what follows it', () => {
    expect(safeName('evil\u202E dlrow')).toBe('evil dlrow');
    expect(safeName('\u2066a\u2069\u200Eb\u200F\u061Cc\u202A\u202B\u202C\u202D\u2067\u2068')).toBe('abc');
  });
  it('truncates astral names without lone surrogates', () => {
    for (const prefix of ['', 'a', 'ab']) {
      const out = safeName(`${prefix}${'🎮'.repeat(40)}`);
      expect(out.length).toBeLessThanOrEqual(32);
      expect(LONE_SURROGATE.test(out)).toBe(false);
      expect(out.endsWith('…')).toBe(true);
    }
    const family = safeName(FAMILY.repeat(5));
    expect(family).toBe(`${FAMILY.repeat(2)}…`);
  });
});

describe('fieldValueFromLines', () => {
  it('joins lines that fit', () => {
    expect(fieldValueFromLines(['a', 'b'])).toBe('a\nb');
    expect(fieldValueFromLines([])).toBe('');
  });
  it('keeps whole lines and marks dropped ones', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const value = fieldValueFromLines(lines);
    expect(value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_LIMIT);
    expect(value.endsWith('\n…')).toBe(true);
    for (const line of value.split('\n').slice(0, -1)) expect(lines).toContain(line);
  });
  it('cuts a single oversized line', () => {
    const value = fieldValueFromLines(['y'.repeat(5000)]);
    expect(value).toHaveLength(EMBED_FIELD_VALUE_LIMIT);
    expect(value.endsWith('…')).toBe(true);
  });
});

describe('fitEmbed', () => {
  const absurd = (): APIEmbed => ({
    title: 't'.repeat(1000),
    description: 'd'.repeat(10_000),
    footer: { text: 'f'.repeat(5000) },
    fields: Array.from({ length: 40 }, (_, i) => ({
      name: `n${i}`.repeat(200),
      value: Array.from({ length: 50 }, () => 'v'.repeat(60)).join('\n'),
    })),
  });

  it('enforces every limit on absurd input', () => {
    const embed = fitEmbed(absurd());
    expect(embed.title!.length).toBeLessThanOrEqual(EMBED_TITLE_LIMIT);
    expect(embed.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    expect(embed.footer!.text.length).toBeLessThanOrEqual(EMBED_FOOTER_LIMIT);
    expect(embed.fields!.length).toBeLessThanOrEqual(EMBED_FIELDS_MAX);
    for (const f of embed.fields!) {
      expect(f.name.length).toBeLessThanOrEqual(EMBED_FIELD_NAME_LIMIT);
      expect(f.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_LIMIT);
      expect(f.value.length).toBeGreaterThan(0);
    }
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
  });

  it('trims trailing fields by whole lines, then drops the rest', () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({
      name: `field ${i}`,
      value: Array.from({ length: 10 }, (_, j) => `${i}-${j} ${'z'.repeat(80)}`).join('\n'),
    }));
    const embed = fitEmbed({ title: 'x', fields });
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    expect(embed.fields!.length).toBeLessThan(10);
    expect(embed.fields![0]).toEqual(fields[0]);
    const last = embed.fields!.at(-1)!;
    for (const line of last.value.split('\n')) expect(line === '…' || line.startsWith(`${embed.fields!.length - 1}-`)).toBe(true);
  });

  it('never splits emoji when cutting titles, descriptions, footers and fields', () => {
    const odd = (n: number) => `a${'😀'.repeat(n)}`;
    const embed = fitEmbed({
      title: odd(300),
      description: odd(3000),
      footer: { text: odd(2000) },
      fields: [
        { name: odd(200), value: odd(1000) },
        { name: 'family', value: Array.from({ length: 200 }, () => `${FAMILY} ${FAMILY}`).join('\n') },
      ],
    });
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    for (const text of [embed.title!, embed.description!, embed.footer!.text, ...embed.fields!.flatMap((f) => [f.name, f.value])]) {
      expect(LONE_SURROGATE.test(text)).toBe(false);
    }
    expect(embed.title!.length).toBeLessThanOrEqual(EMBED_TITLE_LIMIT);
    expect(embed.title!.endsWith('😀…')).toBe(true);
    expect(fieldValueFromLines([odd(600)]).endsWith('😀…')).toBe(true);
  });

  it('cuts the description at a grapheme when it alone overflows the total', () => {
    const embed = fitEmbed({ title: 't'.repeat(256), description: `x${FAMILY.repeat(500)}`, footer: { text: 'f'.repeat(2048) } });
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    expect(embed.description).toMatch(new RegExp(`^x(${FAMILY})*…$`, 'u'));
  });

  it('leaves small embeds untouched', () => {
    const embed: APIEmbed = { title: 'a', description: 'b', footer: { text: 'c' }, fields: [{ name: 'n', value: 'v', inline: true }] };
    expect(fitEmbed(embed)).toEqual(embed);
  });
});
