require('dotenv').config();
const express = require('express');
const axios = require('axios');
const compression = require('compression');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── GLOBAL ERROR HANDLERS (CRITICAL) ────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// ─── OPTIONAL REDIS (Prevents 500 if package missing) ────────────────────────
let redis = null;
try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
        url: process.env.REDIS_URL || 'https://intimate-midge-79639.upstash.io',
        token: process.env.REDIS_TOKEN || 'gQAAAAAAATcXAAIncDE5ZTEyNGM2OTg1ZDA0M2RlYjVhMDFmN2ZkNzkyYjAyY3AxNzk2Mzk',
    });
    console.log('✅ Redis library loaded and initialized');
} catch (e) {
    console.error('⚠️ Redis library NOT FOUND or failed to init. Running in CACHE-LESS mode.', e.message);
}

// ─── L1 CACHE ────────────────────────────────────────────────────────────────
const l1 = new Map();
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

// ─── CACHE UTILS (FAIL-SAFE) ──────────────────────────────────────────────────
async function cacheGet(key) {
    try {
        const hit = l1Get(key);
        if (hit !== null) return hit;
        if (redis) {
            const val = await redis.get(key);
            if (val !== null) { l1Set(key, val); return val; }
        }
    } catch (e) {
        console.error(`[CACHE GET ERROR] ${key}:`, e.message);
    }
    return null;
}

async function cacheSet(key, value, ttlSeconds) {
    try {
        l1Set(key, value);
        if (redis) {
            await redis.set(key, value, { ex: ttlSeconds });
        }
    } catch (e) {
        console.error(`[CACHE SET ERROR] ${key}:`, e.message);
    }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function shortKey(prefix, data) {
    const str = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : 'empty';
    const hash = crypto.createHash('md5').update(str).digest('hex').slice(0, 10);
    return `${prefix}:${hash}`;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());

// Rate limit with dummy JSON instead of status 429 string
const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    handler: (req, res) => res.status(200).json({ error: 'rate_limited', message: 'Take it easy!', places: [] })
});
app.use('/api/', limiter);

const TTL = { PLACES: 3600, ROUTES: 86400, WEATHER: 1800, ROADS: 86400, GEMINI: 1814400, DETAILS: 604800 };

// ─── FIREBASE ADMIN (CRITICAL FOR SAVING URL) ────────────────────────────────
let db = null;
try {
    const admin = require('firebase-admin');
    // Try to init with ADC or service account from ENV
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        // Fallback or assume local environment has ADC
        admin.initializeApp();
    }
    db = admin.firestore();
    console.log('✅ Firebase Admin initialized');
} catch (e) {
    console.warn('⚠️ Firebase Admin failed to init. Backend will return URL but NOT save it to Firestore.', e.message);
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

// 1. UPDATE USER MAP
app.post('/api/user/update-map', async (req, res) => {
    try {
        const { uid, visitedLatLngs, exploredLatLngs } = req.body;
        if (!uid) return res.status(200).json({ error: 'no_uid' });

        const apiKey = process.env.GEOAPIFY_KEY || '49f54774eecb471b98f1afec04a2df6a';
        
        // Construct Geoapify URL
        // Style: dark-matter, Size: 600x400
        let url = `https://maps.geoapify.com/v1/staticmap?style=dark-matter&width=600&height=400&apiKey=${apiKey}`;

        // Add Markers for Visited (Green)
        if (visitedLatLngs && visitedLatLngs.length > 0) {
            visitedLatLngs.forEach(ll => {
                const [lat, lng] = ll.split(',');
                url += `&marker=lonlat:${lng},${lat};color:%2322C55E;size:small`;
            });

            // Add Path connecting Visited
            const pathPoints = visitedLatLngs.map(ll => {
                const [lat, lng] = ll.split(',');
                return `${lng},${lat}`;
            }).join('|');
            url += `&path=stroke:%2322C55E;width:3;points:${pathPoints}`;
        }

        // Add Markers for Explored (Red/Neon)
        if (exploredLatLngs && exploredLatLngs.length > 0) {
            exploredLatLngs.forEach(ll => {
                const [lat, lng] = ll.split(',');
                url += `&marker=lonlat:${lng},${lat};color:%23EF4444;size:small;icon:cloud`;
            });
        }

        // Auto-center/zoom if we have points
        if ((visitedLatLngs?.length || 0) + (exploredLatLngs?.length || 0) > 0) {
            url += '&area=auto';
        } else {
            url += '&center=lonlat:0,0&zoom=1';
        }

        // Save to Firestore if available
        let savedToFirestore = false;
        if (db) {
            try {
                await db.collection('users').document(uid).update({
                    staticMapUrl: url,
                    lastMapUpdate: new Date().toISOString()
                });
                savedToFirestore = true;
                console.log(`✅ Saved map URL for user ${uid}`);
            } catch (firestoreErr) {
                console.error(`[FIRESTORE ERROR] user ${uid}:`, firestoreErr.message);
            }
        }

        // Cache in Redis by UID
        if (redis) {
            await cacheSet(`map:${uid}`, url, 86400); // 24h
        }

        res.json({ success: true, imageUrl: url, savedToFirestore });
    } catch (e) {
        console.error('[UPDATE MAP ERROR]:', e.message);
        res.status(200).json({ error: 'update_failed', message: e.message });
    }
});

// 2. PLACES
app.post('/api/google/places', async (req, res) => {
    try {
        if (!req.body) return res.status(200).json({ places: [], message: 'Empty body' });
        
        const body = JSON.parse(JSON.stringify(req.body));
        if (body.locationRestriction?.circle?.center) {
            const c = body.locationRestriction.circle.center;
            c.latitude = Math.round(c.latitude * 10000) / 10000;
            c.longitude = Math.round(c.longitude * 10000) / 10000;
        }

        const key = shortKey('pl', body);
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';
        
        console.log(`[PLACES] Fetching for ${body.locationRestriction?.circle?.center?.latitude},${body.locationRestriction?.circle?.center?.longitude}`);
        const { data } = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            req.body,
            { headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos'
            }, timeout: 8000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.PLACES);
        res.json(data);
    } catch (e) {
        console.error('[PLACES ERROR]:', e.response?.data || e.message);
        res.status(502).json({ error: 'places_failed', details: e.message });
    }
});

