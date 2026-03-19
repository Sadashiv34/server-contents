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
    // Quantize coordinates to 4 decimal places (~11m) to stabilize cache keys despite GPS jitter
    const quantizedBody = JSON.parse(JSON.stringify(req.body));
    if (quantizedBody.locationRestriction?.circle?.center) {
        const center = quantizedBody.locationRestriction.circle.center;
        center.latitude = Math.round(center.latitude * 10000) / 10000;
        center.longitude = Math.round(center.longitude * 10000) / 10000;
    }
    const cacheKey = `places:${JSON.stringify(quantizedBody)}`;

    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[CACHE HIT] Google Places for ${cacheKey}`);
        return res.json(cached);
    }

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
    let { lat, lon } = req.query;
    // Round to 3 decimal places (~110m) for weather - weather doesn't change much locally
    const qLat = Math.round(parseFloat(lat) * 1000) / 1000;
    const qLon = Math.round(parseFloat(lon) * 1000) / 1000;
    const cacheKey = `weather:${qLat}:${qLon}`;

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

// 5. Google Roads Proxy (Snap to Roads)
app.get('/api/google/roads', async (req, res) => {
    const { path } = req.query; // format: "lat,lon|lat,lon"
    if (!path) return res.status(400).json({ error: "Missing path parameter" });

    const cacheKey = `roads:${path}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[CACHE HIT] Google Roads for ${path}`);
        return res.json(cached);
    }

    try {
        if (!process.env.GOOGLE_API_KEY) {
            return res.status(500).json({ error: "GOOGLE_API_KEY missing on server" });
        }

        const url = `https://roads.googleapis.com/v1/snapToRoads`;
        const response = await axios.get(url, {
            params: {
                path: path,
                interpolate: true,
                key: process.env.GOOGLE_API_KEY
            }
        });

        cache.set(cacheKey, response.data, 86400); // 24h cache
        res.json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        console.error(`Roads API Error [${status}]:`, error.response?.data || error.message);
        res.status(status).json({ error: "Roads API Failure", details: error.response?.data || error.message });
    }
});

// 6. Gemini AI Spot Guide Proxy
app.post('/api/google/gemini', async (req, res) => {
    const { name, address } = req.body;
    if (!name) return res.status(400).json({ error: "Missing place name" });

    const cacheKey = `gemini:${name}:${address || ''}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[CACHE HIT] Gemini Guide for ${name}`);
        return res.json(cached);
    }

    try {
        // Use environment variable for security
        console.log("Key exists in env:", !!process.env.OPENROUTER_API_KEY);
        console.log("Key length in env:", process.env.OPENROUTER_API_KEY?.length);
        
        const openRouterKey = process.env.OPENROUTER_API_KEY || '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';
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        
        const prompt = `You are a world-class travel guide and historian. Generate a fascinating, accurate guide for the spot: "${name}" located at "${address}".
        Provide the response in EXPLICIT JSON format with exactly these keys:
        - "summary": A 1-sentence poetic overview of the spot.
        - "history": A 2-3 sentence deep dive into its historical origin.
        - "builder": Who built it or its architectural style (1 sentence).
        - "purpose": Why it was originally created (1 sentence).
        - "fun_fact": A surprising "Did you know?" style fact.
        
        REPLY ONLY WITH JSON. No markdown backticks.`;

        const response = await axios.post(url, {
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        }, {
            headers: { 
                'Authorization': `Bearer ${openRouterKey}`,
                'HTTP-Referer': 'https://instantspot.example.com', // For OpenRouter rankings
                'X-Title': 'InstantSpot App',
                'Content-Type': 'application/json' 
            },
            timeout: 20000 // 20s timeout for OpenRouter routing
        });

        if (!response.data?.choices?.[0]?.message?.content) {
            throw new Error("Empty or malformed response from OpenRouter");
        }

        const resultText = response.data.choices[0].message.content;
        let resultJson;
        try {
            resultJson = JSON.parse(resultText);
        } catch (parseError) {
            console.error("Failed to parse AI JSON:", resultText);
            throw new Error("AI returned invalid JSON format. Raw output: " + resultText.substring(0, 100));
        }
        
        cache.set(cacheKey, resultJson, 86400); // 24h cache
        res.json(resultJson);
    } catch (error) {
        const status = error.response?.status || 500;
        const errorData = error.response?.data || error.message;
        
        console.error(`AI Proxy Error [${status}]:`, JSON.stringify(errorData));
        
        res.status(status).json({ 
            error: "AI Service Error", 
            statusCode: status,
            details: errorData,
            message: error.message
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud Proxy ready on port ${PORT}`);
});
