"""Main entry point for BraveBot."""

import logging
import discord

from bravebot.bot import BraveBot
from bravebot.commands import setup_commands
from bravebot.config import config

# Set up logging for Docker-friendly output
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)-8s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Configure Discord library logging without extra handlers (avoid duplicates)
discord_logger = logging.getLogger("discord")
discord_logger.setLevel(logging.INFO)
# Ensure no handlers on the discord logger; let it propagate to root
for h in list(discord_logger.handlers):
    discord_logger.removeHandler(h)
discord_logger.propagate = True
logging.getLogger("discord.http").setLevel(logging.WARNING)

# Create logger for this module
logger = logging.getLogger(__name__)


def create_bot() -> BraveBot:
    """Create and configure the bot instance."""
    intents = discord.Intents.default()
    intents.message_content = True
    intents.voice_states = True

    bot = BraveBot(command_prefix="!", intents=intents)
    setup_commands(bot)

    return bot


def main():
    """Main function to start the bot."""
    logger.info("Starting BraveBot...")

    if not config.validate():
        logger.error("Invalid config!")
        exit(1)

    try:
        bot = create_bot()
        bot.run(config.discord_bot_token)
    except Exception as e:
        logger.critical(f"Failed to start bot: {e}")
        exit(1)


if __name__ == "__main__":
    main()
