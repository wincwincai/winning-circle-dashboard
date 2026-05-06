require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { initDatabase, getDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Authentication Config
// ---------------------------------------------------------------------------
if (IS_PROD) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production.');
  }
  if (!process.env.TEAM_ACCESS_CODE) {
    throw new Error('TEAM_ACCESS_CODE must be set in production.');
  }
} else {
  if (!process.env.JWT_SECRET) console.warn('[WARN] JWT_SECRET not set — using insecure dev default.');
  if (!process.env.TEAM_ACCESS_CODE) console.warn('[WARN] TEAM_ACCESS_CODE not set — using insecure dev default.');
}

const TEAM_ACCESS_CODE = process.env.TEAM_ACCESS_CODE || 'winningcircle-dev';
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || null;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-CHANGE-IN-PRODUCTION';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Async route wrapper
// ---------------------------------------------------------------------------
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------
const TITLE_MAX = 200;
const TEXT_MAX = 5000;
const ALLOWED_STATUS = ['todo', 'in_progress', 'review', 'done'];
const ALLOWED_PRIORITY = ['low', 'medium', 'high', 'urgent'];
// Done tasks completed more than this many days ago are hidden from the
// main /api/tasks board response. They remain visible on /api/tasks/archive.
const DONE_HIDE_DAYS = parseInt(process.env.DASHBOARD_DONE_HIDE_DAYS, 10) || 7;

// Standard SELECT used everywhere we return a task — joins assignee + reviewer
// rows so the client always has names/colors for both.
const TASK_SELECT = `
  SELECT t.*,
    m.name  AS member_name,   m.avatar_color  AS avatar_color,
    rv.name AS reviewer_name, rv.avatar_color AS reviewer_avatar_color
  FROM tasks t
  LEFT JOIN members m  ON t.member_id   = m.id
  LEFT JOIN members rv ON t.reviewer_id = rv.id
`;

function isStr(v) { return typeof v === 'string'; }
function isOptStr(v) { return v === undefined || v === null || typeof v === 'string'; }
function isPosInt(v) { return Number.isInteger(v) && v > 0; }
function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Middleware (skip JSON body parsing for /slack/ — Bolt handles its own)
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
    },
  },
}));
app.use(cors({ credentials: true, origin: BASE_URL }));
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/slack/')) return next();
  express.json()(req, res, next);
});
app.use(cookieParser());

