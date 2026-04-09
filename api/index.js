require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { initDatabase, getDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Authentication Config
// ---------------------------------------------------------------------------
const TEAM_ACCESS_CODE = process.env.TEAM_ACCESS_CODE || 'winningcircle-dev';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-CHANGE-IN-PRODUCTION';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ credentials: true, origin: BASE_URL }));
app.use(express.json());
app.use(cookieParser());

// Ensure DB is ready before handling requests
app.use(async (req, res, next) => {
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

app.post('/auth/login', (req, res) => {
  const { name, accessCode } = req.body;
  if (!name || !accessCode) {
    return res.status(400).json({ error: 'Name and Access Code are required.' });
  }

  if (accessCode !== TEAM_ACCESS_CODE) {
    return res.status(401).json({ error: 'Invalid access code.' });
  }

  // Issue JWT
  const token = jwt.sign(
    { name: name.trim() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('wc_token', token, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.json({ success: true });
});

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

// ---------------------------------------------------------------------------
// Protect all /api/* routes
// ---------------------------------------------------------------------------
app.use('/api', requireAuth);

// ---------------------------------------------------------------------------
// API — Me (current user from JWT)
// ---------------------------------------------------------------------------
app.get('/api/me', (req, res) => {
  res.json({
    name: req.user.name,
    email: `${req.user.name.split(' ')[0].toLowerCase()}@winningcircle.io` // Fallback for avatar matching
  });
});

// ---------------------------------------------------------------------------
// API — Members
// ---------------------------------------------------------------------------
app.get('/api/members', async (req, res) => {
  const db = getDB();
  res.json(await db.all('SELECT * FROM members ORDER BY name'));
});

app.post('/api/members', async (req, res) => {
  const db = getDB();
  const { name, slack_id, avatar_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const info = await db.run(
    'INSERT INTO members (name, slack_id, avatar_color) VALUES (?, ?, ?)',
    [name, slack_id || null, avatar_color || '#6366f1']
  );
  res.status(201).json(await db.get('SELECT * FROM members WHERE id = ?', [info.lastInsertRowid]));
});

app.put('/api/members/:id', async (req, res) => {
  const db = getDB();
  const { name, slack_id, avatar_color } = req.body;
  await db.run(
    'UPDATE members SET name = COALESCE(?, name), slack_id = COALESCE(?, slack_id), avatar_color = COALESCE(?, avatar_color) WHERE id = ?',
    [name || null, slack_id || null, avatar_color || null, parseInt(req.params.id)]
  );
  res.json(await db.get('SELECT * FROM members WHERE id = ?', [parseInt(req.params.id)]));
});

app.delete('/api/members/:id', async (req, res) => {
  const db = getDB();
  await db.run('DELETE FROM members WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// API — Tasks
// ---------------------------------------------------------------------------
app.get('/api/tasks', async (req, res) => {
  const db = getDB();
  const { status, member_id } = req.query;
  let sql = `SELECT t.*, m.name as member_name, m.avatar_color
             FROM tasks t LEFT JOIN members m ON t.member_id = m.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (member_id) { sql += ' AND t.member_id = ?'; params.push(parseInt(member_id)); }
  sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC`;
  res.json(await db.all(sql, params));
});

app.post('/api/tasks', async (req, res) => {
  const db = getDB();
  const { title, description, status, priority, member_id, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const info = await db.run(
    'INSERT INTO tasks (title, description, status, priority, member_id, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description || '', status || 'todo', priority || 'medium', member_id || null, due_date || null]
  );
  await db.run(
    'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
    [info.lastInsertRowid, member_id || null, 'created', `Task "${title}" created`]
  );
  res.status(201).json(await db.get(
    'SELECT t.*, m.name as member_name, m.avatar_color FROM tasks t LEFT JOIN members m ON t.member_id = m.id WHERE t.id = ?',
    [info.lastInsertRowid]
  ));
});

app.put('/api/tasks/:id', async (req, res) => {
  const db = getDB();
  const taskId = parseInt(req.params.id);
  const existing = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const { title, description, status, priority, member_id, due_date } = req.body;
  const newStatus = status || existing.status;
  const completedAt = newStatus === 'done' && existing.status !== 'done'
    ? new Date().toISOString() : existing.completed_at;

  await db.run(`UPDATE tasks SET
    title = COALESCE(?, title),
    description = COALESCE(?, description),
    status = COALESCE(?, status),
    priority = COALESCE(?, priority),
    member_id = COALESCE(?, member_id),
    due_date = COALESCE(?, due_date),
    completed_at = ?,
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [title || null, description || null, status || null, priority || null,
    member_id || null, due_date || null, completedAt, taskId]
  );

  if (status && status !== existing.status) {
    await db.run(
      'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
      [taskId, member_id || existing.member_id, 'status_change', `Status: ${existing.status} → ${status}`]
    );
  }

  res.json(await db.get(
    'SELECT t.*, m.name as member_name, m.avatar_color FROM tasks t LEFT JOIN members m ON t.member_id = m.id WHERE t.id = ?',
    [taskId]
  ));
});

app.delete('/api/tasks/:id', async (req, res) => {
  const db = getDB();
  await db.run('DELETE FROM tasks WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// API — Dashboard Stats
// ---------------------------------------------------------------------------
app.get('/api/stats', async (req, res) => {
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
});

// ---------------------------------------------------------------------------
// API — Daily Updates
// ---------------------------------------------------------------------------
app.get('/api/daily-updates', async (req, res) => {
  const db = getDB();
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  res.json(await db.all(`
    SELECT d.*, m.name as member_name, m.avatar_color
    FROM daily_updates d JOIN members m ON d.member_id = m.id
    WHERE d.date = ? ORDER BY m.name
  `, [targetDate]));
});

app.post('/api/daily-updates', async (req, res) => {
  const db = getDB();
  const { member_id, done_summary, working_on_summary, blockers } = req.body;
  const date = new Date().toISOString().split('T')[0];
  await db.run(`INSERT OR REPLACE INTO daily_updates (member_id, date, done_summary, working_on_summary, blockers)
    VALUES (?, ?, ?, ?, ?)`,
    [member_id, date, done_summary, working_on_summary, blockers]);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// API — Activity Log
// ---------------------------------------------------------------------------
app.get('/api/activity', async (req, res) => {
  const db = getDB();
  const limit = parseInt(req.query.limit) || 50;
  res.json(await db.all(`
    SELECT a.*, t.title as task_title, m.name as member_name, m.avatar_color
    FROM activity_log a
    LEFT JOIN tasks t ON a.task_id = t.id
    LEFT JOIN members m ON a.member_id = m.id
    ORDER BY a.created_at DESC LIMIT ?
  `, [limit]));
});

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
