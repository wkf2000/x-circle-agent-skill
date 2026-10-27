#!/usr/bin/env node
// x-circle collector, local side. The browser only reads pages (browser/extract.js returns what is
// on screen); this CLI keeps the progress in <out>/collect-state.json, de-duplicates, decides what
// to open next, and writes the data.json that render.mjs reads.
//
//   node collect.mjs start  --out <dir> [--tz <IANA zone>] [--fresh]
//   node collect.mjs add    --out <dir> [payload.json]     payload from extract.js (stdin if no file)
//   node collect.mjs next   --out <dir>
//   node collect.mjs skip   --out <dir> <url>              give up on a page (e.g. it will not load)
//   node collect.mjs export --out <dir>                    writes <dir>/data.json
//
// Every command prints one JSON line. Its "do" field says what the agent does next:
// "goto" (open "next"), "scroll" (scroll about one screen, then extract again), "export".
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAYS = 7;
const STALE_MS = 6 * 3600e3; // a collection older than this starts fresh
const WEIGHT = { like: 1, repost: 2, mention: 2, reply: 3, quote: 3 };
const TYPES = ['like', 'repost', 'reply', 'quote', 'mention'];
const SHOWN = 52, HALO = 24; // must match the ring sizes in render.mjs

const FOLLOW_RE = /followed you|关注了你|關注了你|跟隨了你|フォローしました|vous a suivi|te siguió|folgt dir/i;
const LIKE_RE = /liked|喜欢了|喜歡了|赞了|いいね/i;
const REPOST_RE = /reposted|转帖了|转发了|轉發了|轉貼了|リポスト/i;
const MORE_RE = /(?:and|以及|和|及)\s*(?:其他)?\s*([\d,.]+[KkMm万千]?)\s*(?:others|other|人|位)/i;

// X post ids are snowflakes: the top bits are milliseconds since 2010-11-04.
const idTime = (id) => new Date(Number(BigInt(id) >> 22n) + 1288834974657).toISOString();
const avatarUrl = (a) => (a && a.startsWith('~/') ? 'https://pbs.twimg.com/profile_images/' + a.slice(2) : a || '');
const sec = (iso) => Math.round(Date.parse(iso) / 1000);
const score = (p) => (p.likes || 0) + 2 * (p.reposts || 0) + 3 * (p.replies || 0);
function parseCount(s) {
  const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm万千亿]?)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, '千': 1e3, '万': 1e4, '亿': 1e8 }[m[2]] || 1));
}
// "6m", "2h", "3d", "2小时", "Oct 20", "10月20日" -> { iso, exact }; exact = good to the hour
function parseRel(s, now) {
  let m = String(s).match(/(?:^|[\s·])(\d+)\s*(s|m|h|d|秒|分钟|分|小时|時間|天|日)(?=$|[\s·])/m);
  if (m) {
    const unit = { s: 1e3, '秒': 1e3, m: 6e4, '分钟': 6e4, '分': 6e4, h: 36e5, '小时': 36e5, '時間': 36e5, d: 864e5, '天': 864e5, '日': 864e5 }[m[2]];
    return { iso: new Date(now - Number(m[1]) * unit).toISOString(), exact: unit < 864e5 };
  }
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/) || String(s).match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const d = new Date(new Date(now).getFullYear(), m[1] in MON ? MON[m[1]] : Number(m[1]) - 1, Number(m[2]), 12);
    if (d.getTime() > now + 864e5) d.setFullYear(d.getFullYear() - 1);
    return { iso: d.toISOString(), exact: false };
  }
  return null;
}

