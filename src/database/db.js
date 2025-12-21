const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'voting.db'));
db.pragma('journal_mode = WAL'); // Enable Write-Ahead Logging for concurrency
db.pragma('foreign_keys = ON');

// Initialize Schema
db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id TEXT,
        media_type TEXT,
        description TEXT,
        settings_json TEXT,
        start_time INTEGER,
        end_time INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        creator_id INTEGER,
        published INTEGER DEFAULT 0,
        notified INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER,
        text TEXT,
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS votes (
        poll_id INTEGER,
        user_id INTEGER,
        option_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (poll_id, user_id, option_id),
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
        FOREIGN KEY(option_id) REFERENCES options(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS required_channels (
        poll_id INTEGER,
        channel_username TEXT,
        channel_id INTEGER,
        channel_title TEXT,
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admins (
        user_id INTEGER PRIMARY KEY,
        added_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        role TEXT DEFAULT 'admin'
    );

    CREATE TABLE IF NOT EXISTS shared_polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER,
        inline_message_id TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS poll_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER,
        chat_id INTEGER,
        message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
        UNIQUE(chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        first_name TEXT,
        username TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS drafts (
        user_id INTEGER PRIMARY KEY,
        media_type TEXT,
        media_id TEXT,
        sticker_id TEXT,
        updated_at INTEGER
    );
`);

module.exports = db;
