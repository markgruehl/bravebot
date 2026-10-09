/**
 * End to end through the pure pipeline: notice text exactly as describeVoiceChange writes it,
 * posted as bot messages -> eventFromMessage -> mergeEvents -> buildReport (sessions + compute)
 * -> renderStats, for the server, channel and user views.
 */
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
import { describeVoiceChange, type VoiceNoticeParty } from '../voice-activity/notices.js';
import { decodeStatsCustomId, encodeStatsCustomId } from './customId.js';
import { eventFromMessage, mergeEvents } from './events.js';
import { embedLength } from './format.js';
import { buildReport } from './pipeline.js';
import { CHANNEL_PAGES, SERVER_PAGES, renderStats } from './render.js';
import { HOUR_MS, MINUTE_MS } from './time.js';
import type {
  Checkpoint,
  GuildVoiceHistory,
  NoticeMessage,
  PersonInfo,
  StatsMessage,
  StatsView,
  VoiceEvent,
} from './types.js';

const BOT_ID = '900000000000000001';
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const CAROL = '100000000000000003';
const DAVE = '100000000000000004';
const EVE = '100000000000000005';
const ROBOT = '100000000000000009'; // another bot: its notices are posted but must not count
const GENERAL = '200000000000000001';
const GAMING = '200000000000000002';
const SYSTEM = '300000000000000001';

const NOW = Date.UTC(2026, 9, 8, 16, 0); // Thu Oct 8 2026, 12:00 in Toronto (EDT)
/** 19:00 Toronto on a day in October 2026 (EDT, UTC-4). */
const evening = (day: number) => Date.UTC(2026, 9, day, 23, 0);

const people = new Map<string, PersonInfo>([
  [ALICE, { name: 'Alice', bot: false }],
  [BOB, { name: 'Bob', bot: false }],
  [CAROL, { name: 'Carol <@1> **x**', bot: false }],
  [DAVE, { name: 'Dave', bot: false }],
  [EVE, { name: 'Eve', bot: false }],
  [ROBOT, { name: 'Robot', bot: true }],
]);
const names = new Map([...people].filter(([, p]) => !p.bot).map(([id, p]) => [id, p.name]));
const channelNames = new Map([
  [GENERAL, 'General'],
  [GAMING, 'Gaming'],
]);

const user = (id: string): VoiceNoticeParty => ({ mention: `<@${id}>`, name: people.get(id)?.name ?? id });
const channel = (id: string): VoiceNoticeParty => ({ mention: `<#${id}>`, name: channelNames.get(id) ?? id });

/** A snowflake for a time (Discord epoch, worker/sequence bits from a counter). */
let sequence = 0;
function snowflake(at: number): string {
  sequence += 1;
  return ((BigInt(at - 1_420_070_400_000) << 22n) | BigInt(sequence % 4096)).toString();
}

const messages: NoticeMessage[] = [];
function post(at: number, content: string, authorId = BOT_ID): void {
  messages.push({ id: snowflake(at), channelId: SYSTEM, content, createdTimestamp: at, author: { id: authorId } });
}
function notice(at: number, userId: string, from: string | null, to: string | null, legacy = false): void {
  const text = describeVoiceChange(user(userId), from ? channel(from) : null, to ? channel(to) : null)?.mentions;
  if (!text) throw new Error('no notice');
  post(at, legacy ? text.replace('<@', '<@!') : text);
}
const connect = (at: number, userId: string, to: string) => notice(at, userId, null, to);
const disconnect = (at: number, userId: string, from: string, legacy = false) => notice(at, userId, from, null, legacy);
const move = (at: number, userId: string, from: string, to: string) => notice(at, userId, from, to);

