// Strict Channel Check Service

async function checkChannelMembership(bot, userId, requiredChannels) {
    const checks = requiredChannels.map(async (channel) => {
        const target = channel.channel_id || channel.channel_username;
        const title = channel.channel_title || channel.channel_username;

        try {
            const member = await bot.getChatMember(target, userId);
            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                const displayTitle = channel.channel_title || title || channel.channel_username;
                return { id: target, title: displayTitle, url: channel.channel_username ? `https://t.me/${channel.channel_username.replace('@', '')}` : null };
            }
        } catch (e) {
            const displayTitle = channel.channel_title || title;
            if (e.message.includes('bot is not a member') || e.message.includes('user not found')) {
                return { id: target, title: displayTitle, error: `Bot ${displayTitle} kanalida admin emas!` };
            }
            if (e.message.includes('chat not found')) {
                return { id: target, title: displayTitle, error: `Kanal topilmadi: ${displayTitle}` };
            }
            return { id: target, title: title, error: `Xatolik: ${e.message}` };
        }
        return null;
    });

    const results = await Promise.all(checks);
    return results.filter(r => r !== null);
}

async function verifyBotAdmin(bot, channelUsername) {
    try {
        const chat = await bot.getChat(channelUsername);
        const botId = (await bot.getMe()).id;
        const member = await bot.getChatMember(chat.id, botId);

        if (member.status === 'administrator' || member.status === 'creator') {
            return { success: true, title: chat.title, id: chat.id };
        } else {
            return { success: false, error: `Bot ${chat.title} kanalida admin emas!` };
        }
    } catch (e) {
        if (e.message.includes('chat not found')) {
            return { success: false, error: `Kanal topilmadi: ${channelUsername}` };
        }
        return { success: false, error: `Xatolik (${channelUsername}): ${e.message}` };
    }
}

module.exports = { checkChannelMembership, verifyBotAdmin };
