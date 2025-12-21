const db = require('../database/db');
const { isAdmin, isSuperAdmin } = require('../services/adminService');
const { sendPoll, getPollResults } = require('../services/pollService');

async function handleAdminCallback(bot, query) {
    const { from, data, message } = query;
    const parts = data.split(':');
    const action = parts[1];
    // Dynamic parts...

    if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: '⛔ Not Authorized', show_alert: true });

    try {
        /* --- POLL ACTIONS --- */
        if (action === 'start') {
            const pollId = parts[2];
            db.prepare("UPDATE polls SET start_time = datetime('now', '-1 minute'), end_time = NULL WHERE id = ?").run(pollId);
            bot.answerCallbackQuery(query.id, { text: '🟢 Boshlandi' });
            refreshManagementMessage(bot, message.chat.id, message.message_id, pollId);
        }
        else if (action === 'stop') {
            const pollId = parts[2];
            db.prepare('UPDATE polls SET end_time = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
            bot.answerCallbackQuery(query.id, { text: '🛑 Toxtatildi' });
            refreshManagementMessage(bot, message.chat.id, message.message_id, pollId);
        }
        else if (action === 'results') {
            const pollId = parts[2];
            bot.answerCallbackQuery(query.id);
            // Send results as new message or alert? Original sent text.
            const resultsText = getPollResults(pollId);
            try {
                await bot.sendMessage(from.id, resultsText, { parse_mode: 'Markdown' });
            } catch (e) {
                bot.sendMessage(message.chat.id, resultsText, { parse_mode: 'Markdown' });
            }
        }
        else if (action === 'delete') {
            const pollId = parts[2];
            const buttons = [[{ text: '✅ HA, Ochirilsin', callback_data: `admin:confirm_delete:${pollId}` }, { text: '❌ Bekor qilish', callback_data: `admin:cancel_delete:${pollId}` }]];
            bot.editMessageText(`⚠️ **DIQQAT!**\n\nSorovnoma #${pollId} ni ochirmoqchimisiz?`, { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
            bot.answerCallbackQuery(query.id);
        }
        else if (action === 'confirm_delete') {
            const pollId = parts[2];
            db.prepare('DELETE FROM polls WHERE id = ?').run(pollId);
            bot.answerCallbackQuery(query.id, { text: 'Ochirildi' });
            bot.deleteMessage(message.chat.id, message.message_id).catch(() => { });
            bot.sendMessage(message.chat.id, `🗑️ Sorovnoma #${pollId} ochirildi.`);
        }
        else if (action === 'cancel_delete') {
            const pollId = parts[2];
            bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
            refreshManagementMessage(bot, message.chat.id, message.message_id, pollId);
        }
    } catch (e) {
        console.error('Admin Handler Error:', e);
        bot.answerCallbackQuery(query.id, { text: 'Xatolik' });
    }
}

async function handleSuperAdminAction(bot, query) {
    const { from, data, message } = query;
    const parts = data.split(':');
    const action = parts[1];

    if (!isSuperAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: '⛔ Super Admin Only', show_alert: true });

    if (action === 'add') {
        // This needs state. For now, simple prompt or instruction.
        // Original had "admin:add" and state? 
        // Let's rely on basic text prompt if we can't easily add state here without session.
        // OR send a force_reply?
        bot.sendMessage(message.chat.id, '🆔 Admin qilmoqchi bo\'lgan foydalanuvchi ID sini va rolini yuboring:\nFormat: `/add_admin 123456789 admin`');
        bot.answerCallbackQuery(query.id);
    }
    else if (action === 'remove') {
        const targetId = parts[2];
        db.prepare('DELETE FROM admins WHERE user_id = ?').run(targetId);
        bot.answerCallbackQuery(query.id, { text: 'Ochirildi' });
        // Refresh list?
        bot.editMessageText('Admin ochirildi. Qayta /admins bosing.', { chat_id: message.chat.id, message_id: message.message_id });
    }
    else if (action === 'info') { // admin_info
        // Show details?
        bot.answerCallbackQuery(query.id, { text: 'Details...' });
    }
}

async function refreshManagementMessage(bot, chatId, msgId, pollId, isNew = false) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return;

    const buttons = [
        [{ text: '📊 Natijalar', callback_data: `admin:results:${pollId}` }],
        [
            { text: '🟢 Boshlash', callback_data: `admin:start:${pollId}` },
            { text: '🛑 Toxtatish', callback_data: `admin:stop:${pollId}` }
        ],
        [{ text: '📤 Yuborish', callback_data: `send_poll:${pollId}` }],
        [{ text: '🗑️ O\'chirish', callback_data: `admin:delete:${pollId}` }]
    ];

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
    } catch (e) { }
}

module.exports = { handleAdminCallback, handleSuperAdminAction, refreshManagementMessage };
