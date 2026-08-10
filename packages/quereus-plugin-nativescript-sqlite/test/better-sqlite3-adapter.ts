/**
 * Adapter to use better-sqlite3 with the SQLiteDatabase interface.
 * This allows testing the NativeScript SQLite plugin in Node.js.
 */

import Database from 'better-sqlite3';
import type { SQLiteDatabase } from '../src/store.js';

/**
 * Convert Uint8Array or ArrayBuffer to Buffer for better-sqlite3 compatibility.
 */
function toBuffer(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array && !(value instanceof Buffer)) {
    return Buffer.from(value);
  }
  return value;
}

/**
 * Convert params array, converting Uint8Array to Buffer.
 */
function convertParams(params?: unknown[]): unknown[] | undefined {
  if (!params) return params;
  return params.map(toBuffer);
}

/**
 * Wraps better-sqlite3 to match the @nativescript-community/sqlite interface.
 */
export class BetterSQLiteAdapter implements SQLiteDatabase {
  private db: Database.Database;

  constructor(path: string = ':memory:') {
    this.db = new Database(path);
  }

  execute(sql: string, params?: unknown[]): void {
    const stmt = this.db.prepare(sql);
    const converted = convertParams(params);
    if (converted && converted.length > 0) {
      stmt.run(...converted);
    } else {
      stmt.run();
    }
  }

  select(sql: string, params?: unknown[]): unknown[] {
    const stmt = this.db.prepare(sql);
    const converted = convertParams(params);
    if (converted && converted.length > 0) {
      return stmt.all(...converted);
    }
    return stmt.all();
  }

  transaction<T>(fn: (cancelTransaction: () => void) => T): T {
    let cancelled = false;
    const cancelTransaction = () => {
      cancelled = true;
    };

    const txn = this.db.transaction(() => {
      const result = fn(cancelTransaction);
      if (cancelled) {
        throw new Error('ROLLBACK');
      }
      return result;
    });

    try {
      return txn();
    } catch (e) {
      if (e instanceof Error && e.message === 'ROLLBACK') {
        // Transaction was cancelled, return undefined
        return undefined as T;
      }
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Create a SQLite database for testing. Defaults to in-memory; pass a file path to get
 * a database that survives close/reopen (what the conformance persistence tier needs).
 */
export function createTestDatabase(path: string = ':memory:'): SQLiteDatabase {
  return new BetterSQLiteAdapter(path);
}

