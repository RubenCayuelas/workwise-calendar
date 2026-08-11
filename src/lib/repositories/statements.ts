import type Database from 'better-sqlite3';
import type { Db } from '../db';

/**
 * A per-database prepared-statement cache.
 *
 * `better-sqlite3` compiles a statement on `db.prepare()` and does not cache it,
 * while a single recomposition runs the same UPDATE once per moved block. Keying
 * the cache on the handle rather than on module scope keeps a test's throwaway
 * `openDatabase(':memory:')` from inheriting statements compiled against the
 * shop's file, and a `WeakMap` lets a closed handle be collected with its
 * statements.
 *
 * Every repository goes through here, so `db.prepare` appears in exactly one
 * place in the data layer.
 */
const caches = new WeakMap<Db, Map<string, Database.Statement<unknown[], unknown>>>();

export function prepared<Result = unknown>(db: Db, sql: string): Database.Statement<unknown[], Result> {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  let statement = cache.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement as Database.Statement<unknown[], Result>;
}
