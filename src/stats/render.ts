/**
 * StatsReport -> /stats message (one embed + buttons). PURE; raw API objects like panel.ts.
 *
 * Server view: pages Overview / People / Social / Channels / Times on row 1, Records (+ Share)
 * on row 2. Channel view: the same pages minus Channels, five on row 1, Share on row 2. User
 * view: a "wrapped" card, only a Share row. The current page button is primary + disabled.
 * Page buttons carry action "page" with their target view; Share carries the current view.
 *
 * People are always plain escaped names (never mentions); channels in bodies are <#id>.
 * Every embed goes through fitEmbed(), so Discord's limits hold for any input.
 */
import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from 'discord.js';
import { STATS_NIGHT_END_HOUR, STATS_NIGHT_START_HOUR, STATS_TIMEZONE, STATS_TOP_OTHER, STATS_TOP_PEOPLE } from '../constants.js';
import { encodeStatsCustomId } from './customId.js';
import {
  FORMER_MEMBER,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  discordTimestamp,
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
} from './format.js';
import { pickPersona } from './persona.js';
import { dateKeyOf } from './time.js';
import type { PersonSummary, RenderContext, StatsMessage, StatsPage, StatsReport, StatsView } from './types.js';

/** Discord blurple. */
export const STATS_EMBED_COLOR = 0x5865f2;

export const SERVER_PAGES: readonly StatsPage[] = ['overview', 'people', 'social', 'channels', 'times', 'records'];
export const CHANNEL_PAGES: readonly StatsPage[] = ['overview', 'people', 'social', 'times', 'records'];

const PAGE_LABELS: Record<StatsPage, string> = {
  overview: 'Overview',
  people: 'People',
  social: 'Social',
  channels: 'Channels',
  times: 'Times',
  records: 'Records',
};

export const SHARE_LABEL = '📤 Share';
const DELETED_CHANNEL = 'deleted channel';
/** Heatmap levels: zero, then five quantised levels relative to the busiest cell. */
const HEAT_ZERO = '⬛';
const HEAT_LEVELS = ['🟦', '🟩', '🟨', '🟧', '🟥'] as const;
const MEDALS = ['🥇', '🥈', '🥉'] as const;
/** Names listed per squad line before "+N more". */
const SQUAD_NAMES_MAX = 6;

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Helpers {
  readonly name: (userId: string) => string;
  readonly channel: (channelId: string) => string;
  /** Desc by value, then by name, then id: the "ties by name" rule for every list. */
  readonly rank: <T>(items: readonly T[], value: (item: T) => number, userId: (item: T) => string) => T[];
}

function helpers(ctx: RenderContext): Helpers {
  const rawName = (id: string) => ctx.names.get(id) ?? FORMER_MEMBER;
  return {
    name: (id) => safeName(rawName(id)),
    channel: (id) => (ctx.channelNames.has(id) ? `<#${id}>` : `*${DELETED_CHANNEL}*`),
    rank: (items, value, userId) =>
      [...items].sort(
        (x, y) =>
          value(y) - value(x) ||
          rawName(userId(x)).localeCompare(rawName(userId(y))) ||
          userId(x).localeCompare(userId(y)),
      ),
  };
}

function field(name: string, lines: readonly string[], inline = false): APIEmbedField | null {
  const value = fieldValueFromLines(lines);
  return value === '' ? null : { name, value, inline };
}

function numbered(lines: readonly string[]): string[] {
  return lines.map((line, i) => `**${i + 1}.** ${line}`);
}

function withTrend(text: string, current: number, previous: number | null | undefined): string {
  const trend = formatTrend(current, previous ?? null);
  return trend === '' ? text : `${text} · ${trend}`;
}

function primeTimeText(report: StatsReport): string | null {
  const prime = report.primeTime;
  if (!prime) return null;
  return `${WEEKDAY_NAMES[prime.weekday]}s around ${formatHour(prime.hour)} · ${prime.avgPeople.toFixed(1)} people on average`;
}

