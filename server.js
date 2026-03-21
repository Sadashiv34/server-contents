require('dotenv').config();
const express = require('express');
const axios = require('axios');
const compression = require('compression');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── UPSTASH REDIS (Persistent, cross-instance cache) ────────────────────────
// Using REST protocol — serverless-safe for Vercel cold starts.
// Storage budget: 256MB. Strategy:
//   - Photos: NOT stored in Redis (binary blobs are too large). Warm-instance only.
//   - All other data: stored with minimal keys and capped TTLs.
const redis = new Redis({
    url: process.env.REDIS_URL || 'https://intimate-midge-79639.upstash.io',
    token: process.env.REDIS_TOKEN || 'gQAAAAAAATcXAAIncDE5ZTEyNGM2OTg1ZDA0M2RlYjVhMDFmN2ZkNzkyYjAyY3AxNzk2Mzk',
});

// ─── L1: In-process memory cache (survives within the same Vercel instance) ──
// Prevents hitting Redis on back-to-back identical requests within the same
// lambda invocation. Simple Map with a 90-second TTL.
const l1 = new Map(); // key -> { value, expiresAt }
const L1_TTL_MS = 90_000;

function l1Get(key) {
    const entry = l1.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { l1.delete(key); return null; }
    return entry.value;
}
function l1Set(key, value) {
    l1.set(key, { value, expiresAt: Date.now() + L1_TTL_MS });
}

// ─── SHORT KEY HELPER ─────────────────────────────────────────────────────────
// Hashing long JSON bodies into 10-char hex saves hundreds of bytes per key.
function shortKey(prefix, data) {
    const hash = crypto.createHash('md5').update(
        typeof data === 'string' ? data : JSON.stringify(data)
    ).digest('hex').slice(0, 10);
    return `${prefix}:${hash}`;
}

// ─── TWO-LAYER GET/SET (FAIL-OPEN) ──────────────────────────────────────────
async function cacheGet(key) {
    try {
        const hit = l1Get(key);
        if (hit !== null) return hit;
        
        // Upstash REST calls have a default timeout, but we catch any connectivity issues
        const val = await redis.get(key);
        if (val !== null) {
            l1Set(key, val);
            return val;
        }
    } catch (e) {
        console.error(`[CACHE ERROR] Get failed for ${key}:`, e.message);
        // Fail open: return null so caller proceeds to real API
    }
    return null;
}

async function cacheSet(key, value, ttlSeconds) {
    try {
        l1Set(key, value);
        // Redis EX = seconds TTL
        await redis.set(key, value, { ex: ttlSeconds });
    } catch (e) {
        console.error(`[CACHE ERROR] Set failed for ${key}:`, e.message);
        // Fail open: just don't cache
    }
}

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────
let failureCount = 0;
let circuitOpen = false;
const MAX_FAILURES = 5;
const RESET_TIMEOUT = 30_000;

function checkCircuit(res) {
    if (circuitOpen) {
        return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
    return false;
}
function handleFailure() {
    failureCount++;
    if (failureCount >= MAX_FAILURES) {
        circuitOpen = true;
        setTimeout(() => { circuitOpen = false; failureCount = 0; }, RESET_TIMEOUT);
    }
}

// ─── CONFIGURATION ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());

// ─── RATE LIMITING ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// ─── TTL CONSTANTS (seconds) ──────────────────────────────────────────────────
const TTL = {
    PLACES:  3_600,      //  1 hour  — nearby places
    ROUTES:  86_400,     // 24 hours — routes rarely change
    WEATHER: 1_800,      // 30 min   — weather data
    ROADS:   86_400,     // 24 hours — road geometry
    GEMINI:  1_814_400,  // 21 days  — AI guide content
    DETAILS: 604_800,    //  7 days  — place details + reviews
};

// ─── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
    message: 'InstantSpot Cloud Proxy (Redis) is ACTIVE',
    endpoints: ['/health', '/api/google/places', '/api/weather']
}));

app.get('/health', (req, res) => res.json({ status: 'ONLINE', cache: 'Upstash Redis' }));

