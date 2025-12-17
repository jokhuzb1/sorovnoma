const db = require('./src/database');

try {
    console.log('Adding notified column...');
    db.prepare('ALTER TABLE polls ADD COLUMN notified INTEGER DEFAULT 0').run();
    console.log('✅ Column added.');
} catch (e) {
    console.error('Migration Error:', e.message);
}