// ---------- state ----------
const stateFile = (out) => path.join(out, 'collect-state.json');
async function load(out) {
  if (!existsSync(stateFile(out))) throw new Error(`No collection in ${out}. Run: node collect.mjs start --out "${out}"`);
  return JSON.parse(await readFile(stateFile(out), 'utf8'));
}
const save = (out, S) => writeFile(stateFile(out), JSON.stringify(S));
function fresh(tz) {
  const now = Date.now();
  return {
    v: 3, createdAt: now, start: new Date(now - DAYS * 864e5).toISOString(), end: new Date(now).toISOString(),
    tz: tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    me: null, auto: false, users: {}, posts: {}, myReplies: {}, interactions: {}, follows: {}, followGroups: {},
    pages: {}, visited: {}, notifOldest: null,
  };
}

// ---------- merging one extract.js payload ----------
function merge(S, P) {
  if (!P || P.v !== 1) throw new Error('Not an extract.js payload. Pass the object that browser/extract.js returned, unchanged.');
  if (!P.me) throw new Error('Not logged in to x.com (no profile link in the nav bar). Ask the user to log in in that browser, then extract again.');
  if (!S.me) S.me = { handle: P.me };
  const me = S.me.handle.toLowerCase();
  if (P.me.toLowerCase() !== me) throw new Error(`This browser is logged in as @${P.me}, but this collection is for @${S.me.handle}. Run start with --fresh to switch accounts.`);
  if (P.scrolled) S.auto = true;
  const startMs = Date.parse(S.start), now = P.now || Date.now();
  const inRange = (iso) => iso && Date.parse(iso) >= startMs;
  const lower = P.path.replace(/\/$/, '').toLowerCase();

  const addUser = (handle, name, avatar) => {
    if (!handle) return;
    const u = S.users[handle.toLowerCase()] ||= { h: handle, n: '', a: '' };
    if (name && !u.n) u.n = name;
    if (avatar && (!u.a || /default_profile/.test(u.a))) u.a = avatarUrl(avatar);
  };
  const addInteraction = (t, handle, extra) => {
    if (!handle || handle.toLowerCase() === me) return false;
    const u = handle.toLowerCase();
    const key = extra.id ? 'tw:' + extra.id : t + ':' + u + ':' + (extra.p || '');
    if (S.interactions[key]) return false;
    S.interactions[key] = { t, u, ...extra };
    return true;
  };
  const tweets = (P.tw || []).map(([id, handle, name, avatar, likes, reposts, replies, views, pinned, text]) =>
    ({ id, handle, name, avatar, likes, reposts, replies, views, pinned, text, time: idTime(id), mine: handle.toLowerCase() === me }));

  let page = P.kind, added = 0, older = [], stop = false;
  if (P.kind === 'profile') {
    const repliesTab = lower.endsWith('/with_replies');
    page = repliesTab ? 'my-replies' : 'my-posts';
    const [name, avatar, followers] = P.prof || [];
    if (name) S.me.name = name;
    if (avatar) S.me.avatar = avatarUrl(avatar);
    if (followers) S.me.followers = followers;
    for (const t of tweets) {
      if (!t.mine) continue;
      if (!inRange(t.time)) { if (!t.pinned) older.push(t.id); continue; }
      if (!repliesTab) {
        if (!S.posts[t.id]) added++;
        S.posts[t.id] = { ...S.posts[t.id], id: t.id, time: t.time, text: t.text, likes: t.likes, reposts: t.reposts, replies: t.replies, views: t.views };
      } else if (!S.posts[t.id] && !S.myReplies[t.id]) {
        S.myReplies[t.id] = { id: t.id, time: t.time };
        added++;
      }
    }
  } else if (P.kind === 'list' && lower.endsWith('/followers')) {
    // Newest followers come first. Fill up to the total the follow notifications announced.
    page = 'followers';
    const want = Object.values(S.followGroups).reduce((a, b) => a + b, 0);
    for (const [handle, name, avatar] of P.cells || []) {
      const k = handle.toLowerCase();
      if (Object.keys(S.follows).length >= want || S.follows[k] || k === me) continue;
      addUser(handle, name, avatar);
      S.follows[k] = 1;
      added++;
    }
    stop = Object.keys(S.follows).length >= want;
  } else if (P.kind === 'list') {
    // Who liked / reposted one of my posts (only the author can see likes).
    const [, pid, which] = lower.match(/\/status\/(\d+)\/(likes|retweets)$/);
    page = which;
    for (const [handle, name, avatar] of P.cells || []) {
      addUser(handle, name, avatar);
      if (addInteraction(which === 'likes' ? 'like' : 'repost', handle, { p: pid })) added++;
    }
  } else if (P.kind === 'status') {
    // A post's conversation (replies) or its quotes list.
    const quotes = lower.endsWith('/quotes');
    const pid = lower.match(/\/status\/(\d+)/)[1];
    page = quotes ? 'quotes' : 'replies';
    for (const t of tweets) {
      if (t.id === pid) {
        if (S.posts[pid]) Object.assign(S.posts[pid], { likes: t.likes, reposts: t.reposts, replies: t.replies, views: t.views || S.posts[pid].views });
        continue;
      }
      if (!inRange(t.time)) continue;
      if (t.mine) { if (!S.posts[t.id] && !S.myReplies[t.id]) { S.myReplies[t.id] = { id: t.id, time: t.time }; added++; } continue; }
      addUser(t.handle, t.name, t.avatar);
      if (addInteraction(quotes ? 'quote' : 'reply', t.handle, { p: pid, at: t.time, id: t.id })) added++;
    }
  } else if (P.kind === 'notifications') {
    // Replies/mentions arrive as posts; likes, reposts and follows as notification rows.
    page = lower.endsWith('/mentions') ? 'mentions' : 'notifications';
    for (const t of tweets) {
      if (!inRange(t.time)) { older.push(t.id); continue; }
      if (t.mine) continue;
      addUser(t.handle, t.name, t.avatar);
      if (addInteraction('mention', t.handle, { at: t.time, id: t.id })) added++;
    }
    for (const [msg, people, pid] of P.notes || []) {
      const kind = FOLLOW_RE.test(msg) ? 'follow' : LIKE_RE.test(msg) ? 'like' : REPOST_RE.test(msg) ? 'repost' : null;
      if (!kind) continue;
      const when = parseRel(msg, now);
      if (when && !inRange(when.iso)) { older.push(msg.slice(0, 40)); continue; }
      if (when && (!S.notifOldest || when.iso < S.notifOldest)) S.notifOldest = when.iso;
      const at = when?.exact ? when.iso : null;
      const list = people.map(([handle, avatar]) => ({ handle, avatar, name: people.length === 1 ? msg.split('\n')[0].trim() : '' }));
      if (kind === 'follow') {
        const g = list[0].handle.toLowerCase();
        if (!S.followGroups[g]) added++;
        S.followGroups[g] = 1 + parseCount(msg.match(MORE_RE)?.[1]);
        list.forEach((p) => { addUser(p.handle, p.name, p.avatar); S.follows[p.handle.toLowerCase()] = 1; });
      } else {
        // Same key as the likes/retweets pages (type:user:post), so both sources merge.
        list.forEach((p) => {
          addUser(p.handle, p.name, p.avatar);
          if (addInteraction(kind, p.handle, { p: pid || 'n:' + msg.slice(0, 30), ...(at ? { at } : {}) })) added++;
        });
      }
    }
  } else {
    // Any other page (e.g. home) only tells us who is logged in.
    return { page: 'other', added: 0, pageDone: true };
  }

  // A page is finished when it reaches past the week, stops yielding new items, is rate-limited,
  // or uses up its budget of extracts.
  const st = S.pages[lower] ||= { runs: 0, idle: 0, blocked: 0, older: [], after: {} };
  st.runs++;
  st.idle = added ? 0 : st.idle + 1;
  st.blocked = P.blocked && !added ? st.blocked + 1 : 0;
  st.older = [...new Set([...st.older, ...older])].slice(0, 10);
  // the cursor for the next extract: the last item of each list (posts, people, notification rows)
  const lastOf = { tw: P.tw?.at(-1)?.[0], cells: P.cells?.at(-1)?.[0].toLowerCase(), notes: P.notes?.length ? P.notes.at(-1)[0].slice(0, 40) + '|' + P.notes.at(-1)[2] : null };
  for (const k in lastOf) if (lastOf[k]) st.after[k] = lastOf[k];
  const notif = page === 'notifications';
  const budget = P.scrolled ? (notif ? 8 : 3) : (notif ? 30 : page === 'my-posts' || page === 'my-replies' ? 25 : 12);
  // nothing new after a scroll means the end, unless X was still loading or the page just opened
  const settled = P.scrolled || (st.runs > 1 && !P.loading);
  const done = stop || st.older.length >= 3 || st.idle >= (settled ? 1 : 2) || st.blocked >= 2 || st.runs >= budget;
  if (done) S.visited[lower] = 1;
  return {
    page, added, pageDone: done,
    ...(st.blocked >= 2 ? { blocked: 'X stopped loading this timeline (rate limit). Kept what loaded; moving on.' } : P.blocked ? { blocked: 'X shows a "Retry" button. Click it once, wait a few seconds, then extract again.' } : {}),
    ...(P.lost ? { warn: 'The page no longer shows where the last extract ended, so some items may be skipped. Scroll by a smaller step (about one screen).' } : {}),
    ...(done || P.scrolled ? {} : { opts: `{ scroll: 0, after: ${JSON.stringify(Object.values(st.after))} }` }),
  };
}

