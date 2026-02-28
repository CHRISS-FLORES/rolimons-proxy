const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cache = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;
const UGC_ID_MIN = 100000000000; // IDs de UGC son muy grandes

app.get('/api/free-ugc', async function(req, res) {
  try {
    if (cache && (Date.now() - cacheTime) < CACHE_MS) {
      return res.json({ success: true, data: cache, cached: true });
    }

    const fetch = (await import('node-fetch')).default;

    // ── 1. Datos de Rolimons ──────────────────────────────────
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.rolimons.com/'
      }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const items = roliJson.items;
    if (!items) throw new Error('No items in Rolimons response');

    // ── 2. Filtrar solo UGC (IDs grandes) ────────────────────
    const ugcIds = Object.keys(items).filter(id => Number(id) >= UGC_ID_MIN);

    // Tomar los más recientes (IDs más altos = más nuevos)
    ugcIds.sort((a, b) => Number(b) - Number(a));
    const top = ugcIds.slice(0, 200); // máximo 200 para no sobrecargar

    // ── 3. Thumbnails desde Roblox (lotes de 100) ────────────
    const thumbMap = {};
    try {
      for (let i = 0; i < top.length; i += 100) {
        const batch = top.slice(i, i + 100).join(',');
        const tRes = await fetch(
          'https://thumbnails.roblox.com/v1/assets?assetIds=' + batch +
          '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false'
        );
        if (tRes.ok) {
          const tJson = await tRes.json();
          (tJson.data || []).forEach(t => { thumbMap[String(t.targetId)] = t.imageUrl; });
        }
      }
    } catch(e) { console.log('Thumbnails error (non-fatal):', e.message); }

    // ── 4. Creadores desde Roblox Economy API (lotes de 50) ──
    const creatorMap = {};
    try {
      for (let i = 0; i < top.length; i += 50) {
        const batch = top.slice(i, i + 50);
        for (const id of batch) {
          try {
            const eRes = await fetch('https://economy.roblox.com/v2/assets/' + id + '/details');
            if (eRes.ok) {
              const eJson = await eRes.json();
              if (eJson.Creator) {
                creatorMap[id] = {
                  name: eJson.Creator.Name || 'UGC Creator',
                  type: eJson.Creator.CreatorType || 'User'
                };
              }
            }
          } catch(e2) { /* skip */ }
        }
      }
    } catch(e) { console.log('Creators error (non-fatal):', e.message); }

    // ── 5. Construir lista final ──────────────────────────────
    const freeItems = top.map(id => {
      const i = items[id];
      const name      = i[0];
      const value     = i[2];
      const demand    = i[3];
      const trend     = i[4];
      const projected = i[5] === 1;
      const hyped     = i[6] === 1;
      const rap       = i[7] > 0 ? i[7] : null;

      const totalQty   = hyped ? 10000 : (projected ? 1000 : 200);
      const unitsAvail = Math.max(1, Math.floor(totalQty * 0.3));
      const creator    = creatorMap[id] || { name: 'UGC Creator', type: 'User' };

      return {
        id: id,
        name: name,
        rap: rap,
        value: value,
        demand: demand,
        trend: trend,
        projected: projected,
        hyped: hyped,
        totalQuantity: totalQty,
        unitsAvailable: unitsAvail,
        thumbnail: thumbMap[id] || null,
        creatorName: creator.name,
        creatorType: creator.type,
        priceInRobux: 0,
        assetType: 'Accessory',
        saleLocation: 'Everywhere',
        saleStatus: 'For Sale',
        favorites: 0,
        purchaseLimit: 1,
        robloxUrl: 'https://www.roblox.com/catalog/' + id,
        roliUrl:   'https://www.rolimons.com/item/' + id,
        tryOnUrl:  'https://www.roblox.com/catalog/' + id + '?tryOn=true'
      };
    }).filter(item => item.name);

    cache = freeItems;
    cacheTime = Date.now();
    res.json({ success: true, data: freeItems, total: freeItems.length });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', message: 'Rolimons Proxy activo ✅' });
});

app.listen(PORT, function() {
  console.log('Servidor en puerto ' + PORT);
});
