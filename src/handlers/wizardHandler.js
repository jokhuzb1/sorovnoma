const db = require('../database/db');
const sessionService = require('../services/sessionService');
const { sendPoll } = require('../services/pollService');
const { MESSAGES } = require('../config/constants');

const { getCalendarKeyboard, getTimeKeyboard } = require('../utils/calendarUtils');

const WIZARD_STEPS = {
    MEDIA: 'media',
    QUESTION: 'question',
    OPTIONS: 'options',
    SETTINGS: 'settings',
    CHANNELS: 'channels',
    START_TIME: 'start_time',
    END_TIME: 'end_time',
    CONFIRM: 'confirm'
};


const { verifyBotAdmin } = require('../services/channelService'); // Import verification service

const startWizard = async (bot, userId, chatId) => {
    // ... (startWizard content unchanged for now, just preserving context if needed, but we are editing handleWizardStep below mostly)
    // Actually startWizard is separate.
    sessionService.updateWizardSession(userId, {
        step: WIZARD_STEPS.MEDIA,
        data: {
            question: '',
            options: [],
            settings: { multiple_choice: false, allow_edit: false },
            channels: [],
            media: null,
            start_time: null,
            end_time: null
        }
    });

    bot.sendMessage(chatId, '📸 *Media yuklash*\n\nSorovnoma uchun rasm yoki video yuboring.\n\nYoki "O\'tkazib yuborish" tugmasini bosing.', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⏭️ O\'tkazib yuborish', callback_data: 'wiz_skip_media' }]
            ]
        }
    });
};

const handleWizardStep = async (bot, msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = sessionService.getWizardSession(userId);

    if (!session) return false;

    const text = msg.text;

    // --- BUG FIX: Check for Global Commands ---
    const globalCommands = Object.values(MESSAGES);
    if (text && (globalCommands.includes(text) || text.startsWith('/'))) {
        if (text === '/cancel') {
            sessionService.clearWizardSession(userId);
            bot.sendMessage(chatId, '❌ Bekor qilindi.');
            return true;
        }
        sessionService.clearWizardSession(userId);
        return false;
    }

    const step = session.step;

    /* --- STEP 1: MEDIA --- */
    if (step === WIZARD_STEPS.MEDIA) {
        if (msg.photo) {
            const photoId = msg.photo[msg.photo.length - 1].file_id;
            sessionService.updateWizardSession(userId, { data: { ...session.data, media: { type: 'photo', id: photoId } }, step: WIZARD_STEPS.QUESTION });
            bot.sendMessage(chatId, '📝 *Savolni kiriting:*\n\nMasalan: "Qaysi rangni yoqtirasiz?"');
            return true;
        } else if (msg.video) {
            const videoId = msg.video.file_id;
            sessionService.updateWizardSession(userId, { data: { ...session.data, media: { type: 'video', id: videoId } }, step: WIZARD_STEPS.QUESTION });
            bot.sendMessage(chatId, '📝 *Savolni kiriting:*\n\nMasalan: "Qaysi rangni yoqtirasiz?"');
            return true;
        } else if (text) {
            bot.sendMessage(chatId, '⚠️ Iltimos, rasm/video yuboring yoki tugmani bosing.');
            return true;
        }
    }

    /* --- STEP 2: QUESTION --- */
    if (step === WIZARD_STEPS.QUESTION) {
        if (!text) return true;
        sessionService.updateWizardSession(userId, { data: { ...session.data, question: text }, step: WIZARD_STEPS.OPTIONS });
        bot.sendMessage(chatId, '📋 *Variantlarni kiriting*\n\nBirinchi variantni yuboring:', { parse_mode: 'Markdown' });
        return true;
    }

    /* --- STEP 3: OPTIONS --- */
    if (step === WIZARD_STEPS.OPTIONS) {
        if (!text) return true;
        const currentOptions = session.data.options || [];
        currentOptions.push(text);
        sessionService.updateWizardSession(userId, { data: { ...session.data, options: currentOptions } });

        const count = currentOptions.length;
        const optsText = currentOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');
        const keyboard = [];
        if (count >= 2) keyboard.push([{ text: '✅ Tayyor', callback_data: 'wiz_options_done' }]);

        bot.sendMessage(chatId, `✅ *Variant qoshildi!*\n\n${optsText}\n\nKeyingi variantni yuboring ${count >= 2 ? 'yoki "Tayyor" ni bosing.' : '.'}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return true;
    }

    /* --- STEP 4: SETTINGS --- */
    if (step === WIZARD_STEPS.SETTINGS) {
        return true; // Wait for buttons
    }

    /* --- STEP 5: CHANNELS --- */
    if (step === WIZARD_STEPS.CHANNELS) {
        if (text) {
            const channels = text.split(/[,\s]+/).filter(c => c.length > 1);
            const validChannels = [];
            const invalidChannels = [];

            for (const ch of channels) {
                let username = ch.replace('https://t.me/', '').replace('@', '');
                username = '@' + username; // Normalized

                const result = await verifyBotAdmin(bot, username);
                if (result.success) {
                    validChannels.push(username); // Can store title if needed, currently storing username string
                } else {
                    invalidChannels.push(`${username} (${result.error})`);
                }
            }

            if (validChannels.length > 0) {
                const currentChannels = session.data.channels || [];
                const newChannels = [...new Set([...currentChannels, ...validChannels])]; // Unique
                sessionService.updateWizardSession(userId, { data: { ...session.data, channels: newChannels } });

                const escapeMd = (str) => str.replace(/_/g, '\\_'); // Escape underscores for Markdown

                let msg = `✅ *Muvaffaqiyatli qo'shildi:*\n${validChannels.map(escapeMd).join('\n')}\n`;
                if (invalidChannels.length > 0) {
                    msg += `\n❌ *Qo'shilmadi (Bot admin emas yoki xato):*\n${invalidChannels.map(escapeMd).join('\n')}\n`;
                }
                msg += `\nYana qo'shishingiz yoki "✅ Tayyor" tugmasini bosishingiz mumkin.`;

                bot.sendMessage(chatId, msg, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: 'wiz_channels_done' }]] }
                });
            } else if (invalidChannels.length > 0) {
                bot.sendMessage(chatId, `❌ *Hech qaysi kanal qoshilmadi:*\n\n${invalidChannels.join('\n')}\n\nIltimos, botni admin qiling va qayta urinib ko'ring.`);
            }
        }
        return true;
    }

    /* --- STEP 6, 7: TIME (Interaction only) --- */
    if (step === WIZARD_STEPS.START_TIME || step === WIZARD_STEPS.END_TIME) {
        return true; // Wait for inline input
    }

    return false;
};