// ---------- what to visit next ----------
function todo(S) {
  if (!S.me) return ['https://x.com/home'];
  const h = S.me.handle, list = [];
  const want = (p) => { if (!S.visited[p.toLowerCase()]) list.push('https://x.com' + p); };
  want('/' + h);
  want('/' + h + '/with_replies');
  want('/notifications');
  want('/notifications/mentions');
  if (S.visited['/notifications'] && Object.keys(S.followGroups).length) want('/' + h + '/followers');
  // the most engaged posts get their replies, likes, reposts and quotes pages
  Object.values(S.posts).sort((a, b) => score(b) - score(a)).slice(0, S.auto ? 10 : 6).forEach((p) => {
    const base = `/${h}/status/${p.id}`;
    if (p.replies > 0) want(base);
    if (p.likes > 0) want(base + '/likes');
    if (p.reposts > 0) { want(base + '/retweets'); want(base + '/quotes'); }
  });
  return list;
}
function status(S, extra = {}) {
  const list = todo(S);
  const followTotal = Object.values(S.followGroups).reduce((a, b) => a + b, 0);
  const pageOpen = extra.pageDone === false;
  return {
    ok: true, ...extra,
    do: pageOpen ? 'scroll' : list.length ? 'goto' : 'export',
    next: pageOpen ? undefined : list[0],
    todo: list.length,
    totals: {
      posts: Object.keys(S.posts).length, myReplies: Object.keys(S.myReplies).length,
      interactions: Object.keys(S.interactions).length, people: Object.keys(S.users).length,
      newFollowers: Math.max(followTotal, Object.keys(S.follows).length),
    },
  };
}

