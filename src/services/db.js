/**
 * db.js - Database abstraction layer
 * Automatically uses PostgreSQL if DATABASE_URL is set, otherwise SQLite
 */

let persistence;

if (process.env.DATABASE_URL) {
  console.log('🐘 Using PostgreSQL for persistence');
  persistence = require('./postgres-persistence');
} else {
  console.log('📦 Using SQLite for persistence');
  persistence = require('./persistence');
}

module.exports = persistence;
