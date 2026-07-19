import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const connections: Map<string, Database> = new Map<string, Database>();
const appSqliteDatabase: string = process.env.SQLITE_DATABASE ?? 'db.sqlite';

const getDb = () => {
    if (!connections.has(appSqliteDatabase)) {
        const appSqliteDatabaseDir = path.dirname(appSqliteDatabase);
        if (!existsSync(appSqliteDatabaseDir)) mkdirSync(appSqliteDatabaseDir, { recursive: true });
        const db: Database = new Database(appSqliteDatabase, { create: true });
        db.run('CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, role TEXT NOT NULL, text_content TEXT, tool_call_id TEXT, function_name TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)');
        db.run('CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user)');
        db.run('CREATE INDEX IF NOT EXISTS idx_chat_history_timestamp ON chat_history(timestamp)');
        connections.set(appSqliteDatabase, db);
        return db;
    }
    return connections.get(appSqliteDatabase)!;
}

const saveHistory = (user: string, role: string, textContent: string, toolCallId: string, functionName: string) => {
    const db: Database = getDb();
    const query: any = db.query('INSERT INTO chat_history (user, role, text_content, tool_call_id, function_name) VALUES (?, ?, ?, ?, ?)');
    try {
        query.run(user, role, textContent, toolCallId, functionName);
        return true;
    } catch (error: any) {
        return false;
    }
};

const loadHistory = (user: string) => {
    const db: Database = getDb();
    const query: any = db.query('SELECT * FROM chat_history WHERE user = ?');
    return query.all(user) ?? [];
};

const resetHistory = (user: string) => {
    const db: Database = getDb();
    const query: any = db.query('DELETE FROM chat_history WHERE user = ?');
    const result: any = query.run(user);
    return result.changes > 0;
};

const resetAllHistory = () => {
    const db: Database = getDb();
    const query: any = db.query('DELETE FROM chat_history');
    const result: any = query.run();
    const queryIds: any = db.query('DELETE FROM sqlite_sequence WHERE name = "chat_history"');
    queryIds.run()
    return result.changes > 0;
};

export { saveHistory, loadHistory, resetHistory, resetAllHistory };