// Ensure DB is ready before handling requests (skip for /slack/)
app.use(async (req, res, next) => {
  if (req.originalUrl.startsWith('/slack/')) return next();
  try {
    await initDatabase();
    next();
  } catch (e) {
    console.error('DB init error:', e);
    res.status(500).json({ error: 'Database unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function isApiRequest(req) {
  // app.use('/api') strips the prefix from req.path, so we must check req.originalUrl
  return req.originalUrl.startsWith('/api/') || req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json'));
}

function requireAuth(req, res, next) {
  const token = req.cookies?.wc_token;
  if (!token) {
    console.log('[Auth] Missing token for request to:', req.path);
    if (isApiRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login?reason=session_expired');
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Force re-login if JWT is from before ownership update (missing member_id)
    if (!req.user.member_id) {
      res.clearCookie('wc_token');
      if (isApiRequest(req)) return res.status(401).json({ error: 'Please log in again.' });
      return res.redirect('/login?reason=session_expired');
    }
    next();
  } catch (err) {
    console.log('[Auth] JWT Verify failed:', err.message);
    res.clearCookie('wc_token');
    if (isApiRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login?reason=session_expired');
  }
}

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/login', (req, res) => {
  res.redirect('/login');
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const perNameAttempts = new Map();
const PER_NAME_WINDOW_MS = 15 * 60 * 1000;
const PER_NAME_MAX = 5;
function checkPerName(name) {
  const key = name.trim().toLowerCase();
  const now = Date.now();
  const entry = perNameAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    perNameAttempts.set(key, { count: 1, resetAt: now + PER_NAME_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= PER_NAME_MAX;
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{7,11}$/;

app.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const { name, accessCode, slackId } = req.body || {};
  if (!isStr(name) || !isStr(accessCode) || !name.trim() || !accessCode) {
    return res.status(400).json({ error: 'Name and Access Code are required.' });
  }
  if (name.length > 200) {
    return res.status(400).json({ error: 'Name too long.' });
  }
  if (slackId !== undefined && slackId !== null && slackId !== '' && (!isStr(slackId) || !SLACK_ID_RE.test(slackId.trim()))) {
    return res.status(400).json({ error: 'Slack ID must look like U01ABC23DEF (starts with U or W, 8–12 chars, A–Z 0–9).' });
  }
  const cleanSlackId = isStr(slackId) ? slackId.trim() : '';
  if (!checkPerName(name)) {
    return res.status(429).json({ error: 'Too many login attempts for this name. Try again later.' });
  }

  const isAdminLogin = !!(ADMIN_ACCESS_CODE && accessCode === ADMIN_ACCESS_CODE);
  const isTeamLogin  = accessCode === TEAM_ACCESS_CODE;
  if (!isAdminLogin && !isTeamLogin) {
    return res.status(401).json({ error: 'Invalid access code.' });
  }

  await initDatabase();
  const db = getDB();
  const allMembers = await db.all('SELECT * FROM members');
  const trimmedName = name.trim();
  let member = allMembers.find(m =>
    m.name.localeCompare(trimmedName, undefined, { sensitivity: 'accent' }) === 0
  );

  if (!member) {
    if (!cleanSlackId) {
      return res.status(400).json({ error: 'Slack ID is required to register. Find yours in Slack → Profile → ⋯ → Copy member ID.' });
    }
    const conflict = allMembers.find(m => m.slack_id === cleanSlackId);
    if (conflict) {
      return res.status(409).json({ error: `Slack ID already registered to "${conflict.name}".` });
    }
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4'];
    const color = colors[allMembers.length % colors.length];
    const info = await db.run(
      'INSERT INTO members (name, slack_id, avatar_color, is_admin) VALUES (?, ?, ?, ?)',
      [trimmedName, cleanSlackId, color, isAdminLogin ? 1 : 0]
    );
    member = await db.get('SELECT * FROM members WHERE id = ?', [info.lastInsertRowid]);
  } else {
    if (cleanSlackId) {
      if (member.slack_id && member.slack_id !== cleanSlackId) {
        return res.status(409).json({ error: 'This name is already linked to a different Slack ID. Contact an admin.' });
      }
      if (!member.slack_id) {
        const conflict = allMembers.find(m => m.id !== member.id && m.slack_id === cleanSlackId);
        if (conflict) {
          return res.status(409).json({ error: `Slack ID already registered to "${conflict.name}".` });
        }
        await db.run('UPDATE members SET slack_id = ? WHERE id = ?', [cleanSlackId, member.id]);
        member.slack_id = cleanSlackId;
      }
    }
    if (isAdminLogin && !member.is_admin) {
      await db.run('UPDATE members SET is_admin = 1 WHERE id = ?', [member.id]);
      member.is_admin = 1;
    }
  }

  // is_admin on the JWT is ONLY true when the admin code was used for THIS login.
  // Team-code logins never elevate, regardless of stored DB flag.
  const tokenIsAdmin = isAdminLogin === true;

  const token = jwt.sign(
    { name: member.name, member_id: member.id, is_admin: tokenIsAdmin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('wc_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({ success: true });
}));

app.get('/auth/logout', (req, res) => {
  res.clearCookie('wc_token');
  res.redirect('/login?reason=logged_out');
});

// ---------------------------------------------------------------------------
// Protected page routes — MUST be before express.static so index.html
// and board.html go through auth instead of being served raw
// ---------------------------------------------------------------------------
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/board', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/archive', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// ---------------------------------------------------------------------------
// Protect all /api/* routes
// ---------------------------------------------------------------------------
app.use('/api', requireAuth);

// ---------------------------------------------------------------------------
// API — Me (current user from JWT)
// ---------------------------------------------------------------------------
app.get('/api/me', wrap(async (req, res) => {
  const db = getDB();
  const member = await db.get('SELECT * FROM members WHERE id = ?', [req.user.member_id]);
  res.json({
    name: req.user.name,
    member_id: req.user.member_id,
    is_admin: !!(req.user.is_admin && member && member.is_admin),
    avatar_color: member?.avatar_color || '#6366f1',
  });
}));

// ---------------------------------------------------------------------------
// Admin middleware — verifies BOTH the JWT claim and the live DB flag.
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  (async () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required.' });
    const db = getDB();
    const member = await db.get('SELECT is_admin FROM members WHERE id = ?', [req.user.member_id]);
    if (!member || !member.is_admin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  })().catch(next);
}

// ---------------------------------------------------------------------------
// Admin API — Members
// ---------------------------------------------------------------------------
app.get('/api/admin/members', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const members = await db.all(`
    SELECT m.*,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END) as active_tasks,
      SUM(CASE WHEN t.status = 'done'  THEN 1 ELSE 0 END) as done_tasks
    FROM members m LEFT JOIN tasks t ON m.id = t.member_id
    GROUP BY m.id ORDER BY m.name
  `);
  res.json(members);
}));

app.put('/api/admin/members/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const { name, slack_id, avatar_color, is_admin } = req.body;
  await db.run(
    `UPDATE members SET
      name         = COALESCE(?, name),
      slack_id     = ?,
      avatar_color = COALESCE(?, avatar_color),
      is_admin     = COALESCE(?, is_admin)
    WHERE id = ?`,
    [name || null, slack_id !== undefined ? (slack_id || null) : undefined,
     avatar_color || null, is_admin !== undefined ? (is_admin ? 1 : 0) : null, id]
  );
  res.json(await db.get('SELECT * FROM members WHERE id = ?', [id]));
}));

app.delete('/api/admin/members/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  if (id === req.user.member_id) return res.status(400).json({ error: "Can't delete your own account." });
  await db.run('DELETE FROM members WHERE id = ?', [id]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Admin API — Tasks (full access, no ownership filter)
// ---------------------------------------------------------------------------
app.get('/api/admin/tasks', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const { status, member_id } = req.query;
  let sql = TASK_SELECT + ' WHERE 1=1';
  const params = [];
  if (status)    { sql += ' AND t.status = ?';    params.push(status); }
  if (member_id) { sql += ' AND t.member_id = ?'; params.push(parseInt(member_id)); }
  sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC`;
  res.json(await db.all(sql, params));
}));

app.put('/api/admin/tasks/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const taskId = parseInt(req.params.id);
  const existing = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  const { title, description, status, priority, member_id, due_date } = req.body;
  const newStatus = status || existing.status;
  const completedAt = newStatus === 'done' && existing.status !== 'done'
    ? new Date().toISOString() : existing.completed_at;
  await db.run(`UPDATE tasks SET
    title = COALESCE(?, title), description = COALESCE(?, description),
    status = COALESCE(?, status), priority = COALESCE(?, priority),
    member_id = COALESCE(?, member_id), due_date = COALESCE(?, due_date),
    completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [title||null, description||null, status||null, priority||null,
     member_id||null, due_date||null, completedAt, taskId]);
  if (status && status !== existing.status) {
    await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
      [taskId, existing.member_id, 'status_change', `Status: ${existing.status} → ${status} (admin)`]);
  }
  res.json(await db.get(TASK_SELECT + ' WHERE t.id = ?', [taskId]));
}));

app.delete('/api/admin/tasks/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  await db.run('DELETE FROM tasks WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// API — Members
// ---------------------------------------------------------------------------
app.get('/api/members', wrap(async (req, res) => {
  const db = getDB();
  res.json(await db.all('SELECT * FROM members ORDER BY name'));
}));

app.post('/api/members', requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const { name, slack_id, avatar_color } = req.body || {};
  if (!isStr(name) || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long' });
  if (!isOptStr(slack_id) || !isOptStr(avatar_color)) return res.status(400).json({ error: 'Invalid input' });
  const info = await db.run(
    'INSERT INTO members (name, slack_id, avatar_color) VALUES (?, ?, ?)',
    [name.trim(), slack_id || null, avatar_color || '#6366f1']
  );
  res.status(201).json(await db.get('SELECT * FROM members WHERE id = ?', [info.lastInsertRowid]));
}));

app.put('/api/members/:id', requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  const { name, slack_id, avatar_color } = req.body || {};
  if (!isOptStr(name) || !isOptStr(slack_id) || !isOptStr(avatar_color)) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  if (isStr(name) && name.length > 200) return res.status(400).json({ error: 'Name too long' });
  await db.run(
    'UPDATE members SET name = COALESCE(?, name), slack_id = COALESCE(?, slack_id), avatar_color = COALESCE(?, avatar_color) WHERE id = ?',
    [name || null, slack_id || null, avatar_color || null, parseInt(req.params.id)]
  );
  res.json(await db.get('SELECT * FROM members WHERE id = ?', [parseInt(req.params.id)]));
}));

