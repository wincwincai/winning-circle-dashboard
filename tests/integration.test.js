const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = DB_PATH;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.JWT_SECRET = 'test-secret';
process.env.TEAM_ACCESS_CODE = 'team-test';
process.env.ADMIN_ACCESS_CODE = 'admin-test';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { initDatabase, getDB } = require('../db');

beforeAll(async () => {
  await initDatabase();
});

afterAll(() => {
  try { fs.unlinkSync(DB_PATH); } catch (_) {}
});

function tokenFromRes(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.find(c => c.startsWith('wc_token='));
  if (!cookie) return null;
  return cookie.split(';')[0].split('=')[1];
}

function cookieHeader(token) { return [`wc_token=${token}`]; }

let _ipCounter = 0;
function nextIp() {
  _ipCounter += 1;
  return `192.168.${Math.floor(_ipCounter / 250) + 1}.${(_ipCounter % 250) + 1}`;
}

let _slackCounter = 0;
function nextSlackId() {
  _slackCounter += 1;
  return 'U' + String(_slackCounter).padStart(8, '0').toUpperCase();
}

async function loginAs(name, code, slackId) {
  const res = await request(app).post('/auth/login')
    .set('X-Forwarded-For', nextIp())
    .send({ name, accessCode: code, slackId: slackId || nextSlackId() });
  return { res, token: tokenFromRes(res) };
}

describe('Auth', () => {
  test('wrong code returns 401', async () => {
    const res = await request(app).post('/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ name: 'Wrong1', accessCode: 'nope' });
    expect(res.status).toBe(401);
  });

  test('team code creates user with is_admin false', async () => {
    const { res, token } = await loginAs('TeamUser1', 'team-test');
    expect(res.status).toBe(200);
    expect(token).toBeTruthy();
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded.is_admin).toBe(false);

    const me = await request(app).get('/api/me').set('Cookie', cookieHeader(token));
    expect(me.status).toBe(200);
    expect(me.body.is_admin).toBe(false);
  });

  test('team code login does NOT escalate even if DB row is_admin=1', async () => {
    // Seed: create user with is_admin=1 directly in DB
    const db = getDB();
    await db.run('INSERT INTO members (name, avatar_color, is_admin) VALUES (?, ?, 1)', ['EscalationTest', '#fff']);

    const { res, token } = await loginAs('EscalationTest', 'team-test');
    expect(res.status).toBe(200);
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded.is_admin).toBe(false);

    const me = await request(app).get('/api/me').set('Cookie', cookieHeader(token));
    expect(me.status).toBe(200);
    expect(me.body.is_admin).toBe(false);
  });

  test('admin code grants admin and updates DB flag', async () => {
    const { res, token } = await loginAs('AdminUser1', 'admin-test');
    expect(res.status).toBe(200);
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded.is_admin).toBe(true);

    const db = getDB();
    const row = await db.get('SELECT * FROM members WHERE name = ?', ['AdminUser1']);
    expect(row.is_admin).toBe(1);

    const me = await request(app).get('/api/me').set('Cookie', cookieHeader(token));
    expect(me.body.is_admin).toBe(true);
  });
});

