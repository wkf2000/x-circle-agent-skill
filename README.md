# x-circle-agent-skill

**[Name] 的 X 宇宙**: an agent skill that turns your last 7 days on X into a constellation poster, so you can thank the people who showed up for you.

![sample](docs/sample.png)

- You sit at the center as the sun. Everyone who liked, reposted, replied, quoted or mentioned you becomes a star, and the more they engaged, the closer their orbit.
- New followers shine on the gold outer halo with a ✦.
- The poster also shows the week's totals (posts, likes, reposts, replies, new followers), your most active hour and day (活跃星时), and your top post with the people who lit it up.
- Optional: a 15-second 9:16 video where the stars appear in the order they arrived during the week.

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
