const db = require('./src/database');

console.log('Testing DB Insert...');

const stmt = db.prepare(`
    INSERT INTO polls (
        media_id, media_type, description, settings_json, start_time, end_time
    ) VALUES (?, ?, ?, ?, ?, ?)
`);

try {
    // Case 1: All valid strings and nulls (as expected)
    console.log('Case 1: Valid inputs');
    stmt.run(null, 'none', 'Test Question', JSON.stringify({}), null, null);
    console.log('Case 1: Success');
} catch (e) {
    console.error('Case 1 Failed:', e.message);
}

try {
    // Case 2: Undefined (should throw "Bind parameters must not be undefined")
    console.log('Case 2: Undefined value');
    stmt.run(undefined, 'none', 'Test', '{}', null, null);
} catch (e) {
    console.log('Case 2 Result:', e.message);
}

try {
    // Case 3: Number where string expected (SQLite handles this fine usually)
    console.log('Case 3: Number instead of string');
    stmt.run(123, 'none', 'Test', '{}', null, null);
    console.log('Case 3: Success');
} catch (e) {
    console.error('Case 3 Failed:', e.message);
}

try {
    // Case 4: Object (not stringified)
    console.log('Case 4: Object instead of string');
    stmt.run(null, 'none', 'Test', { a: 1 }, null, null);
} catch (e) {
    console.log('Case 4 Result:', e.message);
}

try {
    // Case 5: Boolean
    console.log('Case 5: Boolean instead of string');
    stmt.run(null, 'none', 'Test', '{}', true, null); // start_time as boolean?
} catch (e) {
    console.log('Case 5 Result:', e.message);
}
