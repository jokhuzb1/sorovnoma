const db = require('./src/database');
const http = require('http');
const { spawn } = require('child_process');

console.log('--- Phase 1 Test Script ---');

// 1. Setup Temp Admin
const TEST_ID = 999999;
try {
    db.prepare('INSERT OR IGNORE INTO admins (user_id, role) VALUES (?, ?)').run(TEST_ID, 'super_admin');
    console.log('✅ Temp Admin Added:', TEST_ID);
} catch (e) {
    console.error('DB Setup Error:', e.message);
}

// 2. Helper for Requests
function post(data) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/create-poll',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.write(JSON.stringify(data));
        req.end();
    });
}


async function runTests() {
    console.log('⏳ Waiting for server...');
    await new Promise(r => setTimeout(r, 3000)); // Give valid server time to start

    // Test 1: Valid Poll
    console.log('\n🔹 Test 1: Valid Request');
    const r1 = await post({
        user_id: TEST_ID,
        question: 'Unit Test Poll',
        options: ['Yes', 'No']
    });
    console.log(`Status: ${r1.status} (Expected 200)`);
    if (r1.status === 200) console.log('✅ Success'); else console.log('❌ Failed:', r1.body);

    // Test 2: Invalid Question
    console.log('\n🔹 Test 2: Empty Question');
    const r2 = await post({
        user_id: TEST_ID,
        question: '   ',
        options: ['Yes', 'No']
    });
    console.log(`Status: ${r2.status} (Expected 400)`);
    if (r2.status === 400) console.log('✅ Success'); else console.log('❌ Failed:', r2.body);

    // Test 3: Invalid Options (<2)
    console.log('\n🔹 Test 3: Not enough options');
    const r3 = await post({
        user_id: TEST_ID,
        question: 'Valid Q',
        options: ['Just One']
    });
    console.log(`Status: ${r3.status} (Expected 400)`);
    if (r3.status === 400) console.log('✅ Success'); else console.log('❌ Failed:', r3.body);

    // Cleanup
    db.prepare('DELETE FROM admins WHERE user_id = ?').run(TEST_ID);
    console.log('\n🧹 Cleanup Done.');
    process.exit(0);
}

runTests();
