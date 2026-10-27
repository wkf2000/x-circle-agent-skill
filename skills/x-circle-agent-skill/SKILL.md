---
name: x-circle-agent-skill
description: Turns the past 7 days of an X (Twitter) account into a shareable constellation poster titled "[Name] 和朋友们的 X 宇宙" — everyone who liked, reposted, replied or newly followed the user placed as stars on orbits around them (closer = more engaged), an hour-by-hour week dial, weekly stats, the brightest hour, and the week's top post. Optionally renders a 15-second 9:16 video. Works in any agent harness (Claude Code, Codex and others) whose browser can navigate, scroll and evaluate read-only JavaScript on x.com, where the user is already logged in. Use when the user asks for their X/Twitter weekly interaction map, "X 宇宙", "x circle", a thank-you image for followers, who interacted with them this week, or a weekly X recap image/video.
---

# X 宇宙 (x-circle)

Produces `x-universe.png` (1080×1350, rendered @2x) and, when asked, `x-universe.mp4` (1080×1920, 15s): a star map of the user's X week, meant to be posted as a thank-you to the people in it. All text in the image is Chinese.

`SKILL_DIR` below means the directory containing this file.

## 1. Prepare

1. If `SKILL_DIR/scripts/node_modules` is missing, run `npm install --prefix "SKILL_DIR/scripts"` (installs `playwright-core` only; it drives the locally installed Chrome).
2. Video only: check `ffmpeg -version`. If missing, tell the user (`brew install ffmpeg` on macOS) and offer image-only.
3. Output folder: `./x-universe/<today YYYY-MM-DD>/` in the current directory unless the user names one.
4. Ask nothing else up front. Make the video only if the user asked for it (视频 / video / clip / 动画).

## 2. Pick a browser

Use whatever browser your harness gives you that is logged in to x.com. It needs three abilities:

| Ability | Examples |
|---|---|
| open a URL | `navigate`, `browser_navigate`, `open_url` |
| scroll the page | a scroll / mouse-wheel action, or pressing `PageDown` |
| run JavaScript and get the value back (read-only is enough) | `javascript_tool`, `evaluate`, `browser_evaluate` |

Prefer the harness's own in-app browser. In Claude Code that is the built-in browser (`mcp__Claude_Browser__*`), falling back to Claude in Chrome (`mcp__claude-in-chrome__*`). In Codex, use its in-app browser. If the browser's tools are deferred, load them all in one go before starting.

The user must already be logged in to x.com there. If `collect.mjs` reports "Not logged in", ask the user to log in in that browser, then continue. Never type credentials yourself.

This skill is **read-only**. Only navigate, scroll and run `extract.js`. Never click like/follow/repost/reply, never post, never change settings. The one exception is X's own "Retry" button, which you may click when the CLI says X is showing it.

## 3. Collect

The browser only *reads*. Everything else (progress, de-duplication, which page is next) lives on disk, in `<out>/collect-state.json`, and is handled by `SKILL_DIR/scripts/collect.mjs`. Nothing is written to x.com's storage. Every `collect.mjs` command prints one JSON line. Its `do` field tells you what to do next.

1. **Start:** `node "SKILL_DIR/scripts/collect.mjs" start --out "<out>"`. Add `--fresh` to discard an earlier run less than 6 hours old (by default it is resumed). The time zone defaults to this machine's. Override it with `--tz Asia/Shanghai`.
2. **Loop** until `do` is `"export"`:
   - `"goto"` → open `next` in the browser, wait about 2 seconds, then extract.
   - `"scroll"` → scroll down about one screen (one `PageDown`, or a mouse-wheel scroll of similar size), wait about 1.5 seconds, then extract.
   - **Extract:** read `SKILL_DIR/scripts/browser/extract.js` once and keep its text. Pass the whole file to the browser's JavaScript tool. Its last line is `})({ scroll: 0 })`. Replace `{ scroll: 0 }` with the `opts` string from the last `collect.mjs` output, if it gave one, so that only new items come back. If the tool wants a function rather than an expression, wrap it as `() => <file text>`.
   - **Add** the returned object, unchanged, to the state:
     ```bash
     node "SKILL_DIR/scripts/collect.mjs" add --out "<out>" <<'XC_PAYLOAD'
     <the JSON object extract.js returned>
     XC_PAYLOAD
     ```
     Alternatively, write it to a file and pass the path after `--out "<out>"`.
   - `warn` means items were probably skipped. Scroll by smaller steps from then on. `blocked` means X is rate-limiting that page. Follow its text (click Retry once, or move on). If a page will not load at all, run `collect.mjs skip --out "<out>" <url>`.
   - Keep the user posted in one short line every few pages (e.g. "已收集 8/20 个页面，找到 140 位朋友"), using `todo` and `totals`.
3. **Export:** `node "SKILL_DIR/scripts/collect.mjs" export --out "<out>"` writes `<out>/data.json`.

