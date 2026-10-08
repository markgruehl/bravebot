/**
 * Environment configuration. Env is the ONLY configuration source.
 *
 * - DISCORD_BOT_TOKEN (required)
 * - SLACK_WEBHOOK (optional; empty/whitespace is treated as unset)
 */

export interface Config {
  readonly discordToken: string;
  /** Slack incoming-webhook URL, or null when unset/empty. */
  readonly slackWebhook: string | null;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const discordToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!discordToken) {
    throw new ConfigError('DISCORD_BOT_TOKEN is required but was not set');
  }
  const slack = env.SLACK_WEBHOOK?.trim();
  return {
    discordToken,
    slackWebhook: slack ? slack : null,
  };
}
