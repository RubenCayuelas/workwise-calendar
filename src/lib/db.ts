import sqlite3 from 'sqlite3';
import path from 'path';
import { promisify } from 'util';

let db: sqlite3.Database | null = null;

export function initializeDb(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    const dbPath = path.join(process.cwd(), 'data', 'calendar.db');
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
      } else {
        // Enable foreign keys
        db!.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
          if (pragmaErr) {
            reject(pragmaErr);
          } else {
            resolve(db!);
          }
        });
      }
    });
  });
}

export function getDb(): sqlite3.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDb() first.');
  }
  return db;
}

export function closeDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) reject(err);
        else {
          db = null;
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}
