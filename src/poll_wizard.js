const db = require('./database');
const { saveDraft, getDraft, clearDraft } = require('./drafts');
const { sendPoll } = require('./voting');

// Wizard States
const WIZARD_STEPS = {
    MEDIA: 'media',
    QUESTION: 'question',
    OPTIONS: 'options',
    SETTINGS: 'settings',
    CHANNELS: 'channels',
    CONFIRM: 'confirm'
};

// In-memory state (can be moved to DB if persistence needed across restarts, but Map is fine for active sessions)
const wizardSessions = new Map();

// Helper to get session
const getSession = (userId) => wizardSessions.get(userId);

// Helper to save session
const updateSession = (userId, data) => {
    const current = wizardSessions.get(userId) || {};
    wizardSessions.set(userId, { ...current, ...data });
};

// Clear session
const clearSession = (userId) => {
    wizardSessions.delete(userId);
    clearDraft(userId);
};

// Start Wizard
const startWizard = async (bot, userId, chatId) => {
    // Initialize session
    wizardSessions.set(userId, {
        step: WIZARD_STEPS.MEDIA,
        data: {
            question: '',
            options: [],
            settings: { multiple_choice: false, allow_edit: false },
            channels: [], // Array of strings (usernames or links)
            media: null
        }
    });

    bot.sendMessage(chatId, '📸 **Media yuklash**\n\nSorovnoma uchun rasm yoki video yuboring.\n\nYoki "O\'tkazib yuborish" tugmasini bosing.', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⏭️ O\'tkazib yuborish', callback_data: 'wiz_skip_media' }]
            ]
        }
    });
};

