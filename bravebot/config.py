"""Configuration module for BraveBot."""

import os
import logging

logger = logging.getLogger(__name__)


class Config:
    """Configuration class for BraveBot."""

    def __init__(self):
        self.discord_bot_token = os.environ.get("DISCORD_BOT_TOKEN")
        self.slack_webhook = os.environ.get("SLACK_WEBHOOK")
        # Feature flags
        self.voice_events_enabled = self._get_bool_env("ENABLE_VOICE_EVENTS", True)

    def validate(self) -> bool:
        """Validate that required configuration is present."""
        if not self.discord_bot_token:
            logger.error("DISCORD_BOT_TOKEN must be set")
            return False
        return True

    @staticmethod
    def _get_bool_env(name: str, default: bool) -> bool:
        val = os.environ.get(name)
        if val is None:
            return default
        return val.strip().lower() in {"1", "true", "yes", "y", "on"}

    @property
    def has_slack_webhook(self) -> bool:
        """Check if Slack webhook is configured."""
        return bool(self.slack_webhook and self.slack_webhook.strip())


# Global config instance
config = Config()