// ---------- data.json for render.mjs ----------
export function exportData(S) {
  const startMs = Date.parse(S.start);
  const posts = Object.values(S.posts).filter((p) => Date.parse(p.time) >= startMs);
  const postTime = Object.fromEntries(posts.map((p) => [p.id, p.time]));
  const ranked = [...posts].sort((a, b) => score(b) - score(a));
  const topId = ranked[0]?.id;
  const agg = {};
  for (const it of Object.values(S.interactions)) {
    if (!(it.t in WEIGHT)) continue;
    if (it.at && Date.parse(it.at) < startMs) continue;
    const a = agg[it.u] ||= { c: [0, 0, 0, 0, 0], s: 0, f: null, tp: 0 };
    a.c[TYPES.indexOf(it.t)]++;
    a.s += WEIGHT[it.t];
    const when = it.at || postTime[it.p];
    if (when && (!a.f || when < a.f)) a.f = when;
    if (it.p === topId) a.tp = 1;
  }
  const person = (k, a) => {
    const u = S.users[k] || { h: k };
    const o = { h: u.h || k, n: u.n || '', a: (u.a || '').replace('https://pbs.twimg.com/profile_images/', '~/') };
    if (a) { o.c = a.c; o.s = a.s; if (a.f) o.f = sec(a.f); if (a.tp) o.tp = 1; }
    if (S.follows[k]) o.nf = 1;
    return o;
  };
  const interactors = Object.entries(agg).sort((x, y) => y[1].s - x[1].s);
  const shown = new Set(interactors.slice(0, SHOWN).map(([k]) => k));
  const quietNew = Object.keys(S.follows).filter((k) => !agg[k]);
  const fans = interactors.filter(([, a]) => a.tp);
  const followTotal = Object.values(S.followGroups).reduce((a, b) => a + b, 0);
  return {
    v: 2, start: S.start, end: S.end, tz: S.tz, me: S.me,
    posts: ranked.map((p, i) => ({ id: p.id, t: sec(p.time), l: p.likes || 0, r: p.reposts || 0, c: p.replies || 0, ...(i < 3 ? { x: (p.text || '').slice(0, 90) } : {}) })),
    myTimes: [...posts.map((p) => p.time), ...Object.values(S.myReplies).map((r) => r.time)].filter((t) => Date.parse(t) >= startMs).map(sec),
    circleTimes: Object.values(S.interactions).filter((it) => it.at && Date.parse(it.at) >= startMs).map((it) => sec(it.at)),
    people: [
      ...interactors.slice(0, SHOWN).map(([k, a]) => person(k, a)),
      ...fans.slice(0, 7).filter(([k]) => !shown.has(k)).map(([k, a]) => person(k, a)),
      ...quietNew.slice(0, HALO).map((k) => person(k, null)),
    ],
    totals: { interactors: interactors.length, quietNew: quietNew.length, newFollowers: Math.max(followTotal, Object.keys(S.follows).length), topPostFans: fans.length },
    notificationsReachBack: S.notifOldest || null,
  };
}

