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
        url: process.env.REDIS_URL || 'https://prepared-pony-82230.upstash.io',
        token: process.env.REDIS_TOKEN || 'gQAAAAAAAUE2AAIncDFlN2UxYTdhYmVjZWQ0NGU2OTExZGRhZTAyODQzMTM0MHAxODIyMzA',
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
        
        // Deep copy safely
        const bodyStr = JSON.stringify(req.body);
        const body = JSON.parse(bodyStr);

        if (body.locationRestriction?.circle?.center) {
            const c = body.locationRestriction.circle.center;
            c.latitude = Math.round(c.latitude * 10000) / 10000;
            c.longitude = Math.round(c.longitude * 10000) / 10000;
        }

        const key = shortKey('pl', body);
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        if (!process.env.GOOGLE_API_KEY) {
            console.error('Missing GOOGLE_API_KEY');
            return res.status(200).json({ places: [], error: 'key_missing' });
        }

        const { data } = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            req.body,
            { headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos'
            }, timeout: 8000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.PLACES);
        res.json(data);
    } catch (e) {
        console.error('[PLACES ERROR]:', e.message);
        // "RECOVERY MODE": Return empty list instead of 500
        res.status(200).json({ places: [], error: 'api_failed', originalError: e.message });
    }
});

// 2.5 ROUTES (NOW GET AS REQUESTED)
app.get('/api/google/routes', async (req, res) => {
    try {
        const { originLat, originLon, destLat, destLon, travelMode, routingPreference } = req.query;
        if (!originLat || !destLat) return res.status(200).json({ routes: [], message: 'Missing coordinates' });

        const query = { originLat, originLon, destLat, destLon, travelMode, routingPreference };
        const key = shortKey('rt', query);
        
        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';

        // Map BIKE to TWO_WHEELER if coming from Android as BIKE
        const mode = (travelMode === 'BIKE') ? 'TWO_WHEELER' : (travelMode || 'DRIVE');

        const body = {
            origin: { location: { latLng: { latitude: parseFloat(originLat), longitude: parseFloat(originLon) } } },
            destination: { location: { latLng: { latitude: parseFloat(destLat), longitude: parseFloat(destLon) } } },
            travelMode: mode,
            routingPreference: routingPreference || 'TRAFFIC_AWARE'
        };

        // Note: Routes API (New) endpoint is v1:computeRoutes
        const { data } = await axios.post(
            'https://routes.googleapis.com/v1:computeRoutes',
            body,
            { headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline'
            }, timeout: 10000 }
        );

        await cacheSet(key, JSON.stringify(data), TTL.ROUTES);
        res.json(data);
    } catch (e) {
        console.error('[ROUTES ERROR]:', e.response?.data || e.message);
        res.status(200).json({ routes: [], error: 'api_failed', details: e.message });
    }
});

// 2.6 PHOTO PROXY
app.get('/api/google/photo', async (req, res) => {
    try {
        const { name } = req.query;
        if (!name) return res.status(200).json({ error: 'no_name' });
        const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyD_rDZS2mRVdlHrOwTqxcKSMbvgwBZ2CoA';

        // Use the new Places API Media endpoint
        const url = `https://places.googleapis.com/v1/${name}/media?key=${apiKey}&maxWidthPx=1200&maxHeightPx=1200`;
        console.log(`[PHOTO] Proxying ${name}`);
        res.redirect(url);
    } catch (e) {
        console.error('[PHOTO ERROR]:', e.message);
        res.status(200).json({ error: 'photo_failed' });
    }
});

// 3. WEATHER
app.get('/api/weather', async (req, res) => {
    try {
        const { lat, lon } = req.query;
        if (!lat || !lon) return res.status(200).json({ list: [], message: 'No coords' });

        const qLat = Math.round(parseFloat(lat) * 1000) / 1000;
        const qLon = Math.round(parseFloat(lon) * 1000) / 1000;
        const key = `wx:${qLat}:${qLon}`;

        const cached = await cacheGet(key);
        if (cached) return res.json(typeof cached === 'string' ? JSON.parse(cached) : cached);

        if (!process.env.OPENWEATHER_API_KEY) {
            return res.status(200).json({ list: [], error: 'key_missing' });
        }

        const { data } = await axios.get(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`,
            { timeout: 5000 }
        );

        if (data.list) data.list = data.list.slice(0, 8);
        await cacheSet(key, JSON.stringify(data), TTL.WEATHER);
        res.json(data);
    } catch (e) {
        console.error('[WEATHER ERROR]:', e.message);
        res.status(200).json({ list: [], error: 'weather_failed' });
    }
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ACTIVE', redis: !!redis, firebase: !!db }));
app.get('/health', (req, res) => res.json({ status: 'OK', redis: !!redis, firebase: !!db }));

// Catch-all 404 handler
app.use((req, res) => res.status(200).json({ error: 'not_found', path: req.path }));

// THE ULTIMATE 500 PREVENTER
app.use((err, req, res, next) => {
    console.error('🚨 SERVER ERROR INTERCEPTED:', err.message);
    res.status(200).json({ error: 'internal_error', message: 'Intercepted a crash - system stable.', details: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Safety Server listening on port ${PORT}`);
});
