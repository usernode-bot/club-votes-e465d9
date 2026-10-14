const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  // Kept for the members lookup, which calls the platform with the SAME
  // user token this request came with.
  if (typeof token === 'string' && token) req.userToken = token;
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// index: false: the HTML shell must be served by the catch-all below, which
// also seeds the staging demo and answers unauthenticated visits. Letting
// static serve public/index.html for "/" would skip all of that.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Data ────────────────────────────────────────────────────────────────────
// Idempotent schema, applied on boot. user_id/creator_id are text: real
// users are keyed by their platform id, demo ones by names such as
// `demo-priya`.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id serial PRIMARY KEY,
    question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),
    details text CHECK (details IS NULL OR char_length(details) <= 2000),
    creator_id text NOT NULL,
    creator_username text NOT NULL,
    created_at timestamptz NOT NULL,
    closed_at timestamptz,
    result text CHECK (result IN ('passed', 'not_passed', 'tied')),
    demo_for text
  );
  CREATE TABLE IF NOT EXISTS votes (
    decision_id integer NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    username text NOT NULL,
    choice text NOT NULL CHECK (choice IN ('yes', 'no', 'maybe')),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (decision_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id serial PRIMARY KEY,
    decision_id integer NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    author_id text NOT NULL,
    author_username text NOT NULL,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id serial PRIMARY KEY,
    reporter_id text NOT NULL,
    target_kind text NOT NULL CHECK (target_kind IN ('decision', 'comment')),
    target_id integer NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (reporter_id, target_kind, target_id)
  );
  COMMENT ON TABLE reports IS 'staging:private';
`;

// Real responses never read a demo row; demo responses (staging + ?demo=1)
// read only the rows seeded for that viewer. Votes, comments and reports
// follow their decision, so scoping the decision scopes them too.
function demoMode(req) {
  return IS_STAGING && req.query.demo === '1' && !!req.user;
}
function decisionScope(demo, viewer, first) {
  return demo
    ? `demo_for = $${first}`
    : `demo_for IS NULL`;
}

// The club's member list is the platform's ("Members: who is in this
// project"), asked with this request's user token and cached for a minute
// (the endpoint shares its rate limit with /users/*). null = the lookup
// failed or answered 403: the client then hides "not voted" and the empty
// part of the tally bar rather than guessing.
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL
  || '';
const MEMBER_CACHE_MS = 60_000;
const membersCache = new Map();
async function fetchMembers(userToken) {
  if (!PLATFORM_API_BASE || !userToken) return null;
  const hit = membersCache.get(userToken);
  if (hit && Date.now() - hit.at < MEMBER_CACHE_MS) return hit.members;
  let members = null;
  try {
    const resp = await fetch(PLATFORM_API_BASE + '/members', {
      headers: { 'x-usernode-user-token': userToken },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && Array.isArray(data.members)) members = data.members;
    }
  } catch {}
  membersCache.set(userToken, { members, at: Date.now() });
  if (membersCache.size > 500) membersCache.clear();
  return members;
}

// memberCount for a response: a fixed 12 for the demo board, the real
// roster otherwise, null when the lookup is unavailable.
async function memberCount(req, demo) {
  if (demo) return 12;
  if (!req.user || !req.userToken) return null;
  const members = await fetchMembers(req.userToken);
  return members ? members.length : null;
}

// Shared shaping: a decision row plus its counts, my vote, comment count.
function decisionJson(row, counts, commentCount, myVote, memberCount) {
  return {
    id: row.id,
    question: row.question,
    details: row.details,
    creator: { id: row.creator_id, username: row.creator_username },
    createdAt: row.created_at,
    closedAt: row.closed_at,
    result: row.result,
    mine: row.mine,
    myVote: myVote || null,
    counts: counts || { yes: 0, no: 0, maybe: 0 },
    commentCount: commentCount || 0,
    memberCount: memberCount === undefined ? undefined : memberCount,
  };
}
async function voteCounts(decisionId) {
  const { rows } = await pool.query(
    'SELECT choice, count(*)::int AS n FROM votes WHERE decision_id = $1 GROUP BY choice',
    [decisionId]);
  const counts = { yes: 0, no: 0, maybe: 0 };
  for (const r of rows) if (r.choice in counts) counts[r.choice] = r.n;
  return counts;
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/decisions', async (req, res) => {
  const demo = demoMode(req);
  const viewer = req.user ? String(req.user.id) : '';
  try {
    const { rows } = await pool.query(
      `SELECT id, question, details, creator_id, creator_username, created_at,
              closed_at, result, (creator_id = $1) AS mine
       FROM decisions WHERE ${decisionScope(demo, viewer, 1)}
       ORDER BY created_at DESC`,
      // $1 is the viewer either way: `mine` needs it even when the scope
      // (demo_for IS NULL) does not.
      [viewer]);
    const ids = rows.map(r => r.id);
    const countsById = new Map(ids.map(id => [id, { yes: 0, no: 0, maybe: 0 }]));
    const commentsById = new Map(ids.map(id => [id, 0]));
    const myVoteById = new Map();
    if (ids.length) {
      const [vc, cc, mv] = await Promise.all([
        pool.query(
          'SELECT decision_id, choice, count(*)::int AS n FROM votes WHERE decision_id = ANY($1) GROUP BY 1, 2',
          [ids]),
        pool.query(
          'SELECT decision_id, count(*)::int AS n FROM comments WHERE decision_id = ANY($1) GROUP BY 1',
          [ids]),
        viewer
          ? pool.query(
              'SELECT decision_id, choice FROM votes WHERE user_id = $2 AND decision_id = ANY($1)',
              [ids, viewer])
          : Promise.resolve({ rows: [] }),
      ]);
      for (const r of vc.rows) {
        const c = countsById.get(r.decision_id);
        if (c && r.choice in c) c[r.choice] = r.n;
      }
      for (const r of cc.rows) commentsById.set(r.decision_id, r.n);
      for (const r of mv.rows) myVoteById.set(r.decision_id, r.choice);
    }
    const members = await memberCount(req, demo);
    const shape = (r) => decisionJson(
      r, countsById.get(r.id), commentsById.get(r.id), myVoteById.get(r.id), members);
    res.json({
      open: rows.filter(r => !r.closed_at).map(shape),
      closed: rows.filter(r => r.closed_at)
        .sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at))
        .map(shape),
      memberCount: members,
    });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the decisions.' });
  }
});

app.post('/api/decisions', async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  if (!question || question.length > 200) {
    return res.status(400).json({ error: 'Write a question of 1 to 200 characters.' });
  }
  let details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
  if (details.length > 2000) {
    return res.status(400).json({ error: 'Details can be at most 2000 characters.' });
  }
  if (!details) details = null;
  const demo = demoMode(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO decisions (question, details, creator_id, creator_username, created_at, demo_for)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [question, details, String(req.user.id), req.user.username, req.now,
       demo ? String(req.user.id) : null]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'Could not post the decision.' });
  }
});

async function loadDecision(req, res, id) {
  const demo = demoMode(req);
  const viewer = req.user ? String(req.user.id) : '';
  const { rows } = await pool.query(
    `SELECT id, question, details, creator_id, creator_username, created_at,
            closed_at, result, (creator_id = $2) AS mine
     FROM decisions WHERE id = $1 AND ${decisionScope(demo, viewer, 3)}`,
    [id, viewer, ...(demo ? [viewer] : [])]);
  if (!rows.length) {
    res.status(404).json({ error: 'Decision not found.' });
    return null;
  }
  return rows[0];
}

app.get('/api/decisions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Decision not found.' });
  try {
    const row = await loadDecision(req, res, id);
    if (!row) return;
    const demo = demoMode(req);
    const viewer = req.user ? String(req.user.id) : '';
    const [counts, comments, myVote, members] = await Promise.all([
      voteCounts(id),
      pool.query(
        `SELECT c.id, c.author_id, c.author_username, c.body, c.created_at,
                (c.author_id = $2) AS mine, v.choice AS author_vote
         FROM comments c
         LEFT JOIN votes v ON v.decision_id = c.decision_id AND v.user_id = c.author_id
         WHERE c.decision_id = $1
         ORDER BY c.created_at ASC, c.id ASC`,
        [id, viewer]),
      viewer
        ? pool.query('SELECT choice FROM votes WHERE decision_id = $1 AND user_id = $2', [id, viewer])
        : Promise.resolve({ rows: [] }),
      memberCount(req, demo),
    ]);
    res.json({
      ...decisionJson(row, counts, comments.rows.length, myVote.rows[0] && myVote.rows[0].choice, members),
      comments: comments.rows.map(c => ({
        id: c.id,
        author: { id: c.author_id, username: c.author_username },
        body: c.body,
        createdAt: c.created_at,
        mine: c.mine,
        authorVote: c.author_vote || null,
      })),
    });
  } catch (err) {
    console.error('GET /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the decision.' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Decision not found.' });
  const demo = demoMode(req);
  const viewer = String(req.user.id);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM decisions
       WHERE id = $1 AND creator_id = $2 AND ${decisionScope(demo, viewer, 3)}`,
      [id, viewer, ...(demo ? [viewer] : [])]);
    if (!rowCount) return res.status(404).json({ error: 'Decision not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete the decision.' });
  }
});

