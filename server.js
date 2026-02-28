// ==========================================
// PROXY SERVER - Rolimons Free UGC Limiteds
// Deploy en Render.com o Railway (GRATIS)
// ==========================================

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Permitir cualquier origen (tu página web puede llamar a este servidor)
app.use(cors());
app.use(express.json());

// Cache en memoria para no superar el límite de 1 req/min de Rolimons
let cache = {
    freeUGC: null,
    timestamp: 0
};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// ==========================================
// HELPER: fetch simple con https nativo
// ==========================================
function fetchJSON(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                ...headers
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
            });
        }).on('error', reject);
    });
}

// ==========================================
// GET /api/free-ugc
// Devuelve los UGC limiteds gratuitos
// ==========================================
app.get('/api/free-ugc', async (req, res) => {
    try {
        // Usar cache si es reciente
        const ahora = Date.now();
        if (cache.freeUGC && (ahora - cache.timestamp) < CACHE_DURATION) {
            console.log('Sirviendo desde cache');
            return res.json({ success: true, data: cache.freeUGC, fromCache: true });
        }

        console.log('Fetching Rolimons free limiteds...');

        // 1. Obtener la lista de item IDs con precio 0 (free limiteds) desde Rolimons
        const itemsData = await fetchJSON('https://www.rolimons.com/itemapi/itemdetails');

        if (!itemsData || !itemsData.items) {
            return res.status(502).json({ success: false, error: 'No se pudo obtener datos de Rolimons' });
        }

        // Filtrar items con precio = 0 (Free) y que sean limiteds activos
        // Formato Rolimons: { "id": [name, acronym, status, demand, trend, projected, hyped, rate, value, default_value] }
        // status: 1 = limited, 2 = limited unique
        // value 0 = free / no tiene valor en mercado aún
        const freeItems = [];

        for (const [id, details] of Object.entries(itemsData.items)) {
            // details[0] = nombre, details[2] = status (1=limited, 2=limitedU)
            // Buscamos items que tengan status limited Y sean nuevos (sin RAP establecido o muy bajo)
            if (details && details[0]) {
                freeItems.push({
                    id: parseInt(id),
                    name: details[0],
                    acronym: details[1] || '',
                    status: details[2], // 1 = limited, 2 = limitedU
                    demand: details[3], // -1 = unassigned
                    trend: details[4],
                    projected: details[5],
                    hyped: details[6],
                    rap: details[7] || 0,
                    value: details[8] || 0,
                    defaultValue: details[9] || 0
                });
            }
        }

        // Ordenar por ID descendente (más nuevos primero)
        freeItems.sort((a, b) => b.id - a.id);

        // Tomar los 200 más recientes para no sobrecargar
        const recientes = freeItems.slice(0, 200);

        // 2. Obtener thumbnails de Roblox para estos items
        const ids = recientes.map(i => i.id);
        const BATCH = 100;
        const thumbsMap = {};

        for (let i = 0; i < ids.length; i += BATCH) {
            const batchIds = ids.slice(i, i + BATCH).join(',');
            try {
                const thumbData = await fetchJSON(
                    `https://thumbnails.roblox.com/v1/assets?assetIds=${batchIds}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`
                );
                if (thumbData.data) {
                    thumbData.data.forEach(t => { thumbsMap[t.targetId] = t.imageUrl; });
                }
            } catch (e) {
                console.warn('Error thumbnails batch:', e.message);
                // Intentar con rotunnel como fallback
                try {
                    const thumbData2 = await fetchJSON(
                        `https://thumbnails.rotunnel.com/v1/assets?assetIds=${batchIds}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`
                    );
                    if (thumbData2.data) {
                        thumbData2.data.forEach(t => { thumbsMap[t.targetId] = t.imageUrl; });
                    }
                } catch(e2) { console.warn('Rotunnel también falló'); }
            }
        }

        // 3. Obtener detalles de los assets (creador, precio actual) desde Roblox catalog
        const detailsMap = {};
        for (let i = 0; i < ids.length; i += BATCH) {
            const batchIds = ids.slice(i, i + BATCH).join(',');
            try {
                const detailData = await fetchJSON(
                    `https://catalog.roblox.com/v1/catalog/items/details`,
                    { 'Content-Type': 'application/json' }
                );
                // Este endpoint necesita POST, así que lo hacemos diferente abajo
            } catch(e) { /* intentar con economy */ }

            // Usar economy API que sí es GET
            try {
                const econData = await fetchJSON(
                    `https://economy.roblox.com/v2/assets?assetIds=${batchIds}`
                );
                if (econData.data) {
                    econData.data.forEach(d => {
                        detailsMap[d.id] = {
                            creatorName: d.creatorName || 'Unknown',
                            creatorType: d.creatorType || '',
                            priceInRobux: d.priceInRobux,
                            assetType: d.assetType
                        };
                    });
                }
            } catch(e) { console.warn('Economy API error:', e.message); }
        }

        // 4. Combinar todo
        const resultado = recientes.map(item => ({
            id: item.id,
            name: item.name,
            rap: item.rap,
            value: item.value,
            status: item.status,
            demand: item.demand,
            trend: item.trend,
            projected: item.projected === 1,
            hyped: item.hyped === 1,
            thumbnail: thumbsMap[item.id] || null,
            creatorName: detailsMap[item.id]?.creatorName || 'UGC Creator',
            priceInRobux: detailsMap[item.id]?.priceInRobux ?? 0,
            assetType: detailsMap[item.id]?.assetType || 'Accessory',
            robloxUrl: `https://www.roblox.com/catalog/${item.id}`,
            roliUrl: `https://www.rolimons.com/item/${item.id}`,
            tryOnUrl: `https://www.roblox.com/catalog/${item.id}?tryOn=true`
        }));

        // Guardar en cache
        cache.freeUGC = resultado;
        cache.timestamp = ahora;

        console.log(`Devolviendo ${resultado.length} items`);
        res.json({ success: true, data: resultado, fromCache: false, total: resultado.length });

    } catch (err) {
        console.error('Error en /api/free-ugc:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// GET /api/item/:id  — detalle de un item
// ==========================================
app.get('/api/item/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const data = await fetchJSON(`https://www.rolimons.com/itemapi/itemdetails`);
        const item = data.items?.[id];
        if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado' });
        res.json({ success: true, id, name: item[0], value: item[8], rap: item[7] });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// GET /  — health check
// ==========================================
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'Proxy Rolimons UGC activo ✅',
        endpoints: ['/api/free-ugc', '/api/item/:id'],
        cache: {
            hasData: !!cache.freeUGC,
            age: cache.timestamp ? Math.floor((Date.now() - cache.timestamp) / 1000) + 's' : 'no cache'
        }
    });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor proxy corriendo en puerto ${PORT}`);
});