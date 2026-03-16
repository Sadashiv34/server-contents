require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const compression = require('compression');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CLOUD CACHE (In-Memory) ────────────────────────────────────────────────
// stdTTL is in seconds (1 hour = 3600)
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());

// ─── CIRCUIT BREAKER ────────────────────────────────────────────────────────
let failureCount = 0;
let circuitOpen = false;
const MAX_FAILURES = 5;
const RESET_TIMEOUT = 30000;

function checkCircuit(res) {
    if (circuitOpen) {
        return res.status(503).json({ error: "Service temporarily unavailable" });
    }
}

function handleFailure() {
    failureCount++;
    if (failureCount >= MAX_FAILURES) {
        circuitOpen = true;
        setTimeout(() => { circuitOpen = false; failureCount = 0; }, RESET_TIMEOUT);
    }
}

// ─── RATE LIMITING ──────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    message: { error: "Too many requests" }
});
app.use('/api/', limiter);

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ 
        message: "InstantSpot Cloud Proxy is ACTIVE", 
        endpoints: ["/health", "/api/google/places", "/api/weather"] 
    });
});

app.get('/health', (req, res) => {
    res.json({ status: "ONLINE", source: "Cloud Proxy (Vercel Ready)" });
});

// 1. Google Places Proxy
app.post('/api/google/places', async (req, res) => {
    if (checkCircuit(res)) return;
    const cacheKey = `places:${JSON.stringify(req.body)}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        if (!process.env.GOOGLE_API_KEY) {
            return res.status(500).json({ error: "Backend Configuration Error: GOOGLE_API_KEY is missing on server" });
        }

        const response = await axios.post('https://places.googleapis.com/v1/places:searchNearby', req.body, {
            headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos'
            }
        });
        cache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) {
        handleFailure();
        const status = error.response?.status || 500;
        const message = error.response?.data || error.message;
        res.status(status).json({ 
            error: "Google Places API Failure", 
            details: message 
        });
    }
});

// 2. Google Routes Proxy
app.post('/api/google/routes', async (req, res) => {
    if (checkCircuit(res)) return;
    const cacheKey = `routes:${JSON.stringify(req.body)}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const response = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes', req.body, {
            headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
            }
        });
        cache.set(cacheKey, response.data, 86400); // 24hr cache for routes
        res.json(response.data);
    } catch (error) {
        handleFailure();
        res.status(500).json({ error: "Routes API Error" });
    }
});

// 3. OpenWeather Proxy
app.get('/api/weather', async (req, res) => {
    const { lat, lon } = req.query;
    const cacheKey = `weather:${lat}:${lon}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        if (!process.env.OPENWEATHER_API_KEY) {
            return res.status(500).json({ error: "Backend Configuration Error: OPENWEATHER_API_KEY is missing on server" });
        }

        const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`;
        console.log(`Fetching Weather Forecast for ${lat}, ${lon}`);
        const response = await axios.get(url);
        cache.set(cacheKey, response.data, 1800);
        res.json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        console.error(`Weather API Error [${status}]:`, error.response?.data || error.message);
        res.status(status).json({ 
            error: "Weather API Failure", 
            details: error.response?.data || error.message 
        });
    }
});

// 4. Google Photo Proxy (Binary)
app.get('/api/google/photo', async (req, res) => {
    const { name } = req.query; // format: places/{place_id}/photos/{photo_reference}
    if (!name) return res.status(400).json({ error: "Missing photo name" });

    const cacheKey = `photo:${name}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        res.set('Content-Type', 'image/jpeg');
        return res.send(Buffer.from(cached, 'base64'));
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            return res.status(500).send("GOOGLE_API_KEY missing");
        }

        const url = `https://places.googleapis.com/v1/${name}/media`;
        const response = await axios.get(url, {
            params: {
                key: process.env.GOOGLE_API_KEY,
                maxWidthPx: 800
            },
            responseType: 'arraybuffer'
        });

        // Cache binary as base64 string
        cache.set(cacheKey, Buffer.from(response.data).toString('base64'), 86400); // 24h

        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.send(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        console.error(`Photo API Error [${status}]:`, error.response?.data || error.message);
        res.status(status).send("Failed to load photo");
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud Proxy ready on port ${PORT}`);
});
