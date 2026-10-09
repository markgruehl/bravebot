/**
 * The one-line persona on a /stats user card. PURE and deterministic.
 *
 * People without enough activity (not `qualified`) are a "Drop-in". Otherwise every trait
 * whose value clears an absolute floor becomes a candidate, scored by the person's value
 * relative to the best qualified person in the window (1 = they lead the server). The
 * highest score wins; ties go to how far past the floor the value is, then to TRAITS order.
 * With no candidate the person is a "Regular".
 */
import { HOUR_MS } from './time.js';
import { formatDuration, formatPercent, plural } from './format.js';
import type { PersonSummary, StatsReport } from './types.js';

export interface Persona {
  readonly emoji: string;
  readonly title: string;
  readonly line: string;
}

interface Trait {
  readonly emoji: string;
  readonly title: string;
  readonly value: (person: PersonSummary) => number;
  /** Minimum value to be a candidate at all. */
  readonly floor: number;
  readonly line: (person: PersonSummary) => string;
}

const soloShare = (p: PersonSummary) => (p.totalMs > 0 ? p.soloMs / p.totalMs : 0);

/** In tie-break order. */
const TRAITS: readonly Trait[] = [
  {
    emoji: '🔥',
    title: 'On Fire',
    value: (p) => p.currentStreak,
    floor: 5,
    line: (p) => `In voice ${p.currentStreak} days in a row and counting.`,
  },
  {
    emoji: '🦉',
    title: 'Night Owl',
    value: (p) => p.nightShare,
    floor: 0.25,
    line: (p) => `${formatPercent(p.nightShare)} of their voice time is between midnight and 6 am.`,
  },
  {
    emoji: '🏃',
    title: 'Marathoner',
    value: (p) => p.longestSessionMs,
    floor: 4 * HOUR_MS,
    line: (p) => `Once stayed in voice for ${formatDuration(p.longestSessionMs)} straight.`,
  },
  {
    emoji: '🎉',
    title: 'Party Starter',
    value: (p) => p.partyStarts,
    floor: 3,
    line: (p) => `Started ${plural(p.partyStarts, 'call')} that others joined.`,
  },
  {
    emoji: '🚪',
    title: 'Last One Out',
    value: (p) => p.closes,
    floor: 3,
    line: (p) => `Was the last to leave ${plural(p.closes, 'call')}.`,
  },
  {
    emoji: '🧲',
    title: 'Social Glue',
    value: (p) => p.coMs,
    floor: 5 * HOUR_MS,
    line: (p) => `Racked up ${formatDuration(p.coMs)} with friends, counted per friend.`,
  },
  {
    emoji: '🦋',
    title: 'Social Butterfly',
    value: (p) => p.channelsVisited,
    floor: 4,
    line: (p) => `Hopped between ${p.channelsVisited} different channels.`,
  },
  {
    emoji: '🐺',
    title: 'Lone Wolf',
    value: soloShare,
    floor: 0.5,
    line: (p) => `${formatPercent(soloShare(p))} of their voice time is solo.`,
  },
];

const finiteOrZero = (n: number) => (Number.isFinite(n) ? n : 0);

const DROP_IN = { emoji: '👋', title: 'Drop-in' } as const;
const REGULAR = { emoji: '🎧', title: 'Regular' } as const;

export function pickPersona(person: PersonSummary, report: StatsReport): Persona {
  if (!person.qualified) {
    return {
      ...DROP_IN,
      line: `Drops in now and then: ${plural(person.sessions, 'session')}, ${formatDuration(person.totalMs)} in voice.`,
    };
  }

  const group = report.people.filter((p) => p.qualified && p.userId !== person.userId);
  let best: { trait: Trait; score: number; margin: number } | null = null;
  for (const trait of TRAITS) {
    const value = trait.value(person);
    if (!Number.isFinite(value) || value < trait.floor || value <= 0) continue;
    const max = Math.max(value, ...group.map((p) => finiteOrZero(trait.value(p))));
    const score = value / max;
    const margin = value / trait.floor;
    // Strict comparisons keep the earlier trait on exact ties.
    if (!best || score > best.score || (score === best.score && margin > best.margin)) {
      best = { trait, score, margin };
    }
  }

  if (!best) {
    return {
      ...REGULAR,
      line: `Shows up: ${plural(person.sessions, 'session')} and ${formatDuration(person.totalMs)} in voice.`,
    };
  }
  return { emoji: best.trait.emoji, title: best.trait.title, line: best.trait.line(person) };
}
