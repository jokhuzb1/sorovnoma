const db = require('./src/database');
const { handleAdminCallback } = require('./src/admin.js');

console.log('--- Phase 5 Test Script (Admin Logic) ---');

const TEST_POLL_ID = 888;
const ADMIN_ID = 55555;
const USER_ID = 11111;

// Setup DB
try {
    db.prepare('DELETE FROM admins WHERE user_id = ?').run(ADMIN_ID);
    db.prepare('DELETE FROM admins WHERE user_id = ?').run(USER_ID);
    db.prepare('INSERT INTO admins (user_id, role) VALUES (?, ?)').run(ADMIN_ID, 'super_admin');

    db.prepare('DELETE FROM polls WHERE id = ?').run(TEST_POLL_ID);
    db.prepare(`INSERT INTO polls (id, description, settings_json, published) VALUES (?, ?, ?, ?)`).run(TEST_POLL_ID, 'Admin Test Poll', '{}', 1);
} catch (e) {
    console.error('Setup Error:', e.message);
}

// Mock Bot
const mockBot = {
    answerCallbackQuery: (id, opts) => {
        console.log(`[Bot] answerCallbackQuery: ${id} - ${opts?.text || ''}`);
        return Promise.resolve();
    },
    editMessageText: (text, opts) => {
        console.log(`[Bot] editMessageText: "${text.substring(0, 30)}..." Buttons: ${JSON.stringify(opts?.reply_markup?.inline_keyboard[0])}`);
        return Promise.resolve();
    },
    sendMessage: (chatId, text) => {
        console.log(`[Bot] sendMessage to ${chatId}: "${text.substring(0, 30)}..."`);
        return Promise.resolve();
    },
    deleteMessage: (chatId, msgId) => {
        console.log(`[Bot] deleteMessage: ${chatId}:${msgId}`);
        return Promise.resolve();
    }
};

async function runTests() {

    // Test 1: Unauthorized User
    console.log('\n🔹 Test 1: Unauthorized User tries Delete');
    await handleAdminCallback(mockBot, {
        id: 'cb_1',
        from: { id: USER_ID },
        data: `admin:delete:${TEST_POLL_ID}`,
        message: { chat: { id: 123 }, message_id: 456 }
    });
    // Should see "Not Authorized" logic via answerCallbackQuery in logs? 
    // Wait, handleAdminCallback calls answerCallbackQuery with "⛔ Ruxsat yoq..."

    // Test 2: Admin requests Delete (Confirmation)
    console.log('\n🔹 Test 2: Admin requests Delete');
    await handleAdminCallback(mockBot, {
        id: 'cb_2',
        from: { id: ADMIN_ID },
        data: `admin:delete:${TEST_POLL_ID}`,
        message: { chat: { id: 123 }, message_id: 456 }
    });

    // Test 3: Admin Cancels Delete
    console.log('\n🔹 Test 3: Admin Cancel Delete');
    await handleAdminCallback(mockBot, {
        id: 'cb_3',
        from: { id: ADMIN_ID },
        data: `admin:cancel_delete:${TEST_POLL_ID}`,
        message: { chat: { id: 123 }, message_id: 456 }
    });

    // Test 4: Admin Confirms Delete
    console.log('\n🔹 Test 4: Admin Confirm Delete');
    await handleAdminCallback(mockBot, {
        id: 'cb_4',
        from: { id: ADMIN_ID },
        data: `admin:confirm_delete:${TEST_POLL_ID}`,
        message: { chat: { id: 123 }, message_id: 456 }
    });

    // Verify DB
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(TEST_POLL_ID);
    if (!poll) {
        console.log('✅ Success: Poll deleted from DB.');
    } else {
        console.log('❌ Failed: Poll still exists.');
    }
}

runTests();
