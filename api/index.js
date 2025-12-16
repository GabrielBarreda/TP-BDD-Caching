const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;

// Connexion PostgreSQL (WRITES via HAProxy)
const writePool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://app:app_pwd@postgres:5432/appdb',
});

// Connexion PostgreSQL (READS - normalement vers replica, mais ici même DB)
const readPool = new Pool({
    connectionString: process.env.READ_REPLICA_URL || 'postgresql://app:app_pwd@postgres:5432/appdb',
});

// Connexion Redis avec gestion d'erreur
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => {
            // Stratégie de reconnexion exponentielle
            const delay = Math.min(retries * 100, 3000);
            console.log(`Redis reconnection attempt ${retries}, delay: ${delay}ms`);
            return delay;
        }
    }
});

let redisConnected = false;

redisClient.on('error', (err) => {
    console.log('Redis Client Error:', err.message);
    redisConnected = false;
});

redisClient.on('connect', () => {
    console.log('✅ Redis connected');
    redisConnected = true;
});

redisClient.on('ready', () => {
    console.log('✅ Redis ready');
    redisConnected = true;
});

// Fonctions sécurisées pour Redis
async function safeRedisGet(key) {
    if (!redisConnected) return null;

    try {
        const result = await Promise.race([
            redisClient.get(key),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Redis timeout')), 1000)
            )
        ]);
        return result ? JSON.parse(result) : null;
    } catch (error) {
        console.log(`Redis get failed for key ${key}:`, error.message);
        redisConnected = false;
        return null;
    }
}

async function safeRedisSetEx(key, ttl, value) {
    if (!redisConnected) return;

    try {
        await Promise.race([
            redisClient.setEx(key, ttl, JSON.stringify(value)),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Redis timeout')), 1000)
            )
        ]);
    } catch (error) {
        console.log(`Redis set failed for key ${key}:`, error.message);
        redisConnected = false;
    }
}

async function safeRedisDel(key) {
    if (!redisConnected) return;

    try {
        await Promise.race([
            redisClient.del(key),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Redis timeout')), 1000)
            )
        ]);
        console.log(`🗑️ Cache invalidated for product ${key.split(':')[1]}`);
    } catch (error) {
        console.log(`Redis delete failed for key ${key}:`, error.message);
        redisConnected = false;
    }
}

// Initialisation
(async () => {
    try {
        // Connect Redis (sans bloquer)
        redisClient.connect().catch(err => {
            console.log('Initial Redis connection failed:', err.message);
        });

        // Test DB connection
        await writePool.query('SELECT 1');
        console.log('✅ PostgreSQL connected');

        // Créer la table
        await writePool.query(`
            CREATE TABLE IF NOT EXISTS products(
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                price_cents INT NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Database initialized');

    } catch (err) {
        console.error('❌ Initialization error:', err);
    }
})();

// Middleware pour loguer les requêtes
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Routes

// GET /products/:id avec Cache-Aside résilient
app.get('/products/:id', async (req, res) => {
    const { id } = req.params;
    const cacheKey = `product:${id}`;

    try {
        // 1. Essaye Redis (avec fallback silencieux)
        const cachedProduct = await safeRedisGet(cacheKey);
        if (cachedProduct) {
            console.log(`✅ Cache HIT for product ${id}`);
            return res.json({
                source: 'cache',
                data: cachedProduct
            });
        }

        console.log(`📭 Cache MISS for product ${id} ${!redisConnected ? '(Redis down)' : ''}`);

        // 2. Récupère depuis la DB
        const result = await readPool.query(
            'SELECT * FROM products WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const product = result.rows[0];

        // 3. Met en cache si Redis disponible
        await safeRedisSetEx(cacheKey, 60, product);

        res.json({
            source: 'database',
            data: product,
            cache: redisConnected ? 'available' : 'unavailable'
        });

    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// POST /products (CREATE)
app.post('/products', async (req, res) => {
    const { name, price_cents } = req.body;

    if (!name || !price_cents) {
        return res.status(400).json({ error: 'Name and price_cents are required' });
    }

    try {
        const result = await writePool.query(
            'INSERT INTO products(name, price_cents) VALUES($1, $2) RETURNING *',
            [name, parseInt(price_cents)]
        );

        const newProduct = result.rows[0];

        res.status(201).json({
            ...newProduct,
            cache_status: redisConnected ? 'active' : 'inactive'
        });

    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /products/:id (UPDATE avec invalidation de cache)
app.put('/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price_cents } = req.body;

    if (!name || !price_cents) {
        return res.status(400).json({ error: 'Name and price_cents are required' });
    }

    try {
        // 1. Mise à jour dans la DB
        const result = await writePool.query(
            'UPDATE products SET name = $1, price_cents = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
            [name, parseInt(price_cents), id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const updatedProduct = result.rows[0];

        // 2. Invalidation du cache (non bloquant)
        const cacheKey = `product:${id}`;
        await safeRedisDel(cacheKey);

        res.json({
            ...updatedProduct,
            cache_invalidated: redisConnected,
            cache_status: redisConnected ? 'invalidated' : 'unavailable'
        });

    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /products (sans cache)
app.get('/products', async (req, res) => {
    try {
        const result = await readPool.query('SELECT * FROM products ORDER BY id');

        res.json({
            data: result.rows,
            count: result.rows.length,
            cache_status: redisConnected ? 'available' : 'unavailable'
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /health - Endpoint de santé
app.get('/health', async (req, res) => {
    try {
        const dbCheck = await writePool.query('SELECT NOW() as db_time, COUNT(*) as product_count FROM products');
        const dbStatus = 'healthy';

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            services: {
                database: {
                    status: dbStatus,
                    time: dbCheck.rows[0].db_time,
                    product_count: parseInt(dbCheck.rows[0].product_count)
                },
                redis: {
                    status: redisConnected ? 'connected' : 'disconnected',
                    connected: redisConnected
                },
                api: {
                    status: 'running',
                    uptime: process.uptime()
                }
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'degraded',
            error: error.message
        });
    }
});

// Route racine
app.get('/', (req, res) => {
    res.json({
        message: 'TP Docker - PostgreSQL + Redis API (Résiliente)',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET  /',
            'GET  /health',
            'GET  /products',
            'GET  /products/:id (with resilient cache)',
            'POST /products',
            'PUT  /products/:id (invalidates cache)'
        ]
    });
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Lancer le serveur
app.listen(PORT, () => {
    console.log(`🚀 API server running on port ${PORT}`);
    console.log(`📊 Redis status: ${redisConnected ? 'Connected' : 'Disconnected'}`);
});