app.put('/api/decisions/:id/vote', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Decision not found.' });
  const choice = req.body && req.body.choice;
  if (choice !== 'yes' && choice !== 'no' && choice !== 'maybe') {
    return res.status(400).json({ error: 'Vote yes, no or maybe.' });
  }
  const demo = demoMode(req);
  const viewer = String(req.user.id);
  try {
    const row = await loadDecision(req, res, id);
    if (!row) return;
    if (row.closed_at) return res.status(409).json({ error: 'decision_closed' });
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, username, choice, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (decision_id, user_id)
       DO UPDATE SET choice = EXCLUDED.choice, username = EXCLUDED.username, updated_at = EXCLUDED.updated_at`,
      [id, viewer, req.user.username, choice, req.now]);
    const counts = await voteCounts(id);
    res.json(decisionJson(row, counts, null, choice));
  } catch (err) {
    console.error('PUT /api/decisions/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'Could not record the vote.' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Decision not found.' });
  const demo = demoMode(req);
  const viewer = String(req.user.id);
  try {
    const row = await loadDecision(req, res, id);
    if (!row) return;
    if (row.creator_id !== viewer) return res.status(404).json({ error: 'Decision not found.' });
    if (row.closed_at) return res.status(409).json({ error: 'decision_closed' });
    const counts = await voteCounts(id);
    // Simple yes or no, most wins: more yes than no passes, more no than
    // yes does not, equal counts are tied. Maybe never counts.
    const result = counts.yes > counts.no ? 'passed'
      : counts.no > counts.yes ? 'not_passed' : 'tied';
    await pool.query(
      'UPDATE decisions SET closed_at = $2, result = $3 WHERE id = $1',
      [id, req.now, result]);
    row.closed_at = req.now;
    row.result = result;
    res.json(decisionJson(row, counts, null, null));
  } catch (err) {
    console.error('POST /api/decisions/:id/close failed: ' + err.message);
    res.status(500).json({ error: 'Could not close the vote.' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Decision not found.' });
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: 'Write a comment of 1 to 2000 characters.' });
  }
  try {
    const row = await loadDecision(req, res, id);
    if (!row) return;
    const { rows } = await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_username, body, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, String(req.user.id), req.user.username, body, req.now]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /api/decisions/:id/comments failed: ' + err.message);
    res.status(500).json({ error: 'Could not post the comment.' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Comment not found.' });
  const demo = demoMode(req);
  const viewer = String(req.user.id);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM comments
       WHERE id = $1 AND author_id = $2
         AND decision_id IN (SELECT id FROM decisions WHERE ${decisionScope(demo, viewer, 3)})`,
      [id, viewer, ...(demo ? [viewer] : [])]);
    if (!rowCount) return res.status(404).json({ error: 'Comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/comments/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete the comment.' });
  }
});

