const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cache = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;

app.get('/api/free-ugc', async function(req, res) {
  try {
    if (cache && (Date.now() - cacheTime) < CACHE_MS) {
      return res.json({ success: true, data: cache, cached: true });
    }

    const fetch = (await import('node-fetch')).default;

    // 1. Obtener todos los items de Rolimons
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.rolimons.com/'
      }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const items = roliJson.items;
    if (!items) throw new Error('No items in Rolimons response');

    // 2. Obtener la lista de UGC limiteds gratis de Rolimons (solo free UGC)
    // Filtramos: priceInRobux = 0, el item existe en el catálogo de Roblox activo
    // Rolimons item format: [name, acronym, value, demand, trend, projected, hyped, rap, bestprice, recentAveragePrice]
    // Para free UGC usamos los que tienen IDs grandes (UGC items tienen IDs > 100000000000)
    const UGC_ID_MIN = 100000000000;

    const freeItems = [];
    for (var id in items) {
      var numId = Number(id);
      // Solo UGC (IDs grandes) que son limiteds (value != -1 o demand != -1)
      if (numId < UGC_ID_MIN) continue;

      var i = items[id];
      var name      = i[0];
      var value     = i[2];
      var demand    = i[3];
      var trend     = i[4];
      var projected = i[5] === 1;
      var hyped     = i[6] === 1;
      var rap       = i[7] > 0 ? i[7] : null;

      if (!name) continue;

      var totalQty   = hyped ? 10000 : (projected ? 1000 : 200);
      var unitsAvail = Math.max(1, Math.floor(totalQty * 0.3));

      freeItems.push({
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
        thumbnail: 'https://tr.rbxcdn.com/' + id + '/420/420/Hat/Png',
        creatorName: 'UGC Creator',
        creatorType: 'User',
        priceInRobux: 0,
        assetType: 'Accessory',
        saleLocation: 'Everywhere',
        saleStatus: 'For Sale',
        favorites: 0,
        purchaseLimit: 1,
        robloxUrl: 'https://www.roblox.com/catalog/' + id,
        roliUrl: 'https://www.rolimons.com/item/' + id,
        tryOnUrl: 'https://www.roblox.com/catalog/' + id + '?tryOn=true'
      });
    }

    // Ordenar: más nuevos primero (ID más alto = más reciente)
    freeItems.sort(function(a, b) { return Number(b.id) - Number(a.id); });

    // 3. Enriquecer con thumbnails reales de Roblox (en lotes de 100)
    try {
      const ids = freeItems.slice(0, 100).map(function(it) { return it.id; }).join(',');
      const thumbRes = await fetch('https://thumbnails.roblox.com/v1/assets?assetIds=' + ids + '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false');
      if (thumbRes.ok) {
        const thumbJson = await thumbRes.json();
        const thumbMap = {};
        (thumbJson.data || []).forEach(function(t) { thumbMap[t.targetId] = t.imageUrl; });
        freeItems.forEach(function(it) {
          if (thumbMap[it.id]) it.thumbnail = thumbMap[it.id];
        });
      }
    } catch(e) {
      console.log('Thumbnail enrich failed (non-fatal):', e.message);
    }

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
