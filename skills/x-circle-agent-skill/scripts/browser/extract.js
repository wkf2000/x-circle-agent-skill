// x-circle page extractor (read-only; see SKILL.md). Returns what this x.com page shows, for `collect.mjs add`.
(function xcExtract(opts) {
  const H = /^\/([A-Za-z0-9_]{1,15})$/, ST = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/;
  const q = (sel, root = document) => [...root.querySelectorAll(sel)];
  const href = (a) => a?.getAttribute('href') || '';
  const meA = document.querySelector('a[data-testid="AppTabBar_Profile_Link"], nav a[aria-label="Profile"], nav a[aria-label="个人资料"], nav a[aria-label="個人資料"]');
  const meHandle = meA ? href(meA).slice(1) : q('nav a[href^="/"], header a[href^="/"]').map((a) => href(a).match(H)?.[1])
    .find((h) => h && !/^(home|explore|notifications|messages|search|settings|compose|i|jobs|communities|premium|lists|bookmarks)$/i.test(h)) || '';
  const me = meHandle.toLowerCase(), path = location.pathname.replace(/\/$/, ''), p = path.toLowerCase();
  const kind = !me ? 'none' : p === '/' + me || p === `/${me}/with_replies` ? 'profile'
    : /^\/\w+\/status\/\d+\/(likes|retweets)$/.test(p) || p === `/${me}/followers` ? 'list'
    : /^\/\w+\/status\/\d+(\/quotes)?$/.test(p) ? 'status'
    : p === '/notifications' || p === '/notifications/mentions' ? 'notifications' : 'other';
  const main = document.querySelector('main') || document.body;
  const av = (img) => (img?.src || '').replace('https://pbs.twimg.com/profile_images/', '~/');
  const text = (n) => { let s = ''; const w = (x) => { if (x.nodeType === 3) s += x.nodeValue; else if (x.nodeName === 'IMG') s += x.alt || ''; else if (x.nodeName === 'BR') s += '\n'; else x.childNodes.forEach(w); }; if (n) w(n); return s.trim(); };
  const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm万千亿]?)/); return m ? Math.round(m[1] * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, 千: 1e3, 万: 1e4, 亿: 1e8 }[m[2]] || 1)) : 0; };
  const nameIn = (root, hk, sel = 'a[href]') => text(q(sel, root).find((a) => href(a).toLowerCase() === hk && a.innerText.trim() && !a.innerText.trim().startsWith('@'))).split('\n')[0];
  const weekAgo = BigInt(Date.now() - 7 * 864e5 - 1288834974657) << 22n; // post ids carry their timestamp

  // post: [id, handle, name, avatar, likes, reposts, replies, views, pinned, text]
  const tweet = (art) => {
    const own = (sel) => q(sel, art).filter((e) => e.closest('article') === art && !e.closest('[data-slot="embedded-tweet-frame"]'));
    const m = own('a[href*="/status/"]').map((a) => href(a).match(ST)).find(Boolean);
    if (!m) return null;
    const hk = '/' + m[1].toLowerCase(), mine = hk === '/' + me;
    const eng = (k) => num(own(`[data-engagement-action="${k}"], [data-testid="${k}"]`)[0]?.innerText);
    const nameA = own('a[href]').find((a) => href(a).toLowerCase() === hk && a.innerText.trim() && !a.innerText.trim().startsWith('@'));
    return [m[2], m[1], mine ? '' : text(nameA).split('\n')[0], mine ? '' : av(own('a img[src*="profile_images"]').find((i) => href(i.closest('a')).toLowerCase() === hk)),
      Math.max(eng('like'), eng('unlike')), Math.max(eng('retweet'), eng('unretweet')), eng('reply'), num(own('a[href$="/analytics"]')[0]?.innerText),
      /^(Pinned|已置顶|置顶|置頂|固定)/.test(art.innerText.trim()) ? 1 : 0,
      mine && kind === 'profile' ? text(own('[data-testid="tweetText"], div[dir="auto"]')[0]).slice(0, 90) : ''];
  };
  // list person: [handle, name, avatar]
  const cell = (c) => {
    const img = c.querySelector('a[href^="/"] img[src*="profile_images"]');
    const h = img?.alt?.startsWith('@') ? img.alt.slice(1) : href(img?.closest('a')).match(H)?.[1];
    return h ? [h, nameIn(c, '/' + h.toLowerCase()), av(img)] : null;
  };
  // notification row: [message, [[handle, avatar], ...], postId]
  const note = (li) => {
    const ppl = q('a[href^="/"] img[src*="profile_images"]', li).map((img) => [img.alt?.startsWith('@') ? img.alt.slice(1) : href(img.closest('a')).match(H)?.[1], av(img)]).filter((x) => x[0] && x[0].toLowerCase() !== me);
    return ppl.length ? [li.innerText.trim().split('\n').slice(0, 4).join('\n').slice(0, 100), ppl, q('a[href*="/status/"]', li).map((a) => href(a).match(ST)).find(Boolean)?.[2] || ''] : null;
  };

  const seen = { tw: new Map(), cells: new Map(), notes: new Map() };
  let older = 0;
  const grab = () => {
    let n = 0;
    const put = (m, k, v) => { if (!m.has(k)) n++; m.set(k, v); };
    if (kind !== 'list') q('article', main).filter((a) => !a.parentElement.closest('article')).map(tweet).filter(Boolean).forEach((t) => {
      if (!seen.tw.has(t[0]) && kind === 'profile' && t[1].toLowerCase() === me && !t[8] && BigInt(t[0]) < weekAgo) older++;
      put(seen.tw, t[0], t);
    });
    const rows = q('[data-testid="UserCell"], li, article[data-testid="notification"]', main).filter((c) => !c.closest('article') && !c.querySelector('article') && !c.parentElement.closest('li'));
    if (kind === 'list') rows.filter((c) => c.querySelector('img[src*="profile_images"]')).map(cell).filter(Boolean).forEach((c) => put(seen.cells, c[0].toLowerCase(), c));
    if (kind === 'notifications' && !p.endsWith('/mentions')) rows.map(note).filter(Boolean).forEach((r) => put(seen.notes, r[0].slice(0, 40) + '|' + r[2], r));
    return n;
  };
  const result = (scrolled) => {
    const out = { v: 1, path, me: meHandle, now: Date.now(), kind };
    if (kind === 'none' || kind === 'other') return out;
    if (kind === 'profile') {
      const fl = main.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
      out.prof = [text(main.querySelector('h1, [data-testid="UserName"]')).split('\n')[0], av(main.querySelector('a[href$="/photo"] img[src*="profile_images"]')), fl ? num(fl.innerText) : 0];
    }
    // `after` (from collect.mjs): keys already collected; return only what comes after them on the page
    const after = new Set(opts.after || []);
    let found = !after.size;
    const rest = (m) => { const ks = [...m.keys()]; const i = ks.reduce((j, k, n) => (after.has(k) ? n : j), -1); if (i >= 0) found = true; return [...m.values()].slice(i + 1); };
    Object.assign(out, { tw: rest(seen.tw), cells: rest(seen.cells), notes: rest(seen.notes) });
    if (!found) out.lost = 1;
    if (q('button', main).some((b) => /^(Retry|重试|重試|再試行|Réessayer|Reintentar|Erneut versuchen)$/.test(b.innerText.trim()))) out.blocked = 1;
    if (main.querySelector('[role="progressbar"]')) out.loading = 1;
    if (scrolled) out.scrolled = scrolled;
    return out;
  };

  grab();
  if (!opts.scroll || kind === 'none' || kind === 'other') return result(0);
  return (async () => {
    let steps = 0;
    for (let idle = 0; steps < opts.scroll && idle < 3 && older < 3; steps++) {
      window.scrollBy(0, Math.round(innerHeight * 0.85));
      await new Promise((r) => setTimeout(r, 900));
      idle = grab() ? 0 : idle + 1;
    }
    return result(steps || 1);
  })();
})({ scroll: 0 })
