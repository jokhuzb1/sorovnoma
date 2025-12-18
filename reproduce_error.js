// Native fetch check 
// Actually, for file uploads in Node fetch, it's tricky without 'undici' or similar if not fully standards compliant yet for file-from-disk.
// But for simple fields, native FormData works in newer Node.
// Let's stick to simple boundary construction or just use 'querystring' if no file?
// The endpoint requires 'multer' which expects 'multipart/form-data'.
// I will use a simple boundary string construction manually to allow file simulation if needed, 
// or just standard 'new FormData()' if available.
// Node 22 definitely supports `new FormData()`.
// But `response.json()` failing is what we want to catch.

async function run() {
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';

    let body = '';

    // Helper to add field
    const addField = (name, value) => {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    };

    addField('user_id', '5887482755');
    addField('question', 'Test Poll Local fetch');
    addField('options', 'Option A');
    addField('options', 'Option B');
    addField('multiple_choice', 'false');
    addField('allow_edit', 'false');

    body += `--${boundary}--\r\n`;

    try {
        const res = await fetch('http://localhost:3000/api/create-poll', {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: body
        });

        const text = await res.text();
        console.log('Status:', res.status);
        console.log('Body:', text);

        try {
            JSON.parse(text);
            console.log('✅ Body is valid JSON');
        } catch (e) {
            console.error('❌ Body is NOT JSON (This explains "unexpected json")');
        }

    } catch (e) {
        console.error('Fetch Error:', e);
    }
}

run();
