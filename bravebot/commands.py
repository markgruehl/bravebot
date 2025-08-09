"""Slash commands for BraveBot."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import discord
from .analytics import (
    compute_channel_stats,
    fetch_events_from_channel,
    reconstruct_sessions,
)

logger = logging.getLogger(__name__)


@discord.app_commands.command(name="ping", description="Check if the bot is responsive")
async def ping_command(interaction: discord.Interaction):
    """Simple ping command."""
    logger.info(f"Slash ping command used by {interaction.user} in {interaction.guild}")
    await interaction.response.send_message("Pong! 🏓")


@discord.app_commands.command(name="info", description="Get information about the bot")
async def info_command(interaction: discord.Interaction):
    """Bot information command."""
    logger.info(f"Info command used by {interaction.user} in {interaction.guild}")
    embed = discord.Embed(
        title="BraveBot Info",
        description="A Discord bot that tracks voice channel activity",
        color=discord.Color.blue(),
    )
    embed.add_field(
        name="Features",
        value="• Voice channel tracking\n• Slack integration\n• Slash commands",
        inline=False,
    )
    await interaction.response.send_message(embed=embed)


@discord.app_commands.command(
    name="voicestats", description="Get voice channel statistics"
)
async def voicestats_command(interaction: discord.Interaction):
    """Voice channel statistics command."""
    logger.info(f"Voicestats command used by {interaction.user} in {interaction.guild}")
    guild = interaction.guild
    if not guild:
        logger.warning(
            f"Voicestats command used outside of guild by {interaction.user}"
        )
        await interaction.response.send_message(
            "This command can only be used in a server!"
        )
        return

    voice_channels = guild.voice_channels
    total_members = sum(len(channel.members) for channel in voice_channels)
    active_channels = sum(1 for channel in voice_channels if len(channel.members) > 0)

    logger.debug(
        f"Voice stats for {guild}: {len(voice_channels)} channels, {active_channels} active, {total_members} members"
    )

    embed = discord.Embed(title="Voice Channel Statistics", color=discord.Color.green())
    embed.add_field(
        name="Total Voice Channels", value=str(len(voice_channels)), inline=True
    )
    embed.add_field(name="Active Channels", value=str(active_channels), inline=True)
    embed.add_field(
        name="Total Members in Voice", value=str(total_members), inline=True
    )

    await interaction.response.send_message(embed=embed)


def setup_commands(bot):
    """Add all slash commands to the bot."""
    bot.tree.add_command(ping_command)
    bot.tree.add_command(info_command)
    bot.tree.add_command(voicestats_command)
    bot.tree.add_command(channelstats_command)
    logger.info("Slash commands registered")


# ---------- Channel Analytics ----------


def _fmt_td(td: timedelta) -> str:
    total = int(td.total_seconds())
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    parts = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if seconds or not parts:
        parts.append(f"{seconds}s")
    return " ".join(parts)


@discord.app_commands.command(
    name="channelstats",
    description="Analyze recent voice activity from this channel's logs",
)
@discord.app_commands.describe(
    days="How many days back to analyze (default 30)",
    source_bot="Bot user whose messages to analyze (defaults to this bot)",
)
async def channelstats_command(
    interaction: discord.Interaction,
    days: int | None = 30,
    source_bot: discord.User | None = None,
):
    await interaction.response.defer(thinking=True)

    guild = interaction.guild
    if guild is None:
        await interaction.followup.send(
            "This command must be used in a server text channel."
        )
        return

    # Determine time window
    try:
        window_days = 30 if days is None else max(1, min(365, int(days)))
    except Exception:
        window_days = 30
    since = datetime.now(timezone.utc) - timedelta(days=window_days)

    # Determine which bot's messages to analyze
    if source_bot is not None and not source_bot.bot:
        await interaction.followup.send("Please select a bot user for source_bot.")
        return
    bot_user_id = (
        source_bot.id if source_bot is not None else interaction.client.user.id
    )

    # Fetch events from the current text channel (the specified bot's messages)
    try:
        events = await fetch_events_from_channel(
            channel=interaction.channel,
            bot_user_id=bot_user_id,
            since=since,
            limit=5000,
        )
    except Exception as e:
        logger.error(f"channelstats: failed to fetch events: {e}")
        await interaction.followup.send("Failed to read channel history for analytics.")
        return

    if not events:
        await interaction.followup.send(
            "No recent activity messages found in this channel."
        )
        return

    sessions_by_user, dup_count = reconstruct_sessions(events, None)
    stats = compute_channel_stats(sessions_by_user, None)
    stats.duplicate_events_suppressed = dup_count

    # Build name lookups with best-effort resolution (cache -> guild fetch -> global fetch)
    user_ids: set[int] = set(stats.total_time_per_user.keys())
    user_ids.update(stats.session_count_per_user.keys())
    for a, b in stats.pair_cotime_seconds.keys():
        user_ids.add(a)
        user_ids.add(b)

    user_name_by_id: dict[int, str] = {}
    for uid in user_ids:
        member = guild.get_member(uid)
        if member is not None:
            user_name_by_id[uid] = member.display_name
            continue
        try:
            m = await guild.fetch_member(uid)
            user_name_by_id[uid] = m.display_name
            continue
        except Exception:
            pass
        try:
            u = await interaction.client.fetch_user(uid)
            user_name_by_id[uid] = u.name
        except Exception:
            user_name_by_id[uid] = f"User {uid}"

    def name_for(user_id: int) -> str:
        return user_name_by_id.get(user_id, f"User {user_id}")

    # Top users by total time
    top_total = sorted(
        stats.total_time_per_user.items(), key=lambda kv: kv[1], reverse=True
    )[:10]

    # Top pairs by co-time
    top_pairs = sorted(
        stats.pair_cotime_seconds.items(), key=lambda kv: kv[1], reverse=True
    )[:10]

    # Per-channel breakdown (top channels by total time)
    top_channels = (
        sorted(
            stats.per_channel_total_seconds.items(), key=lambda kv: kv[1], reverse=True
        )[:5]
        if hasattr(stats, "per_channel_total_seconds")
        else []
    )

    # Top groups (size >= 3)
    top_groups = (
        sorted(stats.group_cotime_seconds.items(), key=lambda kv: kv[1], reverse=True)[
            :5
        ]
        if hasattr(stats, "group_cotime_seconds")
        else []
    )

    # Build embed
    embed = discord.Embed(
        title="📊 Channel Voice Analytics",
        description=(
            f"🗓️ Window: last {window_days} day(s)\n"
            f"#️⃣ Source: this text channel\n"
            f"🤖 Bot: {(source_bot.mention if source_bot else interaction.client.user.mention)}"
        ),
        color=discord.Color.purple(),
    )

    if top_total:
        lines = [
            f"• {name_for(uid)} — {_fmt_td(td)} in {stats.session_count_per_user.get(uid, 0)} sessions"
            for uid, td in top_total
        ]
        embed.add_field(
            name="⏱️ Top by total time — total presence per user",
            value="\n".join(lines),
            inline=False,
        )
    else:
        embed.add_field(name="Top by total time", value="No sessions", inline=False)

    # Average session length
    if stats.average_session_seconds_per_user:
        avgs = sorted(
            stats.average_session_seconds_per_user.items(),
            key=lambda kv: kv[1],
            reverse=True,
        )[:10]
        lines = [
            f"• {name_for(uid)} — {_fmt_td(timedelta(seconds=avg))} avg"
            for uid, avg in avgs
        ]
        embed.add_field(
            name="⏲️ Average session — mean session length",
            value="\n".join(lines),
            inline=False,
        )

    # Pairs
    if top_pairs:
        lines = [
            f"• {name_for(a)} + {name_for(b)} — {_fmt_td(timedelta(seconds=secs))}"
            for (a, b), secs in top_pairs
        ]
        embed.add_field(
            name="🤝 Most time together — pair co‑time",
            value="\n".join(lines),
            inline=False,
        )

    # Channel breakdown
    if top_channels:
        ch_lines = []
        for ch_id, seconds in top_channels:
            ch_name = f"<#{ch_id}>"
            ch_lines.append(
                f"• {ch_name} — {_fmt_td(timedelta(seconds=seconds))} total"
            )
        embed.add_field(
            name="🔊 Top voice channels — cumulative time in channel",
            value="\n".join(ch_lines),
            inline=False,
        )

    # Top groups of 3+ users
    if top_groups:
        grp_lines = []
        for users, seconds in top_groups:
            names = ", ".join(name_for(uid) for uid in users)
            grp_lines.append(f"• {names} — {_fmt_td(timedelta(seconds=seconds))}")
        embed.add_field(
            name="👥 Most common groups — 3+ people co‑time",
            value="\n".join(grp_lines),
            inline=False,
        )

    # Extras: Lurkers, Vampire index, Social glue, Marathon, Butterfly
    try:
        # Lurker top
        if hasattr(stats, "lurker_seconds_per_user") and stats.lurker_seconds_per_user:
            top_lurkers = sorted(
                stats.lurker_seconds_per_user.items(),
                key=lambda kv: kv[1],
                reverse=True,
            )[:5]
            lines = [
                f"• {name_for(uid)} — {_fmt_td(timedelta(seconds=secs))} solo"
                for uid, secs in top_lurkers
            ]
            embed.add_field(
                name="🫥 Most time alone — solo time in channel",
                value="\n".join(lines),
                inline=False,
            )

        # Vampire index
        if hasattr(stats, "vampire_index_per_user") and stats.vampire_index_per_user:
            top_vamp = sorted(
                stats.vampire_index_per_user.items(), key=lambda kv: kv[1], reverse=True
            )[:5]
            lines = [
                f"• {name_for(uid)} — {int(p * 100)}% off-hours" for uid, p in top_vamp
            ]
            embed.add_field(
                name="🦇 Vampire index — share outside 10:00–18:00 UTC",
                value="\n".join(lines),
                inline=False,
            )

        # Social glue
        if (
            hasattr(stats, "social_glue_seconds_per_user")
            and stats.social_glue_seconds_per_user
        ):
            top_glue = sorted(
                stats.social_glue_seconds_per_user.items(),
                key=lambda kv: kv[1],
                reverse=True,
            )[:5]
            lines = [
                f"• {name_for(uid)} — {_fmt_td(timedelta(seconds=secs))} co-time"
                for uid, secs in top_glue
            ]
            embed.add_field(
                name="🧲 Social glue — total co‑time across people",
                value="\n".join(lines),
                inline=False,
            )

        # Marathon sessions
        if (
            hasattr(stats, "marathon_seconds_per_user")
            and stats.marathon_seconds_per_user
        ):
            top_mar = sorted(
                stats.marathon_seconds_per_user.items(),
                key=lambda kv: kv[1],
                reverse=True,
            )[:5]
            lines = [
                f"• {name_for(uid)} — {_fmt_td(timedelta(seconds=secs))} longest"
                for uid, secs in top_mar
            ]
            embed.add_field(
                name="🏁 Marathons — longest single session",
                value="\n".join(lines),
                inline=False,
            )

        # Butterfly score
        if (
            hasattr(stats, "butterfly_channels_count_per_user")
            and stats.butterfly_channels_count_per_user
        ):
            top_bfly = sorted(
                stats.butterfly_channels_count_per_user.items(),
                key=lambda kv: kv[1],
                reverse=True,
            )[:5]
            lines = [f"• {name_for(uid)} — {count} channels" for uid, count in top_bfly]
            embed.add_field(
                name="🦋 Butterflies — distinct channels visited",
                value="\n".join(lines),
                inline=False,
            )

        # Prime time per channel
        if hasattr(stats, "per_channel_prime_time") and stats.per_channel_prime_time:
            prime_lines = []
            for ch_id, (bucket, user_seconds) in list(
                stats.per_channel_prime_time.items()
            )[:5]:
                if bucket:
                    prime_lines.append(
                        f"• <#{ch_id}> — {bucket.strftime('%Y-%m-%d %H:%M')} UTC ({int(user_seconds)} user-seconds)"
                    )
            if prime_lines:
                embed.add_field(
                    name="🕒 Prime time — busiest 15‑min slot (user‑seconds)",
                    value="\n".join(prime_lines),
                    inline=False,
                )

        # Record attendance per channel
        if (
            hasattr(stats, "per_channel_record_attendance")
            and stats.per_channel_record_attendance
        ):
            rec_lines = []
            for ch_id, (size, at) in list(stats.per_channel_record_attendance.items())[
                :5
            ]:
                rec_lines.append(
                    f"• <#{ch_id}> — {size} concurrent @ {at.strftime('%Y-%m-%d %H:%M')} UTC"
                )
            if rec_lines:
                embed.add_field(
                    name="🏆 Record attendance — max concurrent users",
                    value="\n".join(rec_lines),
                    inline=False,
                )
    except Exception as e:
        logger.error(f"Failed to compile extras: {e}")

    # Duplicates suppressed
    embed.set_footer(
        text=f"⚠️ Suppressed duplicate/noisy events: {stats.duplicate_events_suppressed}"
    )

    await interaction.followup.send(embed=embed)