app.post('/api/reports', async (req, res) => {
  const kind = req.body && req.body.kind;
  const id = Number(req.body && req.body.id);
  if ((kind !== 'decision' && kind !== 'comment')
      || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Report a decision or a comment.' });
  }
  const demo = demoMode(req);
  const viewer = String(req.user.id);
  try {
    // Only someone else's content can be reported.
    if (kind === 'decision') {
      const { rows } = await pool.query(
        `SELECT creator_id FROM decisions
         WHERE id = $1 AND ${decisionScope(demo, viewer, 2)}`,
        [id, ...(demo ? [viewer] : [])]);
      if (!rows.length) return res.status(404).json({ error: 'Decision not found.' });
      if (rows[0].creator_id === viewer) {
        return res.status(400).json({ error: 'You cannot report your own decision.' });
      }
    } else {
      const { rows } = await pool.query(
        `SELECT c.author_id FROM comments c
         JOIN decisions d ON d.id = c.decision_id
         WHERE c.id = $1 AND ${decisionScope(demo, viewer, 2)}`,
        [id, ...(demo ? [viewer] : [])]);
      if (!rows.length) return res.status(404).json({ error: 'Comment not found.' });
      if (rows[0].author_id === viewer) {
        return res.status(400).json({ error: 'You cannot report your own comment.' });
      }
    }
    await pool.query(
      `INSERT INTO reports (reporter_id, target_kind, target_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reporter_id, target_kind, target_id) DO NOTHING`,
      [viewer, kind, id, req.now]);
    res.status(201).json({ reported: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + err.message);
    res.status(500).json({ error: 'Could not record the report.' });
  }
});

// ── Demo (staging preview, ?demo=1 only) ────────────────────────────────────
// A first version's populated demo: the first ?demo=1 request from a viewer
// writes THEIR demo set once, inside a transaction holding an advisory lock
// keyed on them, skipped when their rows already exist. Every route above
// scopes on demo_for the same way, so the controls act on the demo rows.
// Without ?demo=1 nothing is written and demo rows never appear.

const DEMO_MEMBER_NAMES = ['Priya', 'Tom', 'Ana', 'Malik', 'Jo', 'Sam', 'Kim', 'Lee', 'Ruth', 'Nadia', 'Ben'];
const demoId = (name) => 'demo-' + name.toLowerCase();
const H = 3600 * 1000;
const DAY = 24 * H;

const COMMENT_LINES = [
  'Works for me.',
  'I can help set up.',
  'Can we keep it short either way?',
  'The library room books out fast, so we would need to arrive early.',
  'Happy either way, I will follow the group.',
  'That solves the noise problem, the current room echoes.',
  'What do the juniors think? They are the ones there every week.',
  'We tried something like this two years ago and it went fine.',
  'If it costs more than we planned, I am out.',
  'Can we put the exact times in the notes once it is agreed?',
  'I would rather keep things as they are.',
  'Good idea, the club has outgrown the old setup.',
  'Either is fine by me.',
  'Let us decide tonight so people can plan the week.',
  'I will be away that week, but go ahead without me.',
  'Could we ask the venue about parking first?',
  'This matters more than it looks, the clocks slow everything down.',
  'Count me in.',
  'I will miss the first one but I am in from the following week.',
  'Sounds good.',
  'One more thought: whoever opens up should lock up after.',
];

// n comments spread evenly between two moments, oldest first, with authors
// and lines cycling deterministically so each decision reads differently.
function spreadComments(startMs, endMs, n, offset) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      author: DEMO_MEMBER_NAMES[(offset + i) % DEMO_MEMBER_NAMES.length],
      at: startMs + Math.round(((endMs - startMs) * (i + 1)) / (n + 1)),
      body: COMMENT_LINES[(offset * 3 + i) % COMMENT_LINES.length],
    });
  }
  return out;
}

