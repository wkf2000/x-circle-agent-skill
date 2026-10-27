# x-circle-agent-skill

**[Name] 和朋友们的 X 宇宙**: an agent skill that turns your last 7 days on X into a constellation poster, so you can thank the people who showed up for you.

![sample](docs/sample.png)

- Your friends are the stars. Everyone who liked, reposted, replied, quoted or mentioned you gets a place on the map, and the more they engaged, the closer their orbit. You sit quietly at the center, drawn about the same size as they are.
- New followers shine on the gold outer halo with a ✦.
- An outer dial traces the week hour by hour: friends' activity points outward, yours points inward, and the brightest hour is marked.
- The corners hold the week's likes, replies, reposts and new followers. Below the map are the top post with the people who lit it up and the brightest hour (最闪耀时刻).
- Optional: a 15-second 9:16 video in which a radar sweep circles the week and reveals the stars one by one. A soft generated soundtrack follows along, with a chime for each star as it lights up. Pass `--no-music` for a silent video.

All data is collected **read-only** by your agent browsing x.com in your own logged-in browser. No API keys are needed and nothing is posted for you.

## Install

```bash
npx skills add wkf2000/x-circle-agent-skill
```

Requirements:
- Node 18+ and Google Chrome (or Edge / Chromium) for rendering
- `ffmpeg` for the optional video
- An agent with a browser it can drive, e.g. the Claude desktop app's built-in browser or Claude in Chrome, logged in to x.com

## Use

Ask your agent:

> 帮我生成这周的 X 宇宙

> Make my X universe for this week, with a video

The agent visits your profile, each post from the past week (replies, likes, reposts, quotes) and your notifications. It then writes `./x-universe/<date>/x-universe.png` (and `.mp4`).

## Try the renderer without X

```bash
cd skills/x-circle-agent-skill/scripts
npm install
node render.mjs ../assets/sample-data.json --out /tmp/x-universe --video
```

## Notes

- X does not show timestamps for likes, reposts or follows, so the active-time chart uses your own posts and replies plus timestamped replies, quotes and mentions from others.
- Only the author of a post can see who liked it, so the skill only works on your own account.

## License

MIT