// Before the previous period (so history covers it): Alice alone for an hour on Aug 1.
connect(Date.UTC(2026, 7, 1, 23, 0), ALICE, GENERAL);
disconnect(Date.UTC(2026, 7, 2, 0, 0), ALICE, GENERAL);
// Previous period (Aug 9 - Sep 8): Alice and Bob together for an hour on Aug 20.
connect(Date.UTC(2026, 7, 20, 23, 0), ALICE, GENERAL);
connect(Date.UTC(2026, 7, 20, 23, 0) + 1000, BOB, GENERAL);
disconnect(Date.UTC(2026, 7, 21, 0, 0), ALICE, GENERAL);
disconnect(Date.UTC(2026, 7, 21, 0, 0) + 1000, BOB, GENERAL);

// Oct 1: Eve joins and the bot never sees her leave (missed leave -> capped at 12h, estimated).
connect(Date.UTC(2026, 9, 2, 0, 0), EVE, GENERAL);

// Mon-Wed Oct 5-7, the same evening each day:
//   19:00 Alice starts General · 19:30 Bob · 20:00 Carol · 20:05-20:10 Robot (a bot)
//   20:30 Carol moves to Gaming · 21:00 Alice leaves · 21:30 Bob leaves last · 22:00 Carol leaves
for (const day of [5, 6, 7]) {
  const t = evening(day);
  connect(t, ALICE, GENERAL);
  connect(t + 30 * MINUTE_MS, BOB, GENERAL);
  connect(t + 60 * MINUTE_MS, CAROL, GENERAL);
  connect(t + 65 * MINUTE_MS, ROBOT, GENERAL);
  disconnect(t + 70 * MINUTE_MS, ROBOT, GENERAL);
  move(t + 90 * MINUTE_MS, CAROL, GENERAL, GAMING);
  disconnect(t + 120 * MINUTE_MS, ALICE, GENERAL);
  disconnect(t + 150 * MINUTE_MS, BOB, GENERAL, day === 6); // one in the legacy <@!id> form
  disconnect(t + 180 * MINUTE_MS, CAROL, GAMING);
}

// Today: Dave is in Gaming right now.
connect(NOW - 2 * HOUR_MS, DAVE, GAMING);

// Noise in the system channel: not notices, or not written by the bot.
post(NOW - 3 * HOUR_MS, 'Welcome to the server!');
post(NOW - 3 * HOUR_MS, `<@${BOB}> has connected to <#${GENERAL}>`, BOB);
post(NOW - 3 * HOUR_MS, `<@${BOB}> has connected to <#${GENERAL}> lol`);

// The cache reads pages newest -> oldest; mergeEvents sorts and dedupes.
const scanned = [...messages]
  .reverse()
  .map((message) => eventFromMessage(message, BOT_ID))
  .filter((event): event is VoiceEvent => event !== null);
const events = mergeEvents([], scanned);

const history: GuildVoiceHistory = {
  channelId: SYSTEM,
  events,
  // The bot restarted this morning with nobody in voice.
  checkpoints: [{ at: NOW - 5 * HOUR_MS, present: new Map() }],
  oldestEventAt: events[0]?.at ?? null,
};
const live: Checkpoint = {
  at: NOW,
  present: new Map([
    [DAVE, GAMING],
    [ROBOT, GENERAL],
  ]),
};

const report = (view: StatsView) => buildReport({ history, people, live, view, now: NOW });
const render = (view: StatsView, shareable = true) =>
  renderStats(view, report(view), { names, channelNames, shareable, now: NOW });

const MIN = MINUTE_MS;

function embedText(embed: APIEmbed): string {
  return [
    embed.title ?? '',
    embed.description ?? '',
    embed.footer?.text ?? '',
    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
  ].join('\n');
}

