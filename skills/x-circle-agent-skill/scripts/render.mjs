#!/usr/bin/env node
// Render the "X 宇宙" constellation from data.json (written by collect.mjs export).
//
//   node render.mjs <data.json> [--out <dir>] [--video] [options]
//
// data.json comes from `collect.mjs export`. Writes <out>/x-universe.png (1080x1350 @2x) and, with --video, <out>/x-universe.mp4
// (1080x1920, 15s, with a generated soundtrack synced to the animation). Options:
//   --theme starry|aurora|dawn  (星空 / 极光 / 晨曦)     --lang zh|en
//   --name / --title / --subtitle / --thanks <text>       --hide likes,replies,reposts,followers,posts
//   --exclude handle1,handle2   --seconds 10..30   --no-music   --preview-themes (writes themes.png)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compose } from './music.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const RING_SIZES = { inner: 8, middle: 16, outer: 28, halo: 24 };
const THEMES = { starry: '星空', aurora: '极光', dawn: '晨曦' };
const HIDEABLE = ['likes', 'replies', 'reposts', 'followers', 'posts'];

function parseArgs(argv) {
  const args = { input: null, out: null, video: false, music: true, preview: false, name: null, theme: 'starry', lang: 'zh', hide: [], exclude: [] };
  const list = (v) => String(v || '').split(/[,，\s]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--video') args.video = true;
    else if (a === '--no-music') args.music = false;
    else if (a === '--preview-themes') args.preview = true;
    else if (['--out', '--name', '--title', '--subtitle', '--thanks', '--theme', '--lang', '--seconds'].includes(a)) args[a.slice(2)] = argv[++i];
    else if (a === '--hide') args.hide = list(argv[++i]).map((x) => x.toLowerCase());
    else if (a === '--exclude') args.exclude = list(argv[++i]).map((x) => x.toLowerCase());
    else if (!a.startsWith('--')) args.input = a;
  }
  if (!args.input) {
    console.error('usage: node render.mjs <data.json> [--out <dir>] [--video] [--theme starry|aurora|dawn] [--lang zh|en] [--title|--subtitle|--thanks|--name <text>] [--hide likes,...] [--exclude h1,h2] [--seconds N] [--no-music] [--preview-themes]');
    process.exit(2);
  }
  // themes also go by their Chinese names
  args.theme = Object.keys(THEMES).find((k) => k === String(args.theme).toLowerCase() || THEMES[k] === args.theme);
  if (!args.theme) throw new Error('--theme must be one of: ' + Object.entries(THEMES).map(([k, v]) => `${k} (${v})`).join(', '));
  if (!['zh', 'en'].includes(args.lang)) throw new Error('--lang must be zh or en');
  const bad = args.hide.filter((k) => !HIDEABLE.includes(k));
  if (bad.length) throw new Error(`--hide takes: ${HIDEABLE.join(', ')} (got ${bad.join(', ')})`);
  if (args.seconds != null) args.seconds = Math.min(30, Math.max(8, Number(args.seconds) || 15));
  args.out ||= path.dirname(path.resolve(args.input));
  return args;
}

// ---------- time helpers (in the user's time zone) ----------
function zoned(iso, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { ...parts, dow, hourNum: Number(parts.hour) };
}

