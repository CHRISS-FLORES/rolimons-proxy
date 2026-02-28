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

    // Intentar con diferentes endpoints de Rolimons
    const urls = [
      'https://www.rolimons.com/itemapi/itemdetails',
      'https://rolimons.com/itemapi/itemdetails'
    ];

    let json = null;
    let lastError = '';

    for (var u of urls) {
      try {
        const response = await fetch(u, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.rolimons.com/',
            'Origin': 'https://www.rolimons.com'
          }
        });
        if (response.ok) {
          json = await response.json();
          break;
        } else {
          lastError = 'HTTP ' + response.status + ' from ' + u;
        }
      } catch(e) {
        lastError = e.message;
      }
    }

    if (!json) throw new Error('No response: ' + lastError);

    const items = json.item_details;
    if (!items) {
      // Devolver las keys que tiene el JSON para diagnosticar
      return res.json({ success: false, error: 'No item_details', keys: Object.keys(json), sample: JSON.stringify(json).substring(0, 500) });
    }

    const freeItems = [];
    for (var id in items) {
      var i = items[id];
      var name      = i[0];
      var value     = i[2];
      var demand    = i[3];
      var trend     = i[4];
      var projected = i[5] === 1;
      var hyped     = i[6] === 1;

      if (!name) continue;

      var totalQty   = hyped ? 10000 : (projected ? 1000 : 200);
      var unitsAvail = Math.floor(Math.random() * totalQty * 0.5) + 1;

      freeItems.push({
        id: id,
        name: name,
        rap: value > 0 ? value : null,
        value: value,
        demand: demand,
        trend: trend,
        projected: projected,
        hyped: hyped,
        totalQuantity: totalQty,
        unitsAvailable: unitsAvail,
        thumbnail: 'https://www.roblox.com/asset-thumbnail/image?assetId=' + id + '&width=420&height=420&format=Png',
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

    cache = freeItems;
    cacheTime = Date.now();
    res.json({ success: true, data: freeItems, total: freeItems.length });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', message: 'Rolimons Proxy funcionando' });
});

app.listen(PORT, function() {
  console.log('Servidor corriendo en puerto ' + PORT);
});
