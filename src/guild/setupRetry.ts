/**
 * Per-guild cooldown for lazy setup retries. When a guild's setup failed (transient
 * Discord error, missing Manage Channels, ...) the next interaction re-runs it, but at most
 * once per `cooldownMs` per guild so a failing guild cannot hammer the API.
 * In-memory only (nothing persisted).
 */
export interface SetupCooldown {
  /** Record that a setup attempt for `guildId` started now. */
  mark(guildId: string): void;
  /** True when no attempt was made for `guildId` within the cooldown window. */
  due(guildId: string): boolean;
  /** Forget a guild (e.g. the bot left it). */
  forget(guildId: string): void;
}

export const SETUP_RETRY_COOLDOWN_MS = 60_000;

export function createSetupCooldown(
  cooldownMs: number = SETUP_RETRY_COOLDOWN_MS,
  now: () => number = Date.now,
): SetupCooldown {
  const lastAttempt = new Map<string, number>();
  return {
    mark(guildId) {
      lastAttempt.set(guildId, now());
    },
    due(guildId) {
      const last = lastAttempt.get(guildId);
      return last === undefined || now() - last >= cooldownMs;
    },
    forget(guildId) {
      lastAttempt.delete(guildId);
    },
  };
}
