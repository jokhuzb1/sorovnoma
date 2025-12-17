const db = require('./src/database');
try {
    const tableInfo = db.prepare('PRAGMA table_info(polls)').all();
    console.log('Columns in polls table:', tableInfo.map(c => c.name));
} catch (e) {
    console.error(e);
}
