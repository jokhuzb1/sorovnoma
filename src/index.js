require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const db = require('./database');
const fs = require('fs');

const { handleVote, updatePollMessage, sendPoll, generatePollContent, generateSharablePollContent, checkChannelMembership, returnLinkMap, getPollResults } = require('./voting');
const { isAdmin, isSuperAdmin, handleAdminCallback, SUPER_ADMINS } = require('./admin');
const { saveDraft, getDraft, clearDraft } = require('./drafts');
const { handleWizardStep, startWizard, handleWizardCallback } = require('./poll_wizard');

// Validate Environment
if (!process.env.BOT_TOKEN) {
    console.error('CRITICAL: BOT_TOKEN is missing in .env');
    process.exit(1);
}

// Initialize Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log(`Bot started! Super Admin IDs: ${SUPER_ADMINS.join(', ')} `);

// STARTUP: Get Bot Username
let BOT_USERNAME = null;
bot.getMe().then(me => {
    BOT_USERNAME = me.username;
    console.log(`Bot username: ${BOT_USERNAME} `);
});


// --- DEEP LINK HANDLER & START COMMAND ---
bot.onText(/\/poll_(\d+)/, async (msg, match) => {
    const pollId = parseInt(match[1]);
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) {
        return bot.sendMessage(chatId, '❌ Sorovnoma topilmadi.');
    }

    // Check if user is admin or creator
    const isSuper = isSuperAdmin(userId);
    const isCreator = poll.creator_id === userId;
    const canManage = isSuper || isCreator || isAdmin(userId);

    if (canManage) {
        // Show management options
        await refreshManagementMessage(bot, chatId, null, pollId, true);
    } else {
        // Just send the poll
        await sendPoll(bot, chatId, pollId, BOT_USERNAME);
    }
});

// Handle /newpoll command - redirect to wizard
bot.onText(/\/newpoll$/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '⛔ You are not authorized.');
    }
    // Start Wizard
    startWizard(bot, userId, chatId);
});

bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const param = match[1] ? match[1].trim() : '';

    // TRACK USER
    try {
        db.prepare('INSERT OR IGNORE INTO users (user_id, first_name, username) VALUES (?, ?, ?)').run(
            userId, msg.from.first_name, msg.from.username
        );
    } catch (e) { }

    // CHECK ADMIN STATUS
    const isSuper = isSuperAdmin(userId);
    let isAdminUser = isSuper;
    if (!isAdminUser) {
        const adminEntry = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(userId);
        if (adminEntry) isAdminUser = true;
    }

    // HANDLE DEEP LINKS
    if (param) {
        if (param.startsWith('poll_')) {
            const pollId = param.split('_')[1];
            return await sendPoll(bot, chatId, pollId, BOT_USERNAME);
        }

        // --- VOTE LINK HANDLER ---
        if (param.startsWith('v_')) {
            const parts = param.split('_'); // v, pollId, optionId
            if (parts.length === 3) {
                const pollId = parseInt(parts[1], 10);
                const optionId = parseInt(parts[2], 10);

                // Simulate Callback Query Object for handleVote
                const mockQuery = {
                    id: `vote_link_${Date.now()}`,
                    from: msg.from,
                    data: `vote:${pollId}:${optionId}`,
                    message: null, // No specific message to edit directly (handleVote uses global update)
                    inline_message_id: null
                };

                // Helper to mimic bot.answerCallbackQuery for this simulated call
                const originalAnswerCallbackQuery = bot.answerCallbackQuery;
                bot.answerCallbackQuery = async (queryId, options = {}) => {
                    const text = options.text || 'Notification';
                    const show_alert = options.show_alert;
                    await bot.sendMessage(chatId, (show_alert ? '⚠️ ' : '✅ ') + text);
                };

                try {
                    await handleVote(bot, mockQuery, BOT_USERNAME);
                } catch (e) {
                    bot.sendMessage(chatId, '❌ Xatolik yuz berdi.');
                } finally {
                    bot.answerCallbackQuery = originalAnswerCallbackQuery;
                }
                return;
            }
        }

        if (param.startsWith('verify_')) {
            const pollId = parseInt(param.replace('verify_', ''), 10);
            if (isNaN(pollId)) return bot.sendMessage(chatId, '❌ Xato havolasi.');

            const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
            const missing = await checkChannelMembership(bot, userId, requiredChannels);

            if (missing.length === 0) {
                await bot.sendMessage(chatId, '✅ **Siz barcha kanallarga a\'zo bo\'lgansiz!**\n\nMarhamat, ovoz bering:', { parse_mode: 'Markdown' });
                await sendPoll(bot, chatId, pollId, BOT_USERNAME);
                // Option to go back logic...
                const returnLink = returnLinkMap.get(userId);
                if (returnLink) {
                    bot.sendMessage(chatId, 'Yoki avvalgi chatga qaytishingiz mumkin:', {
                        reply_markup: {
                            inline_keyboard: [[{ text: '🔙 Chatga qaytish', url: returnLink }]]
                        }
                    });
                    returnLinkMap.delete(userId);
                }
                return;
            }

            const buttons = missing.map(ch => {
                let url = ch.url || (ch.channel_username ? `https://t.me/${ch.channel_username.replace('@', '')}` : 'https://t.me/');
                return [{ text: `📢 ${ch.channel_title || 'Kanal'}`, url: url }];
            });

            buttons.push([{ text: '✅ Obuna bo\'ldim', callback_data: `check_sub:${pollId}` }]);

            return bot.sendMessage(chatId, `🛑 **Ovoz berish uchun quyidagi kanallarga a'zo bo'ling:**`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }


    // --- MENU DISPLAY (Access Control) ---
    if (isAdminUser) {
        bot.sendMessage(chatId, `👋 Xush kelibsiz! ${isSuper ? '(Super Admin)' : '(Admin)'}`, {
            reply_markup: getMainMenu(userId)
        });
    } else {
        bot.sendMessage(chatId, `👋 Assalomu alaykum, ${msg.from.first_name}!\n\nBotdan foydalanish uchun kanallarda e'lon qilingan so'rovnomalarda qatnashing.`, {
            reply_markup: getMainMenu(userId)
        });
    }
});

// --- INLINE QUERY HANDLER (For Sharing) ---
bot.on('inline_query', async (query) => {
    const queryId = query.id;
    const queryText = query.query.trim();

    if (!queryText.startsWith('poll_')) {
        return bot.answerInlineQuery(queryId, []);
    }

    const pollId = parseInt(queryText.split('_')[1]);
    if (isNaN(pollId)) return bot.answerInlineQuery(queryId, []);

    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return bot.answerInlineQuery(queryId, []);

    // Use the SHARABLE content generator (Link-Based)
    const content = generateSharablePollContent(pollId, BOT_USERNAME);
    if (!content) return bot.answerInlineQuery(queryId, []);

    const { caption, reply_markup } = content;
    let result;

    if (poll.media_type === 'photo') {
        result = {
            type: 'photo',
            id: `poll_${pollId}`,
            photo_file_id: poll.media_id,
            caption: caption,
            parse_mode: 'HTML', // Added
            reply_markup: reply_markup
        };
    } else if (poll.media_type === 'video') {
        result = {
            type: 'video',
            id: `poll_${pollId}`,
            video_file_id: poll.media_id,
            title: 'Sorovnoma Video',
            caption: caption,
            parse_mode: 'HTML', // Added
            reply_markup: reply_markup
        };
    } else {
        result = {
            type: 'article',
            id: `poll_${pollId}`,
            title: 'Sorovnoma',
            input_message_content: {
                message_text: caption,
                parse_mode: 'HTML' // Added
            },
            reply_markup: reply_markup,
            description: poll.description
        };
    }

    try {
        await bot.answerInlineQuery(queryId, [result], { cache_time: 0, is_personal: true });
    } catch (e) {
        console.error('Inline Query Error:', e.message);
    }
});