const handleWizardCallback = async (bot, query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;
    const session = sessionService.getWizardSession(userId);

    // Allow cal/time callbacks even if step check is loose, but strict is better
    if (!session && !data.startsWith('wiz_') && !data.startsWith('cal:') && !data.startsWith('time:')) return;

    if (data === 'wiz_skip_media') {
        if (!session) return bot.answerCallbackQuery(query.id, { text: 'Sessiya eskirgan.' });
        sessionService.updateWizardSession(userId, { data: { ...session.data, media: null }, step: WIZARD_STEPS.QUESTION });
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, '📝 **Savolni kiriting:**');
        return;
    }

    if (data === 'wiz_options_done') {
        if (!session || session.step !== WIZARD_STEPS.OPTIONS) return bot.answerCallbackQuery(query.id);
        if (session.data.options.length < 2) return bot.answerCallbackQuery(query.id, { text: '⚠️ Kamida 2 ta variant kerak!', show_alert: true });

        sessionService.updateWizardSession(userId, { step: WIZARD_STEPS.SETTINGS });
        sendSettingsMenu(bot, chatId, session.data.settings);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('wiz_set:')) {
        if (!session || session.step !== WIZARD_STEPS.SETTINGS) return bot.answerCallbackQuery(query.id);
        const setting = data.split(':')[1];
        const currentSettings = session.data.settings;

        if (setting === 'multi') currentSettings.multiple_choice = !currentSettings.multiple_choice;
        else if (setting === 'edit') currentSettings.allow_edit = !currentSettings.allow_edit;
        else if (setting === 'done') {
            sessionService.updateWizardSession(userId, { step: WIZARD_STEPS.CHANNELS });
            bot.editMessageText('📢 *Majburiy kanallarni sozlash*\n\nKanallar username-larini yuboring (masalan: @kanal).\n\nYoki "O\'tkazib yuborish" tugmasini bosing.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⏭️ O\'tkazib yuborish', callback_data: 'wiz_channels_skip' }]] }
            });
            return;
        }

        sessionService.updateWizardSession(userId, { data: { ...session.data, settings: currentSettings } });
        editSettingsMenu(bot, chatId, query.message.message_id, currentSettings);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data === 'wiz_channels_skip' || data === 'wiz_channels_done') {
        if (!session) return;

        // Move to Start Time
        sessionService.updateWizardSession(userId, { step: WIZARD_STEPS.START_TIME });

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        // Show Prompt
        bot.sendMessage(chatId, '⏳ *Boshlanish vaqtini belgilash*\n\nSorovnoma qachon boshlanishini xohlaysiz?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📅 Vaqtni tanlash', callback_data: 'cal:start' }],
                    [{ text: '⏭️ O\'tkazib yuborish (Hozir)', callback_data: 'wiz_skip_start' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // --- START / END TIME HANDLERS ---

    // 1. Initial Triggers
    if (data === 'cal:start') {
        const now = new Date();
        const kb = getCalendarKeyboard(now.getFullYear(), now.getMonth());
        bot.editMessageText('📅 *Boshlanish sanasini tanlang:*', {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: kb
        });
        return bot.answerCallbackQuery(query.id);
    }

    if (data === 'wiz_skip_start') {
        sessionService.updateWizardSession(userId, { step: WIZARD_STEPS.END_TIME, data: { ...session.data, start_time: null } });
        bot.editMessageText('⏳ *Tugash vaqtini belgilash*\n\nSorovnoma qachon tugashini xohlaysiz?', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📅 Vaqtni tanlash', callback_data: 'cal:end' }],
                    [{ text: '⏭️ O\'tkazib yuborish (Cheksiz)', callback_data: 'wiz_skip_end' }]
                ]
            }
        });
        return bot.answerCallbackQuery(query.id);
    }

    if (data === 'cal:end') {
        // Use logic start time or now
        const now = new Date();
        const kb = getCalendarKeyboard(now.getFullYear(), now.getMonth());
        bot.editMessageText('📅 *Tugash sanasini tanlang:*', {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: kb
        });
        return bot.answerCallbackQuery(query.id);
    }

    if (data === 'wiz_skip_end') {
        if (!session) return bot.answerCallbackQuery(query.id, { text: 'Sessiya eskirgan.' });
        sessionService.updateWizardSession(userId, { step: WIZARD_STEPS.CONFIRM, data: { ...session.data, end_time: null } });
        showConfirmation(bot, chatId, sessionService.getWizardSession(userId).data);
        return bot.answerCallbackQuery(query.id);
    }

    // 2. Calendar Navigation
    if (data.startsWith('cal:nav:')) {
        const [_, __, yStr, mStr] = data.split(':');
        const kb = getCalendarKeyboard(parseInt(yStr), parseInt(mStr));
        const currentStep = session.step === WIZARD_STEPS.START_TIME ? 'Boshlanish' : 'Tugash';
        bot.editMessageText(`📅 *${currentStep} sanasini tanlang:*`, {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: kb
        });
        return bot.answerCallbackQuery(query.id);
    }

    // 3. Date Selected -> Show Hour
    if (data.startsWith('cal:date:')) {
        const dateStr = data.split(':')[2];
        const kb = getTimeKeyboard(dateStr, 'hour');
        bot.editMessageText(`🕒 *Soatni tanlang:* (${dateStr})`, {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: kb
        });
        return bot.answerCallbackQuery(query.id);
    }

    // 4. Hour Selected -> Show Minute
    if (data.startsWith('time:h:')) {
        const [_, __, dateStr, hour] = data.split(':');
        const kb = getTimeKeyboard(dateStr, 'minute', hour);
        bot.editMessageText(`🕒 *Daqiqani tanlang:* (${dateStr} ${hour}:00)`, {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: kb
        });
        return bot.answerCallbackQuery(query.id);
    }

    // 5. Minute Selected -> Save & Next
    if (data.startsWith('time:m:')) {
        const [_, __, dateStr, hour, minute] = data.split(':');
        const fullTimeStr = `${dateStr} ${hour}:${minute}:00`; // SQL Format

        if (session.step === WIZARD_STEPS.START_TIME) {
            sessionService.updateWizardSession(userId, {
                step: WIZARD_STEPS.END_TIME,
                data: { ...session.data, start_time: fullTimeStr }
            });
            // Prompt End Time
            bot.editMessageText(`✅ Boshlanish vaqti: ${fullTimeStr}\n\n⏳ *Tugash vaqtini belgilash*`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📅 Vaqtni tanlash', callback_data: 'cal:end' }],
                        [{ text: '⏭️ O\'tkazib yuborish (Cheksiz)', callback_data: 'wiz_skip_end' }]
                    ]
                }
            });
        } else if (session.step === WIZARD_STEPS.END_TIME) {
            sessionService.updateWizardSession(userId, {
                step: WIZARD_STEPS.CONFIRM,
                data: { ...session.data, end_time: fullTimeStr }
            });
            showConfirmation(bot, chatId, sessionService.getWizardSession(userId).data);
        }
        return bot.answerCallbackQuery(query.id);
    }

    // --- EXISTING ---

    if (data === 'wiz_create') {
        if (!session) return;
        await createPollInDb(bot, userId, session.data);
        sessionService.clearWizardSession(userId);
        bot.answerCallbackQuery(query.id, { text: '✅ Sorovnoma yaratildi!' });
        return;
    }

    if (data === 'wiz_cancel') {
        sessionService.clearWizardSession(userId);
        bot.sendMessage(chatId, '❌ Bekor qilindi.');
        bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
        return;
    }
};