function heatCell(report: StatsReport, weekday: number, block: number): number {
  const value = report.heatmap[weekday]?.[block] ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface Body {
  description?: string;
  fields: (APIEmbedField | null)[];
}

function overviewPage(report: StatsReport, h: Helpers): Body {
  const { totals, previousTotals: prev } = report;
  const description = [
    withTrend(`⏱️ **${formatDuration(totals.personMs)}** of voice time (person-hours)`, totals.personMs, prev?.personMs),
    withTrend(`👥 **${plural(totals.people, 'person', 'people')}** in voice`, totals.people, prev?.people),
    withTrend(`📞 **${plural(totals.calls, 'call')}**`, totals.calls, prev?.calls),
    `🔁 **${plural(totals.sessions, 'session')}**`,
  ];
  if (prev) {
    const span = report.window.days === 1 ? 'day' : `${report.window.days} days`;
    description.push(`*Trends compare with the previous ${span}.*`);
  }

  const top = h.rank(report.people, (p) => p.totalMs, (p) => p.userId).slice(0, MEDALS.length);
  const busiest = report.scope.kind === 'server' ? report.channels[0] : undefined;
  const prime = primeTimeText(report);
  return {
    description: description.join('\n'),
    fields: [
      field(
        '🏆 Top 3',
        top.map((p, i) => `${MEDALS[i] ?? ''} ${h.name(p.userId)} — ${formatDuration(p.totalMs)}`),
      ),
      busiest
        ? field('🔊 Busiest channel', [`${h.channel(busiest.channelId)} — ${formatDuration(busiest.personMs)} person-time`])
        : null,
      prime ? field('🕒 Prime time', [prime]) : null,
    ],
  };
}

function peoplePage(report: StatsReport, h: Helpers): Body {
  const people = report.people;
  const id = (p: PersonSummary) => p.userId;
  const qualified = people.filter((p) => p.qualified);
  return {
    fields: [
      field(
        '⏱️ Total time',
        numbered(
          h
            .rank(people, (p) => p.totalMs, id)
            .slice(0, STATS_TOP_PEOPLE)
            .map((p) => `${h.name(p.userId)} — ${formatDuration(p.totalMs)} · ${plural(p.sessions, 'session')}`),
        ),
      ),
      field(
        '⏲️ Average session',
        numbered(
          h
            .rank(qualified, (p) => p.avgSessionMs, id)
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${formatDuration(p.avgSessionMs)}`),
        ),
      ),
      field(
        '🏁 Marathons',
        numbered(
          h
            .rank(
              people.filter((p) => p.longestSessionMs > 0),
              (p) => p.longestSessionMs,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${formatDuration(p.longestSessionMs)}`),
        ),
      ),
      field(
        '🦋 Butterflies',
        numbered(
          h
            .rank(
              people.filter((p) => p.channelsVisited > 1),
              (p) => p.channelsVisited,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${plural(p.channelsVisited, 'channel')}`),
        ),
      ),
      field(
        '🔥 Streaks',
        numbered(
          h
            .rank(
              people.filter((p) => p.currentStreak > 0),
              // Current streak first, best streak as the tie-break.
              (p) => p.currentStreak * 10_000 + p.longestStreak,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${plural(p.currentStreak, 'day')} (best ${p.longestStreak})`),
        ),
      ),
      field(
        '🦉 Night owls',
        numbered(
          h
            .rank(
              qualified.filter((p) => p.nightShare > 0),
              (p) => p.nightShare,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${formatPercent(p.nightShare)}`),
        ),
      ),
    ],
  };
}

function squadLine(userIds: readonly string[], h: Helpers): string {
  const shown = userIds.slice(0, SQUAD_NAMES_MAX).map(h.name);
  const extra = userIds.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
}

function socialPage(report: StatsReport, h: Helpers): Body {
  const people = report.people;
  const id = (p: PersonSummary) => p.userId;
  const qualified = people.filter((p) => p.qualified);
  const top = <T>(items: readonly T[], n: number) => items.slice(0, n);
  return {
    fields: [
      field(
        '🤝 Most time together',
        numbered(
          top(report.pairs, STATS_TOP_PEOPLE).map((pair) => `${h.name(pair.a)} & ${h.name(pair.b)} — ${formatDuration(pair.ms)}`),
        ),
      ),
      field(
        '👥 Squads',
        numbered(
          top(report.groups, STATS_TOP_OTHER).map((group) => `${squadLine(group.userIds, h)} — ${formatDuration(group.ms)}`),
        ),
      ),
      field(
        '💞 Best friends',
        h
          .rank(people, (p) => p.totalMs, id)
          .flatMap((p) => (p.bestFriend ? [{ p, friend: p.bestFriend }] : []))
          .slice(0, STATS_TOP_PEOPLE)
          .map(({ p, friend }) => `${h.name(p.userId)} → ${h.name(friend.userId)} · ${formatDuration(friend.ms)}`),
      ),
      field(
        '🧲 Social glue · time with others, added up per person',
        numbered(
          h
            .rank(
              people.filter((p) => p.coMs > 0),
              (p) => p.coMs,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${formatDuration(p.coMs)}`),
        ),
      ),
      field(
        '🫥 Solo time',
        numbered(
          h
            .rank(
              people.filter((p) => p.soloMs > 0),
              (p) => p.soloMs,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${formatDuration(p.soloMs)}`),
        ),
      ),
      field(
        '🎉 Party starters',
        numbered(
          h
            .rank(
              qualified.filter((p) => p.partyStarts > 0),
              (p) => p.partyStarts,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${plural(p.partyStarts, 'call')} started`),
        ),
      ),
      field(
        '🚪 Last one out',
        numbered(
          h
            .rank(
              qualified.filter((p) => p.closes > 0),
              (p) => p.closes,
              id,
            )
            .slice(0, STATS_TOP_OTHER)
            .map((p) => `${h.name(p.userId)} — ${plural(p.closes, 'call')} closed`),
        ),
      ),
    ],
  };
}

