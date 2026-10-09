import { ButtonStyle, type APIButtonComponentWithCustomId, type APIEmbed } from 'discord.js';
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
import { decodeStatsCustomId } from './customId.js';
import { embedLength } from './format.js';
import { CHANNEL_PAGES, heatmapLines, renderStats, SERVER_PAGES, SHARE_LABEL, STATS_EMBED_COLOR } from './render.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';
import type { PersonSummary, RenderContext, StatsMessage, StatsPage, StatsReport, StatsView } from './types.js';

const TZ = 'America/Toronto';
const NOW = Date.UTC(2026, 9, 8, 16); // Thu 2026-10-08 12:00 EDT
const DAYS = 30;
const FROM = NOW - DAYS * DAY_MS;

const uid = (n: number) => String(100000000000000000n + BigInt(n));
const CH_GENERAL = '900000000000000001';
const CH_GAMING = '900000000000000002';
const CH_DELETED = '900000000000000099';

function person(n: number, overrides: Partial<PersonSummary> = {}): PersonSummary {
  return {
    userId: uid(n),
    rank: n,
    totalMs: (20 - n) * HOUR_MS,
    previousTotalMs: 10 * HOUR_MS,
    sessions: 10,
    avgSessionMs: (2 - n / 20) * HOUR_MS,
    longestSessionMs: (5 - n / 10) * HOUR_MS,
    channelsVisited: 3,
    soloMs: HOUR_MS,
    coMs: (10 - n / 5) * HOUR_MS,
    nightMs: HOUR_MS,
    nightShare: 0.1,
    currentStreak: 3,
    longestStreak: 9,
    partyStarts: 2,
    closes: 1,
    bestFriend: { userId: uid(n === 1 ? 2 : 1), ms: 5 * HOUR_MS },
    topFriends: [
      { userId: uid(n === 1 ? 2 : 1), ms: 5 * HOUR_MS },
      { userId: uid(n === 3 ? 4 : 3), ms: 2 * HOUR_MS },
    ],
    topChannel: { channelId: CH_GENERAL, ms: 8 * HOUR_MS },
    signatureHour: 21,
    estimatedSessions: 0,
    qualified: true,
    ...overrides,
  };
}

function heatmap(fill: (weekday: number, block: number) => number): number[][] {
  return Array.from({ length: 7 }, (_, d) => Array.from({ length: 12 }, (_, b) => fill(d, b)));
}

