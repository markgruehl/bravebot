/**
 * Thin Discord helpers shared by interaction handlers (INTERACTIONS implementer):
 * ephemeral replies that work whether or not the interaction was deferred, the
 * requester's UserRef, and "deny" = ephemeral reply + admin-log failure.
 */
import { MessageFlags, type GuildMember, type RepliableInteraction, type User } from 'discord.js';
import type { BotContext, FailureReason, GuildState, SourceSummary, UserRef } from '../types.js';
import { truncate } from './validation.js';

export function userRefOf(interaction: { readonly user: User; readonly member: GuildMember }): UserRef {
  return {
    id: interaction.user.id,
    displayName: interaction.member.displayName || interaction.user.username,
  };
}

/**
 * The guild's soundboard state, or undefined when setup has not completed. In that case a
 * rate-limited, fire-and-forget setup retry is kicked off so a failed setup recovers
 * without a restart.
 */
export function guildStateOf(ctx: BotContext, guildId: string): GuildState | undefined {
  const state = ctx.guilds.get(guildId);
  if (!state) ctx.ensureGuild?.(guildId);
  return state;
}

/**
 * Ephemeral, ping-free reply. Uses editReply when the interaction was deferred (the
 * deferral was already ephemeral), followUp when it was already answered, else reply.
 */
export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  const base = { content: truncate(content), allowedMentions: { parse: [] } };
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(base);
  } else if (interaction.replied) {
    await interaction.followUp({ ...base, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...base, flags: MessageFlags.Ephemeral });
  }
}

/** Defer ephemerally unless already acknowledged. */
export async function deferEphemeral(interaction: RepliableInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

export interface FailureDetails {
  readonly reason: FailureReason;
  /** e.g. "/play", "panel button", "/sound add". */
  readonly action: string;
  readonly user: UserRef | null;
  readonly voiceChannelId: string | null;
  readonly source: SourceSummary | null;
  readonly detail: string | null;
}

/** Fire-and-forget admin-log failure entry. AdminLog.log never throws, but be defensive. */
export function logFailure(ctx: BotContext, guildId: string, details: FailureDetails): void {
  ctx.adminLog.log(guildId, { type: 'failure', at: new Date(), ...details }).catch((err: unknown) => {
    console.error('[interactions] admin log failed:', err);
  });
}

/** Deny an action: ephemeral message to the user AND a failure entry in the admin log. */
export async function deny(
  ctx: BotContext,
  interaction: RepliableInteraction<'cached'>,
  message: string,
  details: FailureDetails,
): Promise<void> {
  logFailure(ctx, interaction.guildId, details);
  await replyEphemeral(interaction, message);
}
