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
});

// File Preview Logic
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        fileLabel.innerText = '✅ Fajl tanlandi: ' + e.target.files[0].name;
    }
});

// Submit Logic
submitBtn.addEventListener('click', async () => {
    const form = document.getElementById('pollForm');
    const formData = new FormData(form);

    // Telegram User Data
    const user = tg.initDataUnsafe?.user;
    if (user) {
        formData.append('user_id', user.id);
        formData.append('first_name', user.first_name);
    }

    // Validation
    const question = document.getElementById('question').value;
    const options = Array.from(document.querySelectorAll('input[name="options[]"]')).map(i => i.value).filter(v => v.trim() !== '');

    if (!question || options.length < 2) {
        tg.showAlert('Savol va kamida 2 ta variant yozing!');
        return;
    }

    // Show Loader
    document.getElementById('loader').classList.remove('hidden');
    submitBtn.disabled = true;
    submitBtn.innerText = 'Yaratilmoqda...';

    try {
        const response = await fetch('/api/create-poll', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

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
        tg.showAlert('Serverda xatolik yuz berdi: ' + error.message);
    } finally {
        document.getElementById('loader').classList.add('hidden');
        submitBtn.disabled = false;
        submitBtn.innerText = 'Yaratish';
    }
});

// Set Main Button (Optional - using custom button instead for more control)
// tg.MainButton.setText("YARATISH").show();
// tg.MainButton.onClick(() => submitBtn.click());