// ─── 1. GOOGLE PLACES ──────────────────────────────────────────────────────────
app.post('/api/google/places', async (req, res) => {
    // Quantize to ~11m to absorb GPS jitter
    const body = JSON.parse(JSON.stringify(req.body));
    if (body.locationRestriction?.circle?.center) {
        const c = body.locationRestriction.circle.center;
        c.latitude  = Math.round(c.latitude  * 10000) / 10000;
        c.longitude = Math.round(c.longitude * 10000) / 10000;
    }
    const key = shortKey('pl', body);

    const cached = await cacheGet(key);
    if (cached) {
        console.log(`[REDIS HIT] places ${key}`);
        return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.error('[CONFIG ERROR] GOOGLE_API_KEY missing');
            return res.status(500).json({ error: 'Server Configuration: API Key Missing' });
        }

        const { data } = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            req.body,
            { headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos'
            }}
        );
        await cacheSet(key, JSON.stringify(data), TTL.PLACES);
        res.json(data);
    } catch (e) {
        handleFailure();
        const status = e.response?.status || 500;
        const detail = e.response?.data?.error?.message || e.message;
        console.error(`[PLACES API ERROR] ${status}:`, detail);
        res.status(status).json({ error: 'Google Places API Failure', message: detail });
    }
});

// ─── 2. GOOGLE ROUTES ──────────────────────────────────────────────────────────
app.post('/api/google/routes', async (req, res) => {
    if (checkCircuit(res)) return;
    const key = shortKey('rt', req.body);

    const cached = await cacheGet(key);
    if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

    try {
        const { data } = await axios.post(
            'https://routes.googleapis.com/directions/v2:computeRoutes',
            req.body,
            { headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
            }}
        );
        await cacheSet(key, JSON.stringify(data), TTL.ROUTES);
        res.json(data);
    } catch (e) {
        handleFailure();
        res.status(500).json({ error: 'Routes API Error' });
    }
});

// ─── 3. OPENWEATHER ────────────────────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
    let { lat, lon } = req.query;
    // Round to ~110m — weather doesn't vary that locally
    const qLat = Math.round(parseFloat(lat) * 1000) / 1000;
    const qLon = Math.round(parseFloat(lon) * 1000) / 1000;
    const key = `wx:${qLat}:${qLon}`;

    const cached = await cacheGet(key);
    if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

    try {
        if (!process.env.OPENWEATHER_API_KEY) {
            console.error('[CONFIG ERROR] OPENWEATHER_API_KEY missing');
            return res.status(500).json({ error: 'Server Configuration: Weather API Key Missing' });
        }

        const { data } = await axios.get(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`
        );
        // Trim to first 8 forecast slots (~24h) to save Redis storage
        if (data.list) data.list = data.list.slice(0, 8);
        await cacheSet(key, JSON.stringify(data), TTL.WEATHER);
        res.json(data);
    } catch (e) {
        const status = e.response?.status || 500;
        const detail = e.response?.data?.message || e.message;
        console.error(`[WEATHER API ERROR] ${status}:`, detail);
        res.status(status).json({ error: 'Weather API Failure', message: detail });
    }
});

// ─── 4. GOOGLE PHOTO PROXY ─────────────────────────────────────────────────────
// ⚠️  NOT cached in Redis — binary base64 is too costly for 256MB budget.
//     Glide on the client handles its own disk cache for photos.
app.get('/api/google/photo', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Missing photo name' });

    if (!process.env.GOOGLE_API_KEY) return res.status(500).send('GOOGLE_API_KEY missing');

    try {
        const url = `https://places.googleapis.com/v1/${name}/media`;
        const { data, headers } = await axios.get(url, {
            params: { key: process.env.GOOGLE_API_KEY, maxWidthPx: 800 },
            responseType: 'arraybuffer'
        });
        res.set('Content-Type', headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400'); // HTTP cache header for CDN/Glide
        res.send(data);
    } catch (e) {
        res.status(e.response?.status || 500).send('Failed to load photo');
    }
});

