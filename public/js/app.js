const tg = window.Telegram.WebApp;
tg.expand(); // Full screen

// Theme handling
document.body.style.setProperty('--tg-theme-bg-color', tg.themeParams.bg_color);
document.body.style.setProperty('--tg-theme-text-color', tg.themeParams.text_color);

// Elements
const submitBtn = document.getElementById('submitBtn');
const addOptionBtn = document.getElementById('addOptionBtn');
const optionsContainer = document.getElementById('optionsContainer');
const fileInput = document.getElementById('mediaInput');
const fileLabel = document.getElementById('fileLabel');

// Add Option Logic
addOptionBtn.addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'option-row';
    div.innerHTML = `
        <input type="text" name="options[]" placeholder="Variant" required>
        <button type="button" class="btn-secondary" style="width: 40px;" onclick="this.parentElement.remove()">✕</button>
    `;
    optionsContainer.appendChild(div);

    // Focus the new input
    const newInput = div.querySelector('input');
    if (newInput) newInput.focus();
});

// File Preview Logic
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        fileLabel.innerText = '✅ Fajl tanlandi: ' + e.target.files[0].name;
    }
});

// Draft Media Logic
let draftMedia = null;

// Auto-Run on Init
if (tg.initDataUnsafe?.user?.id) {
    const userId = tg.initDataUnsafe.user.id;
    fetch(`/api/draft-media?user_id=${userId}`)
        .then(res => res.json())
        .then(data => {
            if (data.media) {
                draftMedia = data.media;
                // Update UI
                const typeName = draftMedia.type === 'video' ? 'Video' : 'Rasm';
                fileLabel.innerHTML = `✅ <b>${typeName} biriktirildi</b> (Chatdan olindi)`;
                fileLabel.className = 'w-full p-4 border-2 border-green-500 border-dashed rounded-xl text-center text-green-600 bg-green-50 cursor-not-allowed';
                fileInput.disabled = true; // Disable manual upload if draft exists

                // Add Reset Button (Optional, but good for UX)
                // For now, simplicity: if they want to change, they send new media to bot or just use this.
            }
        })
        .catch(err => console.error('Draft Check Failed:', err));
}

// Submit Logic
submitBtn.addEventListener('click', async () => {
    const form = document.getElementById('pollForm');
    const formData = new FormData(form);

    // Telegram User Data
    const user = tg.initDataUnsafe?.user;
    if (user) {
        formData.append('user_id', user.id);
        formData.append('first_name', user.first_name);

        // Inject Draft Media if available
        if (draftMedia) {
            formData.append('media_id', draftMedia.id);
            formData.append('media_type', draftMedia.type);
        }
    } else {
        // Fallback or error if not in Telegram (shouldn't happen in Prod but for safety)
        tg.showAlert('Foydalanuvchi aniqlanmadi (User Not Found)');
        return;
    }

    // --- Validation (Client Side) ---
    const questionInput = document.getElementById('question');
    const question = questionInput.value.trim();

    // Update input value to trimmed version for UX
    questionInput.value = question;

    // Get Options and Trim
    const optionInputs = document.querySelectorAll('input[name="options[]"]');
    const uniqueOptions = new Set();

    optionInputs.forEach(input => {
        const val = input.value.trim();
        if (val) uniqueOptions.add(val);
        input.value = val; // Auto-trim in UI
    });

    const options = Array.from(uniqueOptions);

    if (!question) {
        tg.showAlert('❌ Savol yozishni unutmang!');
        return;
    }

    if (options.length < 2) {
        tg.showAlert('❌ Kamida 2 ta farqli variant yozing!');
        return;
    }

    // Show Loader
    document.getElementById('loader').classList.remove('hidden');
    submitBtn.disabled = true;
    submitBtn.innerText = 'Yaratilmoqda...';

    // Note: formData already contains 'options[]' from the form inputs.
    // Since we trimmed them in the DOM (input.value = val), FormData might pick up the trimmed values 
    // IF we re-construct it, or we rely on backend trimming.
    // Better: Re-construct options in formData or let backend handle strict trim.
    // We already strictly trimmed in backend.

    try {
        const response = await fetch('/api/create-poll', {
            method: 'POST',
            body: formData
        });

        // Check for HTTP errors first (e.g., 413 Payload Too Large, 500 Server Error)
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server Error (${response.status}): ${text.substring(0, 100)}...`);
        }

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON Response: ${text.substring(0, 100)}...`);
        }

        if (result.success) {
            tg.showPopup({
                title: 'Muvaffaqiyatli!',
                message: 'Sorovnoma yaratildi',
                buttons: [{ type: 'close' }]
            }, () => {
                tg.close();
            });
        } else {
            tg.showAlert('Xatolik: ' + result.message);
        }
    } catch (error) {
        // Detailed Error Logging
        const msg = error.message || 'Unknown Error';
        const stack = error.stack || '';
        console.error('Submit Error:', error);

        let userMsg = 'Serverda xatolik yuz berdi: ' + msg;
        if (msg.includes('match the expected pattern')) {
            userMsg = 'Browser Error (DOMException): ' + msg + '\nStep: ' + (submitBtn.innerText === 'Yaratish' ? 'Pre-Fetch' : 'Fetching');
        }

        tg.showAlert(userMsg);
    } finally {
        document.getElementById('loader').classList.add('hidden');
        submitBtn.disabled = false;
        submitBtn.innerText = 'Yaratish';
    }
});
