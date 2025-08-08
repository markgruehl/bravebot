"""Analytics utilities for computing voice activity statistics from bot messages.

Parses messages the bot posted (join/leave/change) and reconstructs sessions
to compute per-user and channel statistics, handling duplicate/noisy events.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple

import discord

logger = logging.getLogger(__name__)


# Regex patterns to parse bot messages
MENTION_ID = r"(?P<user><@!?(?P<user_id>\d+)>)"
# Named channel group for single occurrence patterns
CHANNEL_ID_NAMED = r"(?P<chan><#(?P<channel_id>\d+)>)"
# Simple (unnamed) channel tag for patterns with multiple occurrences to avoid duplicate group names
CHANNEL_TAG = r"(<#(\d+)>)"

RE_CONNECT = re.compile(rf"^{MENTION_ID} has connected to {CHANNEL_ID_NAMED}$")
RE_DISCONNECT = re.compile(rf"^{MENTION_ID} has disconnected from {CHANNEL_ID_NAMED}$")
RE_CHANGE = re.compile(
    rf"^{MENTION_ID} has changed channels from {CHANNEL_TAG} to {CHANNEL_TAG}$"
)


@dataclasses.dataclass
class Event:
    user_id: int
    type: str  # 'connect' | 'disconnect' | 'change'
    at: datetime
    channel_id_from: Optional[int] = None
    channel_id_to: Optional[int] = None


@dataclasses.dataclass
class Session:
    user_id: int
    channel_id: int
    start: datetime
    end: Optional[datetime] = None

    def duration(self, now: Optional[datetime] = None) -> timedelta:
        if self.end is None:
            ref = now or datetime.now(timezone.utc)
            return max(timedelta(0), ref - self.start)
        return max(timedelta(0), self.end - self.start)


@dataclasses.dataclass
class ChannelStats:
    channel_id: int
    total_time_per_user: Dict[int, timedelta]
    session_count_per_user: Dict[int, int]
    day_presence_per_user: Dict[int, set]
    weekday_streak_per_user: Dict[int, int]
    average_session_seconds_per_user: Dict[int, float]
    median_session_seconds_per_user: Dict[int, float]
    pair_cotime_seconds: Dict[Tuple[int, int], float]
    per_channel_total_seconds_per_user: Dict[int, Dict[int, float]]
    per_channel_total_seconds: Dict[int, float]
    group_cotime_seconds: Dict[Tuple[int, ...], float]
    lurker_seconds_per_user: Dict[int, float]
    social_glue_seconds_per_user: Dict[int, float]
    butterfly_channels_count_per_user: Dict[int, int]
    marathon_seconds_per_user: Dict[int, float]
    vampire_index_per_user: Dict[int, float]
    per_channel_prime_time: Dict[int, Tuple[datetime, float]]
    per_channel_record_attendance: Dict[int, Tuple[int, datetime]]
    duplicate_events_suppressed: int


def _parse_event_from_message(message: discord.Message) -> Optional[Event]:
    content = message.content.strip()
    ts = (
        message.created_at
        if message.created_at.tzinfo
        else message.created_at.replace(tzinfo=timezone.utc)
    )

    for regex, kind in ((RE_CONNECT, "connect"), (RE_DISCONNECT, "disconnect")):
        m = regex.match(content)
        if m:
            user_id = int(m.group("user_id"))
            channel_id = int(m.group("channel_id"))
            if kind == "connect":
                return Event(
                    user_id=user_id, type="connect", at=ts, channel_id_to=channel_id
                )
            return Event(
                user_id=user_id, type="disconnect", at=ts, channel_id_from=channel_id
            )

    m = RE_CHANGE.match(content)
    if m:
        user_id = int(m.group("user_id"))
        # There are two CHANNEL_ID groups; python named groups collide; parse by scanning
        # Re-run a findall to capture both channel ids by order
        ids = [int(x) for x in re.findall(r"<#(\d+)>", content)]
        if len(ids) == 2:
            return Event(
                user_id=user_id,
                type="change",
                at=ts,
                channel_id_from=ids[0],
                channel_id_to=ids[1],
            )
    return None


async def fetch_events_from_channel(
    channel: discord.abc.Messageable,
    bot_user_id: int,
    since: Optional[datetime] = None,
    limit: Optional[int] = 2000,
) -> List[Event]:
    """Fetch and parse bot-generated events from a text channel's history."""
    if since is None:
        since = datetime.now(timezone.utc) - timedelta(days=30)

    # discord.py TextChannel.history returns newest first by default if oldest_first=False
    events: List[Event] = []
    try:
        async for msg in channel.history(limit=limit, after=since, oldest_first=True):
            if (
                msg.author
                and msg.author.bot
                and msg.author.id == bot_user_id
                and msg.content
            ):
                evt = _parse_event_from_message(msg)
                if evt:
                    events.append(evt)
    except Exception as e:
        logger.error(f"Failed to fetch channel history: {e}")
    return events