const sendSettingsMenu = (bot, chatId, settings) => {
    const keyboard = [
        [
            { text: `${settings.multiple_choice ? '✅' : '⬜'} Ko'p tanlovli`, callback_data: 'wiz_set:multi' },
            { text: `${settings.allow_edit ? '✅' : '⬜'} Ovozni o'zgartirish`, callback_data: 'wiz_set:edit' }
        ],
        [{ text: 'Davom etish ➡️', callback_data: 'wiz_set:done' }]
    ];
    bot.sendMessage(chatId, '⚙️ *Sozlamalar*', { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' });
};

const editSettingsMenu = (bot, chatId, msgId, settings) => {
    const keyboard = [
        [
            { text: `${settings.multiple_choice ? '✅' : '⬜'} Ko'p tanlovli`, callback_data: 'wiz_set:multi' },
            { text: `${settings.allow_edit ? '✅' : '⬜'} Ovozni o'zgartirish`, callback_data: 'wiz_set:edit' }
        ],
        [{ text: 'Davom etish ➡️', callback_data: 'wiz_set:done' }]
    ];
    bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: msgId });
};

const showConfirmation = async (bot, chatId, data) => {
    let text = `📝 *Sorovnoma Tasdiqlash*\n\n❓ *Savol:* ${data.question}\n\n📋 *Variantlar:*\n${data.options.map(o => `- ${o}`).join('\n')}\n\n⚙️ *Sozlamalar:*\n- Ko'p tanlovli: ${data.settings.multiple_choice ? '✅' : '❌'}\n- O'zgartirish: ${data.settings.allow_edit ? '✅' : '❌'}\n\n📢 *Kanallar:* ${data.channels.length > 0 ? data.channels.join(', ') : 'Yo\'q'}\n`;

    text += `\n🕒 *Vaqt:*\n`;
    text += `- Boshlanish: ${data.start_time || 'Hozir'}\n`;
    text += `- Tugash: ${data.end_time || 'Cheksiz'}\n`;

    const markup = { inline_keyboard: [[{ text: '✅ Yaratish', callback_data: 'wiz_create' }], [{ text: '❌ Bekor qilish', callback_data: 'wiz_cancel' }]] };

    if (data.media) {
        if (data.media.type === 'photo') await bot.sendPhoto(chatId, data.media.id, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
        else if (data.media.type === 'video') await bot.sendVideo(chatId, data.media.id, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
    }
};

const createPollInDb = async (bot, userId, data) => {
    try {
        const stmt = db.prepare(`INSERT INTO polls (media_id, media_type, description, settings_json, start_time, end_time, creator_id, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const mediaId = data.media ? data.media.id : null;
        const mediaType = data.media ? data.media.type : 'none';

        const info = stmt.run(mediaId, mediaType, data.question, JSON.stringify(data.settings), data.start_time, data.end_time, userId, 1);
        const pollId = info.lastInsertRowid;

        const insertOption = db.prepare('INSERT INTO options (poll_id, text) VALUES (?, ?)');
        data.options.forEach(opt => insertOption.run(pollId, opt));

        const insertChannel = db.prepare('INSERT INTO required_channels (poll_id, channel_username, channel_id, channel_title) VALUES (?, ?, ?, ?)');
        for (const ch of data.channels) {
            insertChannel.run(pollId, ch, null, ch);
        }

        // Format Dates
        const startStr = data.start_time ? new Date(data.start_time).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }) : 'Belgilanmagan';
        const endStr = data.end_time ? new Date(data.end_time).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }) : 'Belgilanmagan';

        await bot.sendMessage(userId, `✅ *Sorovnoma tayyor!*\n\n🆔 ID: #${pollId}\n🕑 Boshlanish: ${startStr}\n🏁 Tugash: ${endStr}`);
        await sendPoll(bot, userId, pollId, (await bot.getMe()).username);
    } catch (e) {
        console.error('DB Error:', e);
        bot.sendMessage(userId, '❌ Xatolik yuz berdi: ' + e.message);
    }
};

module.exports = { startWizard, handleWizardStep, handleWizardCallback };
