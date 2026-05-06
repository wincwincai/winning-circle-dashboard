/**
 * Database adapter — works with both local SQLite (sql.js) and Turso (cloud).
 *
 * Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in .env for cloud mode.
 * Otherwise falls back to local file-based SQLite via sql.js.
 */

const path = require('path');
const fs = require('fs');

let _db = null;
let _mode = null; // 'turso' or 'local'

// ─────────── Schema ───────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slack_id TEXT,
    avatar_color TEXT DEFAULT '#6366f1',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo'
      CHECK(status IN ('todo','in_progress','review','done')),
    priority TEXT DEFAULT 'medium'
      CHECK(priority IN ('low','medium','high','urgent')),
    member_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    due_date TEXT,
    FOREIGN KEY (member_id) REFERENCES members(id)
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    member_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    done_summary TEXT,
    working_on_summary TEXT,
    blockers TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    UNIQUE(member_id, date)
  )`
];

// ─────────── Turso adapter ───────────
class TursoDB {
  constructor(client) { this.client = client; }

  async all(sql, params = []) {
    try {
      const result = await this.client.execute({ sql, args: params });
      return result.rows.map(r => ({ ...r }));
    } catch (e) {
      console.error('Turso query error:', sql, e.message);
      return [];
    }
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async run(sql, params = []) {
    try {
      const result = await this.client.execute({ sql, args: params });
      return { lastInsertRowid: Number(result.lastInsertRowid) || null };
    } catch (e) {
      console.error('Turso run error:', sql, e.message);
      return { lastInsertRowid: null };
    }
  }
}

// ─────────── Local sql.js adapter ───────────
class LocalDB {
  constructor(sqlDb, dbPath) {
    this.sqlDb = sqlDb;
    this.dbPath = dbPath;
    this._writeQueue = Promise.resolve();
  }

  save() {
    try {
      const data = this.sqlDb.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (e) {
      console.error('Failed to save DB:', e.message);
    }
  }

  async all(sql, params = []) {
    try {
      const stmt = this.sqlDb.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch (e) {
      console.error('Query error:', sql, e.message);
      return [];
    }
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async run(sql, params = []) {
    const doWrite = () => {
      try {
        this.sqlDb.run(sql, params);
        const result = this.sqlDb.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 ? result[0].values[0][0] : null;
        this.save();
        return { lastInsertRowid: lastId };
      } catch (e) {
        console.error('Run error:', sql, e.message);
        this.save();
        return { lastInsertRowid: null, error: e.message };
      }
    };
    const next = this._writeQueue.then(doWrite);
    this._writeQueue = next.catch(() => {});
    return next;
  }
}

// ─────────── Initialize ───────────
async function initDatabase() {
  if (_db) return _db;

  // Turso (cloud)
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    const { createClient } = require('@libsql/client');
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    _db = new TursoDB(client);
    _mode = 'turso';
    console.log('Database: Turso (cloud SQLite)');
  }
  // Local fallback
  else {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dashboard.db');

    let sqlDb;
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buf);
    } else {
      sqlDb = new SQL.Database();
    }
    _db = new LocalDB(sqlDb, DB_PATH);
    _mode = 'local';
    console.log('Database: Local SQLite (' + DB_PATH + ')');
  }

  // Run schema
  for (const sql of SCHEMA) {
    await _db.run(sql);
  }

  // Migration: add is_admin column (safe — ignored if already exists)
  try {
    await _db.run('ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message || '')) {
      console.error('Migration is_admin error:', e.message);
    }
  }

  // Migration: add reviewer_id column to tasks (co-task / review-handoff feature)
  try {
    await _db.run('ALTER TABLE tasks ADD COLUMN reviewer_id INTEGER REFERENCES members(id)');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message || '')) {
      console.error('Migration reviewer_id error:', e.message);
    }
  }

  // Migration: ensure unique index on members.name for older DBs
  try {
    await _db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_name_unique ON members(name)');
  } catch (e) {
    console.error('Migration unique index members.name error:', e.message);
  }

  // Migration: unique index on members.slack_id (allows multiple NULLs in SQLite)
  try {
    await _db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_slack_id_unique ON members(slack_id) WHERE slack_id IS NOT NULL');
  } catch (e) {
    console.error('Migration unique index members.slack_id error:', e.message);
  }

  return _db;
}

function getDB() {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

function getMode() { return _mode; }

module.exports = { initDatabase, getDB, getMode };
