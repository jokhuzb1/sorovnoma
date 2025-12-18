const db = require('./src/database');
const { handleVote } = require('./src/voting');

console.log('--- Phase 4 Test Script (Transactional Voting) ---');

const TEST_USER_ID = 999111;
const TEST_POLL_ID = 999;

// Mock Bot
const mockBot = {
    answerCallbackQuery: (id, options) => {
        // console.log(`[MockBot] Answer ${id}:`, options);
        return Promise.resolve();
    }
};

async function runTests() {
    // 1. Setup Data
    try {
        db.prepare('DELETE FROM votes WHERE poll_id = ?').run(TEST_POLL_ID);
        db.prepare('DELETE FROM options WHERE poll_id = ?').run(TEST_POLL_ID);
        db.prepare('DELETE FROM polls WHERE id = ?').run(TEST_POLL_ID);

        // Create Single Choice Poll
        db.prepare(`INSERT INTO polls (id, description, settings_json, start_time, end_time, published) 
            VALUES (?, ?, ?, ?, ?, ?)`).run(
            TEST_POLL_ID,
            'Race Condition Test',
            JSON.stringify({ multiple_choice: false, allow_edit: true }),
            null, null, 1
        );

        db.prepare('INSERT INTO options (id, poll_id, text) VALUES (?, ?, ?)').run(101, TEST_POLL_ID, 'Option A');
        db.prepare('INSERT INTO options (id, poll_id, text) VALUES (?, ?, ?)').run(102, TEST_POLL_ID, 'Option B');

        console.log('✅ Test Data Setup Complete.');
    } catch (e) {
        console.error('Setup Error:', e.message);
    }

    // 2. Race Condition Test: Same User, Same Option x 5
    console.log('\n🔹 Test 1: 5 Concurrent Votes for Option A...');

    const promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(handleVote(mockBot, {
            id: `cb_${i}`,
            data: `vote:${TEST_POLL_ID}:101`,
            from: { id: TEST_USER_ID },
            message: { chat: { id: 123 }, message_id: 456 }
        }, 'bot_username'));
    }

    await Promise.all(promises);

    const votesA = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?').all(TEST_POLL_ID, TEST_USER_ID);
    console.log(`Votes found: ${votesA.length}`);

    if (votesA.length === 1) {
        console.log('✅ Success: Only 1 vote persisted (Race Condition Handled).');
    } else {
        console.log(`❌ Failed: Found ${votesA.length} votes.`);
    }

    // 3. Race Condition Test: Switching Option (A -> B) concurrently
    console.log('\n🔹 Test 2: Concurrent Switch (vote for B while already A)...');
    // Already have A. Now spam B.
    const promisesB = [];
    for (let i = 0; i < 5; i++) {
        promisesB.push(handleVote(mockBot, {
            id: `cb_b_${i}`,
            data: `vote:${TEST_POLL_ID}:102`,
            from: { id: TEST_USER_ID }, // Same user
            message: { chat: { id: 123 }, message_id: 456 }
        }, 'bot_username'));
    }
    await Promise.all(promisesB);

    const votesTotal = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?').all(TEST_POLL_ID, TEST_USER_ID);
    const voteB = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ? AND option_id = ?').get(TEST_POLL_ID, TEST_USER_ID, 102);

    console.log(`Total Votes: ${votesTotal.length}, Vote for B present: ${!!voteB}`);

    if (votesTotal.length === 1 && voteB) {
        console.log('✅ Success: Vote switched to B atomically.');
    } else {
        console.log(`❌ Failed: Total ${votesTotal.length} (Expected 1).`);
    }

}

runTests();