// 3. WEATHER
app.get('/api/weather', async (req, res) => {
    try {
        const { lat, lon } = req.query;
        if (!lat || !lon) return res.status(200).json({ list: [], message: 'No coords' });

        const key = `wx:${Math.round(lat*1000)/1000}:${Math.round(lon*1000)/1000}`;
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.OPENWEATHER_API_KEY;
        if (!apiKey) return res.status(200).json({ list: [], error: 'key_missing' });

        const { data } = await axios.get(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`,
            { timeout: 5000 }
        );

        if (data.list) data.list = data.list.slice(0, 8);
        await cacheSet(key, JSON.stringify(data), TTL.WEATHER);
        res.json(data);
    } catch (e) {
        console.error('[WEATHER ERROR]:', e.message);
        res.status(502).json({ error: 'weather_failed' });
    }
});

// 4. ROUTES
app.post('/api/google/routes', async (req, res) => {
    try {
        const key = shortKey('rt', req.body);
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';

        console.log('[ROUTES] Fetching new route...');
        const { data } = await axios.post(
            'https://routes.googleapis.com/v1/computeRoutes',
            req.body,
            { headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
            }, timeout: 8000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.ROUTES);
        res.json(data);
    } catch (e) {
        console.error('[ROUTES ERROR]:', e.response?.data || e.message);
        res.status(502).json({ error: 'routes_failed' });
    }
});

// 5. PLACE DETAILS
app.get('/api/google/place-details', async (req, res) => {
    try {
        const { googleId } = req.query;
        if (!googleId) return res.status(200).json({ error: 'no_id' });

        const key = `det:${googleId}`;
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';

        const { data } = await axios.get(
            `https://places.googleapis.com/v1/places/${googleId}`,
            { headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,photos,reviews,editorialSummary'
            }, timeout: 8000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.DETAILS);
        res.json(data);
    } catch (e) {
        console.error('[DETAILS ERROR]:', e.message);
        res.status(502).json({ error: 'details_failed' });
    }
});

// 6. PHOTO
app.get('/api/google/photo', async (req, res) => {
    try {
        const { name } = req.query;
        if (!name) return res.status(200).json({ error: 'no_name' });
        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';
        const photoUrl = `https://places.googleapis.com/v1/${name}/media?key=${apiKey}&maxHeightPx=1080&maxWidthPx=1080`;
        
        console.log(`[PHOTO] Proxying ${name}`);
        const response = await axios.get(photoUrl, { 
            responseType: 'stream', 
            timeout: 10000,
            headers: { 'Accept': 'image/*' }
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
        response.data.pipe(res);
    } catch (e) {
        console.error('[PHOTO ERROR]:', e.message);
        res.status(502).send('Photo fetch failed');
    }
});

// 7. ROADS
app.get('/api/google/roads', async (req, res) => {
    try {
        const { path } = req.query;
        if (!path) return res.status(200).json({ snappedPoints: [] });

        const key = shortKey('rd', path);
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';

        const { data } = await axios.get(
            `https://roads.googleapis.com/v1/snapToRoads?path=${path}&key=${apiKey}`,
            { timeout: 5000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.ROADS);
        res.json(data);
    } catch (e) {
        console.error('[ROADS ERROR]:', e.message);
        res.status(502).json({ error: 'roads_failed' });
    }
});

// 8. GEMINI
app.post('/api/google/gemini', async (req, res) => {
    try {
        const { name, address } = req.body;
        const key = shortKey('gm', { name, address });
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';
        const prompt = `Provide a travel guide for "${name}" at "${address}" in JSON format with fields: summary, history, builder, purpose, fun_fact. Keep it concise.`;
        
        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            },
            { timeout: 10000 }
        );

        if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Invalid Gemini response');
        }

        const text = data.candidates[0].content.parts[0].text;
        const result = JSON.parse(text);
        
        await cacheSet(key, JSON.stringify(result), TTL.GEMINI);
        res.json(result);
    } catch (e) {
        console.error('[GEMINI ERROR]:', e.message);
        res.status(502).json({ error: 'gemini_failed' });
    }
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ACTIVE', redis: !!redis, firebase: !!db }));
app.get('/health', (req, res) => res.json({ status: 'OK', redis: !!redis, firebase: !!db }));

// Catch-all 404 handler
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// THE ULTIMATE 500 PREVENTER
app.use((err, req, res, next) => {
    console.error('🚨 SERVER ERROR INTERCEPTED:', err.message);
    res.status(500).json({ error: 'internal_error', message: 'Intercepted a crash - system stable.', details: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Safety Server listening on port ${PORT}`);
});
