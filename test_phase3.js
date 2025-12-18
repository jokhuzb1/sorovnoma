const db = require('./src/database');

console.log('--- Phase 3 Test Script (Multipart) ---');

const TEST_ID = 777777;

// Setup Admin
try {
    db.prepare('INSERT OR IGNORE INTO admins (user_id, role) VALUES (?, ?)').run(TEST_ID, 'super_admin');
} catch (e) { }

async function runTests() {
    console.log('⏳ Waiting for server...');
    await new Promise(r => setTimeout(r, 2000));

    // Test 1: Invalid Channel
    console.log('\n🔹 Test 1: Invalid Channel (Not Admin/Existent)');

    const fd = new FormData();
    fd.append('user_id', TEST_ID);
    fd.append('question', 'Channel Test');
    fd.append('options', 'A');
    fd.append('options', 'B');
    fd.append('channels', 'invalid_channel_12345_xyz');

    try {
        const res = await fetch('http://localhost:3000/api/create-poll', {
            method: 'POST',
            body: fd
        });
        const body = await res.json();

        console.log(`Status: ${res.status}`);
        if (res.status === 400) {
            console.log('✅ Success: Rejected invalid channel.');
        } else {
            console.log('❌ Failed: Accepted invalid channel (or other error).', body);
        }
    } catch (e) {
        console.log('❌ Request Failed:', e.message);
    }

    // Test 2: Normalization Check (@test)
    console.log('\n🔹 Test 2: Normalization Check (@test)');
    const fd2 = new FormData();
    fd2.append('user_id', TEST_ID);
    fd2.append('question', 'Norm Test');
    fd2.append('options', 'A');
    fd2.append('options', 'B');
    fd2.append('channels', ' @invalid_channel_123 ');

    try {
        const res = await fetch('http://localhost:3000/api/create-poll', {
            method: 'POST',
            body: fd2
        });
        const body = await res.json();

        if (res.status === 400 && body.message && body.message.includes('invalid_channel_123')) {
            console.log('✅ Success: Normalized and rejected.');
        } else {
            console.log('❌ Failed:', body);
        }
    } catch (e) {
        console.log('❌ Request Failed:', e.message);
    }

    // process.exit(0); // Fetch might verify handles, safe to exit
}

runTests();