/** Every Discord limit for one message, plus button ids that decode back to themselves. */
function expectWithinDiscordLimits(message: StatsMessage): void {
  expect(message.embeds).toHaveLength(1);
  for (const embed of message.embeds) {
    expect(embed.title?.length ?? 0).toBeLessThanOrEqual(EMBED_TITLE_LIMIT);
    expect(embed.description?.length ?? 0).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    expect(embed.footer?.text.length ?? 0).toBeLessThanOrEqual(EMBED_FOOTER_LIMIT);
    expect(embed.fields?.length ?? 0).toBeLessThanOrEqual(EMBED_FIELDS_MAX);
    for (const f of embed.fields ?? []) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.name.length).toBeLessThanOrEqual(EMBED_FIELD_NAME_LIMIT);
      expect(f.value.length).toBeGreaterThan(0);
      expect(f.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_LIMIT);
    }
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_LIMIT);
    // People are names, never mentions (allowedMentions is off too, but nothing should look like one).
    expect(embedText(embed)).not.toMatch(/<@[!&]?\d/);
  }
  expect(message.components.length).toBeLessThanOrEqual(5);
  for (const row of message.components) {
    expect(row.components.length).toBeLessThanOrEqual(5);
    for (const button of row.components) {
      const customId = 'custom_id' in button ? button.custom_id : '';
      expect(customId.length).toBeLessThanOrEqual(100);
      const decoded = decodeStatsCustomId(customId);
      expect(decoded).not.toBeNull();
      expect(encodeStatsCustomId(decoded!.action, decoded!.view)).toBe(customId);
    }
  }
}