function channelsPage(report: StatsReport, h: Helpers): Body {
  const records = [...report.channels]
    .filter((c) => c.record.size > 0)
    .sort((x, y) => y.record.size - x.record.size || x.record.at - y.record.at || x.channelId.localeCompare(y.channelId));
  return {
    fields: [
      field(
        '🔊 Top channels',
        numbered(
          report.channels
            .slice(0, STATS_TOP_OTHER)
            .map(
              (c) =>
                `${h.channel(c.channelId)} — ${formatDuration(c.personMs)} person-time · ${formatDuration(c.occupiedMs)} occupied · ${plural(c.calls, 'call')}`,
            ),
        ),
      ),
      field(
        '🏆 Record attendance',
        numbered(
          records
            .slice(0, STATS_TOP_OTHER)
            .map((c) => `${h.channel(c.channelId)} — ${plural(c.record.size, 'person', 'people')} · ${discordTimestamp(c.record.at, 'f')}`),
        ),
      ),
    ],
  };
}

/** Heatmap grid lines (Mon..Sun), each a weekday label plus 12 two-hour blocks. */
export function heatmapLines(report: StatsReport): string[] {
  let max = 0;
  for (let d = 0; d < 7; d++) for (let b = 0; b < 12; b++) max = Math.max(max, heatCell(report, d, b));
  return WEEKDAY_SHORT.map((label, d) => {
    let cells = '';
    for (let b = 0; b < 12; b++) {
      const value = heatCell(report, d, b);
      if (value <= 0 || max <= 0) {
        cells += HEAT_ZERO;
      } else {
        const level = Math.min(HEAT_LEVELS.length - 1, Math.max(0, Math.ceil((value / max) * HEAT_LEVELS.length) - 1));
        cells += HEAT_LEVELS[level];
      }
    }
    return `\`${label}\` ${cells}`;
  });
}