**Faster, where allowed:** if the browser's JavaScript tool can await async code and lets scripts scroll the page (Claude Code's tools can), use `{ scroll: 12 }` instead. `extract.js` then scrolls up to 12 screens itself and returns everything it saw. In this mode, skip the separate scroll step and the `opts` string. Run it again whenever `do` is `"scroll"`. If the tool rejects async code or the page does not move, go back to `{ scroll: 0 }`.

Expect roughly 15–30 pages for an active account. Each page takes 1–3 extracts in auto-scroll mode, or a few more when scrolling by hand.

What each page contributes (`extract.js` and `collect.mjs` detect the page from its URL):

| Page | Data |
|---|---|
| `/<me>` | my posts in the last 7 days with counts; my name, avatar, follower count |
| `/<me>/with_replies` | my replies (for my active hours) |
| `/notifications` | likes and reposts on everything I posted (with approximate times), replies, follow notifications ("A and 15 others followed you") |
| `/notifications/mentions` | mentions with exact times |
| `/<me>/followers` | the newest N followers, where N is the total announced by follow notifications |
| `/<me>/status/<id>` | replies to that post (exact times) |
| `/<me>/status/<id>/likes` · `/retweets` · `/quotes` | complete liker / reposter / quoter lists (only the author can see likes) |

Timing comes from post ids, which encode a millisecond timestamp, and from the "2h"/"35m" labels on notifications. X shows no time for likes older than a day, so those count toward people but not toward the active-hours chart.

## 4. Render

```bash
node "SKILL_DIR/scripts/render.mjs" "<out>/data.json" --out "<out>"            # image
node "SKILL_DIR/scripts/render.mjs" "<out>/data.json" --out "<out>" --video    # image + video (~30s to render)
```

The video comes with a short generated soundtrack synced to the animation. Add `--no-music` if the user wants it silent (for example, to add their own music).

`--name <显示名>` overrides the name in the title. Use it when the user wants a different display name or theirs is very long. Chrome is found automatically. Set `CHROME_PATH` if it lives elsewhere, or run `npx playwright install chromium`.

The script prints a one-line summary and writes `model.json` (what was drawn) next to the outputs.

## 5. Deliver

1. Look at the PNG yourself before showing it. If something is off (names overlapping, empty map), check `model.json` and the collection totals rather than guessing.
2. Show the user the image (and video) with a 2–3 line summary: number of people, top post, most active time, new followers. If any page reported `blocked`, say in one line that X rate-limited part of the history, so the earliest days are thinner.
3. Offer a ready-to-paste Chinese caption that thanks the people in the map, e.g.
   「这一周，有 56 颗星照亮了我的 X 宇宙 ✨ 谢谢每一位点赞、转发、回复和新关注的朋友，下周继续相遇！」
   Do not post it. Posting is the user's call.

## How the map is built

- Score per person: like 1, repost 2, mention 2, reply 3, quote 3.
- Rings by rank: inner 8, middle 16, outer 28 people, each ring ordered by first interaction. New followers who did not interact sit on the dotted gold halo (up to 24). The user sits at the center, about the size of an inner-ring friend, because the map is meant to celebrate the friends. The subtitle counts everyone ("N 位朋友，一起点亮了这一周").
- Week dial: 168 hourly bars around the map, starting at the top and running clockwise from the start of the range. Friends' timestamped interactions point outward and the user's own posts and replies point inward. The busiest hour gets a gold ✦ and is shown as 最闪耀时刻.
- Star color = deepest interaction: blue reply/mention, purple quote, green repost, pink like, gold new follower. ✦ marks new followers.
- Stats (发帖 / 获赞 / 转发 / 回复) are X's own counters summed over the week's posts. 新关注 is the total from follow notifications. The poster puts four of them in the corners, with 发帖 in the subtitle. The story video shows all five in a row.
- Video: a radar sweep circles the dial once (one turn = the week). Bars grow and stars appear as it passes, then new followers ripple out onto the halo, and it closes with 「谢谢你们，照亮了我的一周」.
- Music (`scripts/music.mjs`) is synthesized from the animation's own cue times, so there are no samples or licensing concerns:
  - a soft pad that changes chord with each section
  - a bell for each star as it appears, panned to its side of the map, pitched by ring
  - a harp-like run for the new followers and a low swell under the ripple
  - a resolving chord on the thank-you

## Files

- `scripts/browser/extract.js` – read-only page reader, run in the browser. It returns what the page shows and never writes storage or clicks.
- `scripts/collect.mjs` – local collector CLI: state on disk, de-duplication, what to visit next, export to `data.json`
- `scripts/render.mjs` – builds the model, inlines avatars, renders PNG/MP4 via headless Chrome + ffmpeg
- `scripts/template.html` – the SVG constellation (poster and story layouts, frame-by-frame animation, soundtrack cues)
- `scripts/music.mjs` – synthesizes the video's soundtrack from those cues (WAV, muxed by ffmpeg)
- `assets/sample-data.json` – fictional sample. Try the renderer with `node scripts/render.mjs assets/sample-data.json --out /tmp/xu`
