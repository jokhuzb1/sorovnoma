const db = require('./src/database');

try {
    console.log('Clearing database...');
    db.prepare('DELETE FROM votes').run();
    db.prepare('DELETE FROM options').run();
    db.prepare('DELETE FROM required_channels').run();
    db.prepare('DELETE FROM polls').run();
    console.log('✅ Database cleared successfully!');
} catch (error) {
    console.error('❌ Error clearing database:', error);
}