function timesPage(report: StatsReport): Body {
  let peak = 0;
  for (let d = 0; d < 7; d++) for (let b = 0; b < 12; b++) peak = Math.max(peak, heatCell(report, d, b));
  const description = [
    'Average people in voice by weekday, in 2-hour blocks from 12 am (left) to 10 pm (right).',
    `${HEAT_ZERO} nobody · ${HEAT_LEVELS.join('')} quiet → busiest (${peak.toFixed(1)} people)`,
    '',
    ...heatmapLines(report),
  ].join('\n');

  let busiest: { weekday: number; avg: number } | null = null;
  for (let d = 0; d < 7; d++) {
    let sum = 0;
    for (let b = 0; b < 12; b++) sum += heatCell(report, d, b);
    const avg = sum / 12;
    if (avg > 0 && (!busiest || avg > busiest.avg)) busiest = { weekday: d, avg };
  }

  const total = report.people.reduce((sum, p) => sum + p.totalMs, 0);
  const night = report.people.reduce((sum, p) => sum + p.nightMs, 0);
  const prime = primeTimeText(report);
  return {
    description,
    fields: [
      prime ? field('🕒 Prime time', [prime]) : null,
      busiest
        ? field('📅 Busiest weekday', [`${WEEKDAY_NAMES[busiest.weekday] ?? '?'}s · ${busiest.avg.toFixed(1)} people on average`])
        : null,
      total > 0
        ? field('🌙 Night owl share', [
            `${formatPercent(night / total)} of voice time is between ${formatHour(STATS_NIGHT_START_HOUR)} and ${formatHour(STATS_NIGHT_END_HOUR)}.`,
          ])
        : null,
    ],
  };
}

function recordsPage(report: StatsReport, h: Helpers): Body {
  const r = report.records;
  return {
    fields: [
      r.longestCall
        ? field('📞 Longest call', [
            `${h.channel(r.longestCall.channelId)} · ${formatDuration(r.longestCall.end - r.longestCall.start)} · peak ${plural(r.longestCall.peak, 'person', 'people')}`,
            discordTimestamp(r.longestCall.start, 'f'),
          ])
        : null,
      r.biggestParty
        ? field('🎉 Biggest party', [
            `**${plural(r.biggestParty.size, 'person', 'people')}** in ${h.channel(r.biggestParty.channelId)}`,
            discordTimestamp(r.biggestParty.at, 'f'),
          ])
        : null,
      r.busiestDay
        ? field('📅 Busiest day', [`${formatDateKey(r.busiestDay.date)} · ${formatDuration(r.busiestDay.personMs)} person-time`])
        : null,
      r.longestSession
        ? field('🏁 Longest session', [
            `${h.name(r.longestSession.userId)} · ${formatDuration(r.longestSession.ms)}`,
            discordTimestamp(r.longestSession.start, 'f'),
          ])
        : null,
      r.longestStreak
        ? field('🔥 Longest streak', [
            `${h.name(r.longestStreak.userId)} · ${plural(r.longestStreak.days, 'day')}`,
            `ending ${formatDateKey(r.longestStreak.endDate)}`,
          ])
        : null,
    ],
  };
}

function userCard(person: PersonSummary, report: StatsReport, h: Helpers): Body {
  const persona = pickPersona(person, report);
  const inline = (name: string, value: string) => field(name, [value], true);
  return {
    description: `${persona.emoji} **${persona.title}** — ${persona.line}`,
    fields: [
      inline('🏅 Rank', `#${person.rank} of ${report.people.length}`),
      inline('⏱️ Total time', withTrend(formatDuration(person.totalMs), person.totalMs, person.previousTotalMs)),
      inline('🔁 Sessions', String(person.sessions)),
      inline('⏲️ Avg session', formatDuration(person.avgSessionMs)),
      inline('🏁 Longest session', formatDuration(person.longestSessionMs)),
      person.topChannel ? inline('🔊 Top channel', h.channel(person.topChannel.channelId)) : null,
      person.bestFriend
        ? inline('💞 Best friend', `${h.name(person.bestFriend.userId)} · ${formatDuration(person.bestFriend.ms)}`)
        : null,
      person.topFriends.length > 0 ? inline('👥 Crew', person.topFriends.map((f) => h.name(f.userId)).join(', ')) : null,
      person.signatureHour !== null ? inline('🕒 Signature hour', formatHour(person.signatureHour)) : null,
      person.longestStreak > 0
        ? inline('🔥 Streak', `${plural(person.currentStreak, 'day')} · best ${person.longestStreak}`)
        : null,
      inline('🦉 Night owl', formatPercent(person.nightShare)),
      inline('🎉 Starts / 🚪 closes', `${person.partyStarts} / ${person.closes}`),
    ],
  };
}

// ---------------------------------------------------------------------------
// Frame: title, footer, components
// ---------------------------------------------------------------------------

/**
 * Footer parts joined with " · ". Plain text only: footers can't render <t:> timestamps.
 * `estimatedSessions` is the report total for server/channel views and the person's own
 * count on a user card.
 */
