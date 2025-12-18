const db = require('./src/database');

try {
    console.log('Dropping tables...');
    db.prepare('DROP TABLE IF EXISTS votes').run();
    db.prepare('DROP TABLE IF EXISTS options').run();
    db.prepare('DROP TABLE IF EXISTS required_channels').run();
    db.prepare('DROP TABLE IF EXISTS polls').run();
    db.prepare('DROP TABLE IF EXISTS admins').run();
    console.log('✅ Tables dropped!');
} catch (error) {
    console.error('❌ Error:', error);
}