// --- TRACK SHARED POLL INSTANCES ---
bot.on('chosen_inline_result', (result) => {
    const resultId = result.result_id;
    const inlineMessageId = result.inline_message_id;

    if (!resultId.startsWith('poll_') || !inlineMessageId) return;

    const pollId = parseInt(resultId.split('_')[1]);
    if (isNaN(pollId)) return;

    // Save to database for later updates
    try {
        db.prepare('INSERT OR IGNORE INTO shared_polls (poll_id, inline_message_id) VALUES (?, ?)').run(pollId, inlineMessageId);
        console.log(`[shared_poll] Tracked: Poll ${pollId} -> ${inlineMessageId}`);
    } catch (e) {
        console.error('[shared_poll] Error:', e.message);
    }
});

// --- HELPER: UPDATE ALL SHARED INSTANCES ---
async function updateSharedPolls(pollId) {
    // 1. Update Inline Shared Instances (Sharable Content)
    const sharedInstances = db.prepare('SELECT inline_message_id FROM shared_polls WHERE poll_id = ?').all(pollId);

    if (sharedInstances.length > 0) {
        const content = generateSharablePollContent(pollId, BOT_USERNAME);
        if (content) {
            for (const instance of sharedInstances) {
                try {
                    await bot.editMessageCaption(content.caption, {
                        inline_message_id: instance.inline_message_id,
                        reply_markup: content.reply_markup,
                        parse_mode: 'HTML' // Changed from Markdown
                    });
                } catch (e) {
                    if (e.message.includes('message is not modified')) continue;
                    if (e.message.includes('MESSAGE_ID_INVALID')) {
                        db.prepare('DELETE FROM shared_polls WHERE inline_message_id = ?').run(instance.inline_message_id);
                    }
                    console.error('[shared_poll] Update error:', e.message);
                }
            }
        }
    }

    // 2. Update Direct Messages (Poll Messages in Groups/Private)
    const directMessages = db.prepare('SELECT chat_id, message_id FROM poll_messages WHERE poll_id = ?').all(pollId);

    if (directMessages.length > 0) {
        // Use updatePollMessage helper which handles button-based content
        for (const msg of directMessages) {
            // We don't await strictly to avoid blocking everything (parallel-ish)
            updatePollMessage(bot, msg.chat_id, msg.message_id, pollId, null, BOT_USERNAME)
                .catch(e => {
                    // Cleanup invalid messages
                    if (e.message.includes('chat not found') || e.message.includes('forbidden') || e.message.includes('message to edit not found')) {
                        db.prepare('DELETE FROM poll_messages WHERE chat_id = ? AND message_id = ?').run(msg.chat_id, msg.message_id);
                    }
                });
        }
    }
}

// Export globally for voting.js to call
global.updateSharedPolls = updateSharedPolls;

// Helper to List Polls (Interactive & Paginated)
async function sendPollList(bot, chatId, userId, type = 'active', page = 0, msgId = null) {
    const isSuper = isSuperAdmin(userId);
    const limit = 10;
    const offset = page * limit;
    let query, countQuery, params = [];

    // Filter Logic
    let filterClause = '';
    if (type === 'active') {
        filterClause = 'AND (start_time IS NULL OR start_time <= CURRENT_TIMESTAMP) AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP)';
    }

    if (isSuper) {
        query = `SELECT * FROM polls WHERE 1=1 ${filterClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        countQuery = `SELECT COUNT(*) as count FROM polls WHERE 1=1 ${filterClause}`;
    } else {
        query = `SELECT * FROM polls WHERE creator_id = ? ${filterClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        countQuery = `SELECT COUNT(*) as count FROM polls WHERE creator_id = ? ${filterClause}`;
        params.push(userId);
    }

    // Execute
    const polls = db.prepare(query).all(...params, limit, offset);
    const totalCount = db.prepare(countQuery).get(...params).count;

    // Build UI
    const buttons = [];
    polls.forEach(p => {
        let statusIcon = '🟢';
        const now = new Date();
        const start = p.start_time ? new Date(p.start_time) : now;
        const end = p.end_time ? new Date(p.end_time) : null;

        if (now < start) statusIcon = '⏳';
        if (end && now > end) statusIcon = '🔒';

        // Button Label: ID | Desc | Status
        // Truncate desc
        let desc = p.description.replace(/\n/g, ' ').substring(0, 20);
        if (p.description.length > 20) desc += '...';

        buttons.push([{ text: `${statusIcon} #${p.id} - ${desc}`, callback_data: `manage:${p.id}` }]);
    });

    // Navigation Buttons
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '⬅️ Oldingi', callback_data: `plist:${type}:${page - 1}` });
    }

    // Page Indicator
    navRow.push({ text: `📄 ${page + 1}/${Math.ceil(totalCount / limit) || 1}`, callback_data: 'ignore' });

    if ((page + 1) * limit < totalCount) {
        navRow.push({ text: 'Keyingi ➡️', callback_data: `plist:${type}:${page + 1}` });
    }
    buttons.push(navRow);

    // Tools Row
    buttons.push([
        { text: '🔍 ID bo\'yicha qidirish', callback_data: 'search_poll_prompt' },
        { text: '🔄 Yangilash', callback_data: `plist:${type}:${page}` }
    ]);

    const title = type === 'active' ? '🟢 **Aktiv Sorovnomalar**' : '📋 **Barcha Sorovnomalar**';
    const text = `${title}\n\nJami: ${totalCount} ta\nBoshqarish uchun tanlang:`;

    if (msgId) {
        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (e) { /* ignore no-mod */ }
    } else {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }
}

