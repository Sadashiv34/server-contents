const axios = require('axios');

async function testOpenRouter() {
    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: "Say hello!" }],
            response_format: { type: "json_object" }
        }, {
            headers: { 
                'Authorization': `Bearer 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`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://server-contents.vercel.app',
                'X-Title': 'Instantspot'
            }
        });
        console.log("SUCCESS:", response.data);
    } catch (e) {
        console.error("ERROR STATUS:", e.response?.status);
        console.error("ERROR DATA:", e.response?.data || e.message);
    }
}
testOpenRouter();
