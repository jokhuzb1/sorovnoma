const db = require('./src/database');
const http = require('http');

console.log('--- Phase 2 Test Script ---');

const TEST_ID = 888888;
const NOW = Date.now();

// Setup Admin
try {
    db.prepare('INSERT OR IGNORE INTO admins (user_id, role) VALUES (?, ?)').run(TEST_ID, 'super_admin');
} catch (e) { }

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
        req.end(JSON.stringify(data));
    });
}

async function runTests() {
    console.log('⏳ Waiting for server...');
    await new Promise(r => setTimeout(r, 2000));

    // Test 1: Scheduled Start (Start in 10s)
    // Note: API expects ISO string usually, but we updated it to parse string.
    // Let's send ISO string for specific time.
    const startIso = new Date(NOW + 10000).toISOString();

    console.log(`\n🔹 Test 1: Scheduled Poll (Starts at ${startIso})`);
    const r1 = await post({
        user_id: TEST_ID,
        question: 'Scheduled Poll',
        options: ['A', 'B'],
        start_time: startIso
    });

    if (r1.status === 200) {
        const pollId = r1.body.pollId;
        console.log(`Poll created: ${pollId}. Checking DB...`);

        let p = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        console.log(`Initial State: Published=${p.published}, StartTime=${p.start_time}`);

        if (p.published === 0) console.log('✅ Correctly saved as Unpublished.');
        else console.log('❌ Failed: Should be unpublished.');

        console.log('⏳ Waiting 25s for scheduler...');
        await new Promise(r => setTimeout(r, 25000));

        p = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        console.log(`Final State: Published=${p.published}`);

        if (p.published === 1) console.log('✅ Scheduler successfully published the poll!');
        else console.log('❌ Scheduler failed to publish.');

    } else {
        console.log('❌ Create Request Failed:', r1.body);
    }

    process.exit(0);
}

runTests();
