/**
 * Initialize the database with sample team members.
 * Run: node init-db.js
 */

require('dotenv').config();
const { initDatabase, getDB } = require('./db');

const colors = [
  '#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6',
  '#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4',
  '#84cc16','#e11d48','#7c3aed','#0ea5e9','#d946ef'
];

const sampleMembers = [
  'Efe Winning', 'Alex Johnson', 'Maria Garcia', 'James Chen',
  'Sarah Kim', 'David Park', 'Emma Wilson', 'Chris Lee',
  'Olivia Brown', 'Ryan Taylor', 'Sofia Martinez', 'Lucas Davis',
  'Isabella Moore', 'Ethan Clark', 'Mia Robinson'
];

(async () => {
  try {
    await initDatabase();
    const db = getDB();
    for (let i = 0; i < sampleMembers.length; i++) {
      await db.run(
        'INSERT OR IGNORE INTO members (name, avatar_color) VALUES (?, ?)',
        [sampleMembers[i], colors[i % colors.length]]
      );
    }
    console.log(`Added ${sampleMembers.length} team members to the database`);
    console.log('Members:', sampleMembers.join(', '));
    process.exit(0);
  } catch (e) {
    console.error('init-db failed:', e);
    process.exit(1);
  }
})();