def _finalize_open_sessions(
    open_session_by_user: Dict[int, Session],
    sessions_by_user: Dict[int, List[Session]],
    now: datetime,
) -> None:
    for user_id, sess in open_session_by_user.items():
        # Keep open sessions open; stats will compute duration to 'now'
        sessions_by_user[user_id].append(sess)


def reconstruct_sessions(
    events: Iterable[Event],
    target_voice_channel_id: Optional[int] = None,
) -> Tuple[Dict[int, List[Session]], int]:
    """Turn events into sessions per user, suppressing duplicate/noisy events.

    Returns (sessions_by_user, duplicate_count)
    """
    open_session_by_user: Dict[int, Session] = {}
    sessions_by_user: Dict[int, List[Session]] = defaultdict(list)
    duplicate_count = 0

    def is_dup(prev: Optional[Session], evt: Event) -> bool:
        nonlocal duplicate_count
        if prev is None:
            return False
        # Duplicate connect to same channel while already connected to same
        if (
            evt.type == "connect"
            and prev.end is None
            and prev.channel_id == evt.channel_id_to
        ):
            duplicate_count += 1
            return True
        # Duplicate disconnect while not connected or already ended
        if evt.type == "disconnect" and prev.end is not None:
            duplicate_count += 1
            return True
        # Change to same channel
        if (
            evt.type == "change"
            and prev.end is None
            and prev.channel_id == evt.channel_id_to == evt.channel_id_from
        ):
            duplicate_count += 1
            return True
        return False

    for evt in events:
        if target_voice_channel_id is not None:
            # Only consider events that involve the target voice channel
            chan_ids = {evt.channel_id_from, evt.channel_id_to}
            if target_voice_channel_id not in chan_ids:
                continue

        current = open_session_by_user.get(evt.user_id)
        if is_dup(current, evt):
            continue

        if evt.type == "connect":
            # End any stray open session in a different channel, then start new
            if (
                current
                and current.end is None
                and current.channel_id != evt.channel_id_to
            ):
                current.end = evt.at
                sessions_by_user[evt.user_id].append(current)
            open_session_by_user[evt.user_id] = Session(
                user_id=evt.user_id,
                channel_id=evt.channel_id_to or 0,
                start=evt.at,
            )
        elif evt.type == "disconnect":
            if current and current.end is None:
                # Only close if channel matches or target unspecified
                if (evt.channel_id_from is None) or (
                    current.channel_id == evt.channel_id_from
                ):
                    current.end = evt.at
                    sessions_by_user[evt.user_id].append(current)
                    open_session_by_user.pop(evt.user_id, None)
                else:
                    # Mismatched channel; treat as duplicate/noise
                    duplicate_count += 1
            else:
                duplicate_count += 1
        elif evt.type == "change":
            if current and current.end is None:
                # Close previous session and open new one
                current.end = evt.at
                sessions_by_user[evt.user_id].append(current)
            open_session_by_user[evt.user_id] = Session(
                user_id=evt.user_id,
                channel_id=evt.channel_id_to or 0,
                start=evt.at,
            )

    _finalize_open_sessions(
        open_session_by_user, sessions_by_user, datetime.now(timezone.utc)
    )
    return sessions_by_user, duplicate_count


def _compute_streak(days: Iterable[datetime]) -> int:
    # Consider only weekdays; streak counts consecutive weekdays (Mon-Fri)
    if not days:
        return 0
    unique_days = sorted({d.date() for d in days})
    # Filter to weekdays
    unique_days = [
        d for d in unique_days if datetime(d.year, d.month, d.day).weekday() < 5
    ]
    if not unique_days:
        return 0
    streak = 1
    for i in range(len(unique_days) - 1, 0, -1):
        prev = unique_days[i - 1]
        cur = unique_days[i]
        # Next expected weekday ignoring weekends
        delta = (cur - prev).days
        if delta == 1:
            streak += 1
        elif delta >= 2:
            # Break on gaps (including weekends skipped in set)
            streak = 1
    return streak


