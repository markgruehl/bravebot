/**
 * /stats (server, user, channel) and its Previous/Next/page/Share buttons.
 *
 * Replies are ephemeral with a Share button; Share posts the current view publicly, and anyone
 * may page a public post. Nothing pings (allowedMentions: none). Views are not written to the
 * admin log; failures are. All the logic lives in src/stats/; this file only gathers the
 * inputs from the guild and sends the result.
 */
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { STATS_DAYS_DEFAULT, STATS_DAYS_MAX, STATS_DAYS_MIN } from '../constants.js';
import { StatsError } from '../errors.js';
import { decodeStatsCustomId, isStatsCustomId } from '../stats/customId.js';
import { buildReport, userIdsOf } from '../stats/pipeline.js';
import { renderStats } from '../stats/render.js';
import type { Checkpoint, Ms, PersonInfo, StatsMessage, StatsReport, StatsView } from '../stats/types.js';
import type { BotContext } from '../types.js';
import { OPTIONS, STATS_SUBCOMMANDS } from './commands.js';
import { deferEphemeral, deny, logFailure, replyEphemeral, userRefOf } from './reply.js';
import { MESSAGES } from './validation.js';

export { isStatsCustomId };

export const STATS_MESSAGES = {
  botTarget: "Bots don't have voice stats.",
  staleButton: 'That button is no longer valid.',
} as const;

/** Clamp `days` to the allowed range (Discord enforces it too); default when missing. */
export function clampDays(days: number | null): number {
  if (days === null || !Number.isFinite(days)) return STATS_DAYS_DEFAULT;
  return Math.min(Math.max(Math.trunc(days), STATS_DAYS_MIN), STATS_DAYS_MAX);
}

/** The first page of a /stats subcommand; null for an unknown subcommand. */
export function viewFromCommand(
  subcommand: string | null,
  args: { readonly days: number | null; readonly userId: string; readonly channelId: string | null },
): StatsView | null {
  const days = clampDays(args.days);
  switch (subcommand) {
    case STATS_SUBCOMMANDS.server:
      return { kind: 'server', page: 'overview', days };
    case STATS_SUBCOMMANDS.user:
      return { kind: 'user', userId: args.userId, days };
    case STATS_SUBCOMMANDS.channel:
      return args.channelId === null ? null : { kind: 'channel', channelId: args.channelId, page: 'overview', days };
    default:
      return null;
  }
}

/** The parts of a discord.js VoiceState the live checkpoint reads. */
export interface LiveVoiceState {
  readonly id: string;
  readonly channelId: string | null;
  readonly member: { readonly user: { readonly bot: boolean } } | null;
}

/** Who (non-bot, as far as the cache knows) is in a voice channel right now. */
export function liveCheckpointOf(states: Iterable<LiveVoiceState>, now: Ms): Checkpoint {
  const present = new Map<string, string>();
  for (const state of states) {
    if (state.channelId && state.member?.user.bot !== true) present.set(state.id, state.channelId);
  }
  return { at: now, present };
}

/** Display names of the humans (bots never show up in a report). */
export function namesOf(people: ReadonlyMap<string, PersonInfo>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [userId, person] of people) if (!person.bot) names.set(userId, person.name);
  return names;
}

/** Every channel id a rendered report may mention. */
export function channelIdsOf(report: StatsReport): Set<string> {
  const ids = new Set<string>();
  if (report.scope.kind === 'channel') ids.add(report.scope.channelId);
  for (const channel of report.channels) ids.add(channel.channelId);
  for (const person of report.people) if (person.topChannel) ids.add(person.topChannel.channelId);
  if (report.records.longestCall) ids.add(report.records.longestCall.channelId);
  if (report.records.biggestParty) ids.add(report.records.biggestParty.channelId);
  return ids;
}

/** Load, compute and render one view of the guild's stats. Throws StatsError. */
export async function renderView(ctx: BotContext, guild: Guild, view: StatsView, shareable: boolean): Promise<StatsMessage> {
  const history = await ctx.stats.load(guild);
  const now = Date.now();
  const live = liveCheckpointOf(guild.voiceStates.cache.values(), now);
  const ids = userIdsOf(history, live);
  if (view.kind === 'user') ids.add(view.userId);
  const people = await ctx.stats.people(guild, ids);
  const report = buildReport({ history, people, live, view, now });

  const channelNames = new Map<string, string>();
  for (const id of channelIdsOf(report)) {
    const channel = guild.channels.cache.get(id);
    if (channel) channelNames.set(id, channel.name);
  }
  return renderStats(view, report, { names: namesOf(people), channelNames, shareable, now });
}

function payload(message: StatsMessage) {
  return { embeds: [...message.embeds], components: [...message.components], allowedMentions: { parse: [] } };
}

export async function handleStatsCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  // Defer first: the first /stats in a guild scans the system channel history.
  await deferEphemeral(interaction);
  const subcommand = interaction.options.getSubcommand(false);
  const target = interaction.options.getUser(OPTIONS.user) ?? interaction.user;
  if (subcommand === STATS_SUBCOMMANDS.user && target.bot) {
    await replyEphemeral(interaction, STATS_MESSAGES.botTarget);
    return;
  }
  const view = viewFromCommand(subcommand, {
    days: interaction.options.getInteger(OPTIONS.days),
    userId: target.id,
    channelId: interaction.options.getChannel(OPTIONS.channel)?.id ?? null,
  });
  if (!view) {
    await replyEphemeral(interaction, MESSAGES.unknownCommand);
    return;
  }

  try {
    const message = await renderView(ctx, interaction.guild, view, true);
    await interaction.editReply(payload(message));
  } catch (err) {
    if (!(err instanceof StatsError)) throw err;
    await deny(ctx, interaction, err.message, {
      reason: 'stats-unavailable',
      action: `/stats ${subcommand ?? ''}`.trim(),
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: err.code,
    });
  }
}

export async function handleStatsButton(ctx: BotContext, interaction: ButtonInteraction<'cached'>): Promise<void> {
  const decoded = decodeStatsCustomId(interaction.customId);
  if (!decoded) {
    await replyEphemeral(interaction, STATS_MESSAGES.staleButton);
    return;
  }

  try {
    // Both actions acknowledge with deferUpdate, so any failure stays private (the router
    // follows up ephemerally instead of editing the message the button is on).
    await interaction.deferUpdate();
    if (decoded.action === 'page') {
      // Page in place; an ephemeral message keeps its Share button, a public one never gets it.
      const shareable = interaction.message.flags.has(MessageFlags.Ephemeral);
      await interaction.editReply(payload(await renderView(ctx, interaction.guild, decoded.view, shareable)));
    } else {
      // Share: post publicly only once the view is rendered, so nothing public is left on failure.
      await interaction.followUp(payload(await renderView(ctx, interaction.guild, decoded.view, false)));
    }
  } catch (err) {
    if (!(err instanceof StatsError)) throw err;
    logFailure(ctx, interaction.guildId, {
      reason: 'stats-unavailable',
      action: 'stats button',
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: err.code,
    });
    await interaction.followUp({ content: err.message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}
