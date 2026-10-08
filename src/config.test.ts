import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('requires DISCORD_BOT_TOKEN', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DISCORD_BOT_TOKEN: '   ' })).toThrow(ConfigError);
  });

  it('reads the token and treats an empty SLACK_WEBHOOK as unset', () => {
    expect(loadConfig({ DISCORD_BOT_TOKEN: 'abc', SLACK_WEBHOOK: '' })).toEqual({
      discordToken: 'abc',
      slackWebhook: null,
    });
    expect(loadConfig({ DISCORD_BOT_TOKEN: 'abc', SLACK_WEBHOOK: '  ' }).slackWebhook).toBeNull();
    expect(loadConfig({ DISCORD_BOT_TOKEN: 'abc' }).slackWebhook).toBeNull();
  });

  it('keeps a configured SLACK_WEBHOOK', () => {
    expect(loadConfig({ DISCORD_BOT_TOKEN: 'abc', SLACK_WEBHOOK: 'https://hooks.slack.com/x' }).slackWebhook).toBe(
      'https://hooks.slack.com/x',
    );
  });
});
