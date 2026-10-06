/**
 * PURE permission helpers (INTERACTIONS implementer). Take a PermissionsBitField
 * (e.g. member.permissionsIn(voiceChannel) or interaction.member.permissions) so they
 * are trivially unit-testable with new PermissionsBitField([...]).
 *
 * PermissionsBitField#has() treats Administrator as having every permission, which is
 * what we want here (admins can always play / manage sounds).
 */
import { PermissionFlagsBits, type PermissionsBitField } from 'discord.js';
import type { LibrarySound } from '../types.js';

/** Use Soundboard (PermissionFlagsBits.UseSoundboard) in the target voice channel. */
export function canPlay(permissionsInVoiceChannel: Readonly<PermissionsBitField> | null): boolean {
  if (!permissionsInVoiceChannel) return false;
  return permissionsInVoiceChannel.has(PermissionFlagsBits.UseSoundboard);
}

/** Create Expressions (Administrator implied via has()). Manage Expressions alone does not grant adding. */
export function canAddSounds(permissions: Readonly<PermissionsBitField> | null): boolean {
  if (!permissions) return false;
  return permissions.has(PermissionFlagsBits.CreateGuildExpressions);
}

/** Manage Expressions => any sound; Create Expressions => only sounds the user added. */
export function canModifySound(
  user: { readonly id: string; readonly permissions: Readonly<PermissionsBitField> | null },
  sound: LibrarySound,
): boolean {
  const { permissions } = user;
  if (!permissions) return false;
  if (permissions.has(PermissionFlagsBits.ManageGuildExpressions)) return true;
  return permissions.has(PermissionFlagsBits.CreateGuildExpressions) && sound.addedBy === user.id;
}

/** /stop, /skip, /volume: the user must be in the bot's current voice channel. */
export function canControlPlayback(userVoiceChannelId: string | null, botVoiceChannelId: string | null): boolean {
  return userVoiceChannelId !== null && botVoiceChannelId !== null && userVoiceChannelId === botVoiceChannelId;
}