function demoDataSet(now, viewerId, viewerName) {
  const ms = (t) => new Date(t).toISOString();
  // votes: choice → fake member names. The viewer's own vote travels in
  // `viewer` and is stored under their real id, so "You voted yes" works.
  const open = [
    {
      question: 'Move Thursday meetings to the library?',
      details: 'The current room echoes, and the library has space for two boards side by side.',
      creator: 'Priya', created: now - 2 * DAY,
      votes: { yes: ['Priya', 'Tom', 'Ana', 'Jo', 'Sam', 'Kim'], no: ['Lee', 'Ruth'], maybe: ['Nadia'] },
      viewer: 'yes',
      comments: [
        { author: 'Tom', at: now - 47 * H, body: 'The current room echoes, so anywhere quieter is a win.' },
        { author: 'Ana', at: now - 45 * H, body: 'Do we need to book the library room in advance?' },
        { author: 'Priya', at: now - 44 * H, body: 'Yes, I asked. They hold it for us if we arrive by seven.' },
        { author: 'Malik', at: now - 40 * H, body: 'Two boards side by side would fix the waiting list problem.' },
        { author: 'Jo', at: now - 36 * H, body: 'What about the sets? Do we have to carry them over?' },
        { author: 'Priya', at: now - 30 * H, body: 'There is a trolley we can borrow from the desk.' },
        { author: 'Sam', at: now - 26 * H, body: 'Works for me.' },
        { author: 'Kim', at: now - 22 * H, body: 'The lighting in the library is much better too.' },
        { author: 'Lee', at: now - 20 * H, body: 'I would rather stay where we are.' },
        { author: 'Ruth', at: now - 18 * H, body: 'Same, the current room is five minutes from my house.' },
        { author: 'Nadia', at: now - 15 * H, body: 'Either is fine by me.' },
        { author: 'Tom', at: now - 9 * H, body: 'We could try it for a month and then decide properly.' },
        { author: 'Malik', at: now - 5 * H, body: 'Good idea.' },
        { author: 'Ana', at: now - 1 * H, body: "Let us put it to the vote at tonight's meeting." },
      ],
    },
    {
      question: 'Buy two new tournament clocks?',
      details: 'Our two old clocks lose time, and pairs nights need four running at once.',
      creator: 'Tom', created: now - 26 * H,
      votes: { yes: ['Priya', 'Ana', 'Malik', 'Jo'], no: ['Sam'], maybe: ['Kim', 'Lee'] },
      viewer: null,
      comments: [
        { author: 'Priya', at: now - 20 * H, body: 'The ones at the shop by the station are on offer this week.' },
        { author: 'Ana', at: now - 14 * H, body: 'Can we get a third? Pairs nights run four boards.' },
        { author: 'Tom', at: now - 10 * H, body: 'Two now, and a third next season if the funds stretch.' },
        { author: 'Malik', at: now - 6 * H, body: 'Fair enough, that spreads the cost.' },
        { author: 'Jo', at: now - 2 * H, body: 'Count me in.' },
      ],
    },
    {
      question: 'Spring social: picnic or pizza night?',
      details: 'Yes means picnic in Elm Park, no means pizza at the club room. Maybe if you would come to either.',
      creator: null, created: now - 4 * H, // the viewer's own
      votes: { yes: ['Priya', 'Sam', 'Kim'], no: ['Tom', 'Malik'], maybe: ['Ana', 'Nadia'] },
      viewer: 'no',
      comments: [
        { author: 'Priya', at: now - 3 * H, body: 'The park has covered tables now, so rain is not a problem.' },
        { author: 'Tom', at: now - 2 * H, body: 'Pizza means we can still run the blitz boards after.' },
        { author: 'Ana', at: now - 1 * H, body: 'Either works for me if it is on a Saturday.' },
        { author: viewerName, viewer: true, at: now - 20 * 60 * 1000, body: 'Could we do the picnic in June instead, when it is warmer?' },
        { author: 'Sam', at: now - 18 * 60 * 1000, body: 'Count me in, either way.' },
        { author: 'Kim', at: now - 15 * 60 * 1000, body: 'Picnic if the weather holds, pizza if not.' },
        { author: 'Malik', at: now - 12 * 60 * 1000, body: 'June works better for me too.' },
        { author: 'Jo', at: now - 10 * 60 * 1000, body: "Can we settle it at Thursday's meeting?" },
        { author: 'Ruth', at: now - 5 * 60 * 1000, body: 'I will come to whichever we pick.' },
      ],
    },
    {
      question: 'Host a junior open day in May?',
      details: 'An afternoon of quick games for school children, with the older juniors helping run the boards.',
      creator: 'Ana', created: now - 10 * 60 * 1000,
      votes: { yes: ['Priya'] },
      viewer: null,
      comments: [],
    },
  ];
  const closed = [
    {
      question: 'Adopt a club handbook for new members?',
      details: null,
      creator: 'Malik', created: now - 28 * DAY, closed: now - 2 * DAY, result: 'passed',
      votes: { yes: ['Priya', 'Tom', 'Ana', 'Malik', 'Jo', 'Sam', 'Kim', 'Lee'], no: ['Ruth'], maybe: ['Nadia', 'Ben'] },
      viewer: 'yes',
      comments: spreadComments(now - 28 * DAY, now - 3 * DAY, 3, 2),
    },
    {
      question: 'Raise yearly dues to $30?',
      details: null,
      creator: 'Priya', created: now - 21 * DAY, closed: now - 5 * DAY, result: 'passed',
      votes: { yes: ['Priya', 'Tom', 'Ana', 'Malik', 'Jo', 'Sam', 'Kim'], no: ['Lee', 'Ruth', 'Nadia'], maybe: ['Ben'] },
      viewer: 'yes',
      comments: spreadComments(now - 21 * DAY, now - 6 * DAY, 21, 0),
    },
    {
      question: 'Move the club night to Wednesdays?',
      details: null,
      creator: 'Sam', created: now - 42 * DAY, closed: now - 6 * DAY, result: 'not_passed',
      votes: { yes: ['Sam'], no: ['Priya', 'Tom', 'Ana', 'Malik', 'Jo', 'Kim', 'Lee', 'Ruth'], maybe: ['Ben'] },
      viewer: 'no',
      comments: spreadComments(now - 42 * DAY, now - 7 * DAY, 2, 5),
    },
    {
      question: 'Switch to Sunday afternoons?',
      details: null,
      creator: 'Tom', created: now - 35 * DAY, closed: now - 9 * DAY, result: 'not_passed',
      votes: { yes: ['Tom', 'Kim'], no: ['Priya', 'Ana', 'Malik', 'Jo', 'Sam', 'Lee', 'Ruth'], maybe: ['Nadia'] },
      viewer: 'no',
      comments: spreadComments(now - 35 * DAY, now - 10 * DAY, 8, 1),
    },
    {
      question: 'Buy a demo board for the juniors?',
      details: null,
      creator: 'Jo', created: now - 49 * DAY, closed: now - 14 * DAY, result: 'passed',
      votes: { yes: ['Priya', 'Ana', 'Malik', 'Jo', 'Kim'], no: ['Tom', 'Ruth'], maybe: ['Sam', 'Lee', 'Ben'] },
      viewer: 'yes',
      comments: spreadComments(now - 49 * DAY, now - 15 * DAY, 5, 4),
    },
    {
      question: 'New club logo: knight or rook?',
      details: null,
      creator: 'Ana', created: now - 60 * DAY, closed: now - 21 * DAY, result: 'tied',
      votes: { yes: ['Priya', 'Malik', 'Kim', 'Ben'], no: ['Tom', 'Ana', 'Jo', 'Sam', 'Ruth'], maybe: ['Lee'] },
      viewer: 'yes',
      comments: spreadComments(now - 60 * DAY, now - 22 * DAY, 11, 7),
    },
  ];
  const shape = (d) => ({
    question: d.question,
    details: d.details,
    creatorId: d.creator ? demoId(d.creator) : viewerId,
    creatorName: d.creator || viewerName,
    createdAt: ms(d.created),
    closedAt: d.closed ? ms(d.closed) : null,
    result: d.result || null,
    votes: d.votes || {},
    viewerVote: d.viewer,
    comments: d.comments.map(c => ({
      authorId: c.viewer ? viewerId : demoId(c.author),
      authorName: c.viewer ? viewerName : c.author,
      body: c.body,
      at: ms(c.at),
    })),
  });
  return { decisions: open.map(shape).concat(closed.map(shape)) };
}