describe('Admin enforcement', () => {
  let adminToken, teamToken;

  beforeAll(async () => {
    ({ token: adminToken } = await loginAs('AdminEnforcer', 'admin-test'));
    ({ token: teamToken } = await loginAs('TeamPleb', 'team-test'));
  });

  test('non-admin POST /api/members returns 403', async () => {
    const res = await request(app).post('/api/members')
      .set('Cookie', cookieHeader(teamToken))
      .send({ name: 'NewMemberX' });
    expect(res.status).toBe(403);
  });

  test('admin POST /api/members succeeds', async () => {
    const res = await request(app).post('/api/members')
      .set('Cookie', cookieHeader(adminToken))
      .send({ name: 'NewMemberY' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.name).toBe('NewMemberY');
  });

  test('demoted admin loses access immediately even with valid JWT', async () => {
    const db = getDB();
    const row = await db.get('SELECT * FROM members WHERE name = ?', ['AdminEnforcer']);
    await db.run('UPDATE members SET is_admin = 0 WHERE id = ?', [row.id]);

    const res = await request(app).post('/api/members')
      .set('Cookie', cookieHeader(adminToken))
      .send({ name: 'ShouldFail' });
    expect(res.status).toBe(403);

    // restore
    await db.run('UPDATE members SET is_admin = 1 WHERE id = ?', [row.id]);
  });
});

describe('Validation', () => {
  let token;
  beforeAll(async () => {
    ({ token } = await loginAs('TaskUser', 'team-test'));
  });

  test('title length 201 returns 400', async () => {
    const res = await request(app).post('/api/tasks')
      .set('Cookie', cookieHeader(token))
      .send({ title: 'a'.repeat(201) });
    expect(res.status).toBe(400);
  });

  test('description length 5001 returns 400', async () => {
    const res = await request(app).post('/api/tasks')
      .set('Cookie', cookieHeader(token))
      .send({ title: 'ok', description: 'd'.repeat(5001) });
    expect(res.status).toBe(400);
  });

  test('valid task returns 201', async () => {
    const res = await request(app).post('/api/tasks')
      .set('Cookie', cookieHeader(token))
      .send({ title: 'valid task', description: 'short', status: 'todo', priority: 'medium' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.title).toBe('valid task');
  });

  test('bogus status returns 400', async () => {
    const res = await request(app).post('/api/tasks')
      .set('Cookie', cookieHeader(token))
      .send({ title: 'x', status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('Rate limit', () => {
  test('6th failed login returns 429', async () => {
    const ip = '10.20.30.40';
    const attempts = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ name: `RLUser${i}`, accessCode: 'wrong' });
      attempts.push(r.status);
    }
    // First 5 should be 401 (invalid code)
    for (const s of attempts) expect(s).toBe(401);

    const sixth = await request(app).post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ name: 'RLUser6', accessCode: 'wrong' });
    expect(sixth.status).toBe(429);
  });
});

describe('DB uniqueness', () => {
  test('inserting duplicate member name fails', async () => {
    const db = getDB();
    await db.run('INSERT INTO members (name, avatar_color) VALUES (?, ?)', ['UniqTest', '#aaa']);
    const second = await db.run('INSERT INTO members (name, avatar_color) VALUES (?, ?)', ['UniqTest', '#bbb']);
    // LocalDB swallows errors and returns { lastInsertRowid: null, error }
    // Either an error is reported OR lastInsertRowid is null
    expect(second.lastInsertRowid == null || !!second.error).toBe(true);

    const rows = await db.all('SELECT * FROM members WHERE name = ?', ['UniqTest']);
    expect(rows.length).toBe(1);
  });
});

describe('Reviewer / co-task workflow', () => {
  let assigneeToken, assigneeId;
  let reviewerToken, reviewerId;
  let outsiderToken;
  let adminToken;

  beforeAll(async () => {
    ({ token: assigneeToken } = await loginAs('Assignee1', 'team-test'));
    ({ token: reviewerToken } = await loginAs('Reviewer1', 'team-test'));
    ({ token: outsiderToken } = await loginAs('Outsider1', 'team-test'));
    ({ token: adminToken    } = await loginAs('AdminReview', 'admin-test'));
    const db = getDB();
    assigneeId = (await db.get('SELECT id FROM members WHERE name = ?', ['Assignee1'])).id;
    reviewerId = (await db.get('SELECT id FROM members WHERE name = ?', ['Reviewer1'])).id;
  });

  async function createTask(title, status = 'todo', extras = {}) {
    const res = await request(app).post('/api/tasks')
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ title, status, ...extras });
    return res;
  }

  test('creating with status=review without reviewer returns 400', async () => {
    const res = await createTask('Needs review on create', 'review');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewer/i);
  });

  test('creating with status=review and a reviewer succeeds and returns reviewer info', async () => {
    const res = await createTask('Needs review on create OK', 'review', { reviewer_id: reviewerId });
    expect([200, 201]).toContain(res.status);
    expect(res.body.reviewer_id).toBe(reviewerId);
    expect(res.body.reviewer_name).toBe('Reviewer1');
  });

  test('PUT to status=review without reviewer returns 400', async () => {
    const created = await createTask('Pending review change');
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review' });
    expect(res.status).toBe(400);
  });

  test('PUT setting reviewer + status=review succeeds', async () => {
    const created = await createTask('Pending review change OK');
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review', reviewer_id: reviewerId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('review');
    expect(res.body.reviewer_id).toBe(reviewerId);
  });

  test('reviewer can move review→done (status-only update)', async () => {
    const created = await createTask('Reviewer marks done');
    await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review', reviewer_id: reviewerId });
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(reviewerToken))
      .send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
  });

  test('outsider (non-assignee, non-reviewer, non-admin) cannot move review→done', async () => {
    const created = await createTask('Outsider blocked');
    await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review', reviewer_id: reviewerId });
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(outsiderToken))
      .send({ status: 'done' });
    expect(res.status).toBe(403);
  });

  test('admin can override review→done', async () => {
    const created = await createTask('Admin override');
    await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review', reviewer_id: reviewerId });
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(adminToken))
      .send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
  });

  test('reviewer cannot edit non-status fields', async () => {
    const created = await createTask('Reviewer cannot rename');
    await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ status: 'review', reviewer_id: reviewerId });
    const res = await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(reviewerToken))
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(403);
  });

  test('reviewer notification hook fires on assignment', async () => {
    const calls = [];
    app.locals.notifyReviewer = (rId, tId, aId) => calls.push({ rId, tId, aId });
    const created = await createTask('Notify on assign');
    await request(app).put(`/api/tasks/${created.body.id}`)
      .set('Cookie', cookieHeader(assigneeToken))
      .send({ reviewer_id: reviewerId, status: 'review' });
    expect(calls.length).toBe(1);
    expect(calls[0].rId).toBe(reviewerId);
    expect(calls[0].tId).toBe(created.body.id);
    expect(calls[0].aId).toBe(assigneeId);
    delete app.locals.notifyReviewer;
  });
});