// Handle Incoming Message (Text/Photo/Video)
const handleWizardStep = async (bot, msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = getSession(userId);

    if (!session) return false; // Not in wizard mode

    const text = msg.text;
    const step = session.step;

    if (text === '/cancel') {
        clearSession(userId);
        bot.sendMessage(chatId, '❌ Bekor qilindi.');
        return true;
    }

    /* --- STEP 1: MEDIA (Handled via generic message or callback) --- */
    if (step === WIZARD_STEPS.MEDIA) {
        if (msg.photo) {
            const photoId = msg.photo[msg.photo.length - 1].file_id;
            updateSession(userId, { data: { ...session.data, media: { type: 'photo', id: photoId } }, step: WIZARD_STEPS.QUESTION });
            bot.sendMessage(chatId, '📝 **Savolni kiriting:**\n\nMasalan: "Qaysi rangni yoqtirasiz?"');
            return true;
        } else if (msg.video) {
            const videoId = msg.video.file_id;
            updateSession(userId, { data: { ...session.data, media: { type: 'video', id: videoId } }, step: WIZARD_STEPS.QUESTION });
            bot.sendMessage(chatId, '📝 **Savolni kiriting:**\n\nMasalan: "Qaysi rangni yoqtirasiz?"');
            return true;
        } else if (text) {
            bot.sendMessage(chatId, '⚠️ Iltimos, rasm/video yuboring yoki tugmani bosing.');
            // Don't advance step, but consume message
            return true;
        }
    }

    /* --- STEP 2: QUESTION --- */
    if (step === WIZARD_STEPS.QUESTION) {
        if (!text) return true; // ignore non-text
        updateSession(userId, { data: { ...session.data, question: text }, step: WIZARD_STEPS.OPTIONS });
        bot.sendMessage(chatId, '📋 **Variantlarni kiriting**\n\nBirinchi variantni yuboring:', { parse_mode: 'Markdown' });
        return true;
    }

    /* --- STEP 3: OPTIONS --- */
    if (step === WIZARD_STEPS.OPTIONS) {
        if (!text) return true;

        const currentOptions = session.data.options || [];
        // Check for duplicates? Maybe not strictly needed.
        currentOptions.push(text);

        updateSession(userId, { data: { ...session.data, options: currentOptions } });

        const count = currentOptions.length;
        const optsText = currentOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');

        const keyboard = [];
        if (count >= 2) {
            keyboard.push([{ text: '✅ Tayyor', callback_data: 'wiz_options_done' }]);
        }

        bot.sendMessage(chatId, `✅ **Variant qoshildi!**\n\n${optsText}\n\nKeyingi variantni yuboring ${count >= 2 ? 'yoki "Tayyor" ni bosing.' : '.'}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return true;
    }

    /* --- STEP 4: SETTINGS (Handled mostly via callbacks, but maybe next step trigger) --- */
    if (step === WIZARD_STEPS.SETTINGS) {
        // If they type something, maybe ignore or say "Press Done"
        if (text === '/next' || text.toLowerCase() === 'keyingisi') {
            // Check settings?
        }
        return true;
    }

    /* --- STEP 5: CHANNELS --- */
    if (step === WIZARD_STEPS.CHANNELS) {
        if (text) {
            // Add channel
            // Basic validation: must start with @ or be a link?
            // Let's assume username for simplicity or robust parser.
            // We can accept comma separated list.
            const channels = text.split(/[,\s]+/).filter(c => c.length > 1);
            const validChannels = [];

            // Verify channels
            for (const ch of channels) {
                let username = ch.replace('https://t.me/', '').replace('@', '');
                try {
                    const chat = await bot.getChat('@' + username);
                    validChannels.push('@' + username);
                } catch (e) {
                    bot.sendMessage(chatId, `❌ Kanal topilmadi yoki bot admin emas: ${ch}\n\nIltimos tekshirib qayta yuboring yoki o'tkazib yuboring (/skip).`);
                    return true;
                }
            }

            if (validChannels.length > 0) {
                const currentChannels = session.data.channels || [];
                updateSession(userId, { data: { ...session.data, channels: [...currentChannels, ...validChannels] } });
                bot.sendMessage(chatId, `✅ Qo'shildi: ${validChannels.join(', ')}\n\nYana qo'shishingiz yoki "✅ Tayyor" tugmasini bosishingiz mumkin.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '✅ Tayyor', callback_data: 'wiz_channels_done' }]]
                    }
                });
            }
        }
        return true;
    }

    return false;
};

// Handle Callbacks
const handleWizardCallback = async (bot, query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;
    const session = getSession(userId);

    if (!session && !data.startsWith('wiz_')) return; // Should allow wiz_start?

    /* --- SKIP MEDIA --- */
    if (data === 'wiz_skip_media') {
        if (!session) return bot.answerCallbackQuery(query.id, { text: 'Sessiya eskirgan.' });
        updateSession(userId, { data: { ...session.data, media: null }, step: WIZARD_STEPS.QUESTION });
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, '📝 **Savolni kiriting:**');
        return;
    }

    /* --- OPTIONS DONE --- */
    if (data === 'wiz_options_done') {
        if (!session || session.step !== WIZARD_STEPS.OPTIONS) return bot.answerCallbackQuery(query.id);

        const options = session.data.options;
        if (!options || options.length < 2) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Kamida 2 ta variant kerak!', show_alert: true });
        }

        updateSession(userId, { step: WIZARD_STEPS.SETTINGS });
        sendSettingsMenu(bot, chatId, session.data.settings);
        bot.answerCallbackQuery(query.id);
        return;
    }

    /* --- SETTINGS TOGGLES --- */
    if (data.startsWith('wiz_set:')) {
        if (!session || session.step !== WIZARD_STEPS.SETTINGS) return bot.answerCallbackQuery(query.id);
        const setting = data.split(':')[1];
        const currentSettings = session.data.settings;

        if (setting === 'multi') currentSettings.multiple_choice = !currentSettings.multiple_choice;
        else if (setting === 'edit') currentSettings.allow_edit = !currentSettings.allow_edit;
        else if (setting === 'done') {
            // Move to next step
            updateSession(userId, { step: WIZARD_STEPS.CHANNELS });
            bot.editMessageText('📢 **Majburiy kanallarni sozlash**\n\nFoydalanuvchi ovoz berish uchun a\'zo bo\'lishi kerak bo\'lgan kanallar username-larini yuboring (masalan: @kanal).\n\nAgar shart bo\'lmasa, "O\'tkazib yuborish" tugmasini bosing.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '⏭️ O\'tkazib yuborish', callback_data: 'wiz_channels_skip' }]]
                }
            });
            return;
        }

        updateSession(userId, { data: { ...session.data, settings: currentSettings } });
        // Update UI
        editSettingsMenu(bot, chatId, query.message.message_id, currentSettings);
        bot.answerCallbackQuery(query.id);
        return;
    }

    /* --- CHANNELS FLOW --- */
    if (data === 'wiz_channels_skip' || data === 'wiz_channels_done') {
        if (!session) return;
        updateSession(userId, { step: WIZARD_STEPS.CONFIRM });
        showConfirmation(bot, chatId, getSession(userId).data);
        bot.answerCallbackQuery(query.id);
        return;
    }

    /* --- CONFIRMATION --- */
    if (data === 'wiz_create') {
        if (!session) return;
        await createPollInDb(bot, userId, session.data);
        clearSession(userId);
        bot.answerCallbackQuery(query.id, { text: '✅ Sorovnoma yaratildi!' });
        return;
    }

    if (data === 'wiz_cancel') {
        clearSession(userId);
        bot.sendMessage(chatId, '❌ Bekor qilindi.');
        bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
        return;
    }
};

// UI Helpers
const sendSettingsMenu = (bot, chatId, settings) => {
    const keyboard = [
        [
            { text: `${settings.multiple_choice ? '✅' : '⬜'} Ko'p tanlovli`, callback_data: 'wiz_set:multi' },
            { text: `${settings.allow_edit ? '✅' : '⬜'} Ovozni o'zgartirish`, callback_data: 'wiz_set:edit' }
        ],
        [{ text: 'Davom etish ➡️', callback_data: 'wiz_set:done' }]
    ];

    bot.sendMessage(chatId, '⚙️ **Sozlamalar**\n\nKerakli opsiyalarni tanlang:', {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
    });
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
    let text = `📝 **Sorovnoma Tasdiqlash**\n\n`;
    text += `❓ **Savol:** ${data.question}\n\n`;
    text += `📋 **Variantlar:**\n${data.options.map(o => `- ${o}`).join('\n')}\n\n`;
    text += `⚙️ **Sozlamalar:**\n`;
    text += `- Ko'p tanlovli: ${data.settings.multiple_choice ? '✅' : '❌'}\n`;
    text += `- O'zgartirish: ${data.settings.allow_edit ? '✅' : '❌'}\n\n`;
    text += `📢 **Kanallar:** ${data.channels.length > 0 ? data.channels.join(', ') : 'Yo\'q'}\n`;

    if (data.media) {
        if (data.media.type === 'photo') {
            await bot.sendPhoto(chatId, data.media.id, {
                caption: text, parse_mode: 'Markdown', reply_markup: {
                    inline_keyboard: [[{ text: '✅ Yaratish', callback_data: 'wiz_create' }], [{ text: '❌ Bekor qilish', callback_data: 'wiz_cancel' }]]
                }
            });
        } else if (data.media.type === 'video') {
            await bot.sendVideo(chatId, data.media.id, {
                caption: text, parse_mode: 'Markdown', reply_markup: {
                    inline_keyboard: [[{ text: '✅ Yaratish', callback_data: 'wiz_create' }], [{ text: '❌ Bekor qilish', callback_data: 'wiz_cancel' }]]
                }
            });
        }
    } else {
        bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown', reply_markup: {
                inline_keyboard: [[{ text: '✅ Yaratish', callback_data: 'wiz_create' }], [{ text: '❌ Bekor qilish', callback_data: 'wiz_cancel' }]]
            }
        });
    }
};

