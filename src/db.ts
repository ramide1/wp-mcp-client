import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { intFromEnv } from './env';

const log = createLogger('db');

const connections: Map<string, Database> = new Map<string, Database>();

/** A row of the `chat_history` table. */
export interface HistoryRow {
    id: number;
    user: string;
    role: string;
    text_content: string | null;
    tool_call_id: string | null;
    function_name: string | null;
    timestamp: string;
}

/**
 * Path of the SQLite database. It is resolved on every call (instead of once at
 * import time) so the value can be changed at runtime and so the module can be
 * pointed at a temporary database in the tests.
 */
const getDatabasePath = (): string => process.env.SQLITE_DATABASE ?? 'db.sqlite';

/** Maximum number of rows kept per user. */
const getMaxHistory = (): number => intFromEnv('LIMIT_HISTORY', 100);

const getDb = (): Database => {
    const databasePath = getDatabasePath();
    const existing = connections.get(databasePath);
    if (existing) return existing;

    const databaseDir = path.dirname(databasePath);
    if (!existsSync(databaseDir)) mkdirSync(databaseDir, { recursive: true });
    const db: Database = new Database(databasePath, { create: true });
    db.run('CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, role TEXT NOT NULL, text_content TEXT, tool_call_id TEXT, function_name TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_history_timestamp ON chat_history(timestamp)');
    connections.set(databasePath, db);
    return db;
}

/**
 * Store a message of the conversation.
 *
 * The encoding is quirky on purpose (see AGENTS.md): the tool calls of an
 * assistant message are serialized in `function_name` and the result of a tool
 * is stored in `text_content` together with its `tool_call_id`.
 *
 * @returns true when the message was stored.
 */
const saveHistory = (
    user: string,
    role: string,
    textContent: string,
    toolCallId: string,
    functionName: string
): boolean => {
    const db: Database = getDb();
    try {
        db.query<unknown, [string, string, string, string, string]>(
            'INSERT INTO chat_history (user, role, text_content, tool_call_id, function_name) VALUES (?, ?, ?, ?, ?)'
        ).run(user, role, textContent, toolCallId, functionName);
        const maxHistory = getMaxHistory();
        db.query<unknown, [string, string, number]>(
            'DELETE FROM chat_history WHERE user = ? AND id NOT IN (SELECT id FROM chat_history WHERE user = ? ORDER BY id DESC LIMIT ?)'
        ).run(user, user, maxHistory);
        return true;
    } catch (error) {
        log.error('Error saving history', {
            user,
            role,
            error: error instanceof Error ? error.message : String(error)
        });
        return false;
    }
};

/**
 * Read the messages of a user, from the oldest to the newest.
 */
const loadHistory = (user: string): HistoryRow[] => {
    const db: Database = getDb();
    return db.query<HistoryRow, [string, number]>(
        'SELECT * FROM chat_history WHERE user = ? ORDER BY id ASC LIMIT ?'
    ).all(user, getMaxHistory());
}

/**
 * Delete the messages of a user.
 *
 * @returns true when at least one row was deleted.
 */
const resetHistory = (user: string): boolean => {
    const db: Database = getDb();
    const result = db.query<unknown, [string]>(
        'DELETE FROM chat_history WHERE user = ?'
    ).run(user);
    return result.changes > 0;
};

/**
 * Delete the messages of every user and reset the autoincrement counter.
 *
 * @returns true when at least one row was deleted.
 */
const resetAllHistory = (): boolean => {
    const db: Database = getDb();
    const result = db.query<unknown, []>('DELETE FROM chat_history').run();
    // Reset the autoincrement counter of the table (it only exists once a row
    // with AUTOINCREMENT has been created).
    try {
        db.query<unknown, []>("DELETE FROM sqlite_sequence WHERE name = 'chat_history'").run();
    } catch (error) {
        log.debug('Could not reset the autoincrement counter', {
            error: error instanceof Error ? error.message : String(error)
        });
    }
    return result.changes > 0;
};

/** Close every open connection. It is safe to call it more than once. */
const closeDatabase = (): void => {
    for (const [name, db] of connections.entries()) {
        try {
            db.close();
            log.debug('Closed database', { path: name });
        } catch (error) {
            log.error('Error closing database', {
                path: name,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    connections.clear();
};

export { saveHistory, loadHistory, resetHistory, resetAllHistory, closeDatabase };
