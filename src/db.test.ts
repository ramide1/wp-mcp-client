import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveHistory, loadHistory, resetHistory, resetAllHistory, closeDatabase } from './db';

const tempDirs: string[] = [];

const useTemporaryDatabase = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'history.sqlite');
    process.env.SQLITE_DATABASE = dbPath;
    return dbPath;
};

beforeEach(() => {
    useTemporaryDatabase();
    delete process.env.LIMIT_HISTORY;
});

afterEach(() => {
    closeDatabase();
    delete process.env.SQLITE_DATABASE;
    delete process.env.LIMIT_HISTORY;
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('saveHistory / loadHistory', () => {
    test('stores and reads back a user message', () => {
        expect(saveHistory('user1', 'user', 'hello', '', '')).toBe(true);
        const rows = loadHistory('user1');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.role).toBe('user');
        expect(rows[0]!.text_content).toBe('hello');
    });

    test('keeps the users isolated', () => {
        saveHistory('user1', 'user', 'one', '', '');
        saveHistory('user2', 'user', 'two', '', '');
        expect(loadHistory('user1')).toHaveLength(1);
        expect(loadHistory('user1')[0]!.text_content).toBe('one');
        expect(loadHistory('user2')[0]!.text_content).toBe('two');
    });

    test('stores the tool calls of an assistant message in the function_name column', () => {
        // This encoding is what the history reconstruction depends on: the tool
        // calls are serialized in `function_name` and the text stays in `text_content`.
        const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: '{"toolName":"x"}' } }];
        saveHistory('user1', 'assistant', '', '', JSON.stringify(toolCalls));

        const rows = loadHistory('user1');
        expect(rows[0]!.function_name).toBe(JSON.stringify(toolCalls));
        expect(JSON.parse(rows[0]!.function_name ?? '[]')).toHaveLength(1);
        expect(rows[0]!.text_content).toBe('');
    });

    test('stores a tool result in the text_content and tool_call_id columns', () => {
        saveHistory('user1', 'tool', 'the result', 'call-1', 'call_tool');
        const rows = loadHistory('user1');
        expect(rows[0]!.role).toBe('tool');
        expect(rows[0]!.text_content).toBe('the result');
        expect(rows[0]!.tool_call_id).toBe('call-1');
        expect(rows[0]!.function_name).toBe('call_tool');
    });

    test('returns the rows in insertion order', () => {
        saveHistory('user1', 'user', 'first', '', '');
        saveHistory('user1', 'assistant', 'second', '', '');
        saveHistory('user1', 'user', 'third', '', '');
        expect(loadHistory('user1').map((r: any) => r.text_content)).toEqual(['first', 'second', 'third']);
    });
});

describe('history trimming', () => {
    test('keeps only the last LIMIT_HISTORY rows of each user', () => {
        process.env.LIMIT_HISTORY = '3';
        for (let i = 1; i <= 6; i++) {
            saveHistory('user1', 'user', `message ${i}`, '', '');
        }
        const rows = loadHistory('user1');
        expect(rows).toHaveLength(3);
        expect(rows.map((r: any) => r.text_content)).toEqual(['message 4', 'message 5', 'message 6']);
    });

    test('trims each user independently', () => {
        process.env.LIMIT_HISTORY = '2';
        saveHistory('user1', 'user', 'a', '', '');
        saveHistory('user1', 'user', 'b', '', '');
        saveHistory('user1', 'user', 'c', '', '');
        saveHistory('user2', 'user', 'x', '', '');
        expect(loadHistory('user1')).toHaveLength(2);
        expect(loadHistory('user2')).toHaveLength(1);
    });

    test('falls back to the default limit when the value is invalid', () => {
        process.env.LIMIT_HISTORY = 'not-a-number';
        saveHistory('user1', 'user', 'hello', '', '');
        expect(loadHistory('user1')).toHaveLength(1);
    });
});

describe('resetHistory', () => {
    test('deletes only the rows of the given user', () => {
        saveHistory('user1', 'user', 'one', '', '');
        saveHistory('user2', 'user', 'two', '', '');
        expect(resetHistory('user1')).toBe(true);
        expect(loadHistory('user1')).toHaveLength(0);
        expect(loadHistory('user2')).toHaveLength(1);
    });

    test('reports false when there was nothing to delete', () => {
        expect(resetHistory('unknown')).toBe(false);
    });
});

describe('resetAllHistory', () => {
    test('deletes the rows of every user', () => {
        saveHistory('user1', 'user', 'one', '', '');
        saveHistory('user2', 'user', 'two', '', '');
        expect(resetAllHistory()).toBe(true);
        expect(loadHistory('user1')).toHaveLength(0);
        expect(loadHistory('user2')).toHaveLength(0);
    });

    test('reports false when the history was already empty', () => {
        expect(resetAllHistory()).toBe(false);
    });
});

describe('closeDatabase', () => {
    test('can be called twice without throwing', () => {
        saveHistory('user1', 'user', 'hello', '', '');
        closeDatabase();
        expect(() => closeDatabase()).not.toThrow();
    });

    test('reopens the database transparently after being closed', () => {
        saveHistory('user1', 'user', 'hello', '', '');
        closeDatabase();
        expect(saveHistory('user1', 'user', 'again', '', '')).toBe(true);
        expect(loadHistory('user1')).toHaveLength(2);
    });
});
