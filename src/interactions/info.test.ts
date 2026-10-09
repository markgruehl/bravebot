import { readFileSync } from 'node:fs';
import { MessageFlags, type APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { makeCtx, makeInteraction } from './__tests__/fakes.js';
import { REPO_URL, botVersion, buildInfoEmbed, describeStatsStatus, formatUptime, handleInfoCommand } from './info.js';

const NOW = Date.UTC(2026, 9, 8, 12);
const MIN = 60_000;

const field = (embed: APIEmbed, name: string) => embed.fields?.find((f) => f.name === name)?.value;

describe('botVersion', () => {
  it('reads the version from the repo package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(botVersion()).toBe(pkg.version);
  });
});

describe('formatUptime', () => {
  it('shows days and hours only once they are non-zero', () => {
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(59 * MIN)).toBe('59m');
    expect(formatUptime(61 * MIN)).toBe('1h 1m');
    expect(formatUptime(3 * 1440 * MIN + 5 * MIN)).toBe('3d 0h 5m');
  });
});

describe('describeStatsStatus', () => {
  it('covers not loaded, building and loaded', () => {
    expect(describeStatsStatus(null)).toBe('Not loaded yet — run /stats');
    expect(describeStatsStatus({ events: 0, oldestEventAt: null, building: true })).toBe('Building…');
    expect(describeStatsStatus({ events: 1234, oldestEventAt: 1_700_000_000_500, building: false })).toBe(
      '1,234 notices cached since <t:1700000000:D>',
    );
    expect(describeStatsStatus({ events: 1, oldestEventAt: 1_700_000_000_000, building: false })).toBe(
      '1 notice cached since <t:1700000000:D>',
    );
    expect(describeStatsStatus({ events: 0, oldestEventAt: null, building: false })).toBe('0 notices cached');
  });
});

describe('buildInfoEmbed', () => {
  it('lists version, uptime, features, cache status and the source link', () => {
    const embed = buildInfoEmbed({ version: '2.1.0', uptimeMs: 90 * MIN, statsStatus: null, now: NOW });
    expect(embed.title).toBe('bravebot');
    expect(embed.description).toBeTruthy();
    expect(field(embed, 'Version')).toBe('2.1.0');
    expect(field(embed, 'Uptime')).toBe(`1h 30m (since <t:${(NOW - 90 * MIN) / 1000}:f>)`);
    const features = field(embed, 'Features') ?? '';
    for (const f of ['Soundboard', 'Voice activity notices', 'Voice stats', 'Ping']) expect(features).toContain(f);
    expect(field(embed, 'Voice stats cache')).toBe('Not loaded yet — run /stats');
    expect(field(embed, 'Source')).toBe(REPO_URL);
    expect(REPO_URL).toBe('https://github.com/markgruehl/bravebot');
    expect(embed.footer?.text).toContain('Eastern');
  });
});

describe('handleInfoCommand', () => {
  it('replies ephemerally with the embed, no pings, using the guild cache status', async () => {
    const ctx = makeCtx();
    ctx.statsMock.status.mockReturnValue({ events: 3, oldestEventAt: null, building: false });
    const i = makeInteraction({ commandName: 'info' });
    await handleInfoCommand(ctx, i as never);
    expect(ctx.statsMock.status).toHaveBeenCalledWith('guild-1');
    const payload = i.reply.mock.calls[0]![0] as { embeds: APIEmbed[]; flags: number; allowedMentions: unknown };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(field(payload.embeds[0]!, 'Voice stats cache')).toBe('3 notices cached');
    expect(field(payload.embeds[0]!, 'Version')).toBe(botVersion());
  });
});