def compute_channel_stats(
    sessions_by_user: Dict[int, List[Session]],
    target_channel_id: Optional[int] = None,
    max_group_size: int = 3,
) -> ChannelStats:
    total_time_per_user: Dict[int, timedelta] = defaultdict(timedelta)
    session_count_per_user: Dict[int, int] = defaultdict(int)
    day_presence_per_user: Dict[int, set] = defaultdict(set)
    per_user_session_seconds: Dict[int, List[float]] = defaultdict(list)

    # Build a timeline for co-time computation per channel
    per_channel_timeline: Dict[int, List[Tuple[datetime, datetime, int]]] = defaultdict(
        list
    )
    per_channel_total_seconds_per_user: Dict[int, Dict[int, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    per_channel_total_seconds: Dict[int, float] = defaultdict(float)
    butterfly_channels_set_per_user: Dict[int, set] = defaultdict(set)
    vampire_totals_per_user: Dict[int, Tuple[float, float]] = defaultdict(
        lambda: (0.0, 0.0)
    )  # (total, outside)

    for user_id, sessions in sessions_by_user.items():
        for s in sessions:
            if target_channel_id is not None and s.channel_id != target_channel_id:
                continue
            dur = s.duration()
            total_time_per_user[user_id] += dur
            session_count_per_user[user_id] += 1
            per_user_session_seconds[user_id].append(dur.total_seconds())
            per_channel_total_seconds_per_user[s.channel_id][user_id] += (
                dur.total_seconds()
            )
            per_channel_total_seconds[s.channel_id] += dur.total_seconds()
            butterfly_channels_set_per_user[user_id].add(s.channel_id)
            # Track presence days
            day_presence_per_user[user_id].add(s.start.date())
            if s.end:
                day_presence_per_user[user_id].add(s.end.date())
            per_channel_timeline[s.channel_id].append(
                (s.start, s.end or datetime.now(timezone.utc), user_id)
            )

    # Compute weekday streak
    weekday_streak_per_user: Dict[int, int] = {
        uid: _compute_streak({datetime.combine(d, datetime.min.time()) for d in days})
        for uid, days in day_presence_per_user.items()
    }

    # Average/median session seconds
    import statistics

    average_session_seconds_per_user: Dict[int, float] = {}
    median_session_seconds_per_user: Dict[int, float] = {}
    for uid, arr in per_user_session_seconds.items():
        if arr:
            average_session_seconds_per_user[uid] = float(statistics.mean(arr))
            median_session_seconds_per_user[uid] = float(statistics.median(arr))

    # Co-time per pair (who do they chat most with)
    pair_cotime_seconds: Dict[Tuple[int, int], float] = defaultdict(float)
    group_cotime_seconds: Dict[Tuple[int, ...], float] = defaultdict(float)
    lurker_seconds_per_user: Dict[int, float] = defaultdict(float)
    per_channel_prime_buckets: Dict[int, Dict[datetime, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    per_channel_record_attendance: Dict[int, Tuple[int, datetime]] = {}

    def floor_15(dt: datetime) -> datetime:
        return dt.replace(minute=dt.minute - (dt.minute % 15), second=0, microsecond=0)

    def work_overlap_seconds(start: datetime, end: datetime) -> float:
        # Work window 10:00–18:00 (UTC)
        total = 0.0
        cur = start
        while cur < end:
            day_start = cur.replace(hour=10, minute=0, second=0, microsecond=0)
            day_end = cur.replace(hour=18, minute=0, second=0, microsecond=0)
            # If work window already passed for current day, advance to next day
            if end <= day_start:
                # move to previous window end
                break
            window_start = max(cur, day_start)
            window_end = min(end, day_end)
            if window_end > window_start:
                total += (window_end - window_start).total_seconds()
            # advance to next day 00:00
            cur = cur.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
                days=1
            )
        return total

    for ch_id, intervals in per_channel_timeline.items():
        # Sweep line over intervals
        points: List[Tuple[datetime, int, int]] = []  # time, +1 start/-1 end, user
        for start, end, uid in intervals:
            points.append((start, 1, uid))
            points.append((end, -1, uid))
        points.sort(key=lambda x: x[0])
        active: Dict[int, datetime] = {}
        last_time: Optional[datetime] = None
        record_size = 0
        record_time: Optional[datetime] = None
        for t, typ, uid in points:
            if last_time is not None and active:
                dt = (t - last_time).total_seconds()
                users = list(active.keys())
                if len(users) >= 2:
                    for i in range(len(users)):
                        for j in range(i + 1, len(users)):
                            pair = tuple(sorted((users[i], users[j])))
                            pair_cotime_seconds[pair] += dt
                if len(users) >= 3 and max_group_size >= 3:
                    from itertools import combinations

                    cap = min(max_group_size, len(users))
                    for k in range(3, cap + 1):
                        for combo in combinations(sorted(users), k):
                            group_cotime_seconds[combo] += dt
                if len(users) == 1:
                    lurker_seconds_per_user[users[0]] += dt
                # Prime time bucketting by user-seconds
                bucket = floor_15(last_time)
                per_channel_prime_buckets[ch_id][bucket] += dt * len(users)
                # Record attendance
                if len(users) > record_size:
                    record_size = len(users)
                    record_time = last_time
            if typ == 1:
                active[uid] = t
            else:
                active.pop(uid, None)
            last_time = t
        if record_size > 0 and record_time is not None:
            per_channel_record_attendance[ch_id] = (record_size, record_time)

    # Compute vampire index (outside work hours share) and marathon/butterfly
    vampire_index_per_user: Dict[int, float] = {}
    marathon_seconds_per_user: Dict[int, float] = {}
    butterfly_channels_count_per_user: Dict[int, int] = {
        uid: len(chs) for uid, chs in butterfly_channels_set_per_user.items()
    }
    now = datetime.now(timezone.utc)
    for uid, sessions in sessions_by_user.items():
        total_sec = 0.0
        work_sec = 0.0
        max_session = 0.0
        for s in sessions:
            start = s.start
            end = s.end or now
            dur = (end - start).total_seconds()
            total_sec += dur
            work_sec += work_overlap_seconds(start, end)
            if dur > max_session:
                max_session = dur
        marathon_seconds_per_user[uid] = max_session
        vampire_index_per_user[uid] = (
            0.0 if total_sec == 0 else max(0.0, (total_sec - work_sec) / total_sec)
        )

    # Social glue: sum of co-time across pairs for each user
    social_glue_seconds_per_user: Dict[int, float] = defaultdict(float)
    for (a, b), secs in pair_cotime_seconds.items():
        social_glue_seconds_per_user[a] += secs
        social_glue_seconds_per_user[b] += secs

    return ChannelStats(
        channel_id=target_channel_id or 0,
        total_time_per_user=total_time_per_user,
        session_count_per_user=session_count_per_user,
        day_presence_per_user=day_presence_per_user,
        weekday_streak_per_user=weekday_streak_per_user,
        average_session_seconds_per_user=average_session_seconds_per_user,
        median_session_seconds_per_user=median_session_seconds_per_user,
        pair_cotime_seconds=pair_cotime_seconds,
        per_channel_total_seconds_per_user=per_channel_total_seconds_per_user,
        per_channel_total_seconds=per_channel_total_seconds,
        group_cotime_seconds=group_cotime_seconds,
        lurker_seconds_per_user=lurker_seconds_per_user,
        social_glue_seconds_per_user=social_glue_seconds_per_user,
        butterfly_channels_count_per_user=butterfly_channels_count_per_user,
        marathon_seconds_per_user=marathon_seconds_per_user,
        vampire_index_per_user=vampire_index_per_user,
        per_channel_prime_time={
            ch: max(buckets.items(), key=lambda kv: kv[1]) if buckets else (None, 0.0)
            for ch, buckets in per_channel_prime_buckets.items()
        },
        per_channel_record_attendance=per_channel_record_attendance,
        duplicate_events_suppressed=0,  # set by caller
    )


def pick_default_voice_channel_id(events: List[Event]) -> Optional[int]:
    """Heuristic: choose the most recently referenced voice channel id."""
    for evt in reversed(events):
        if evt.channel_id_to:
            return evt.channel_id_to
        if evt.channel_id_from:
            return evt.channel_id_from
    return None