app.delete('/api/members/:id', requireAdmin, wrap(async (req, res) => {
  const db = getDB();
  await db.run('DELETE FROM members WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// API — Tasks
// ---------------------------------------------------------------------------
app.get('/api/tasks', wrap(async (req, res) => {
  const db = getDB();
  const { status, member_id, include_archived } = req.query;
  let sql = TASK_SELECT + ' WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (member_id) { sql += ' AND t.member_id = ?'; params.push(parseInt(member_id)); }
  // Hide done tasks older than DONE_HIDE_DAYS unless caller opts in.
  // Tasks without a completed_at timestamp are kept (legacy data).
  if (include_archived !== 'true' && include_archived !== '1') {
    sql += ` AND NOT (t.status = 'done' AND t.completed_at IS NOT NULL
             AND t.completed_at < datetime('now', ?))`;
    params.push(`-${DONE_HIDE_DAYS} days`);
  }
  sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC`;
  res.json(await db.all(sql, params));
}));

// Archive: completed tasks with filters (assignee, date range, free-text search).
// Supports CSV export via ?format=csv.
app.get('/api/tasks/archive', wrap(async (req, res) => {
  const db = getDB();
  const { member_id, date_from, date_to, q, format } = req.query;
  let sql = TASK_SELECT + " WHERE t.status = 'done'";
  const params = [];
  if (member_id) { sql += ' AND t.member_id = ?'; params.push(parseInt(member_id)); }
  if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
    sql += ' AND t.completed_at >= ?'; params.push(date_from);
  }
  if (date_to && /^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    // make end-date inclusive — completed_at < (date_to + 1 day)
    sql += " AND t.completed_at < datetime(?, '+1 day')"; params.push(date_to);
  }
  if (q && typeof q === 'string' && q.trim()) {
    sql += ' AND (t.title LIKE ? OR t.description LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  sql += ' ORDER BY t.completed_at DESC';
  const rows = await db.all(sql, params);

  if (format === 'csv') {
    const escape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const header = ['id', 'title', 'description', 'priority', 'assignee', 'reviewer', 'completed_at', 'created_at'].join(',');
    const lines = rows.map(r => [
      r.id, r.title, r.description, r.priority,
      r.member_name || '', r.reviewer_name || '',
      r.completed_at || '', r.created_at || ''
    ].map(escape).join(','));
    const csv = [header, ...lines].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="archive-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.send(csv);
  }
  res.json(rows);
}));

app.post('/api/tasks', wrap(async (req, res) => {
  const db = getDB();
  const { title, description, status, priority, due_date, reviewer_id } = req.body || {};
  if (!isStr(title) || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (title.length > TITLE_MAX) return res.status(400).json({ error: `Title must be <= ${TITLE_MAX} chars` });
  if (description !== undefined && description !== null) {
    if (!isStr(description)) return res.status(400).json({ error: 'Invalid description' });
    if (description.length > TEXT_MAX) return res.status(400).json({ error: `Description must be <= ${TEXT_MAX} chars` });
  }
  if (status !== undefined && status !== null && !ALLOWED_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (priority !== undefined && priority !== null && !ALLOWED_PRIORITY.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (due_date !== undefined && due_date !== null && !isStr(due_date)) {
    return res.status(400).json({ error: 'Invalid due_date' });
  }
  const reviewerIdInt = toIntOrNull(reviewer_id);
  if (reviewer_id !== undefined && reviewer_id !== null && reviewer_id !== '' && reviewerIdInt === null) {
    return res.status(400).json({ error: 'Invalid reviewer_id' });
  }
  if (reviewerIdInt !== null) {
    const exists = await db.get('SELECT id FROM members WHERE id = ?', [reviewerIdInt]);
    if (!exists) return res.status(400).json({ error: 'Reviewer not found' });
  }
  // Creating directly into review status requires a reviewer
  if (status === 'review' && reviewerIdInt === null) {
    return res.status(400).json({ error: 'A reviewer is required when status is "review".' });
  }
  const memberId = req.user.member_id;
  const info = await db.run(
    'INSERT INTO tasks (title, description, status, priority, member_id, due_date, reviewer_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description || '', status || 'todo', priority || 'medium', memberId, due_date || null, reviewerIdInt]
  );
  await db.run(
    'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
    [info.lastInsertRowid, memberId, 'created', `Task "${title}" created`]
  );
  if (reviewerIdInt) notifyReviewer(reviewerIdInt, info.lastInsertRowid, memberId);
  res.status(201).json(await db.get(TASK_SELECT + ' WHERE t.id = ?', [info.lastInsertRowid]));
}));

// Hook the Slack bot can populate to DM the reviewer when assigned.
// No-op until slack-bot.js wires it via app.locals.notifyReviewer.
function notifyReviewer(reviewerId, taskId, assignerId) {
  try {
    const fn = app.locals.notifyReviewer;
    if (typeof fn === 'function') fn(reviewerId, taskId, assignerId);
  } catch (e) {
    console.error('notifyReviewer error:', e.message);
  }
}

app.put('/api/tasks/:id', wrap(async (req, res) => {
  const db = getDB();
  const taskId = parseInt(req.params.id);
  const existing = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const userId  = req.user.member_id;
  const isAdmin = !!req.user.is_admin;
  const isAssignee = existing.member_id === userId;
  const isReviewer = existing.reviewer_id === userId;

  // Permission gate:
  // - Assignee can edit their own task (any field)
  // - Admin can edit anything
  // - Reviewer can ONLY change status while the task is currently in 'review'
  //   (their job is to approve/reject — not edit content)
  const onlyStatusChange = Object.keys(req.body || {}).every(k => k === 'status');
  const reviewerOk = isReviewer && existing.status === 'review' && onlyStatusChange;
  if (!isAssignee && !isAdmin && !reviewerOk) {
    return res.status(403).json({ error: 'You can only edit your own tasks.' });
  }

  const { title, description, status, priority, due_date, reviewer_id } = req.body || {};
  if (title !== undefined && title !== null) {
    if (!isStr(title) || !title.trim()) return res.status(400).json({ error: 'Invalid title' });
    if (title.length > TITLE_MAX) return res.status(400).json({ error: `Title must be <= ${TITLE_MAX} chars` });
  }
  if (description !== undefined && description !== null) {
    if (!isStr(description)) return res.status(400).json({ error: 'Invalid description' });
    if (description.length > TEXT_MAX) return res.status(400).json({ error: `Description must be <= ${TEXT_MAX} chars` });
  }
  if (status !== undefined && status !== null && !ALLOWED_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (priority !== undefined && priority !== null && !ALLOWED_PRIORITY.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (due_date !== undefined && due_date !== null && !isStr(due_date)) {
    return res.status(400).json({ error: 'Invalid due_date' });
  }

  // reviewer_id handling — accept null/empty to clear, integer to set
  let reviewerIdProvided = reviewer_id !== undefined;
  let reviewerIdNew = existing.reviewer_id;
  if (reviewerIdProvided) {
    if (reviewer_id === null || reviewer_id === '') {
      reviewerIdNew = null;
    } else {
      const r = toIntOrNull(reviewer_id);
      if (r === null) return res.status(400).json({ error: 'Invalid reviewer_id' });
      const exists = await db.get('SELECT id FROM members WHERE id = ?', [r]);
      if (!exists) return res.status(400).json({ error: 'Reviewer not found' });
      reviewerIdNew = r;
    }
  }

  const newStatus = status || existing.status;

  // Status transition rules
  if (newStatus === 'review' && !reviewerIdNew) {
    return res.status(400).json({ error: 'A reviewer is required when status is "review".' });
  }
  // Moving from review→done: only assignee, the assigned reviewer, or admin
  if (existing.status === 'review' && newStatus === 'done') {
    const allowed = isAssignee || isReviewer || isAdmin;
    if (!allowed) {
      return res.status(403).json({ error: 'Only the assignee, the assigned reviewer, or an admin can mark a review as done.' });
    }
  }

  const completedAt = newStatus === 'done' && existing.status !== 'done'
    ? new Date().toISOString() : existing.completed_at;

  await db.run(`UPDATE tasks SET
    title = COALESCE(?, title),
    description = COALESCE(?, description),
    status = COALESCE(?, status),
    priority = COALESCE(?, priority),
    due_date = COALESCE(?, due_date),
    reviewer_id = ?,
    completed_at = ?,
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [title || null, description || null, status || null, priority || null,
     due_date || null, reviewerIdNew, completedAt, taskId]
  );

  if (status && status !== existing.status) {
    await db.run(
      'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
      [taskId, userId, 'status_change', `Status: ${existing.status} → ${status}`]
    );
  }
  // DM the reviewer if newly assigned (not on no-op re-assignments)
  if (reviewerIdProvided && reviewerIdNew && reviewerIdNew !== existing.reviewer_id) {
    notifyReviewer(reviewerIdNew, taskId, userId);
  }

  res.json(await db.get(TASK_SELECT + ' WHERE t.id = ?', [taskId]));
}));

app.delete('/api/tasks/:id', wrap(async (req, res) => {
  const db = getDB();
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [parseInt(req.params.id)]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // Allow deleting your own tasks OR orphaned tasks (member was deleted)
  const taskOwner = await db.get('SELECT * FROM members WHERE id = ?', [task.member_id]);
  if (task.member_id !== req.user.member_id && taskOwner) {
    return res.status(403).json({ error: 'You can only delete your own tasks.' });
  }
  await db.run('DELETE FROM tasks WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// API — Dashboard Stats
// ---------------------------------------------------------------------------
app.get('/api/stats', wrap(async (req, res) => {
  const db = getDB();
  const tasksByStatus = await db.all('SELECT status, COUNT(*) as count FROM tasks GROUP BY status');
  const tasksByMember = await db.all(`
    SELECT m.name, m.avatar_color,
      SUM(CASE WHEN t.status = 'todo'        THEN 1 ELSE 0 END) as todo,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status = 'review'      THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN t.status = 'done'        THEN 1 ELSE 0 END) as done,
      COUNT(t.id) as total
    FROM members m LEFT JOIN tasks t ON m.id = t.member_id
    GROUP BY m.id ORDER BY m.name
  `);
  const recentActivity = await db.all(`
    SELECT a.*, t.title as task_title, m.name as member_name
    FROM activity_log a
    LEFT JOIN tasks t ON a.task_id = t.id
    LEFT JOIN members m ON a.member_id = m.id
    ORDER BY a.created_at DESC LIMIT 20
  `);
  const completedToday = await db.get("SELECT COUNT(*) as count FROM tasks WHERE completed_at >= date('now')");

  res.json({ tasksByStatus, tasksByMember, recentActivity, completedToday: completedToday?.count || 0 });
}));

// ---------------------------------------------------------------------------
// API — Daily Updates
// ---------------------------------------------------------------------------
app.get('/api/daily-updates', wrap(async (req, res) => {
  const db = getDB();
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  res.json(await db.all(`
    SELECT d.*, m.name as member_name, m.avatar_color
    FROM daily_updates d JOIN members m ON d.member_id = m.id
    WHERE d.date = ? ORDER BY m.name
  `, [targetDate]));
}));

app.post('/api/daily-updates', wrap(async (req, res) => {
  const db = getDB();
  const { done_summary, working_on_summary, blockers } = req.body || {};
  for (const [field, val] of [['done_summary', done_summary], ['working_on_summary', working_on_summary], ['blockers', blockers]]) {
    if (val === undefined || val === null) continue;
    if (!isStr(val)) return res.status(400).json({ error: `Invalid ${field}` });
    if (val.length > TEXT_MAX) return res.status(400).json({ error: `${field} must be <= ${TEXT_MAX} chars` });
  }
  const date = new Date().toISOString().split('T')[0];
  await db.run(`INSERT OR REPLACE INTO daily_updates (member_id, date, done_summary, working_on_summary, blockers)
    VALUES (?, ?, ?, ?, ?)`,
    [req.user.member_id, date, done_summary || null, working_on_summary || null, blockers || null]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// API — Activity Log
// ---------------------------------------------------------------------------
app.get('/api/activity', wrap(async (req, res) => {
  const db = getDB();
  const limit = parseInt(req.query.limit) || 50;
  res.json(await db.all(`
    SELECT a.*, t.title as task_title, m.name as member_name, m.avatar_color
    FROM activity_log a
    LEFT JOIN tasks t ON a.task_id = t.id
    LEFT JOIN members m ON a.member_id = m.id
    ORDER BY a.created_at DESC LIMIT ?
  `, [limit]));
}));

// ---------------------------------------------------------------------------
// Static assets — CSS, JS, images, etc. (no index.html since / is handled above)
// exclude HTML files from static serving so they go through auth routes
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  index: false  // Prevent express.static from auto-serving index.html for /
}));

// ---------------------------------------------------------------------------
// SPA catch-all — protected (any other route serves the dashboard)
// ---------------------------------------------------------------------------
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start (only when run directly, not when imported by Vercel)
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    await initDatabase();

    // Slack Integration (loaded conditionally)
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
      const { initSlackBot } = require('./slack-bot');
      initSlackBot(app, getDB());
      console.log('Slack bot integration enabled');
    } else {
      console.log('Slack integration disabled (set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env)');
    }

    app.listen(PORT, () => {
      console.log(`\nWinning Circle Dashboard running at http://localhost:${PORT}`);
    });
  })();
}

// Export for Vercel serverless
module.exports = app;