describe('Archive endpoint', () => {
  let token, memberId;

  beforeAll(async () => {
    ({ token } = await loginAs('Archiver1', 'team-test'));
    const db = getDB();
    memberId = (await db.get('SELECT id FROM members WHERE name = ?', ['Archiver1'])).id;
    // Seed three done tasks + one open one
    await db.run("INSERT INTO tasks (title, status, member_id, completed_at) VALUES (?, 'done', ?, datetime('now', '-2 days'))", ['Recent done', memberId]);
    await db.run("INSERT INTO tasks (title, status, member_id, completed_at) VALUES (?, 'done', ?, datetime('now', '-30 days'))", ['Old done', memberId]);
    await db.run("INSERT INTO tasks (title, description, status, member_id, completed_at) VALUES (?, ?, 'done', ?, datetime('now', '-1 day'))", ['Archive needle', 'searchable text here', memberId]);
    await db.run("INSERT INTO tasks (title, status, member_id) VALUES (?, 'todo', ?)", ['Still active', memberId]);
  });

  test('archive returns only done tasks', async () => {
    const res = await request(app).get('/api/tasks/archive').set('Cookie', cookieHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every(t => t.status === 'done')).toBe(true);
    const titles = res.body.map(t => t.title);
    expect(titles).toEqual(expect.arrayContaining(['Recent done', 'Old done', 'Archive needle']));
    expect(titles).not.toContain('Still active');
  });

  test('archive search filter (q) narrows by title/description', async () => {
    const res = await request(app).get('/api/tasks/archive?q=needle').set('Cookie', cookieHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('Archive needle');
  });

  test('archive CSV export sets correct content type and contains rows', async () => {
    const res = await request(app).get('/api/tasks/archive?format=csv').set('Cookie', cookieHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="archive-/);
    expect(res.text).toMatch(/^id,title/);
    expect(res.text).toMatch(/Archive needle/);
  });

  test('board view (/api/tasks) hides done tasks completed >7 days ago', async () => {
    const res = await request(app).get('/api/tasks').set('Cookie', cookieHeader(token));
    expect(res.status).toBe(200);
    const titles = res.body.map(t => t.title);
    expect(titles).toContain('Recent done');
    expect(titles).not.toContain('Old done');
  });

  test('board view with include_archived=true returns old done tasks too', async () => {
    const res = await request(app).get('/api/tasks?include_archived=true').set('Cookie', cookieHeader(token));
    expect(res.status).toBe(200);
    const titles = res.body.map(t => t.title);
    expect(titles).toContain('Old done');
  });
});
