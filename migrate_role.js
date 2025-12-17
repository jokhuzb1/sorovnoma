const db = require('./src/database');

try {
    console.log('Adding role column to admins...');
    db.prepare("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'").run();
    console.log('✅ Role column added.');
} catch (e) {
    if (e.message.includes('duplicate column')) {
        console.log('✅ Column already exists.');
    } else {
        console.error('Migration Error:', e.message);
    }
}