// ---------- CLI ----------
async function readPayload(file) {
  let raw = file ? await readFile(file, 'utf8') : await new Promise((resolve, reject) => {
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; }).on('end', () => resolve(s)).on('error', reject);
  });
  let p = JSON.parse(raw.trim());
  if (typeof p === 'string') p = JSON.parse(p); // some tools hand back the object as a JSON string
  return p;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
  const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !['--out', '--tz'].includes(arr[i - 1]));
  const out = opt('--out');
  if (!cmd || !out) {
    console.error('usage: node collect.mjs <start|add|next|skip|export> --out <dir> [...]');
    process.exit(2);
  }
  await mkdir(out, { recursive: true });
  let S, result;
  if (cmd === 'start') {
    S = existsSync(stateFile(out)) && !argv.includes('--fresh') ? await load(out) : null;
    if (!S || Date.now() - S.createdAt > STALE_MS) S = fresh(opt('--tz'));
    result = status(S, { resumed: !!S.me });
  } else if (cmd === 'add') {
    S = await load(out);
    result = status(S, merge(S, await readPayload(positional[0])));
  } else if (cmd === 'next') {
    S = await load(out);
    result = status(S);
  } else if (cmd === 'skip') {
    S = await load(out);
    const u = new URL(positional[0], 'https://x.com');
    S.visited[u.pathname.replace(/\/$/, '').toLowerCase()] = 1;
    result = status(S, { skipped: u.pathname });
  } else if (cmd === 'export') {
    S = await load(out);
    const data = exportData(S);
    const file = path.join(out, 'data.json');
    await writeFile(file, JSON.stringify(data));
    result = { ok: true, wrote: file, people: data.people.length, posts: data.posts.length, ...status(S).totals };
  } else {
    throw new Error('unknown command: ' + cmd);
  }
  if (S) await save(out, S);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
