require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./database/db');
const { handleMessage, sendPollList } = require('./handlers/messageHandler');
const { handleVote } = require('./handlers/voteHandler');
const { handleAdminCallback, handleSuperAdminAction, refreshManagementMessage, handleBroadcastCallback } = require('./handlers/adminHandler');
const { handleWizardCallback } = require('./handlers/wizardHandler');
const { MESSAGES } = require('./config/constants');
const { generateSharablePollContent, sendPoll } = require('./services/pollService');
const { SUPER_ADMINS } = require('./services/adminService');

// Notification Helper
const notifyAdmins = async (error) => {
    const errorMsg = `🚨 **BOT ERROR:**\n\n\`${error.message || error}\``;
    /*
    for (const adminId of SUPER_ADMINS) {
        try {
            await bot.sendMessage(adminId, errorMsg, { parse_mode: 'Markdown' });
        } catch (e) { console.error('Notify fail:', e.message); }
    }
    */
    // Use Promise.all for speed
    await Promise.all(SUPER_ADMINS.map(id =>
        bot.sendMessage(id, errorMsg, { parse_mode: 'Markdown' }).catch(e => console.error('Notify fail:', e.message))
    ));
};

if (!process.env.BOT_TOKEN) {
    console.error('BOT_TOKEN missing');
    process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
console.log('Bot Started (Refactored)');

// Get Bot Username
let BOT_USERNAME = '';
bot.getMe().then(me => {
    BOT_USERNAME = me.username;
    console.log(`Username: ${BOT_USERNAME}`);
    const { SUPER_ADMINS } = require('./services/adminService');
    console.log('DEBUG SUPER_ADMINS:', SUPER_ADMINS);
});

// --- ROUTER ---
// (Imports moved to top)
// (Admin imports moved to top)
// ...

// /add_admin command
bot.onText(/\/add_admin (\d+) ?(.*)/, (msg, match) => {
    const userId = msg.from.id;
    // Check super admin
    const { isSuperAdmin } = require('./services/adminService'); // Require inside to ensure DB init? Or top level fine.
    if (!isSuperAdmin(userId)) return;

    const targetId = match[1];
    const role = match[2] || 'admin';
    try {
        db.prepare('INSERT OR REPLACE INTO admins (user_id, role) VALUES (?, ?)').run(targetId, role);
        bot.sendMessage(msg.chat.id, `✅ Admin qo'shildi: ${targetId} (${role})`);
    } catch (e) {
        bot.sendMessage(msg.chat.id, '❌ Xatolik: ' + e.message);
    }
});

bot.on('message', (msg) => {
    handleMessage(bot, msg).catch(async (e) => {
        console.error('HandleMessage Error:', e);
        await notifyAdmins(e);
    });
});

bot.on('callback_query', async (query) => {
    const { data } = query;
    if (data.startsWith('vote:') || data.startsWith('results:') || data.startsWith('check_sub:')) {
        handleVote(bot, query, BOT_USERNAME);
    } else if (data.startsWith('admin:')) {
        handleAdminCallback(bot, query);
    } else if (data.startsWith('broadcast:')) {
        handleBroadcastCallback(bot, query);
    } else if (data.startsWith('super:')) {
        // Needs extraction
        if (data.startsWith('super:remove')) {
            // Handle remove in handleSuperAdminAction? Yes
            handleSuperAdminAction(bot, query);
        } else if (data === 'super:add') {
            handleSuperAdminAction(bot, query);
        }
    } else if (data.startsWith('wiz_') || data.startsWith('cal:') || data.startsWith('time:')) {
        handleWizardCallback(bot, query);
    } else if (data.startsWith('manage:')) {
        const pollId = data.split(':')[1];
        await refreshManagementMessage(bot, query.message.chat.id, query.message.message_id, pollId);
        await bot.answerCallbackQuery(query.id).catch(() => { });
    } else if (data.startsWith('plist:')) {
        // plist:type:page
        const parts = data.split(':');
        const type = parts[1];
        const page = parseInt(parts[2]);
        await sendPollList(bot, query.message.chat.id, query.from.id, type, page, query.message.message_id);
        await bot.answerCallbackQuery(query.id).catch(() => { });
    } else if (data.startsWith('send_poll:')) {
        const pollId = data.split(':')[1];
        await sendPoll(bot, query.message.chat.id, pollId, BOT_USERNAME);
        await bot.answerCallbackQuery(query.id).catch(() => { });
    } else if (data === 'search_poll_prompt') {
        // Simple prompt logic? Or redirect?
        // searchState? need to move searchState to messageHandler or a global service.
        // For now, simple text response:
        bot.sendMessage(query.message.chat.id, 'Use /search ID');
        bot.answerCallbackQuery(query.id).catch(() => { });
    } else {
        bot.answerCallbackQuery(query.id).catch(() => { });
    }
});

bot.on('inline_query', async (query) => {
    const queryText = query.query.trim();
    if (queryText.startsWith('poll_')) {
        const pollId = parseInt(queryText.split('_')[1]);
        const content = generateSharablePollContent(pollId, BOT_USERNAME);
        if (content) {
            const { poll, caption, reply_markup } = content;
            let result;

            if (poll.media_type === 'photo') {
                result = {
                    type: 'photo',
                    id: `poll_${pollId}`,
                    photo_file_id: poll.media_id,
                    caption: caption,
                    parse_mode: 'HTML',
                    reply_markup: reply_markup
                };
            } else if (poll.media_type === 'video') {
                result = {
                    type: 'video',
                    id: `poll_${pollId}`,
                    video_file_id: poll.media_id,
                    title: 'Poll Video',
                    caption: caption,
                    parse_mode: 'HTML',
                    reply_markup: reply_markup
                };
            } else {
                result = {
                    type: 'article',
                    id: `poll_${pollId}`,
                    title: 'Poll',
                    input_message_content: { message_text: caption, parse_mode: 'HTML' },
                    reply_markup: reply_markup,
                    description: poll.description
                };
            }

            bot.answerInlineQuery(query.id, [result], { cache_time: 0 });
        }
    }
});

// Global Error Handlers
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await notifyAdmins(`Uncaught Exception: ${error.message}\nStack: ${error.stack}`);
    // process.exit(1); // Optional: restart if using Docker/PM2 (recommended)
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    await notifyAdmins(`Unhandled Rejection: ${reason.message || reason}`);
});
