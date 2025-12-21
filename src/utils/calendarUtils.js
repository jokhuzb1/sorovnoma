const getCalendarKeyboard = (year, month) => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay(); // 0 = Sun
    // Adjust for Monday start (Telegram standard usually)
    const startDay = firstDay === 0 ? 6 : firstDay - 1;

    const monthNames = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentyabr", "Oktyabr", "Noyabr", "Dekabr"];
    const currentMonthName = monthNames[month];

    const keyboard = [];

    // Header: Month Year
    keyboard.push([{ text: `${currentMonthName} ${year}`, callback_data: 'ignore' }]);

    // Days Header
    keyboard.push([
        { text: 'Du', callback_data: 'ignore' },
        { text: 'Se', callback_data: 'ignore' },
        { text: 'Ch', callback_data: 'ignore' },
        { text: 'Pa', callback_data: 'ignore' },
        { text: 'Ju', callback_data: 'ignore' },
        { text: 'Sh', callback_data: 'ignore' },
        { text: 'Ya', callback_data: 'ignore' }
    ]);

    let row = [];
    // Empty slots
    for (let i = 0; i < startDay; i++) {
        row.push({ text: ' ', callback_data: 'ignore' });
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        row.push({ text: String(day), callback_data: `cal:date:${dateStr}` });

        if (row.length === 7) {
            keyboard.push(row);
            row = [];
        }
    }

    if (row.length > 0) {
        // Fill remaining
        while (row.length < 7) {
            row.push({ text: ' ', callback_data: 'ignore' });
        }
        keyboard.push(row);
    }

    // Navigation
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;

    keyboard.push([
        { text: '⬅️', callback_data: `cal:nav:${prevYear}:${prevMonth}` },
        { text: '❌ Bekor qilish', callback_data: 'wiz_cancel' }, // Contextual cancel
        { text: '➡️', callback_data: `cal:nav:${nextYear}:${nextMonth}` }
    ]);

    return { inline_keyboard: keyboard };
};

const getTimeKeyboard = (dateStr, type = 'hour', selectedHour = null) => {
    const keyboard = [];

    if (type === 'hour') {
        const rows = 4; // 6 cols x 4 rows = 24 hours
        let hour = 0;
        for (let r = 0; r < rows; r++) {
            const rowArr = [];
            for (let c = 0; c < 6; c++) {
                const h = String(hour).padStart(2, '0');
                rowArr.push({ text: h, callback_data: `time:h:${dateStr}:${h}` });
                hour++;
            }
            keyboard.push(rowArr);
        }
        keyboard.push([{ text: '🔙 Ortga', callback_data: `cal:nav:${dateStr.split('-')[0]}:${parseInt(dateStr.split('-')[1]) - 1}` }]); // Back to calendar
    } else if (type === 'minute') {
        // 00, 05, 10 ... 55
        const row1 = [];
        const row2 = [];
        for (let m = 0; m < 60; m += 5) {
            const min = String(m).padStart(2, '0');
            const btn = { text: min, callback_data: `time:m:${dateStr}:${selectedHour}:${min}` };
            if (m < 30) row1.push(btn);
            else row2.push(btn);
        }
        keyboard.push(row1);
        keyboard.push(row2);
        keyboard.push([{ text: '🔙 Ortga', callback_data: `cal:date:${dateStr}` }]); // Back to hour pick (technically re-trigger date pick resets to hour? actually strictly back to hour would be better but keeping simple)
    }

    return { inline_keyboard: keyboard };
};

module.exports = { getCalendarKeyboard, getTimeKeyboard };