describe('voice stats end to end', () => {
  it('parses every bot notice (legacy mentions too) and nothing else', () => {
    // 2 + 4 + 1 + 3 * 9 + 1 notices; the 3 noise messages are dropped.
    expect(events).toHaveLength(35);
    expect(events.filter((e) => e.userId === BOB && e.kind === 'disconnect')).toHaveLength(4);
  });

  it('computes the server report', () => {
    const r = report({ kind: 'server', page: 'overview', days: 30 });
    const byId = new Map(r.people.map((p) => [p.userId, p]));

    // Eve 12h (estimated), Alice/Bob/Carol 3 x 2h, Dave 2h live. Robot is a bot: absent.
    expect(r.people.map((p) => p.userId)).toEqual([EVE, ALICE, BOB, CAROL, DAVE]);
    expect(r.totals).toEqual({ personMs: 32 * HOUR_MS, people: 5, calls: 8, sessions: 11 });
    expect(r.estimatedSessions).toBe(1);
    expect(byId.get(EVE)?.totalMs).toBe(12 * HOUR_MS);
    expect(byId.get(DAVE)?.totalMs).toBe(2 * HOUR_MS);
    expect(byId.get(EVE)?.estimatedSessions).toBe(1);
    expect(byId.get(ALICE)?.estimatedSessions).toBe(0);

    // Previous period: Alice + Bob for an hour each.
    expect(r.previousTotals).toEqual({ personMs: 2 * HOUR_MS, people: 2, calls: 1, sessions: 2 });
    expect(byId.get(ALICE)?.previousTotalMs).toBe(HOUR_MS);

    // Co-time: Alice & Bob 90m a night, both with Carol 30m a night; the trio 30m a night.
    expect(r.pairs).toEqual([
      { a: ALICE, b: BOB, ms: 270 * MIN },
      { a: ALICE, b: CAROL, ms: 90 * MIN },
      { a: BOB, b: CAROL, ms: 90 * MIN },
    ]);
    expect(r.groups).toEqual([{ userIds: [ALICE, BOB, CAROL], ms: 90 * MIN }]);
    expect(byId.get(ALICE)?.bestFriend).toEqual({ userId: BOB, ms: 270 * MIN });

    // Alice starts each General call, Bob closes it; Carol's solo Gaming calls don't count.
    expect(byId.get(ALICE)).toMatchObject({ partyStarts: 3, closes: 0, qualified: true });
    expect(byId.get(BOB)).toMatchObject({ partyStarts: 0, closes: 3 });
    expect(byId.get(CAROL)).toMatchObject({ partyStarts: 0, closes: 0, channelsVisited: 2 });

    // Mon-Wed, last one yesterday: a live 3-day streak. 19:00 is Alice's hour.
    expect(byId.get(ALICE)).toMatchObject({ currentStreak: 3, longestStreak: 3, signatureHour: 19 });
    // Streaks use all history: a 2-day window holds only Oct 6-7 but still sees Oct 5.
    const short = report({ kind: 'server', page: 'overview', days: 2 });
    expect(short.people.find((p) => p.userId === ALICE)).toMatchObject({ currentStreak: 3, longestStreak: 3 });

    // The bot joining made no 4-person party.
    expect(r.records.biggestParty).toMatchObject({ channelId: GENERAL, size: 3 });
    expect(r.records.longestSession).toMatchObject({ userId: EVE, ms: 12 * HOUR_MS });
    expect(r.records.longestCall).toMatchObject({ channelId: GENERAL, peak: 3 });
    expect(r.records.longestCall!.end - r.records.longestCall!.start).toBe(150 * MIN);
    expect(r.heatmap).toHaveLength(7);
    expect(r.heatmap.every((row) => row.length === 12)).toBe(true);
  });

  it('renders every server page within Discord limits', () => {
    for (const page of SERVER_PAGES) {
      const message = render({ kind: 'server', page, days: 30 });
      expectWithinDiscordLimits(message);
    }
    const overview = render({ kind: 'server', page: 'overview', days: 30 }).embeds[0]!;
    expect(overview.description).toContain('**32h** of voice time');
    expect(overview.description).toContain('▲ 1500%');
    expect(overview.footer?.text).toContain('1 session estimated');
    expect(overview.footer?.text).not.toContain('History only goes back');

    const social = embedText(render({ kind: 'server', page: 'social', days: 30 }).embeds[0]!);
    expect(social).toContain('Alice & Bob — 4h 30m');
    expect(social).toMatch(/Party starters[^\n]*\n\*\*1\.\*\* Alice — 3 calls started/);
    expect(social).toMatch(/Last one out[^\n]*\n\*\*1\.\*\* Bob — 3 calls closed/);
    // Carol's name is escaped text, not a mention or bold.
    expect(social).toContain('Carol <\u200b@1> \\*\\*x\\*\\*');
  });

  it('computes and renders one channel', () => {
    const view: StatsView = { kind: 'channel', channelId: GENERAL, page: 'overview', days: 30 };
    const r = report(view);
    // General only: Eve 12h, Alice 6h, Bob 6h, Carol 3 x 30m.
    expect(r.totals.personMs).toBe(25.5 * HOUR_MS);
    expect(r.people.find((p) => p.userId === CAROL)).toMatchObject({ totalMs: 90 * MIN, sessions: 3 });
    expect(r.channels.map((c) => c.channelId)).toEqual([GENERAL]);
    expect(r.pairs[0]).toEqual({ a: ALICE, b: BOB, ms: 270 * MIN });

    for (const page of CHANNEL_PAGES) expectWithinDiscordLimits(render({ ...view, page }));
    expect(render(view).embeds[0]!.title).toContain('General');
  });

  it("renders a user's card", () => {
    const message = render({ kind: 'user', userId: ALICE, days: 30 });
    expectWithinDiscordLimits(message);
    const text = embedText(message.embeds[0]!);
    expect(text).toContain("Alice's voice wrapped");
    expect(text).toContain('#2 of 5');
    expect(text).toContain('6h · ▲ 500%');
    expect(text).toContain('Bob · 4h 30m');
    expect(text).toContain('7 pm');

    // The public copy has no Share button.
    expect(render({ kind: 'user', userId: ALICE, days: 30 }, false).components).toEqual([]);
  });

  it('keeps every view within limits at the extremes of `days`', () => {
    for (const days of [1, 365]) {
      for (const page of SERVER_PAGES) expectWithinDiscordLimits(render({ kind: 'server', page, days }));
      expectWithinDiscordLimits(render({ kind: 'user', userId: EVE, days }));
    }
    // A short window says how far history goes back only when it doesn't cover the window.
    expect(render({ kind: 'server', page: 'overview', days: 365 }).embeds[0]!.footer?.text).toContain(
      'History only goes back to 2026-08-01',
    );
  });
});
