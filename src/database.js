const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'voting.db'));

// Initialize Schema
db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id TEXT,
        media_type TEXT,
        description TEXT,
        settings_json TEXT,
        start_time DATETIME,
        end_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admins (
        user_id INTEGER PRIMARY KEY,
        added_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Migration for existing tables (run independently)
const migrations = [
    'ALTER TABLE polls ADD COLUMN start_time DATETIME',
    'ALTER TABLE polls ADD COLUMN end_time DATETIME',
    'ALTER TABLE polls ADD COLUMN notified INTEGER DEFAULT 0',
    "ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'"
];

migrations.forEach(query => {
    try {
        db.prepare(query).run();
    } catch (e) {
        // Prepare might fail if column exists, which is fine.
    }
});

module.exports = db;
