const db = require('./database');

const SUPER_ADMIN_ID = 5887482755;

console.log('Cleaning database...');

try {
    // 1. Delete all votes
    db.prepare('DELETE FROM votes').run();
    console.log('Votes cleared.');

    // 2. Delete all options
    db.prepare('DELETE FROM options').run();
    console.log('Options cleared.');

    // 3. Delete all required channels
    db.prepare('DELETE FROM required_channels').run();
    console.log('Required Channels cleared.');

    // 4. Delete all polls
    db.prepare('DELETE FROM polls').run();
    console.log('Polls cleared.');

    // 5. Delete all admins EXCEPT Super Admin
    db.prepare('DELETE FROM admins WHERE user_id != ?').run(SUPER_ADMIN_ID);
    console.log('Admins cleared (Super Admin preserved).');

    // Vacuum to reclaim space
    db.exec('VACUUM');
    console.log('Database vacuumed.');

    console.log('✅ Database cleaning complete!');

} catch (e) {
    console.error('Error cleaning DB:', e);
}
