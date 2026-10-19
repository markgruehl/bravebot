/**
 * /info: an ephemeral embed about the bot (version, uptime, features, stats cache status).
 */
import { readFileSync } from 'node:fs';
import { MessageFlags, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js';
import type { Ms, StatsService } from '../stats/types.js';
import type { BotContext } from '../types.js';

export const REPO_URL = 'https://github.com/markgruehl/bravebot';

let cachedVersion: string | undefined;

/**
 * The package.json version, read once. '../../package.json' is the repo root from both
 * src/interactions (tsx) and dist/interactions (the image's /app has package.json).
 */
export function botVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }
  return cachedVersion;
}

/** "3d 4h 5m"; days and hours are left out while zero, minutes always shown. */
export function formatUptime(ms: Ms): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export type StatsStatus = ReturnType<StatsService['status']>;

export function describeStatsStatus(status: StatsStatus): string {
  if (!status) return 'Not loaded yet — run /stats';
  if (status.building) return 'Building…';
  const notices = `${status.events.toLocaleString('en-US')} ${status.events === 1 ? 'notice' : 'notices'} cached`;
  return status.oldestEventAt === null ? notices : `${notices} since <t:${Math.floor(status.oldestEventAt / 1000)}:D>`;
}

export interface InfoInput {
  readonly version: string;
  readonly uptimeMs: Ms;
  readonly statsStatus: StatsStatus;
  readonly now: Ms;
}

export function buildInfoEmbed(input: InfoInput): APIEmbed {
  const startedAt = Math.floor((input.now - input.uptimeMs) / 1000);
  return {
    title: 'bravebot',
    url: REPO_URL,
    description: 'A soundboard, voice activity notices and voice stats for this server.',
    fields: [
      { name: 'Version', value: input.version, inline: true },
      { name: 'Uptime', value: `${formatUptime(input.uptimeMs)} (since <t:${startedAt}:f>)`, inline: true },
      {
        name: 'Features',
        value: [
          '**Soundboard:** `/play`, `/soundboard`, `/sound`',
          '**Voice activity notices** in the system channel',
          '**Voice stats:** `/stats server`, `/stats user`, `/stats channel`',
          '**Ping:** say `ping`, get `pong`',
        ].join('\n'),
      },
      { name: 'Voice stats cache', value: describeStatsStatus(input.statsStatus) },
      { name: 'Source', value: REPO_URL },
    ],
    footer: { text: 'Stats use Eastern time (America/Toronto)' },
  };
}

export async function handleInfoCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const embed = buildInfoEmbed({
    version: botVersion(),
    uptimeMs: process.uptime() * 1000,
    statsStatus: ctx.stats.status(interaction.guildId),
    now: Date.now(),
  });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
