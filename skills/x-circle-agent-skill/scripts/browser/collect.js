// x-circle collector. Run on x.com pages in the logged-in browser (built-in browser or Chrome).
// Detects the page type from the URL, scrolls, and merges what it sees into localStorage
// under "xcircle:v1". Safe to re-run: everything is keyed and de-duplicated.
// The first run stores this source in localStorage; later pages can re-run it with the
// short loader in SKILL.md (x.com's CSP blocks eval, but allows a nonce'd inline script).
//
// Selectors lean on stable semantics (hrefs, img alt="@handle", data-engagement-action,
// post ids) rather than CSS classes, because X's markup changes often.
(async function xcircle() {
  const KEY = 'xcircle:v1';
  const DAYS = 7;
  const MAX_ROUNDS = 28;
  const POST_PAGES = 10; // open replies/likes/reposts pages for the N most engaged posts only
  const WAIT_MS = 900;
  const STALE_MS = 6 * 3600e3; // a run older than this starts fresh

  try { localStorage.setItem('xcircle:src', '(' + xcircle.toString() + ')()'); } catch (e) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();
  let S = null;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!S || now - S.createdAt > STALE_MS) {
    S = {
      v: 2, createdAt: now,
      start: new Date(now - DAYS * 864e5).toISOString(),
      end: new Date(now).toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      me: null, users: {}, posts: {}, myReplies: {}, interactions: {},
      follows: {}, followGroups: {}, visited: {},
    };
  }
  const save = () => localStorage.setItem(KEY, JSON.stringify(S));
  const startMs = Date.parse(S.start);

  const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})$/;
  const STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/;
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose', 'i', 'jobs', 'communities', 'premium', 'lists', 'bookmarks', 'tos', 'privacy']);

  const meHandle = (() => {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"], nav a[aria-label="Profile"], nav a[aria-label="个人资料"], nav a[aria-label="個人資料"]');
    if (a) return a.getAttribute('href').slice(1);
    const cand = [...document.querySelectorAll('nav a[href^="/"], header a[href^="/"]')]
      .map((x) => x.getAttribute('href').match(HANDLE_RE)?.[1]).filter((h) => h && !RESERVED.has(h.toLowerCase()));
    return cand[0] || '';
  })();
  if (!meHandle) return JSON.stringify({ ok: false, error: 'Not logged in to x.com (no profile link in the nav bar). Ask the user to log in, then re-run.' });
  const me = meHandle.toLowerCase();
  S.me = Object.assign({ handle: meHandle }, S.me || {});

  const main = () => document.querySelector('main') || document.querySelector('[data-testid="primaryColumn"]') || document.body;
  // X post ids are snowflakes: the top bits are milliseconds since 2010-11-04.
  const idTime = (id) => new Date(Number(BigInt(id) >> 22n) + 1288834974657).toISOString();
  const inRange = (iso) => iso && Date.parse(iso) >= startMs;

  function text(node) {
    if (!node) return '';
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeName === 'IMG') out += n.getAttribute('alt') || '';
      else if (n.nodeName === 'BR') out += '\n';
      else n.childNodes.forEach(walk);
    };
    walk(node);
    return out.trim();
  }
  function parseCount(s) {
    const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm万千亿]?)/);
    if (!m) return 0;
    const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, '千': 1e3, '万': 1e4, '亿': 1e8 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }
  // "6m", "2h", "3d", "2小时", "Oct 20", "10月20日" -> { iso, exact }; exact = good to the hour
  function parseRel(s) {
    let m = String(s).match(/(?:^|[\s·])(\d+)\s*(s|m|h|d|秒|分钟|分|小时|時間|天|日)(?=$|[\s·])/m);
    if (m) {
      const unit = { s: 1e3, '秒': 1e3, m: 6e4, '分钟': 6e4, '分': 6e4, h: 36e5, '小时': 36e5, '時間': 36e5, d: 864e5, '天': 864e5, '日': 864e5 }[m[2]];
      return { iso: new Date(now - Number(m[1]) * unit).toISOString(), exact: unit < 864e5 };
    }
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/) || String(s).match(/(\d{1,2})月(\d{1,2})日/);
    if (m) {
      const mon = m[1] in MON ? MON[m[1]] : Number(m[1]) - 1;
      const d = new Date(new Date(now).getFullYear(), mon, Number(m[2]), 12);
      if (d.getTime() > now + 864e5) d.setFullYear(d.getFullYear() - 1);
      return { iso: d.toISOString(), exact: false };
    }
    return null;
  }
  function addUser(handle, name, avatar) {
    if (!handle) return;
    const k = handle.toLowerCase();
    const u = S.users[k] || (S.users[k] = { h: handle, n: '', a: '' });
    if (name && !u.n) u.n = name;
    if (avatar && (!u.a || /default_profile/.test(u.a))) u.a = avatar;
  }
  function addInteraction(t, handle, extra) {
    if (!handle || handle.toLowerCase() === me) return false;
    const u = handle.toLowerCase();
    const key = extra.id ? 'tw:' + extra.id : t + ':' + u + ':' + (extra.p || '');
    if (S.interactions[key]) return false;
    S.interactions[key] = Object.assign({ t, u }, extra);
    return true;
  }

  // ---------- posts ----------
  const topArticles = () => [...main().querySelectorAll('article')].filter((a) => !a.parentElement.closest('article'));
  const own = (art, sel) => [...art.querySelectorAll(sel)].filter((e) => e.closest('article') === art && !e.closest('[data-slot="embedded-tweet-frame"]'));
  function readTweet(art) {
    const perma = own(art, 'a[href*="/status/"]').map((a) => a.getAttribute('href').match(STATUS_RE)).find(Boolean);
    if (!perma) return null;
    const [, handle, id] = perma;
    const hk = '/' + handle.toLowerCase();
    const nameLink = own(art, 'a[href]').find((a) => a.getAttribute('href').toLowerCase() === hk && a.innerText.trim() && !a.innerText.trim().startsWith('@'));
    const avatar = own(art, `a img[src*="profile_images"]`).find((i) => i.closest('a').getAttribute('href').toLowerCase() === hk)?.src || '';
    const body = own(art, '[data-testid="tweetText"], div[dir="auto"]')[0];
    const eng = (k) => parseCount(own(art, `[data-engagement-action="${k}"], [data-testid="${k}"]`)[0]?.innerText);
    return {
      handle, id, avatar,
      name: text(nameLink).split('\n')[0],
      time: idTime(id),
      text: text(body).slice(0, 140),
      pinned: /^(Pinned|已置顶|置顶|置頂|固定)/.test(art.innerText.trim()),
      replies: eng('reply'),
      reposts: Math.max(eng('retweet'), eng('unretweet')),
      likes: Math.max(eng('like'), eng('unlike')),
      views: parseCount(own(art, 'a[href$="/analytics"]')[0]?.innerText),
    };
  }

  // ---------- people lists (likes, reposts, followers) ----------
  function readCells() {
    const cells = [...main().querySelectorAll('[data-testid="UserCell"], li')].filter((c) => !c.closest('article') && c.querySelector('img[src*="profile_images"]'));
    return cells.map((c) => {
      const img = c.querySelector('a[href^="/"] img[src*="profile_images"]');
      const handle = (img?.alt || '').startsWith('@') ? img.alt.slice(1) : img?.closest('a')?.getAttribute('href').match(HANDLE_RE)?.[1];
      if (!handle) return null;
      const hk = '/' + handle.toLowerCase();
      const nameLink = [...c.querySelectorAll('a[href]')].find((a) => a.getAttribute('href').toLowerCase() === hk && a.innerText.trim() && !a.innerText.trim().startsWith('@'));
      return { handle, name: text(nameLink).split('\n')[0], avatar: img.src };
    }).filter(Boolean);
  }

  // X shows "Something went wrong · Retry" when it rate-limits a timeline.
  const retryButton = () => [...main().querySelectorAll('button')].find((b) => /^(Retry|重试|重試|再試行|Réessayer|Reintentar|Erneut versuchen)$/.test(b.innerText.trim()));
  async function scrollCollect(step) {
    let idle = 0, rounds = 0, added = 0, done = false, blocked = false, retries = 0;
    for (; rounds < MAX_ROUNDS; rounds++) {
      const r = step();
      added += r.added;
      if (r.stop) { done = true; break; }
      idle = r.added ? 0 : idle + 1;
      if (idle >= 3 && retryButton()) {
        if (retries++ >= 2) { blocked = true; break; }
        retryButton().click();
        await sleep(4000);
        idle = 0;
        continue;
      }
      if (idle >= 4) { done = true; break; }
      window.scrollBy(0, Math.round(innerHeight * 0.85));
      await sleep(WAIT_MS);
    }
    return { rounds, added, done, blocked };
  }

  await sleep(400);
  const path = location.pathname.replace(/\/$/, '');
  const lower = path.toLowerCase();
  let page = 'unknown', res = { rounds: 0, added: 0, done: true };

  if (lower === '/' + me || lower === '/' + me + '/with_replies') {
    // Own profile: my posts (Posts tab) and my replies (Replies tab).
    const repliesTab = lower.endsWith('/with_replies');
    page = repliesTab ? 'my-replies' : 'my-posts';
    const h1 = main().querySelector('h1, [data-testid="UserName"]');
    if (h1) S.me.name = text(h1).split('\n')[0];
    const av = main().querySelector('a[href$="/photo"] img[src*="profile_images"]');
    if (av) S.me.avatar = av.src;
    const fl = main().querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
    if (fl) S.me.followers = parseCount(fl.innerText);
    let older = 0;
    res = await scrollCollect(() => {
      let added = 0;
      topArticles().forEach((art) => {
        const t = readTweet(art);
        if (!t || t.handle.toLowerCase() !== me) return;
        if (!inRange(t.time)) { if (!t.pinned) older++; return; }
        if (!repliesTab) {
          const isNew = !S.posts[t.id];
          S.posts[t.id] = Object.assign(S.posts[t.id] || {}, {
            id: t.id, time: t.time, text: t.text, likes: t.likes, reposts: t.reposts, replies: t.replies, views: t.views,
          });
          if (isNew) added++;
        } else if (!S.posts[t.id] && !S.myReplies[t.id]) {
          S.myReplies[t.id] = { id: t.id, time: t.time };
          added++;
        }
      });
      return { added, stop: older >= 3 };
    });
  } else if (/^\/[^/]+\/status\/\d+\/(likes|retweets)$/.test(path)) {
    // Who liked / reposted one of my posts (only the author can see likes).
    const [, pid, kind] = path.match(/\/status\/(\d+)\/(likes|retweets)$/);
    page = kind;
    res = await scrollCollect(() => {
      let added = 0;
      readCells().forEach((u) => {
        addUser(u.handle, u.name, u.avatar);
        if (addInteraction(kind === 'likes' ? 'like' : 'repost', u.handle, { p: pid })) added++;
      });
      return { added, stop: false };
    });
  } else if (/^\/[^/]+\/status\/\d+(\/quotes)?$/.test(path)) {
    // A post's conversation (replies) or its quotes list.
    const quotes = path.endsWith('/quotes');
    const pid = path.match(/\/status\/(\d+)/)[1];
    page = quotes ? 'quotes' : 'replies';
    res = await scrollCollect(() => {
      let added = 0;
      topArticles().forEach((art) => {
        const t = readTweet(art);
        if (!t) return;
        if (t.id === pid) {
          if (S.posts[pid]) Object.assign(S.posts[pid], { likes: t.likes, reposts: t.reposts, replies: t.replies, views: t.views || S.posts[pid].views });
          return;
        }
        if (!inRange(t.time)) return;
        if (t.handle.toLowerCase() === me) {
          if (!S.posts[t.id] && !S.myReplies[t.id]) { S.myReplies[t.id] = { id: t.id, time: t.time }; added++; }
          return;
        }
        addUser(t.handle, t.name, t.avatar);
        if (addInteraction(quotes ? 'quote' : 'reply', t.handle, { p: pid, at: t.time, id: t.id })) added++;
      });
      return { added, stop: false };
    });
  } else if (lower === '/notifications' || lower === '/notifications/mentions') {
    // Notifications: replies/mentions (posts), plus likes on my replies and follow counts (list items).
    const mentionsTab = lower.endsWith('/mentions');
    page = mentionsTab ? 'mentions' : 'notifications';
    const FOLLOW_RE = /followed you|关注了你|關注了你|跟隨了你|フォローしました|vous a suivi|te siguió|folgt dir/i;
    const LIKE_RE = /liked|喜欢了|喜歡了|赞了|いいね/i;
    const REPOST_RE = /reposted|转帖了|转发了|轉發了|轉貼了|リポスト/i;
    const MORE_RE = /(?:and|以及|和|及)\s*(?:其他)?\s*([\d,.]+[KkMm万千]?)\s*(?:others|other|人|位)/i;
    let older = 0;
    res = await scrollCollect(() => {
      let added = 0;
      topArticles().forEach((art) => {
        const t = readTweet(art);
        if (!t) return;
        if (!inRange(t.time)) { older++; return; }
        if (t.handle.toLowerCase() === me) return;
        addUser(t.handle, t.name, t.avatar);
        if (addInteraction('mention', t.handle, { at: t.time, id: t.id })) added++;
      });
      if (!mentionsTab) {
        const items = [...main().querySelectorAll('li, article[data-testid="notification"]')].filter((l) => !l.querySelector('article') && !l.closest('article') && !l.parentElement.closest('li'));
        items.forEach((li) => {
          const msg = li.innerText;
          const kind = FOLLOW_RE.test(msg) ? 'follow' : LIKE_RE.test(msg) ? 'like' : REPOST_RE.test(msg) ? 'repost' : null;
          if (!kind) return;
          const when = parseRel(msg);
          if (when && !inRange(when.iso)) { older++; return; }
          if (when && (!S.notifOldest || when.iso < S.notifOldest)) S.notifOldest = when.iso;
          const at = when?.exact ? when.iso : null;
          const people = [...li.querySelectorAll('a[href^="/"] img[src*="profile_images"]')]
            .map((img) => ({ handle: (img.alt || '').startsWith('@') ? img.alt.slice(1) : img.closest('a').getAttribute('href').match(HANDLE_RE)?.[1], avatar: img.src }))
            .filter((p) => p.handle && p.handle.toLowerCase() !== me);
          if (!people.length) return;
          if (people.length === 1) people[0].name = msg.split('\n')[0].trim();
          if (kind === 'follow') {
            const gkey = people[0].handle.toLowerCase();
            if (!S.followGroups[gkey]) added++;
            S.followGroups[gkey] = 1 + parseCount(msg.match(MORE_RE)?.[1]);
            people.forEach((p) => { addUser(p.handle, p.name, p.avatar); S.follows[p.handle.toLowerCase()] = 1; });
          } else {
            // Same key as the likes/retweets pages (type:user:post), so both sources merge.
            const pid = [...li.querySelectorAll('a[href*="/status/"]')].map((a) => a.getAttribute('href').match(STATUS_RE)).find(Boolean)?.[2];
            people.forEach((p) => {
              addUser(p.handle, p.name, p.avatar);
              if (addInteraction(kind, p.handle, Object.assign({ p: pid || 'n:' + msg.slice(0, 30) }, at ? { at } : {}))) added++;
            });
          }
        });
      }
      return { added, stop: older >= 3 };
    });
  } else if (lower === '/' + me + '/followers') {
    // Newest followers come first. Notification avatars are already in S.follows;
    // fill up to the total the follow notifications announced.
    page = 'followers';
    const want = Object.values(S.followGroups).reduce((a, b) => a + b, 0);
    const full = () => Object.keys(S.follows).length >= want;
    res = await scrollCollect(() => {
      let added = 0;
      readCells().forEach((u) => {
        const k = u.handle.toLowerCase();
        if (full() || S.follows[k] || k === me) return;
        addUser(u.handle, u.name, u.avatar);
        S.follows[k] = 1;
        added++;
      });
      return { added, stop: full() };
    });
  }

  // A page is finished when it is done, rate-limited, or has used its run budget.
  if (page !== 'unknown') {
    S.runs = S.runs || {};
    S.runs[lower] = (S.runs[lower] || 0) + 1;
    const budget = page === 'notifications' ? 8 : 3;
    if (res.done || res.blocked || S.runs[lower] >= budget) S.visited[lower] = 1;
  }
  save();

  const todo = [];
  const want = (p) => { if (!S.visited[p.toLowerCase()]) todo.push('https://x.com' + p); };
  want('/' + meHandle);
  want('/' + meHandle + '/with_replies');
  want('/notifications');
  want('/notifications/mentions');
  if (S.visited['/notifications'] && Object.keys(S.followGroups).length) want('/' + meHandle + '/followers');
  Object.values(S.posts).sort((a, b) => (b.likes + 2 * b.reposts + 3 * b.replies) - (a.likes + 2 * a.reposts + 3 * a.replies)).slice(0, POST_PAGES).forEach((p) => {
    const base = `/${meHandle}/status/${p.id}`;
    if (p.replies > 0) want(base);
    if (p.likes > 0) want(base + '/likes');
    if (p.reposts > 0) { want(base + '/retweets'); want(base + '/quotes'); }
  });

  const followTotal = Object.values(S.followGroups).reduce((a, b) => a + b, 0);
  return JSON.stringify({
    ok: true, page, added: res.added, done: res.done, rounds: res.rounds,
    ...(res.blocked ? { blocked: 'X stopped loading this timeline (rate limit). Kept what loaded; move on.' } : {}),
    ...(page === 'notifications' && S.notifOldest ? { notificationsReachBack: S.notifOldest } : {}),
    totals: {
      posts: Object.keys(S.posts).length, myReplies: Object.keys(S.myReplies).length,
      interactions: Object.keys(S.interactions).length, people: Object.keys(S.users).length,
      newFollowers: Math.max(followTotal, Object.keys(S.follows).length),
    },
    todoCount: todo.length,
    next: todo.slice(0, 5),
  });
})()