// Global Poll Search State (Simple Map)
// userId -> true (waiting for input)
const searchState = new Map();

// --- HELPER: MAIN MENU ---
function getMainMenu(userId) {
    const isSuper = isSuperAdmin(userId);
    let isAdminUser = isSuper;
    if (!isAdminUser) {
        const adminEntry = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(userId);
        if (adminEntry) isAdminUser = true;
    }

    if (isAdminUser) {
        const keyboard = [
            ['➕ Yangi So\'rovnoma', '⚙️ Sorovnomalar (Aktiv)'], // Renamed
            ['📋 Sorovnomalar (Barchasi)', '📊 Statistika'],   // Added
            ['ℹ️ Yordam']
        ];
        if (isSuper) {
            keyboard.push(['📢 Yangilik Yuborish', '👤 Adminlar']);
        }
        return {
            keyboard: keyboard,
            resize_keyboard: true,
            one_time_keyboard: false
        };
    }
    return {
        keyboard: [['ℹ️ Yordam']],
        resize_keyboard: true,
        one_time_keyboard: false
    };
}

// BROADCAST STATE
const broadcastState = new Map();

// CONSOLIDATED MESSAGE HANDLER
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Check if handling wizard step (Returns true if wizard handled it)
    if (await handleWizardStep(bot, msg)) return;

    if (!text) return; // Non-text messages not in wizard ignored down here

    // --- SEARCH PROMPT HANDLER ---
    if (searchState.get(userId)) {
        if (text.toLowerCase() === '/cancel') {
            searchState.delete(userId);
            return bot.sendMessage(chatId, '❌ Qidiruv bekor qilindi.');
        }

        const pollId = parseInt(text);
        if (!isNaN(pollId)) {
            // Check if exists
            const poll = db.prepare('SELECT id FROM polls WHERE id = ?').get(pollId);
            if (poll) {
                searchState.delete(userId);
                await refreshManagementMessage(bot, chatId, null, pollId, true);
                return;
            } else {
                return bot.sendMessage(chatId, '❌ Bunday ID li sorovnoma topilmadi.\nQayta urinib koring yoki /cancel:', {
                    reply_markup: { remove_keyboard: true }
                });
            }
        } else {
            return bot.sendMessage(chatId, '⚠️ Iltimos, raqam (ID) kiriting:');
        }
    }

    // Handle "Yangi Sorovnoma" button
    if (text === '➕ Yangi So\'rovnoma') {
        if (!isAdmin(userId)) return bot.sendMessage(chatId, '⛔ You are not authorized.', { reply_markup: getMainMenu(userId) });
        startWizard(bot, userId, chatId);
        return;
    }

    // Handle "Sorovnomalar (Aktiv)" button (Formerly Boshqarish)
    if (text === '⚙️ Sorovnomalar (Aktiv)' || text === '⚙️ Boshqarish') { // Legacy support
        if (!isAdmin(userId)) return;
        return sendPollList(bot, chatId, userId, 'active', 0);
    }
    // Handle "Sorovnomalar (Barchasi)" button
    if (text === '📋 Sorovnomalar (Barchasi)' || text === '⏳ Boshqarish (Aktiv)') {
        if (!isAdmin(userId)) return;
        return sendPollList(bot, chatId, userId, 'all', 0);
    }

    // Handle "Yordam"
    if (text === 'ℹ️ Yordam') {
        const helpText = `📖 **Yordam**\n\n` +
            `**Sorovnoma yaratish:**\n` +
            `1. "📝 Yangi Sorovnoma" tugmasini bosing\n` +
            `2. Media yuklang (ixtiyoriy)\n` +
            `3. Formani to'ldiring\n` +
            `4. "Yaratish" tugmasini bosing\n\n` +
            `**Sorovnomalarni boshqarish:**\n` +
            `- "⚙️ Sorovnomalar" tugmasidan foydalaning\n` +
            `- Ro'yxatdan tanlab, boshqarishingiz mumkin`;

        return bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown', reply_markup: getMainMenu(userId) });
    }

    // Handle "Statistika"
    if (text === '📊 Statistika') {
        if (!isAdmin(userId)) return;

        const isSuper = isSuperAdmin(userId);
        let pollCount, voteCount;
        if (isSuper) {
            pollCount = db.prepare('SELECT COUNT(*) as count FROM polls').get().count;
            voteCount = db.prepare('SELECT COUNT(*) as count FROM votes').get().count;
        } else {
            pollCount = db.prepare('SELECT COUNT(*) as count FROM polls WHERE creator_id = ?').get(userId).count;
            voteCount = db.prepare('SELECT COUNT(*) as count FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE creator_id = ?)').get(userId).count;
        }
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

        return bot.sendMessage(chatId, `📊 **Statistika**\n\n📝 Sorovnomalar: ${pollCount}\n✅ Ovozlar: ${voteCount}\n👥 Foydalanuvchilar: ${userCount}`, { parse_mode: 'Markdown', reply_markup: getMainMenu(userId) });
    }

    // Handle "👤 Adminlar" button
    if (text === '👤 Adminlar' || text === '👥 Adminlar') {
        if (!isSuperAdmin(userId)) return;

        const admins = db.prepare('SELECT * FROM admins').all();
        const buttons = admins.map(a => {
            const roleBadge = a.role === 'super_admin' ? '🌟' : '👤';
            return [{ text: `${roleBadge} ${a.user_id}`, callback_data: `admin_info:${a.user_id}` }, { text: '🗑️ O\'chirish', callback_data: `super:remove:${a.user_id}` }];
        });

        buttons.push([{ text: '➕ Admin Qo\'shish', callback_data: 'super:add' }]);
        buttons.push([{ text: '➕ SUPER Admin Qo\'shish', callback_data: 'super:add_super' }]);

        return bot.sendMessage(chatId, '👮 **Adminlar Boshqaruvi**:\n\n🌟 = Super Admin\n👤 = Oddiy Admin', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    // Handle Broadcast Command
    if (text === '📢 Yangilik Yuborish') {
        if (!isSuperAdmin(userId)) return;
        broadcastState.set(userId, { step: 'ask_message' });
        return bot.sendMessage(chatId, '📢 <b>Yangilik matnini yuboring</b> (rasm/video ham mumkin):\n\nBekor qilish uchun /cancel', { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }

    // Handle Broadcast State
    if (broadcastState.has(userId)) {
        const state = broadcastState.get(userId);
        if (text === '/cancel') {
            broadcastState.delete(userId);
            return bot.sendMessage(chatId, '❌ Bekor qilindi.', {
                reply_markup: getMainMenu(userId)
            });
        }

        if (state.step === 'ask_message') {
            // Confirm
            broadcastState.set(userId, { step: 'confirm', message: msg });
            try {
                await bot.copyMessage(chatId, chatId, msg.message_id);
            } catch (e) { }

            return bot.sendMessage(chatId, '⚠️ <b>Xabarni tasdiqlaysizmi?</b>\n\nBarcha foydalanuvchilarga yuboriladi!', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Yuborish', callback_data: 'broadcast_propagate' }],
                        [{ text: '❌ Bekor qilish', callback_data: 'broadcast_cancel' }]
                    ]
                }
            });
        }
    }
});