async function ensureDemo(viewerId, viewerName, now) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('club-votes-demo:' || $1))",
      [String(viewerId)]);
    const existing = await client.query(
      'SELECT 1 FROM decisions WHERE demo_for = $1 LIMIT 1', [String(viewerId)]);
    if (existing.rowCount === 0) {
      for (const d of demoDataSet(now, viewerId, viewerName).decisions) {
        const { rows } = await client.query(
          `INSERT INTO decisions
             (question, details, creator_id, creator_username, created_at, closed_at, result, demo_for)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [d.question, d.details, d.creatorId, d.creatorName, d.createdAt,
           d.closedAt, d.result, String(viewerId)]);
        const decId = rows[0].id;
        for (const [choice, names] of Object.entries(d.votes)) {
          for (const name of names) {
            await client.query(
              `INSERT INTO votes (decision_id, user_id, username, choice, updated_at)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
              [decId, demoId(name), name, choice, d.createdAt]);
          }
        }
        if (d.viewerVote) {
          await client.query(
            `INSERT INTO votes (decision_id, user_id, username, choice, updated_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [decId, String(viewerId), viewerName, d.viewerVote, d.createdAt]);
        }
        for (const c of d.comments) {
          await client.query(
            `INSERT INTO comments (decision_id, author_id, author_username, body, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [decId, c.authorId, c.authorName, c.body, c.at]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', async (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes-e465d9/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes-e465d9/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  // The demo board is seeded per viewer on their first ?demo=1 load (and
  // any other demo=1 request keeps it current), staging only.
  if (req.user && IS_STAGING && req.query.demo === '1') {
    try {
      await ensureDemo(String(req.user.id), req.user.username, req.now);
    } catch (err) {
      console.error('demo seeding failed: ' + err.message);
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(SCHEMA);
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting, drain about 3 s, close the pool, exit.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => {});
    setTimeout(() => {
      pool.end().then(() => process.exit(0), () => process.exit(0));
    }, 3000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