// ---------- data -> model ----------
// data.json is the compact v2 shape written by `collect.mjs export`: only the people who are drawn,
// with per-type counts, plus totals and timestamps (epoch seconds).
export function buildModel(data, opts = {}) {
  if (data.v !== 2) throw new Error('data.json must come from collect.mjs export (v2)');
  const tz = data.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startMs = Date.parse(data.start), endMs = Date.parse(data.end);
  const iso = (s) => new Date(s * 1000).toISOString();
  const avatarUrl = (a) => (a && a.startsWith('~/') ? 'https://pbs.twimg.com/profile_images/' + a.slice(2) : a || '');
  const TYPES = ['like', 'repost', 'reply', 'quote', 'mention'];

  const excluded = new Set(opts.exclude || []);
  const all = (data.people || []).map((p) => {
    const c = Object.fromEntries(TYPES.map((t, i) => [t, p.c?.[i] || 0]));
    return { handle: p.h, name: p.n || p.h, avatar: avatarUrl(p.a), c, score: p.s || 0, first: p.f || null, isNew: !!p.nf, topFan: !!p.tp };
  });
  // --exclude drops accounts (spam, bots); export keeps a few spares so the rings stay full
  const people = all.filter((p) => !excluded.has(p.handle.toLowerCase()));
  const gone = all.filter((p) => excluded.has(p.handle.toLowerCase()));
  const kindOf = (p) => (p.c.reply || p.c.mention ? 'reply' : p.c.quote ? 'quote' : p.c.repost ? 'repost' : p.c.like ? 'like' : 'follow');
  const span = endMs - startMs;
  const interactors = people.filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || (a.first || 0) - (b.first || 0) || a.handle.localeCompare(b.handle));
  const maxScore = interactors[0]?.score || 1;
  const star = (p) => ({
    handle: p.handle, name: p.name, avatar: p.avatar, c: p.c, isNew: p.isNew, kind: kindOf(p),
    weight: Math.sqrt(p.score / maxScore), f: p.first ? Math.min(1, Math.max(0, (p.first * 1000 - startMs) / span)) : null,
  });
  const rings = { inner: [], middle: [], outer: [], halo: [] };
  let i = 0;
  // within a ring, order by first interaction so the video's sweep reveals people roughly in time order
  const byFirst = (a, b) => (a.f ?? 0.5) - (b.f ?? 0.5);
  for (const ring of ['inner', 'middle', 'outer']) {
    rings[ring] = interactors.slice(i, i + RING_SIZES[ring]).map(star).sort(byFirst);
    i += RING_SIZES[ring];
  }
  const quietNew = people.filter((p) => p.isNew && p.score === 0);
  rings.halo = quietNew.slice(0, RING_SIZES.halo).map(star);
  const totals = data.totals || {};
  const nInteractors = Math.max((totals.interactors || 0) - gone.filter((p) => p.score > 0).length, interactors.length);
  const nQuietNew = Math.max((totals.quietNew || 0) - gone.filter((p) => p.isNew && !p.score).length, quietNew.length);

  // activity: my own posts/replies vs. timestamped interactions from others
  const hoursMe = Array(24).fill(0), hoursCircle = Array(24).fill(0);
  const inRange = (s) => s * 1000 >= startMs && s * 1000 <= endMs;
  const myTimes = (data.myTimes || []).filter(inRange);
  const circleTimes = (data.circleTimes || []).filter(inRange);
  for (const s of myTimes) hoursMe[zoned(iso(s), tz).hourNum]++;
  for (const s of circleTimes) hoursCircle[zoned(iso(s), tz).hourNum]++;
  const argmax = (arr) => arr.reduce((b, v, j) => (v > arr[b] ? j : b), 0);

  // the week dial: 168 hourly slots from the (local) hour the range starts, plus the local days they fall in
  const HOURS = 168;
  const slot0 = Math.floor(startMs / 3600e3) * 3600e3;
  const slot = (s) => Math.min(HOURS - 1, Math.max(0, Math.floor((s * 1000 - slot0) / 3600e3)));
  const weekMe = Array(HOURS).fill(0), weekCircle = Array(HOURS).fill(0);
  for (const s of myTimes) weekMe[slot(s)]++;
  for (const s of circleTimes) weekCircle[slot(s)]++;
  const daySegs = [];
  for (let h = 0; h < HOURS; h++) {
    const z = zoned(new Date(slot0 + h * 3600e3).toISOString(), tz);
    const last = daySegs[daySegs.length - 1];
    if (last && last.day === z.day) last.to = h + 1;
    else daySegs.push({ day: z.day, from: h, to: h + 1, dow: z.dow, date: `${Number(z.month)}.${Number(z.day)}` });
  }
  const peakSlot = argmax(weekMe.map((v, h) => v + weekCircle[h]));
  const pz = zoned(new Date(slot0 + peakSlot * 3600e3).toISOString(), tz);

  // top post (export sorts posts by engagement) and the people who lit it up
  const posts = (data.posts || []).filter((p) => inRange(p.t));
  const top = posts[0];
  let topPost = null;
  if (top) {
    const fans = interactors.filter((p) => p.topFan);
    const z = zoned(iso(top.t), tz);
    topPost = {
      text: top.x || '', likes: top.l, reposts: top.r, replies: top.c,
      dow: z.dow, time: `${z.hour}:${z.minute}`,
      fans: fans.slice(0, 7).map((p) => ({ handle: p.handle, name: p.name, avatar: p.avatar })),
      fanCount: Math.max((totals.topPostFans || 0) - gone.filter((p) => p.topFan).length, fans.length),
    };
  }

  const s = zoned(data.start, tz), e = zoned(new Date(endMs - 1).toISOString(), tz);
  const sum = (k) => posts.reduce((a, p) => a + (p[k] || 0), 0);
  return {
    me: { handle: data.me?.handle || '', name: opts.name || data.me?.name || data.me?.handle || '', avatar: data.me?.avatar || '' },
    rangeLabel: `${s.year}.${s.month}.${s.day} – ${e.month}.${e.day}`,
    startHour: zoned(new Date(slot0).toISOString(), tz).hourNum,
    stats: {
      stars: nInteractors + nQuietNew,
      posts: posts.length,
      likes: sum('l'),
      reposts: sum('r'),
      replies: sum('c'),
      newFollowers: totals.newFollowers ?? quietNew.length,
    },
    rings,
    activity: {
      total: myTimes.length + circleTimes.length,
      weekMe, weekCircle, daySegs, peakSlot,
      peakDow: pz.dow, peakTime: `${pz.hour}:00`,
      meHour: myTimes.length ? argmax(hoursMe) : null,
      circleHour: circleTimes.length ? argmax(hoursCircle) : null,
    },
    topPost,
    options: { theme: opts.theme || 'starry', lang: opts.lang || 'zh', hide: opts.hide || [], title: opts.title, subtitle: opts.subtitle, thanks: opts.thanks, seconds: opts.seconds },
  };
}

