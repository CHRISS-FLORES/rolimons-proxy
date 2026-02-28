const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Cache en memoria
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

app.get('/api/free-ugc', async function(req, res) {
  // Forzar recarga si se pasa ?refresh=1
  const forceRefresh = req.query.refresh === '1';

  if (!forceRefresh && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // ── Obtener todos los limiteds de Rolimons ────────────────
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.rolimons.com/'
      }
    });

    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const allItems = roliJson.items;
    if (!allItems) throw new Error('Sin datos de Rolimons');

    // ── Filtrar SOLO UGC (IDs >= 1,000,000,000) ──────────────
    // Los UGC limiteds tienen IDs de 12-18 dígitos
    // Los items clásicos de Roblox tienen IDs de 6-9 dígitos
    const UGC_MIN_ID = 1000000000; // 1 billion

    const ugcItems = [];
    for (const id in allItems) {
      if (Number(id) < UGC_MIN_ID) continue; // saltar items clásicos

      const i = allItems[id];
      const name      = i[0];
      const value     = i[2];  // valor en Rolimons
      const demand    = i[3];  // demanda
      const trend     = i[4];  // tendencia
      const projected = i[5] === 1;
      const hyped     = i[6] === 1;
      const rap       = i[7] > 0 ? i[7] : null;

      if (!name) continue;

      ugcItems.push({
        id: id,
        name: name,
        rap: rap,
        value: value,
        demand: demand,
        trend: trend,
        projected: projected,
        hyped: hyped
      });
    }

    // Ordenar por ID descendente (más nuevos primero)
    ugcItems.sort((a, b) => Number(b.id) - Number(a.id));

    console.log('UGC items encontrados:', ugcItems.length);

    // ── Obtener thumbnails reales de Roblox (lotes de 100) ───
    const thumbMap = {};
    const ids = ugcItems.map(i => i.id);

    for (let i = 0; i < Math.min(ids.length, 400); i += 100) {
      const batch = ids.slice(i, i + 100).join(',');
      try {
        const tRes = await fetch(
          'https://thumbnails.roblox.com/v1/assets?assetIds=' + batch +
          '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false'
        );
        if (tRes.ok) {
          const tJson = await tRes.json();
          (tJson.data || []).forEach(t => {
            if (t.state === 'Completed') thumbMap[String(t.targetId)] = t.imageUrl;
          });
        }
      } catch(e) {
        console.log('Thumb batch error:', e.message);
      }
    }

    // ── Construir lista final ─────────────────────────────────
    const result = ugcItems.map(item => {
      const totalQty   = item.hyped ? 10000 : (item.projected ? 1000 : 200);
      const unitsAvail = Math.max(1, Math.floor(totalQty * 0.4));

      return {
        id: item.id,
        name: item.name,
        rap: item.rap,
        value: item.value,
        demand: item.demand,
        trend: item.trend,
        projected: item.projected,
        hyped: item.hyped,
        totalQuantity: totalQty,
        unitsAvailable: unitsAvail,
        thumbnail: thumbMap[item.id] || ('https://www.roblox.com/asset-thumbnail/image?assetId=' + item.id + '&width=420&height=420&format=Png'),
        creatorName: 'UGC Creator',
        creatorType: 'User',
        priceInRobux: 0,
        assetType: 'Accessory',
        saleLocation: 'Everywhere',
        saleStatus: 'For Sale',
        favorites: 0,
        purchaseLimit: 1,
        robloxUrl: 'https://www.roblox.com/catalog/' + item.id,
        roliUrl:   'https://www.rolimons.com/item/' + item.id,
        tryOnUrl:  'https://www.roblox.com/catalog/' + item.id + '?tryOn=true'
      };
    });

    cacheData = result;
    cacheTime = Date.now();

    res.json({ success: true, data: result, total: result.length });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', uptime: process.uptime(), cached: !!cacheData, total: cacheData ? cacheData.length : 0 });
});

app.listen(PORT, function() {
  console.log('✅ Servidor activo en puerto ' + PORT);
});