function makeReport(overrides: Partial<StatsReport> = {}, peopleCount = 3): StatsReport {
  const people = Array.from({ length: peopleCount }, (_, i) => person(i + 1));
  return {
    window: { from: FROM, to: NOW, days: DAYS },
    scope: { kind: 'server' },
    timeZone: TZ,
    oldestEventAt: FROM - 100 * DAY_MS,
    estimatedSessions: 0,
    totals: { personMs: 57 * HOUR_MS, people: peopleCount, calls: 31, sessions: 30 },
    previousTotals: { personMs: 50 * HOUR_MS, people: 4, calls: 31, sessions: 25 },
    people,
    pairs: people.length >= 2 ? [{ a: uid(1), b: uid(2), ms: 5 * HOUR_MS }] : [],
    groups: people.length >= 3 ? [{ userIds: [uid(1), uid(2), uid(3)], ms: 3 * HOUR_MS }] : [],
    channels: [
      { channelId: CH_GENERAL, personMs: 40 * HOUR_MS, occupiedMs: 22 * HOUR_MS, calls: 31, record: { size: 3, at: NOW - 2 * DAY_MS } },
      { channelId: CH_GAMING, personMs: 17 * HOUR_MS, occupiedMs: 9 * HOUR_MS, calls: 1, record: { size: 7, at: NOW - 3 * DAY_MS } },
    ],
    heatmap: heatmap((d, b) => (d === 3 && b === 10 ? 4.2 : d === 3 ? 1 : 0)),
    primeTime: { weekday: 3, hour: 21, avgPeople: 4.2 },
    records: {
      longestCall: { channelId: CH_GENERAL, start: NOW - 5 * DAY_MS, end: NOW - 5 * DAY_MS + 5 * HOUR_MS + 12 * MINUTE_MS, peak: 6 },
      biggestParty: { channelId: CH_GAMING, size: 7, at: NOW - 3 * DAY_MS },
      busiestDay: { date: '2026-10-03', personMs: 40 * HOUR_MS },
      longestSession: { userId: uid(1), start: NOW - 6 * DAY_MS, ms: 7 * HOUR_MS },
      longestStreak: { userId: uid(2), days: 9, endDate: '2026-10-07' },
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    names: new Map([
      [uid(1), 'Alice'],
      [uid(2), 'Bob'],
      [uid(3), 'Carol'],
      [uid(4), 'Dave'],
    ]),
    channelNames: new Map([
      [CH_GENERAL, 'General'],
      [CH_GAMING, 'Gaming'],
    ]),
    shareable: true,
    now: NOW,
    ...overrides,
  };
}

const embedOf = (message: StatsMessage): APIEmbed => {
  expect(message.embeds).toHaveLength(1);
  return message.embeds[0]!;
};
const rows = (message: StatsMessage) => message.components.map((row) => row.components as APIButtonComponentWithCustomId[]);
const buttons = (message: StatsMessage) => rows(message).flat();
const field = (embed: APIEmbed, name: string) => embed.fields?.find((f) => f.name.includes(name));
const fieldNames = (embed: APIEmbed) => (embed.fields ?? []).map((f) => f.name);

function expectWithinLimits(embed: APIEmbed): void {
  expect(embed.title!.length).toBeLessThanOrEqual(EMBED_TITLE_LIMIT);
  expect((embed.description ?? '').length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
  expect(embed.footer!.text.length).toBeLessThanOrEqual(EMBED_FOOTER_LIMIT);
  expect((embed.fields ?? []).length).toBeLessThanOrEqual(EMBED_FIELDS_MAX);
  for (const f of embed.fields ?? []) {
    expect(f.name.length).toBeLessThanOrEqual(EMBED_FIELD_NAME_LIMIT);
    expect(f.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_LIMIT);
    expect(f.value.length).toBeGreaterThan(0);
  }
  expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
}

const server = (page: StatsPage): StatsView => ({ kind: 'server', page, days: DAYS });
const channel = (page: StatsPage, channelId = CH_GENERAL): StatsView => ({ kind: 'channel', channelId, page, days: DAYS });
const user = (n: number): StatsView => ({ kind: 'user', userId: uid(n), days: DAYS });

describe('components', () => {
  it('lays out server pages over two rows with Share last', () => {
    const message = renderStats(server('people'), makeReport(), makeCtx());
    expect(rows(message).map((r) => r.map((b) => b.label))).toEqual([
      ['Overview', 'People', 'Social', 'Channels', 'Times'],
      ['Records', SHARE_LABEL],
    ]);
    const people = buttons(message).find((b) => b.label === 'People')!;
    expect(people).toMatchObject({ style: ButtonStyle.Primary, disabled: true });
    for (const b of buttons(message).filter((b) => b.label !== 'People')) {
      expect(b).toMatchObject({ style: ButtonStyle.Secondary, disabled: false });
    }
  });

  it('page buttons target their page and Share carries the current view', () => {
    const view = server('social');
    const message = renderStats(view, makeReport(), makeCtx());
    const decoded = buttons(message).map((b) => decodeStatsCustomId(b.custom_id));
    expect(decoded.slice(0, 6)).toEqual(SERVER_PAGES.map((page) => ({ action: 'page', view: { ...view, page } })));
    expect(decoded[6]).toEqual({ action: 'share', view });
    const ids = buttons(message).map((b) => b.custom_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops Share on shared posts', () => {
    const message = renderStats(server('records'), makeReport(), makeCtx({ shareable: false }));
    expect(rows(message).map((r) => r.map((b) => b.label))).toEqual([
      ['Overview', 'People', 'Social', 'Channels', 'Times'],
      ['Records'],
    ]);
  });

  it('channel views have no Channels page', () => {
    const view = channel('times');
    const shareable = renderStats(view, makeReport(), makeCtx());
    expect(rows(shareable).map((r) => r.map((b) => b.label))).toEqual([
      ['Overview', 'People', 'Social', 'Times', 'Records'],
      [SHARE_LABEL],
    ]);
    expect(buttons(shareable).slice(0, 5).map((b) => decodeStatsCustomId(b.custom_id)?.view)).toEqual(
      CHANNEL_PAGES.map((page) => ({ ...view, page })),
    );
    expect(decodeStatsCustomId(buttons(shareable)[5]!.custom_id)).toEqual({ action: 'share', view });

    const shared = renderStats(view, makeReport(), makeCtx({ shareable: false }));
    expect(rows(shared)).toHaveLength(1);
  });

  it('user views only have the Share row', () => {
    const view = user(1);
    const message = renderStats(view, makeReport(), makeCtx());
    expect(rows(message).map((r) => r.map((b) => b.label))).toEqual([[SHARE_LABEL]]);
    expect(decodeStatsCustomId(buttons(message)[0]!.custom_id)).toEqual({ action: 'share', view });
    expect(renderStats(view, makeReport(), makeCtx({ shareable: false })).components).toEqual([]);
  });
});

describe('frame', () => {
  it('titles each view kind', () => {
    const ctx = makeCtx();
    expect(embedOf(renderStats(server('overview'), makeReport(), ctx)).title).toBe('📊 Voice stats · last 30 days');
    expect(embedOf(renderStats(channel('overview'), makeReport(), ctx)).title).toBe('🔊 General · last 30 days');
    expect(embedOf(renderStats(channel('overview', CH_DELETED), makeReport(), ctx)).title).toBe(
      '🔊 deleted channel · last 30 days',
    );
    expect(embedOf(renderStats(user(1), makeReport(), ctx)).title).toBe("🎧 Alice's voice wrapped · last 30 days");
    expect(embedOf(renderStats(user(77), makeReport(), ctx)).title).toBe("🎧 Former member's voice wrapped · last 30 days");
  });

  it('uses the stats colour', () => {
    expect(embedOf(renderStats(server('overview'), makeReport(), makeCtx())).color).toBe(STATS_EMBED_COLOR);
  });

  it('footer: time zone only when history covers the window', () => {
    const embed = embedOf(renderStats(server('overview'), makeReport(), makeCtx()));
    expect(embed.footer?.text).toBe('Times in Eastern (America/Toronto)');
  });

  it('footer: estimated sessions and short history', () => {
    const report = makeReport({ estimatedSessions: 3, oldestEventAt: Date.UTC(2026, 8, 20, 3) }); // 2026-09-19 local
    expect(embedOf(renderStats(server('overview'), report, makeCtx())).footer?.text).toBe(
      'Times in Eastern (America/Toronto) · 3 sessions estimated (missed leaves) · History only goes back to 2026-09-19',
    );
    const one = makeReport({ estimatedSessions: 1 });
    expect(embedOf(renderStats(server('overview'), one, makeCtx())).footer?.text).toContain('1 session estimated');
  });

  it('footer: server and channel views count the whole report, user cards only that person', () => {
    const people = [person(1, { estimatedSessions: 2 }), person(2), person(3, { estimatedSessions: 1 })];
    const report = makeReport({ estimatedSessions: 7, people });
    const footer = (view: StatsView) => embedOf(renderStats(view, report, makeCtx())).footer?.text;
    expect(footer(server('overview'))).toContain('7 sessions estimated (missed leaves)');
    expect(footer(channel('people'))).toContain('7 sessions estimated (missed leaves)');
    expect(footer(user(1))).toBe('Times in Eastern (America/Toronto) · 2 sessions estimated (missed leaves)');
    expect(footer(user(3))).toContain('1 session estimated');
    expect(footer(user(2))).toBe('Times in Eastern (America/Toronto)');
    expect(footer(user(77))).toBe('Times in Eastern (America/Toronto)'); // no time in the window
  });

  it('footer: no notices at all', () => {
    const report = makeReport({ oldestEventAt: null, people: [] });
    expect(embedOf(renderStats(server('overview'), report, makeCtx())).footer?.text).toBe(
      'Times in Eastern (America/Toronto) · No voice notices found yet',
    );
  });
});

describe('empty report', () => {
  const empty = makeReport({ people: [], pairs: [], groups: [], channels: [], primeTime: null }, 0);

  it.each(SERVER_PAGES)('server %s page says there is no activity', (page) => {
    const embed = embedOf(renderStats(server(page), empty, makeCtx()));
    expect(embed.description).toBe('No voice activity in the last 30 days.');
    expect(embed.fields ?? []).toEqual([]);
  });

  it('user card without data', () => {
    const message = renderStats(user(1), empty, makeCtx());
    const embed = embedOf(message);
    expect(embed.description).toBe('No voice time in the last 30 days.');
    expect(embed.title).toContain('Alice');
    expect(embed.footer?.text).toContain('Times in Eastern');
    expect(buttons(message).map((b) => b.label)).toEqual([SHARE_LABEL]);
  });
});

describe('pages', () => {
  it('overview: totals with trends, top 3, busiest channel, prime time', () => {
    const embed = embedOf(renderStats(server('overview'), makeReport(), makeCtx()));
    const lines = embed.description!.split('\n');
    expect(lines[0]).toBe('⏱️ **57h** of voice time (person-hours) · ▲ 14%');
    expect(lines[1]).toBe('👥 **3 people** in voice · ▼ 25%');
    expect(lines[2]).toBe('📞 **31 calls** · ±0%');
    expect(lines[3]).toBe('🔁 **30 sessions**');
    expect(field(embed, 'Top 3')?.value).toBe('🥇 Alice — 19h\n🥈 Bob — 18h\n🥉 Carol — 17h');
    expect(field(embed, 'Busiest channel')?.value).toBe(`<#${CH_GENERAL}> — 40h person-time`);
    expect(field(embed, 'Prime time')?.value).toBe('Thursdays around 9 pm · 4.2 people on average');
  });

  it('overview: no trends without a previous period', () => {
    const embed = embedOf(renderStats(server('overview'), makeReport({ previousTotals: null }), makeCtx()));
    expect(embed.description).not.toMatch(/[▲▼±]|Trends/);
  });

  it('overview: channel scope skips the busiest channel', () => {
    const report = makeReport({ scope: { kind: 'channel', channelId: CH_GENERAL } });
    expect(field(embedOf(renderStats(channel('overview'), report, makeCtx())), 'Busiest channel')).toBeUndefined();
  });

  it('people: rankings, ties by name, qualification filters', () => {
    const report = makeReport({
      people: [
        person(1, { totalMs: 5 * HOUR_MS, nightShare: 0.4 }),
        person(2, { totalMs: 5 * HOUR_MS, qualified: false, nightShare: 0.9 }),
        person(3, { totalMs: 9 * HOUR_MS, channelsVisited: 1, currentStreak: 0 }),
      ],
    });
    const ctx = makeCtx({ names: new Map([[uid(1), 'Zed'], [uid(2), 'Amy'], [uid(3), 'Max']]) });
    const embed = embedOf(renderStats(server('people'), report, ctx));
    expect(field(embed, 'Total time')?.value).toBe(
      '**1.** Max — 9h · 10 sessions\n**2.** Amy — 5h · 10 sessions\n**3.** Zed — 5h · 10 sessions',
    );
    expect(field(embed, 'Average session')?.value).not.toContain('Amy');
    expect(field(embed, 'Butterflies')?.value).not.toContain('Max');
    expect(field(embed, 'Streaks')?.value).toBe('**1.** Amy — 3 days (best 9)\n**2.** Zed — 3 days (best 9)');
    expect(field(embed, 'Night owls')?.value).toBe('**1.** Zed — 40%\n**2.** Max — 10%');
  });

  it('social: pairs, squads, best friends, glue, solo, starters, closers', () => {
    const embed = embedOf(renderStats(server('social'), makeReport(), makeCtx()));
    expect(field(embed, 'Most time together')?.value).toBe('**1.** Alice & Bob — 5h');
    expect(field(embed, 'Squads')?.value).toBe('**1.** Alice, Bob, Carol — 3h');
    expect(field(embed, 'Best friends')?.value.split('\n')[0]).toBe('Alice → Bob · 5h');
    expect(field(embed, 'Social glue')?.name).toMatch(/added up per person/);
    expect(field(embed, 'Solo time')).toBeDefined();
    expect(field(embed, 'Party starters')?.value).toContain('2 calls started');
    expect(field(embed, 'Last one out')?.value).toContain('1 call closed');
  });

  it('social: skips empty fields', () => {
    const people = [person(1, { partyStarts: 0, closes: 0, soloMs: 0, coMs: 0, bestFriend: null })];
    const embed = embedOf(renderStats(server('social'), makeReport({ people, pairs: [], groups: [] }), makeCtx()));
    expect(embed.description).toBe('Nothing to show here yet.');
    expect(embed.fields).toEqual([]);
  });

  it('channels: top channels and record attendance', () => {
    const embed = embedOf(renderStats(server('channels'), makeReport(), makeCtx()));
    expect(field(embed, 'Top channels')?.value.split('\n')[0]).toBe(
      `**1.** <#${CH_GENERAL}> — 40h person-time · 22h occupied · 31 calls`,
    );
    const records = field(embed, 'Record attendance')!.value.split('\n');
    expect(records[0]).toBe(`**1.** <#${CH_GAMING}> — 7 people · <t:${Math.floor((NOW - 3 * DAY_MS) / 1000)}:f>`);
  });

  it('times: heatmap grid, legend and fields', () => {
    const embed = embedOf(renderStats(server('times'), makeReport(), makeCtx()));
    const grid = heatmapLines(makeReport());
    expect(grid).toHaveLength(7);
    expect(grid[0]).toBe(`\`Mon\` ${'⬛'.repeat(12)}`);
    // Thursday: 1 person (level 1 of 5 vs a 4.2 peak) except the 8-10 pm block at the peak.
    expect(grid[3]).toBe(`\`Thu\` ${'🟩'.repeat(10)}🟥🟩`);
    expect(embed.description).toContain('2-hour blocks from 12 am');
    expect(embed.description).toContain(grid[3]);
    expect(field(embed, 'Prime time')?.value).toContain('Thursdays around 9 pm');
    expect(field(embed, 'Busiest weekday')?.value).toBe('Thursdays · 1.3 people on average');
    expect(field(embed, 'Night owl share')?.value).toBe('6% of voice time is between 12 am and 6 am.');
  });

  it('times: tolerates a malformed heatmap', () => {
    const embed = embedOf(renderStats(server('times'), makeReport({ heatmap: [[Number.NaN, -1]], primeTime: null }), makeCtx()));
    expect(embed.description).toContain(`\`Sun\` ${'⬛'.repeat(12)}`);
    expect(field(embed, 'Busiest weekday')).toBeUndefined();
  });

  it('records: every record with Discord timestamps', () => {
    const embed = embedOf(renderStats(server('records'), makeReport(), makeCtx()));
    expect(field(embed, 'Longest call')?.value).toBe(
      `<#${CH_GENERAL}> · 5h 12m · peak 6 people\n<t:${Math.floor((NOW - 5 * DAY_MS) / 1000)}:f>`,
    );
    expect(field(embed, 'Biggest party')?.value).toContain(`**7 people** in <#${CH_GAMING}>`);
    expect(field(embed, 'Busiest day')?.value).toBe('Sat, Oct 3, 2026 · 40h person-time');
    expect(field(embed, 'Longest session')?.value).toContain('Alice · 7h');
    expect(field(embed, 'Longest streak')?.value).toBe('Bob · 9 days\nending Wed, Oct 7, 2026');
  });

  it('records: deleted channels render as plain text', () => {
    const report = makeReport();
    const embed = embedOf(
      renderStats(server('records'), { ...report, records: { ...report.records, biggestParty: { channelId: CH_DELETED, size: 2, at: NOW } } }, makeCtx()),
    );
    expect(field(embed, 'Biggest party')?.value).toContain('*deleted channel*');
  });

  it('a channel view asked for the Channels page shows the overview', () => {
    const embed = embedOf(renderStats(channel('channels'), makeReport(), makeCtx()));
    expect(embed.description).toContain('of voice time');
  });
});

describe('user card', () => {
  it('shows persona, rank and the wrapped fields', () => {
    const embed = embedOf(renderStats(user(1), makeReport(), makeCtx()));
    expect(embed.description).toMatch(/^\S+ \*\*[^*]+\*\* — .+/);
    const value = (name: string) => field(embed, name)?.value;
    expect(value('Rank')).toBe('#1 of 3');
    expect(value('Total time')).toBe('19h · ▲ 90%');
    expect(value('Sessions')).toBe('10');
    expect(value('Top channel')).toBe(`<#${CH_GENERAL}>`);
    expect(value('Best friend')).toBe('Bob · 5h');
    expect(value('Crew')).toBe('Bob, Carol');
    expect(value('Signature hour')).toBe('9 pm');
    expect(value('Streak')).toBe('3 days · best 9');
    expect(value('Night owl')).toBe('10%');
    expect(value('Starts / 🚪 closes')).toBe('2 / 1');
    expect(embed.fields!.every((f) => f.inline)).toBe(true);
  });

  it('skips fields with nothing to show', () => {
    const people = [
      person(1, { bestFriend: null, topFriends: [], topChannel: null, signatureHour: null, longestStreak: 0, previousTotalMs: null }),
    ];
    const embed = embedOf(renderStats(user(1), makeReport({ people }), makeCtx()));
    expect(fieldNames(embed).join()).not.toMatch(/Best friend|Crew|Top channel|Signature|Streak/);
    expect(field(embed, 'Total time')?.value).toBe('19h');
  });
});

describe('list caps', () => {
  // 100 people with short names, each a candidate for every list, so every list overflows its cap.
  const n = 100;
  const people = Array.from({ length: n }, (_, i) =>
    person(i + 1, {
      totalMs: (200 - i) * HOUR_MS,
      avgSessionMs: (100 - i / 2) * MINUTE_MS,
      longestSessionMs: (300 - i) * MINUTE_MS,
      channelsVisited: 2 + (i % 7),
      currentStreak: 1 + (i % 9),
      nightShare: 0.01 + i / 1000,
      coMs: (100 + i) * MINUTE_MS,
      soloMs: (10 + i) * MINUTE_MS,
      partyStarts: 1 + (i % 11),
      closes: 1 + (i % 13),
      bestFriend: { userId: uid(((i + 1) % n) + 1), ms: HOUR_MS },
    }),
  );
  const channelIds = Array.from({ length: 20 }, (_, c) => String(900000000000000100n + BigInt(c)));
  const report = makeReport({
    people,
    pairs: Array.from({ length: 30 }, (_, i) => ({ a: uid(1), b: uid(i + 2), ms: (30 - i) * HOUR_MS })),
    groups: Array.from({ length: 20 }, (_, g) => ({ userIds: [uid(g + 1), uid(g + 2), uid(g + 3)], ms: (20 - g) * HOUR_MS })),
    channels: channelIds.map((channelId, c) => ({
      channelId,
      personMs: (20 - c) * HOUR_MS,
      occupiedMs: HOUR_MS,
      calls: 3,
      record: { size: 2 + c, at: NOW - c * HOUR_MS },
    })),
  });
  const ctx = makeCtx({
    names: new Map(people.map((p, i) => [p.userId, `P${i + 1}`])),
    channelNames: new Map(channelIds.map((id, c) => [id, `c${c}`])),
  });
  const lineCount = (embed: APIEmbed, name: string) => {
    const value = field(embed, name)?.value;
    expect(value, name).toBeDefined();
    expect(value, name).not.toContain('…');
    return value!.split('\n').length;
  };

  it('people page: top 10 by total time, top 5 elsewhere', () => {
    const embed = embedOf(renderStats(server('people'), report, ctx));
    expect(lineCount(embed, 'Total time')).toBe(10);
    for (const name of ['Average session', 'Marathons', 'Butterflies', 'Streaks', 'Night owls']) {
      expect(lineCount(embed, name), name).toBe(5);
    }
  });

  it('social page: top 10 pairs and best friends, top 5 elsewhere', () => {
    const embed = embedOf(renderStats(server('social'), report, ctx));
    expect(lineCount(embed, 'Most time together')).toBe(10);
    expect(lineCount(embed, 'Best friends')).toBe(10);
    for (const name of ['Squads', 'Social glue', 'Solo time', 'Party starters', 'Last one out']) {
      expect(lineCount(embed, name), name).toBe(5);
    }
  });

  it('channels page: top 5 channels and record attendance', () => {
    const embed = embedOf(renderStats(server('channels'), report, ctx));
    expect(lineCount(embed, 'Top channels')).toBe(5);
    expect(lineCount(embed, 'Record attendance')).toBe(5);
  });
});

describe('names and limits', () => {
  it('escapes markdown and never renders people as mentions', () => {
    const ctx = makeCtx({ names: new Map([[uid(1), '**Boss** <@1> [x](https://e.co)']]) });
    const embed = embedOf(renderStats(server('people'), makeReport(), ctx));
    const total = field(embed, 'Total time')!.value;
    expect(total).toContain('\\*\\*Boss\\*\\*');
    expect(total).not.toContain('<@');
    expect(total).toContain('\\[x]');
    expect(total).toContain('Former member'); // uid(2) and uid(3) have no name
  });

  it('defuses line-start markdown and bidi controls in names', () => {
    const ctx = makeCtx({ names: new Map([[uid(1), '>>> \u202Eloud'], [uid(2), '-# tiny'], [uid(3), 'Carol']]) });
    const embed = embedOf(renderStats(server('social'), makeReport(), ctx));
    const friends = field(embed, 'Best friends')!.value.split('\n');
    expect(friends[0]).toBe('\\>>> loud → \\-# tiny · 5h');
    expect(JSON.stringify(embed)).not.toContain('\\u202e');
    expect(JSON.stringify(embed)).not.toContain('\u202E');
  });

    it('stays within every Discord limit with 100 hostile names', () => {
    const n = 100;
    const nasty = (i: number) => `${'*_~|`'.repeat(12)}${i}${'<@!1>'.repeat(4)}`;
    const people = Array.from({ length: n }, (_, i) =>
      person(i + 1, {
        totalMs: (n - i) * HOUR_MS,
        channelsVisited: 50,
        currentStreak: 300,
        longestStreak: 365,
        nightShare: 0.5,
        partyStarts: 100,
        closes: 100,
        topFriends: [1, 2, 3].map((k) => ({ userId: uid(((i + k) % n) + 1), ms: HOUR_MS })),
      }),
    );
    const report = makeReport({
      people,
      pairs: people.slice(1).map((p, i) => ({ a: uid(1), b: p.userId, ms: (n - i) * HOUR_MS })),
      groups: Array.from({ length: 20 }, (_, g) => ({ userIds: people.slice(g, g + 40).map((p) => p.userId), ms: HOUR_MS })),
      channels: Array.from({ length: 50 }, (_, c) => ({
        channelId: String(900000000000000100n + BigInt(c)),
        personMs: 1e12,
        occupiedMs: 1e12,
        calls: 99_999,
        record: { size: 99, at: NOW },
      })),
      estimatedSessions: 99_999,
      oldestEventAt: NOW - DAY_MS,
    });
    const ctx = makeCtx({
      names: new Map(people.map((p, i) => [p.userId, nasty(i)])),
      channelNames: new Map([[CH_GENERAL, 'x'.repeat(100)]]),
    });
    const views: StatsView[] = [
      ...SERVER_PAGES.map(server),
      ...CHANNEL_PAGES.map((page) => channel(page)),
      ...people.slice(0, 5).map((_, i) => user(i + 1)),
    ];
    for (const view of views) {
      const message = renderStats(view, report, ctx);
      const embed = embedOf(message);
      expectWithinLimits(embed);
      expect(JSON.stringify(embed)).not.toContain('<@!1>');
      for (const b of buttons(message)) expect(b.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
});