export function footerText(report: StatsReport, estimatedSessions = report.estimatedSessions): string {
  const parts = [
    report.timeZone === STATS_TIMEZONE ? `Times in Eastern (${STATS_TIMEZONE})` : `Times in ${report.timeZone}`,
  ];
  if (estimatedSessions > 0) {
    parts.push(`${plural(estimatedSessions, 'session')} estimated (missed leaves)`);
  }
  if (report.oldestEventAt === null) {
    parts.push('No voice notices found yet');
  } else if (report.oldestEventAt > report.window.from) {
    parts.push(`History only goes back to ${dateKeyOf(report.oldestEventAt, report.timeZone)}`);
  }
  return parts.join(' · ');
}

function titleOf(view: StatsView, report: StatsReport, ctx: RenderContext): string {
  const days = lastDays(report.window.days);
  switch (view.kind) {
    case 'server':
      return `📊 Voice stats · ${days}`;
    case 'channel':
      return `🔊 ${safeName(ctx.channelNames.get(view.channelId) ?? DELETED_CHANNEL, 100)} · ${days}`;
    case 'user':
      return `🎧 ${safeName(ctx.names.get(view.userId) ?? FORMER_MEMBER)}'s voice wrapped · ${days}`;
  }
}

function button(customId: string, label: string, style: ButtonStyle, disabled = false): APIButtonComponentWithCustomId {
  return {
    type: ComponentType.Button,
    style: style as APIButtonComponentWithCustomId['style'],
    custom_id: customId,
    label,
    disabled,
  };
}

function row(components: APIButtonComponentWithCustomId[]): Row {
  return { type: ComponentType.ActionRow, components };
}

/** The page a view actually shows (a channel view has no Channels page). */
export function effectivePage(view: StatsView): StatsPage | null {
  if (view.kind === 'user') return null;
  if (view.kind === 'channel' && view.page === 'channels') return 'overview';
  return view.page;
}

function components(view: StatsView, ctx: RenderContext): Row[] {
  const share = button(encodeStatsCustomId('share', view), SHARE_LABEL, ButtonStyle.Secondary);
  const current = effectivePage(view);
  if (view.kind === 'user' || current === null) return ctx.shareable ? [row([share])] : [];

  const pages = view.kind === 'server' ? SERVER_PAGES : CHANNEL_PAGES;
  const buttons = pages.map((page) =>
    button(
      encodeStatsCustomId('page', { ...view, page }),
      PAGE_LABELS[page],
      page === current ? ButtonStyle.Primary : ButtonStyle.Secondary,
      page === current,
    ),
  );
  const first = buttons.slice(0, 5);
  const second = buttons.slice(5);
  if (ctx.shareable) second.push(share);
  return second.length > 0 ? [row(first), row(second)] : [row(first)];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderStats(view: StatsView, report: StatsReport, ctx: RenderContext): StatsMessage {
  const h = helpers(ctx);
  const days = lastDays(report.window.days);
  let body: Body;
  let estimatedSessions = report.estimatedSessions;

  if (view.kind === 'user') {
    const person = report.people.find((p) => p.userId === view.userId);
    body = person ? userCard(person, report, h) : { description: `No voice time in the ${days}.`, fields: [] };
    estimatedSessions = person?.estimatedSessions ?? 0;
  } else if (report.people.length === 0) {
    body = { description: `No voice activity in the ${days}.`, fields: [] };
  } else {
    const page = effectivePage(view) ?? 'overview';
    const pages = { overview: overviewPage, people: peoplePage, social: socialPage, channels: channelsPage, times: timesPage, records: recordsPage };
    body = pages[page](report, h);
  }

  const fields = body.fields.filter((f): f is APIEmbedField => f !== null);
  const description = body.description ?? (fields.length === 0 ? 'Nothing to show here yet.' : undefined);
  const embed: APIEmbed = {
    title: titleOf(view, report, ctx),
    color: STATS_EMBED_COLOR,
    footer: { text: footerText(report, estimatedSessions) },
    fields,
  };
  if (description !== undefined) embed.description = description;

  return { embeds: [fitEmbed(embed)], components: components(view, ctx) };
}
