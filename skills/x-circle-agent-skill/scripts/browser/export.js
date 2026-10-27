// x-circle export. Aggregates what collect.js gathered into the compact data.json that
// render.mjs reads: only the people who will be drawn, plus totals and timestamps.
// Save the returned string to data.json unchanged.
(() => {
  const WEIGHT = { like: 1, repost: 2, mention: 2, reply: 3, quote: 3 };
  const TYPES = ['like', 'repost', 'reply', 'quote', 'mention'];
  const SHOWN = 52, HALO = 24; // must match the ring sizes in render.mjs
  let S = null;
  try { S = JSON.parse(localStorage.getItem('xcircle:v1')); } catch (e) {}
  if (!S) return JSON.stringify({ ok: false, error: 'Nothing collected yet. Run collect.js first.' });

  const sec = (iso) => Math.round(Date.parse(iso) / 1000);
  const startMs = Date.parse(S.start);
  const posts = Object.values(S.posts).filter((p) => Date.parse(p.time) >= startMs);
  const postTime = Object.fromEntries(posts.map((p) => [p.id, p.time]));
  const score = (p) => (p.likes || 0) + 2 * (p.reposts || 0) + 3 * (p.replies || 0);
  const ranked = [...posts].sort((a, b) => score(b) - score(a));
  const topId = ranked[0]?.id;

  const agg = {};
  for (const it of Object.values(S.interactions)) {
    if (!(it.t in WEIGHT)) continue;
    if (it.at && Date.parse(it.at) < startMs) continue;
    const a = agg[it.u] || (agg[it.u] = { c: [0, 0, 0, 0, 0], s: 0, f: null, tp: 0 });
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
  const quietNew = Object.keys(S.follows).filter((k) => !agg[k]);
  const fans = interactors.filter(([, a]) => a.tp);
  const people = [
    ...interactors.slice(0, SHOWN).map(([k, a]) => person(k, a)),
    ...fans.slice(0, 7).filter(([k]) => !interactors.slice(0, SHOWN).some(([k2]) => k2 === k)).map(([k, a]) => person(k, a)),
    ...quietNew.slice(0, HALO).map((k) => person(k, null)),
  ];

  const followTotal = Object.values(S.followGroups || {}).reduce((a, b) => a + b, 0);
  return JSON.stringify({
    v: 2,
    start: S.start, end: S.end, tz: S.tz,
    me: S.me,
    posts: ranked.map((p, i) => Object.assign({ id: p.id, t: sec(p.time), l: p.likes || 0, r: p.reposts || 0, c: p.replies || 0 }, i < 3 ? { x: (p.text || '').slice(0, 90) } : {})),
    myTimes: [...posts.map((p) => p.time), ...Object.values(S.myReplies).map((r) => r.time)].filter((t) => Date.parse(t) >= startMs).map(sec),
    circleTimes: Object.values(S.interactions).filter((it) => it.at && Date.parse(it.at) >= startMs).map((it) => sec(it.at)),
    people,
    totals: {
      interactors: interactors.length,
      quietNew: quietNew.length,
      newFollowers: Math.max(followTotal, Object.keys(S.follows).length),
      topPostFans: fans.length,
    },
    notificationsReachBack: S.notifOldest || null,
  });
})()
