const db = require('../database/db');
const { isAdmin, isSuperAdmin } = require('../services/adminService');
const { startWizard, handleWizardStep } = require('./wizardHandler');
const { sendPoll } = require('../services/pollService');
const { MESSAGES } = require('../config/constants');
const sessionService = require('../services/sessionService');

// Broadcast State (In-memory)
const broadcastState = new Map();
const adminState = new Map();

async function handleMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // 0. Save User
    saveUser(msg.from);

    // 1. Wizard Check
    if (await handleWizardStep(bot, msg)) return;

    // --- Admin Add State ---
    if (adminState.has(userId)) {
        if (text === '/cancel') {
            adminState.delete(userId);
            return bot.sendMessage(chatId, '❌ Bekor qilindi.', { reply_markup: getMainMenu(userId) });
        }

        const state = adminState.get(userId);
        if (state.step === 'waiting_for_id') {
            // Validate ID
            if (!/^\d+$/.test(text)) {
                return bot.sendMessage(chatId, '⚠️ Iltimos, faqat raqamli ID yuboring (yoki /cancel):');
            }

            const targetId = parseInt(text, 10);
            try {
                // Always create as SUPER ADMIN as requested
                db.prepare('INSERT OR REPLACE INTO admins (user_id, role) VALUES (?, ?)').run(targetId, 'super_admin');
                bot.sendMessage(chatId, `✅ **Muvaffaqiyatli!**\n\nFoydalanuvchi (${targetId}) **Super Admin** etib tayinlandi.`);
            } catch (e) {
                bot.sendMessage(chatId, '❌ Xatolik: ' + e.message);
            }
            adminState.delete(userId);
            return;
        }
    }

    if (broadcastState.has(userId)) {
        const state = broadcastState.get(userId);
        if (text === '/cancel') {
            broadcastState.delete(userId);
            return bot.sendMessage(chatId, '❌ Bekor qilindi.', { reply_markup: getMainMenu(userId) });
        }

        if (state.step === 'ask_message') {
            // Capture Content
            const content = {};
            if (msg.photo) {
                content.type = 'photo';
                content.file_id = msg.photo[msg.photo.length - 1].file_id;
                content.caption = msg.caption;
            } else if (msg.video) {
                content.type = 'video';
                content.file_id = msg.video.file_id;
                content.caption = msg.caption;
            } else if (msg.text) {
                content.type = 'text';
                content.text = msg.text;
            } else {
                return bot.sendMessage(chatId, '⚠️ Faqat matn, rasm yoki video yuboring.');
            }

            broadcastState.set(userId, { step: 'confirm', content });

            // Show Confirmation
            const buttons = [[
                { text: '✅ Tasdiqlash', callback_data: 'broadcast:confirm' },
                { text: '❌ Bekor qilish', callback_data: 'broadcast:cancel' }
            ]];

            if (content.type === 'text') {
                return bot.sendMessage(chatId, `📢 **Xabar matni:**\n${content.text}\n\nXabarni barcha foydalanuvchilarga yuborasizmi?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
            } else {
                const method = content.type === 'photo' ? 'sendPhoto' : 'sendVideo';
                return bot[method](chatId, content.file_id, {
                    caption: `📢 **Xabar matni:**\n${content.caption || ''}\n\nXabarni barcha foydalanuvchilarga yuborasizmi?`,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buttons }
                });
            }
        }
    }

    // Broadcast Confirm Logic (above) ...

    if (!text) return;

    // --- /start Handler ---
    if (text.startsWith('/start')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            // Deep linking handling
            const payload = parts[1];
            if (payload.startsWith('poll_') || payload.startsWith('verify_')) {
                const pollId = payload.split('_')[1];
                const { sendPoll } = require('../services/pollService');
                const { checkChannelMembership } = require('../services/channelService');

                // Check channels
                const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
                if (requiredChannels.length > 0) {
                    const missing = await checkChannelMembership(bot, userId, requiredChannels);
                    if (missing.length > 0) {
                        let text = `⚠️ **Ovoz berish uchun quyidagi kanallarga a'zo bo'ling:**\n\n`;
                        const buttons = [];

                        missing.forEach(ch => {
                            text += `• ${ch.title}\n`;
                            if (ch.url) buttons.push([{ text: `➕ A'zo bo'lish (${ch.title})`, url: ch.url }]);
                        });

                        buttons.push([{ text: '✅ Tekshirish', callback_data: `check_sub:${pollId}` }]);

                        return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
                    }
                }

                await sendPoll(bot, chatId, pollId);
                return;
            }
        }

        // Default Welcome
        const welcomeText = `👋 **Assalomu alaykum!**\n\nSiz ushbu bot orqali so'rovnomalarda qatnashishingiz mumkin.\nAdminlar yangiliklari va so'rovnomalarini kuting.`;
        if (isAdmin(userId)) {
            return bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: getMainMenu(userId) });
        } else {
            return bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        }
    }

    // 2. Global Menu Handling
    if (text === MESSAGES.NEW_POLL) {
        if (!isAdmin(userId)) return bot.sendMessage(chatId, '⛔ Not Authorized');
        return startWizard(bot, userId, chatId);
    }

    if (text === MESSAGES.ACTIVE_POLLS || text === '⚙️ Boshqarish') {
        if (!isAdmin(userId)) return;
        return sendPollList(bot, chatId, userId, 'active', 0);
    }

    if (text === MESSAGES.ALL_POLLS) {
        if (!isAdmin(userId)) return;
        return sendPollList(bot, chatId, userId, 'all', 0);
    }

    if (text === MESSAGES.HELP) {
        const isSuper = isSuperAdmin(userId);
        let helpText = `📖 **Adminlar uchun Qo'llanma**\n\n`;
        helpText += `➕ **Yangi So'rovnoma**: Yangi ovoz berish jarayonini yaratish.\n`;
        helpText += `⚙️ **Aktiv So'rovnomalar**: Hozir ishlayotgan so'rovnomalarni boshqarish (To'xtatish, O'chirish).\n`;
        helpText += `📋 **Barchasi**: Barcha eski va yangi so'rovnomalar ro'yxati.\n`;
        helpText += `📊 **Statistika**: Bot foydalanuvchilari va ovozlar soni.\n`;

        if (isSuper) {
            helpText += `\n👤 **Adminlar**: Adminlarni boshqarish (faqat Super Admin).\n`;
            helpText += `📢 **Yangilik Yuborish**: Barcha foydalanuvchilarga xabar tarqatish.\n`;
        }

        helpText += `\n❓ Savollar bo'lsa @admin ga yozing.`;

        return bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown', reply_markup: getMainMenu(userId) });
    }

    if (text === MESSAGES.STATISTICS) {
        if (!isAdmin(userId)) return;
        const count = db.prepare('SELECT COUNT(*) as c FROM polls').get().c;
        const votes = db.prepare('SELECT COUNT(*) as c FROM votes').get().c;
        const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        return bot.sendMessage(chatId, `📊 **Statistika**\n\n🗳 Sorovnomalar: ${count}\n👥 Foydalanuvchilar: ${users}\n✅ Ovozlar: ${votes}`, { reply_markup: getMainMenu(userId) });
    }

    if (text === MESSAGES.ADMINS) {
        if (!isSuperAdmin(userId)) return;
        const admins = db.prepare('SELECT * FROM admins').all();
        const buttons = admins.map(a => [{ text: `👤 ${a.user_id} (${a.role})`, callback_data: `admin_info:${a.user_id}` }]);
        buttons.push([{ text: '➕ Add Admin', callback_data: 'super:add' }]);
        return bot.sendMessage(chatId, 'Admin Management', { reply_markup: { inline_keyboard: buttons } });
    }

    // Broadcast Logic
    if (text === MESSAGES.SEND_NEWS) {
        if (!isSuperAdmin(userId)) return;
        broadcastState.set(userId, { step: 'ask_message' });
        return bot.sendMessage(chatId, '📢 **Yangilik Yuborish**\n\nXabarni matn, rasm yoki video ko\'rinishida yuboring.\nBekor qilish uchun /cancel ni bosing.', { reply_markup: { remove_keyboard: true } }); // Hide menu temporarily? Or keep it. keeping for cancel logic.
    }

    // ... Broadcast confirm handled above ...

    // Default: Show Menu if Admin
    if (isAdmin(userId)) {
        bot.sendMessage(chatId, 'Menu:', { reply_markup: getMainMenu(userId) });
    }
}

function saveUser(user) {
    if (!user || user.is_bot) return;
    try {
        db.prepare('INSERT OR IGNORE INTO users (user_id, first_name, username) VALUES (?, ?, ?)').run(user.id, user.first_name, user.username);
    } catch (e) { }
}

module.exports = { handleMessage, sendPollList, broadcastState };


// Helper: Poll List (Interactive & Paginated)
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

        let desc = p.description.replace(/\n/g, ' ').substring(0, 20);
        if (p.description.length > 20) desc += '...';

        buttons.push([{ text: `${statusIcon} #${p.id} - ${desc}`, callback_data: `manage:${p.id}` }]);
    });



    // Navigation Buttons
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '⬅️ Oldingi', callback_data: `plist:${type}:${page - 1}` });
    }

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
        } catch (e) { /* ignore */ }
    } else {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }
}

function getMainMenu(userId) {
    const isSuper = isSuperAdmin(userId);

    if (isAdmin(userId)) {
        const keyboard = [
            [MESSAGES.NEW_POLL, MESSAGES.ACTIVE_POLLS],
            [MESSAGES.ALL_POLLS, MESSAGES.STATISTICS],
            [MESSAGES.HELP]
        ];
        if (isSuper) {
            keyboard.push([MESSAGES.SEND_NEWS, MESSAGES.ADMINS]);
        }
        return {
            keyboard: keyboard,
            resize_keyboard: true
        };
    }
    return { keyboard: [[MESSAGES.HELP]], resize_keyboard: true };
}

module.exports = { handleMessage, sendPollList, broadcastState, adminState };