const createPollInDb = async (bot, userId, data) => {
    try {
        const published = 1;
        const now = Date.now();
        const settings = JSON.stringify(data.settings);

        const stmt = db.prepare(`
            INSERT INTO polls (
                media_id, media_type, description, settings_json, start_time, end_time, creator_id, published
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const mediaId = data.media ? data.media.id : null;
        const mediaType = data.media ? data.media.type : 'none';

        const info = stmt.run(
            mediaId, mediaType, data.question, settings, null, null, userId, published
        );
        const pollId = info.lastInsertRowid;

        // Options
        const insertOption = db.prepare('INSERT INTO options (poll_id, text) VALUES (?, ?)');
        data.options.forEach(opt => insertOption.run(pollId, opt));

        // Channels
        if (data.channels && data.channels.length > 0) {
            const insertChannel = db.prepare('INSERT INTO required_channels (poll_id, channel_username, channel_id, channel_title) VALUES (?, ?, ?, ?)');
            for (const ch of data.channels) {
                // We resolve again or just store? Better resolve.
                try {
                    const chat = await bot.getChat(ch);
                    const title = chat.title || chat.username || ch;
                    insertChannel.run(pollId, ch, chat.id, title);
                } catch (e) {
                    // Fallback to username if getChat fails (bot not admin yet)
                    // We try to save it anyway so they can add bot later
                    insertChannel.run(pollId, ch, null, ch);
                    console.error('Failed to resolve channel:', ch, e.message);
                }
            }
        }

        // Send
        await bot.sendMessage(userId, `✅ **Sorovnoma tayyor!**\nID: #${pollId}`);
        await sendPoll(bot, userId, pollId, (await bot.getMe()).username);

    } catch (e) {
        console.error('DB Error:', e);
        bot.sendMessage(userId, '❌ Xatolik yuz berdi: ' + e.message);
    }
};

module.exports = { startWizard, handleWizardStep, handleWizardCallback };