// ---------- avatars -> data URIs (so the page never waits on the network) ----------
async function inlineAvatars(model) {
  const targets = [model.me, ...Object.values(model.rings).flat(), ...(model.topPost?.fans || [])];
  const cache = new Map();
  const get = (url) => {
    if (!url) return Promise.resolve(null);
    const big = url.replace(/_(normal|bigger|mini)(\.\w+)$/, '_200x200$2');
    if (!cache.has(big)) {
      cache.set(big, (async () => {
        for (const u of [big, url]) {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
          } catch { /* try next */ }
        }
        return null;
      })());
    }
    return cache.get(big);
  };
  const queue = [...targets];
  const worker = async () => { for (let t; (t = queue.shift());) t.avatarData = t.avatarData || await get(t.avatar); };
  await Promise.all(Array.from({ length: 8 }, worker));
  const missing = targets.filter((t) => t.avatar && !t.avatarData).length;
  if (missing) console.warn(`warning: ${missing} avatar(s) could not be downloaded; using initials instead`);
}

// ---------- browser ----------
async function launch() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    throw new Error(`playwright-core is not installed. Run:  npm install --prefix "${HERE}"`);
  }
  const tries = [];
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH });
  tries.push({ channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' }, {});
  let last;
  for (const o of tries) {
    try { return await chromium.launch({ headless: true, ...o }); } catch (e) { last = e; }
  }
  throw new Error(`No Chrome/Chromium found (${last?.message?.split('\n')[0]}). Install Google Chrome, set CHROME_PATH, or run: npx playwright install chromium`);
}

async function openStage(browser, model, layout, scale) {
  const page = await browser.newPage({ viewport: { width: 1080, height: layout === 'story' ? 1920 : 1350 }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(path.join(HERE, 'template.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const info = await page.evaluate(([m, l]) => window.XC.build(m, l), [model, layout]);
  return { page, info };
}

async function renderImage(browser, model, file, scale = 2) {
  const { page } = await openStage(browser, model, 'poster', scale);
  await page.evaluate(() => window.XC.frame(null));
  await page.waitForTimeout(150);
  const png = await page.screenshot({ path: file, type: 'png' });
  await page.close();
  return png;
}

// One image with the poster in every theme side by side, so the user can pick a look.
async function renderPreview(browser, model, file) {
  const shots = [];
  for (const [theme, label] of Object.entries(THEMES)) {
    const png = await renderImage(browser, { ...model, options: { ...model.options, theme } }, undefined, 1);
    shots.push({ theme, label, src: 'data:image/png;base64,' + png.toString('base64') });
  }
  const page = await browser.newPage({ viewport: { width: 1740, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:#16161a;font:500 22px 'PingFang SC',system-ui,sans-serif;color:#eee">
    <div style="display:flex;gap:30px;padding:30px">${shots.map((s) => `<figure style="margin:0;text-align:center">
      <img src="${s.src}" style="width:540px;height:675px;display:block;border-radius:6px">
      <figcaption style="margin-top:14px">${s.label} <span style="opacity:.55">--theme ${s.theme}</span></figcaption></figure>`).join('')}</div></body>`);
  await page.screenshot({ path: file, type: 'png', fullPage: true });
  await page.close();
}

async function renderVideo(browser, model, file, music) {
  const { page, info } = await openStage(browser, model, 'story', 1);
  let wav = null;
  const audioArgs = [];
  if (music) {
    wav = path.join(os.tmpdir(), `x-universe-${process.pid}.wav`);
    await writeFile(wav, compose(info.events, info.T, info.duration));
    audioArgs.push('-i', wav, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  }
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', ...audioArgs,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = new Promise((resolve, reject) => {
    ffmpeg.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('ffmpeg not found. Install it (macOS: brew install ffmpeg) to render video.') : e));
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited with code ' + code))));
  });
  const frames = Math.round(info.duration * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.XC.frame(t), f / FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ffmpeg.stdin.write(jpg)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (f % FPS === 0) process.stdout.write(`\rvideo ${Math.round((f / frames) * 100)}%`);
  }
  ffmpeg.stdin.end();
  try { await exited; } finally { if (wav) await rm(wav, { force: true }); }
  process.stdout.write('\rvideo 100%\n');
  await page.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(await readFile(args.input, 'utf8'));
  const model = buildModel(data, args);
  await mkdir(args.out, { recursive: true });
  await inlineAvatars(model);
  await writeFile(path.join(args.out, 'model.json'), JSON.stringify(model, (k, v) => (k === 'avatarData' ? undefined : v), 2));

  const browser = await launch();
  try {
    const png = path.join(args.out, 'x-universe.png');
    await renderImage(browser, model, png);
    console.log('image: ' + png);
    if (args.preview) {
      const sheet = path.join(args.out, 'themes.png');
      await renderPreview(browser, model, sheet);
      console.log('themes: ' + sheet);
    }
    if (args.video) {
      const mp4 = path.join(args.out, 'x-universe.mp4');
      await renderVideo(browser, model, mp4, args.music);
      console.log('video: ' + mp4);
    }
  } finally {
    await browser.close();
  }
  const st = model.stats;
  console.log(`summary: ${st.stars} people, ${st.posts} posts, ${st.likes} likes, ${st.reposts} reposts, ${st.replies} replies, +${st.newFollowers} followers` +
    (model.activity.total ? `, peak ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][model.activity.peakDow]} ${model.activity.peakTime}` : ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
}