// ─── 5. GOOGLE ROADS (Snap to Roads) ──────────────────────────────────────────
app.get('/api/google/roads', async (req, res) => {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'Missing path parameter' });

    const key = shortKey('rd', path);
    const cached = await cacheGet(key);
    if (cached) {
        console.log(`[REDIS HIT] roads ${key}`);
        return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.error('[CONFIG ERROR] GOOGLE_API_KEY missing');
            return res.status(500).json({ error: 'Server Configuration: API Key Missing' });
        }

        const { data } = await axios.get('https://roads.googleapis.com/v1/snapToRoads', {
            params: { path, interpolate: true, key: process.env.GOOGLE_API_KEY }
        });
        await cacheSet(key, JSON.stringify(data), TTL.ROADS);
        res.json(data);
    } catch (e) {
        const status = e.response?.status || 500;
        const detail = e.message;
        console.error(`[ROADS API ERROR] ${status}:`, detail);
        res.status(status).json({ error: 'Roads API Failure', message: detail });
    }
});

// ─── 6. GEMINI AI SPOT GUIDE ───────────────────────────────────────────────────
app.post('/api/google/gemini', async (req, res) => {
    const { name, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing place name' });

    const key = shortKey('gm', `${name}:${address || ''}`);
    const cached = await cacheGet(key);
    if (cached) {
        console.log(`[REDIS HIT] gemini ${name}`);
        return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.error('[CONFIG ERROR] GOOGLE_API_KEY (LLM) missing');
            return res.status(500).json({ error: 'Server Configuration: AI API Key Missing' });
        }

        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`;
        const prompt = `You are a world-class travel guide and historian. Generate a fascinating, accurate guide for the spot: "${name}" located at "${address}".
        Provide the response in EXPLICIT JSON format with exactly these keys:
        - "summary": A 1-sentence poetic overview of the spot.
        - "history": A 2-3 sentence deep dive into its historical origin.
        - "builder": Who built it or its architectural style (1 sentence).
        - "purpose": Why it was originally created (1 sentence).
        - "fun_fact": A surprising "Did you know?" style fact.
        REPLY ONLY WITH JSON. No markdown backticks.`;

        const { data } = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
        });

        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!resultText) throw new Error('Empty response from Gemini API');

        const resultJson = JSON.parse(resultText);
        await cacheSet(key, JSON.stringify(resultJson), TTL.GEMINI);
        res.json(resultJson);
    } catch (e) {
        const status = e.response?.status || 500;
        const detail = e.response?.data?.error?.message || e.message;
        console.error(`[GEMINI API ERROR] ${status}:`, detail);
        res.status(status).json({ error: 'Gemini AI Service Error', message: detail });
    }
});

// ─── 7. GOOGLE PLACE DETAILS (Reviews) ───────────────────────────────────────
app.get('/api/google/place-details', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required' });

    const key = `pd:${googleId}`;  // place IDs are already short & unique
    const cached = await cacheGet(key);
    if (cached) {
        console.log(`[REDIS HIT] place-details ${googleId}`);
        return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.error('[CONFIG ERROR] GOOGLE_API_KEY missing');
            return res.status(500).json({ error: 'Server Configuration: API Key Missing' });
        }

        const url = `https://places.googleapis.com/v1/places/${googleId}?fields=rating,reviews,userRatingCount,displayName&key=${process.env.GOOGLE_API_KEY}`;
        const { data } = await axios.get(url);

        // Cap at 5 reviews and strip author profile photos to save storage
        if (data.reviews) {
            data.reviews = data.reviews.slice(0, 5).map(r => ({
                authorAttribution: { displayName: r.authorAttribution?.displayName },
                rating: r.rating,
                relativePublishTimeDescription: r.relativePublishTimeDescription,
                text: { text: r.text?.text }
            }));
        }

        await cacheSet(key, JSON.stringify(data), TTL.DETAILS);
        res.json(data);
    } catch (e) {
        const status = e.response?.status || 500;
        const detail = e.response?.data?.error?.message || e.message;
        console.error(`[PLACE DETAILS ERROR] ${status}:`, detail);
        res.status(status).json({ error: 'Failed to fetch place details', message: detail });
    }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`InstantSpot Cloud Proxy (Redis) ready on port ${PORT}`);
});
