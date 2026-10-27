---
name: x-circle-agent-skill
description: Turns the past 7 days of an X (Twitter) account into a shareable constellation poster titled "[Name] 的 X 宇宙" — the user at the center, everyone who liked, reposted, replied or newly followed them placed as stars on orbits (closer = more engaged), plus weekly stats, the most active hour/day, and the week's top post. Optionally renders a 15-second 9:16 video. Collects data read-only by browsing x.com in the built-in browser (fallback: Claude in Chrome). Use when the user asks for their X/Twitter weekly interaction map, "X 宇宙", "x circle", a thank-you image for followers, who interacted with them this week, or a weekly X recap image/video.
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

- Use the **built-in browser** (`mcp__Claude_Browser__*`: `navigate`, `javascript_tool`) if available.
- Otherwise fall back to **Claude in Chrome** (`mcp__claude-in-chrome__*`: `navigate`, `javascript_tool`). Load its tools in one ToolSearch call.
- The user must already be logged in to x.com there. If the collector reports "Not logged in", ask the user to log in in that browser, then continue. Never type credentials yourself.

This skill is **read-only**. Only navigate and run the provided scripts. Never click like/follow/repost/reply, never post, never change settings. (The collector itself only scrolls, and clicks X's own "Retry" button when a timeline fails to load.)

## 3. Collect

State lives in x.com's `localStorage` (key `xcircle:v1`), so stay on x.com in one tab. Expect roughly 15–30 page visits and 5–15 minutes for an active account.

1. Navigate to `https://x.com/home`, then reset leftovers from an earlier run with `localStorage.removeItem('xcircle:v1'); 'reset'`.
2. **First run:** read `SKILL_DIR/scripts/browser/collect.js` and pass its full contents to `javascript_tool`, prefixed with `await ` (the file is one async expression). It finds the logged-in handle itself and stores its own source in `localStorage`.
3. **Every later run** (after each navigation, wait ~2s, then) use this short loader. x.com's CSP blocks `eval`, but allows a script that carries the page's nonce:
   ```js
   const s=document.createElement('script'); s.nonce=document.querySelector('script[nonce]')?.nonce; s.textContent='window.__xc='+localStorage.getItem('xcircle:src'); document.head.appendChild(s); s.remove(); await window.__xc
   ```
   If it fails (e.g. `localStorage` was cleared), paste the full file again as in step 2.
4. Each run returns JSON: `{ok, page, added, done, totals, todoCount, next}`.
   - `done: false` → run the loader again on the same page. The collector tracks its own run budget per page (3, or 8 for `/notifications`) and drops the page from the list when the budget is used up.
   - `blocked` → X is rate-limiting that timeline. Data so far is kept; move on.
   - Otherwise navigate to `next[0]` and run again. Stop when `todoCount` is 0.
   - Order: profile → replies tab → notifications → mentions → followers → the 10 most engaged posts (replies, `/likes`, `/retweets`, `/quotes`).
5. Keep the user posted in one short line every few pages (e.g. "已收集 8/20 个页面，找到 140 位朋友").
6. **Export:** pass `SKILL_DIR/scripts/browser/export.js` (full contents) to `javascript_tool`. It returns a compact JSON string (~10–30 KB) holding only the people who will be drawn, plus totals and timestamps. Write it unchanged to `<out>/data.json`.

What each page contributes (the collector detects the page from its URL):

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
- Rings by rank: inner 8, middle 16, outer 28 people. New followers who did not interact sit on the dotted gold halo (up to 24). The subtitle counts everyone ("N 颗星照亮了我的这一周").
- Star color = deepest interaction: blue reply/mention, purple quote, green repost, pink like, gold new follower. ✦ marks new followers.
- Stats (发帖 / 获赞 / 转发 / 回复) are X's own counters summed over the week's posts. 新关注 is the total from follow notifications.

## Files

- `scripts/browser/collect.js` – page-aware collector, run in the browser
- `scripts/browser/export.js` – aggregates collected data into `data.json`
- `scripts/render.mjs` – builds the model, inlines avatars, renders PNG/MP4 via headless Chrome + ffmpeg
- `scripts/template.html` – the SVG constellation (poster and story layouts, frame-by-frame animation)
- `assets/sample-data.json` – fictional sample. Try the renderer with `node scripts/render.mjs assets/sample-data.json --out /tmp/xu`
