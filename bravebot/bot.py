"""Main bot class for BraveBot."""

import logging
import requests
import discord
from discord.ext import commands

from .config import config

logger = logging.getLogger(__name__)


class BraveBot(commands.Bot):
    """Discord bot for tracking voice channel activity."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    async def setup_hook(self):
        """Set up the bot when it starts."""
        try:
            await self.tree.sync()
            command_count = len(self.tree.get_commands())
            logger.info(f"Synced {command_count} slash commands")
        except Exception as e:
            logger.error(f"Failed to sync slash commands: {e}")

    async def on_ready(self):
        """Called when the bot is ready."""
        logger.info(f"Bot logged in as {self.user} (ID: {self.user.id})")
        logger.info(f"Connected to {len(self.guilds)} guilds")

    async def on_message(self, message):
        """Handle incoming messages."""
        # don't respond to ourselves
        if message.author == self.user:
            return

        if message.content == "ping":
            logger.info(f"Ping command from {message.author} in {message.guild}")
            await message.channel.send("pong")

    async def on_voice_state_update(self, member, before, after):
        """Handle voice state updates."""
        if not config.voice_events_enabled:
            logger.debug(
                "Voice events disabled via config; skipping on_voice_state_update"
            )
            return
        guild = member.guild

        # do not send if there is no system channel in guild or if the member state change belongs to a bot user
        if guild.system_channel is None and member.bot:
            return

        # do not send if voice state change occurs in same channel. Eg. mute/unmute
        if before.channel is after.channel:
            return

        logger.debug(
            f"Voice state update: {member} in {guild} - Before: {before.channel}, After: {after.channel}"
        )

        # disconnected
        if after.channel is None:
            to_send_mentions = (
                f"{member.mention} has disconnected from {before.channel.mention}"
            )
            to_send_names = f"{member.name} has disconnected from {before.channel.name}"
        # connected
        elif member in after.channel.members:
            # member is joining for first time
            if before.channel is None:
                to_send_mentions = (
                    f"{member.mention} has connected to {after.channel.mention}"
                )
                to_send_names = f"{member.name} has connected to {after.channel.name}"
            # member is changing channels
            else:
                to_send_mentions = f"{member.mention} has changed channels from {before.channel.mention} to {after.channel.mention}"
                to_send_names = f"{member.name} has changed channels from {before.channel.name} to {after.channel.name}"

        # if the slack webhook exists, send a message to it
        if config.has_slack_webhook:
            try:
                response = requests.post(
                    config.slack_webhook, json={"text": to_send_names}
                )
                if response.status_code == 200:
                    logger.debug(f"Slack notification sent: {to_send_names}")
                else:
                    logger.warning(
                        f"Slack webhook failed with status {response.status_code}"
                    )
            except Exception as e:
                logger.error(f"Failed to send Slack notification: {e}")

        # Send message to Discord guild system channel
        try:
            await guild.system_channel.send(to_send_mentions)
            logger.info(f"Voice update notification sent: {to_send_names}")
        except Exception as e:
            logger.error(f"Failed to send Discord notification: {e}")
