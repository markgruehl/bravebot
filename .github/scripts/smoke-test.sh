#!/usr/bin/env bash
# Smoke-tests a locally loaded bravebot image: tools present, native voice deps load and
# encode, and the bot fully loads and exits 1 with its config error when no token is set.
set -euo pipefail
image="${1:?usage: smoke-test.sh <image>}"
docker run --rm --entrypoint sh "$image" -c 'yt-dlp --version && ffmpeg -hide_banner -version | head -n 1'
docker run --rm "$image" node -e '
  const report = require("@discordjs/voice").generateDependencyReport();
  console.log(report);
  if (/@discordjs\/opus: not found|@snazzah\/davey: not found/.test(report)) process.exit(1);
  const { OpusEncoder } = require("@discordjs/opus");
  const enc = new OpusEncoder(48000, 2);
  if (enc.decode(enc.encode(Buffer.alloc(3840))).length !== 3840) process.exit(1);
  console.log("opus encode/decode ok");'
status=0
out=$(docker run --rm "$image" 2>&1) || status=$?
echo "$out"
test "$status" -eq 1
grep -q '\[config\] DISCORD_BOT_TOKEN is required' <<< "$out"