// Callbacks
bot.on('callback_query', async (query) => {
    const { from, data, message } = query;
    const userId = from.id;

    // POLL LIST PAGINATION
    if (data.startsWith('plist:')) {
        const parts = data.split(':');
        const type = parts[1];
        const page = parseInt(parts[2]);
        await sendPollList(bot, message.chat.id, userId, type, page, message.message_id);
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // POLL SEARCH PROMPT
    if (data === 'search_poll_prompt') {
        searchState.set(userId, true);
        await bot.sendMessage(message.chat.id, '🔍 **Qidirilayotgan Sorovnoma ID sini kiriting:**\n(Bekor qilish uchun /cancel)');
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // MANAGE POLL (Detailed View)
    if (data.startsWith('manage:')) {
        const pollId = parseInt(data.split(':')[1]);
        await refreshManagementMessage(bot, message.chat.id, message.message_id, pollId);
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // IGNORE (Pagination Spacer)
    if (data === 'ignore') {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // Wizard Callbacks
    if (data.startsWith('wiz_')) {
        handleWizardCallback(bot, query);
        return;
    }

    // Broadcast Callbacks
    if (data === 'broadcast_cancel') {
        broadcastState.delete(userId);
        await bot.deleteMessage(message.chat.id, message.message_id);
        return bot.sendMessage(message.chat.id, '❌ Bekor qilindi.', {
            reply_markup: { keyboard: [['📝 Yangi Sorovnoma', '⚙️ Boshqarish'], ['👤 Adminlar', 'ℹ️ Yordam']], resize_keyboard: true }
        });
    }
    if (data === 'broadcast_propagate') {
        const state = broadcastState.get(userId);
        if (!state || !state.message) return bot.answerCallbackQuery(query.id, { text: 'Eskirgan sessiya.' });

        await bot.editMessageText('⏳ <b>Yuborilmoqda...</b>', { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'HTML' });

        const users = db.prepare('SELECT user_id FROM users').all();
        let sent = 0;
        let blocked = 0;

        (async () => {
            // Optimization: Use Promise.all with chunks or just loop
            for (const user of users) {
                try {
                    await bot.copyMessage(user.user_id, state.message.chat.id, state.message.message_id);
                    sent++;
                } catch (e) { blocked++; }
                // Delay to avoid flood limits
                await new Promise(r => setTimeout(r, 40));
            }
            bot.sendMessage(message.chat.id, `✅ <b>Yuborildi!</b>\n\n✅ Qabul qildi: ${sent}\n🚫 Blokladi/Yopdi: ${blocked}`, { parse_mode: 'HTML' });
        })();

        broadcastState.delete(userId);
        return bot.answerCallbackQuery(query.id, { text: 'Boshlandi!' });
    }

    // Verify / Check Subscription
    if (data.startsWith('check_sub:')) {
        const pollId = parseInt(data.split(':')[1]);
        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length === 0) {
            await bot.answerCallbackQuery(query.id, { text: '✅ Tasdiqlandi! Ovoz berishingiz mumkin.', show_alert: true });
        } else {
            const missingTitles = missing.map(m => m.channel_title || 'Kanal').join(', ');
            await bot.answerCallbackQuery(query.id, { text: `❌ Hali ${missingTitles} ga a'zo bo'lmadingiz.`, show_alert: true });
        }
        return;
    }

    // Admin Actions
    if (data.startsWith('admin:') || data.startsWith('super:') || data.startsWith('delete:')) {
        handleAdminAction(bot, query);
        return;
    }

    // Results
    if (data.startsWith('results:')) {
        const pollId = parseInt(data.split(':')[1]);
        const resultsText = getPollResults(pollId);
        try {
            await bot.sendMessage(userId, resultsText, { parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(query.id, { text: '📊 Natijalar xususiy xabarda yuborildi.' });
        } catch (e) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Botga admin sifatida yozing', show_alert: true });
        }
        return;
    }

    // Send Poll (Manual Trigger)
    if (data.startsWith('send_poll:')) {
        const pollId = parseInt(data.split(':')[1]);
        await sendPoll(bot, message.chat.id, pollId, BOT_USERNAME);
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // Default Vote Handler
    handleVote(bot, query, BOT_USERNAME);
});


// Helper for Admin Actions
async function handleAdminAction(bot, query) {
    const { from, data, message } = query;
    const msgId = message.message_id;
    const chatId = message.chat.id;

    if (data.startsWith('admin:stop:')) {
        const pollId = parseInt(data.split(':')[1]);
        db.prepare('UPDATE polls SET end_time = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
        await bot.answerCallbackQuery(query.id, { text: 'Toxtatildi' });
        await refreshManagementMessage(bot, chatId, msgId, pollId);
    }

    if (data.startsWith('admin:start:')) {
        const pollId = parseInt(data.split(':')[1]);
        db.prepare("UPDATE polls SET start_time = datetime('now', '-1 minute'), end_time = NULL WHERE id = ?").run(pollId);
        await bot.answerCallbackQuery(query.id, { text: 'Boshlandi' });
        await refreshManagementMessage(bot, chatId, msgId, pollId);
    }

    if (data.startsWith('delete:') || data.startsWith('admin:delete:')) {
        const parts = data.split(':');
        const pollId = parseInt(parts[parts.length - 1]);

        // Ask for confirmation
        if (!data.includes('confirm') && !data.includes('cancel')) {
            const buttons = [
                [
                    { text: '✅ HA, Ochirilsin', callback_data: `admin:delete:confirm:${pollId}` },
                    { text: '❌ Bekor qilish', callback_data: `admin:delete:cancel:${pollId}` }
                ]
            ];
            await bot.editMessageText(`⚠️ **DIQQAT!**\n\nSorovnoma #${pollId} ni ochirmoqchimisiz?`, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (data.includes('confirm')) {
            db.prepare('DELETE FROM polls WHERE id = ?').run(pollId);
            await bot.answerCallbackQuery(query.id, { text: 'Ochirildi' });
            await bot.deleteMessage(chatId, msgId).catch(() => { });
            await bot.sendMessage(chatId, `🗑️ Sorovnoma #${pollId} ochirildi.`);
        } else if (data.includes('cancel')) {
            await bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
            await refreshManagementMessage(bot, chatId, msgId, pollId);
        }
    }
}

// Updated Helper for Management Message (Supports sending New or Editing)
async function refreshManagementMessage(bot, chatId, msgId, pollId, isNew = false) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return;

    const buttons = [
        [{ text: '📊 Natijalar', callback_data: `results:${pollId}` }],
        [
            { text: '🟢 Boshlash', callback_data: `admin:start:${pollId}` },
            { text: '🛑 Toxtatish', callback_data: `admin:stop:${pollId}` }
        ],
        [{ text: '📤 Yuborish', callback_data: `send_poll:${pollId}` }],
        [{ text: '🗑️ O\'chirish', callback_data: `delete:${pollId}` }]
    ];

    // Determine status
    const now = new Date();
    const start = poll.start_time ? new Date(poll.start_time) : null;
    const end = poll.end_time ? new Date(poll.end_time) : null;
    let status = '🟢 Ochiq';
    if (start && now < start) status = '⏳ Boshlanmagan';
    if (end && now > end) status = '🔒 Yopiq';

    const text = `🆔 **Poll #${pollId}**\n\n📝 ${poll.description}\n\n📊 Status: ${status}\n\nQanday amal bajarasiz?`;

    try {
        if (isNew || !msgId) {
            await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    } catch (e) {
        // Ignore "message is not modified"
    }
}
