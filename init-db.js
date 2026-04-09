/**
 * Initialize the database with sample team members.
 * Run: node init-db.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dashboard.db'));
db.pragma('journal_mode = WAL');

const colors = [
  '#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6',
  '#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4',
  '#84cc16','#e11d48','#7c3aed','#0ea5e9','#d946ef'
];

// Add 15 sample members (replace with your actual team)
const sampleMembers = [
  'Efe Winning', 'Alex Johnson', 'Maria Garcia', 'James Chen',
  'Sarah Kim', 'David Park', 'Emma Wilson', 'Chris Lee',
  'Olivia Brown', 'Ryan Taylor', 'Sofia Martinez', 'Lucas Davis',
  'Isabella Moore', 'Ethan Clark', 'Mia Robinson'
];

const insert = db.prepare('INSERT OR IGNORE INTO members (name, avatar_color) VALUES (?, ?)');

const insertMany = db.transaction((members) => {
  members.forEach((name, i) => {
    insert.run(name, colors[i % colors.length]);
  });
});

// Create tables first by importing server logic
require('./server.js');

// Wait a moment for tables to be created, then insert
setTimeout(() => {
  insertMany(sampleMembers);
  console.log(`✅ Added ${sampleMembers.length} team members to the database`);
  console.log('Members:', sampleMembers.join(', '));
  process.exit(0);
}, 500);
