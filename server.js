const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assetTypeName(id) {
  const t = {8:'Hat',11:'Shirt',12:'Pants',17:'Head',18:'Face',19:'Gear',
    41:'Hair Accessory',42:'Face Accessory',43:'Neck Accessory',
    44:'Shoulder Accessory',45:'Front Accessory',46:'Back Accessory',
    47:'Waist Accessory',64:'Emote',76:'Shoes'};
  return t[id] || 'Accessory';
}

// ── ENDPOINT PRINCIPAL ────────────────────────────────────────
app.get('/api/free-ugc', async function(req, res) {
  const force = req.query.refresh === '1';
  if (!force && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // ── PASO 1: Buscar UGC Limiteds gratis en el catalogo de Roblox
    // Usamos catalog.roblox.com para buscar items con precio 0 y tipo Limited
    let allItems = [];
    let cursor = '';
    let paginas = 0;
    const MAX_PAGINAS = 5; // 5 páginas x 120 items = hasta 600 items

    do {
      const url = 'https://catalog.roblox.com/v1/search/items/details?' +
        'Category=Accessories&Subcategory=All&MaxPrice=0&MinPrice=0' +
        '&salesTypeFilter=1&limit=120&sortType=3' + // sortType=3 = más recientes
        (cursor ? '&cursor=' + cursor : '');

      try {
        const r = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        if (!r.ok) { console.log('Catalog page error:', r.status); break; }
        const j = await r.json();
        const items = (j.data || []).filter(i =>
          i.itemRestrictions && i.itemRestrictions.includes('Limited')
        );
        allItems = allItems.concat(items);
        cursor = j.nextPageCursor || '';
        paginas++;
        if (cursor) await sleep(300);
      } catch(e) {
        console.log('Catalog fetch error:', e.message);
        break;
      }
    } while (cursor && paginas < MAX_PAGINAS);

    console.log('Items gratis limiteds encontrados:', allItems.length);

    // Si el catálogo no devuelve nada, intentar con la API de Rolimons como fallback
    if (allItems.length === 0) {
      console.log('Usando fallback de Rolimons...');
      const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (roliRes.ok) {
        const roliJson = await roliRes.json();
        const items = roliJson.items || {};
        for (const id in items) {
          if (Number(id) < 1000000000) continue;
          const i = items[id];
          if (i[0]) allItems.push({ id: Number(id), name: i[0], _fromRoli: true, _roliData: i });
        }
        allItems.sort((a, b) => b.id - a.id);
        allItems = allItems.slice(0, 200);
      }
    }

    // ── PASO 2: Obtener thumbnails (lotes de 100)
    const thumbMap = {};
    const ids = allItems.map(i => String(i.id));
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100).join(',');
      try {
        const r = await fetch(
          'https://thumbnails.roblox.com/v1/assets?assetIds=' + batch +
          '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false'
        );
        if (r.ok) {
          const j = await r.json();
          (j.data || []).forEach(t => {
            if (t.state === 'Completed') thumbMap[String(t.targetId)] = t.imageUrl;
          });
        }
      } catch(e) { console.log('Thumb error:', e.message); }
      await sleep(200);
    }

    // ── PASO 3: Detalles individuales desde catalog.roblox.com/v1/catalog/items/details
    // Este endpoint acepta lotes de hasta 120 items
    const detailMap = {};
    const idChunks = [];
    for (let i = 0; i < ids.length; i += 120) idChunks.push(ids.slice(i, i + 120));

    for (const chunk of idChunks) {
      try {
        const body = { items: chunk.map(id => ({ itemType: 'Asset', id: Number(id) })) };
        const r = await fetch('https://catalog.roblox.com/v1/catalog/items/details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body)
        });
        if (r.ok) {
          const j = await r.json();
          (j.data || []).forEach(item => {
            detailMap[String(item.id)] = {
              creatorName:   item.creatorName || 'UGC Creator',
              creatorType:   item.creatorType || 'User',
              creatorId:     item.creatorTargetId || 0,
              assetType:     assetTypeName(item.assetType),
              description:   item.description || '',
              favorites:     item.favoriteCount || 0,
              price:         item.price || 0,
              lowestPrice:   item.lowestPrice || item.price || 0,
              unitsAvailable: item.remaining !== undefined ? item.remaining : (item.unitsAvailableForConsumption || 0),
              totalQuantity: item.totalQuantity || 0,
              purchaseLimit: item.purchaseLimit || null,
              saleLocation:  item.saleLocationType === 1 ? 'Everywhere' : (item.saleLocationType === 2 ? 'Game Only' : 'Everywhere'),
              saleStatus:    item.offSale ? 'Off Sale' : 'For Sale',
              itemRestrictions: item.itemRestrictions || [],
            };
          });
        }
      } catch(e) { console.log('Detail batch error:', e.message); }
      await sleep(300);
    }

    // ── PASO 4: Construir resultado final
    const result = allItems.map(item => {
      const id = String(item.id || item.Id);
      const d = detailMap[id] || {};
      const roliData = item._roliData || [];

      const rap   = roliData[2] > 0 ? roliData[2] : null;
      const value = roliData[2] > 0 ? roliData[2] : (d.lowestPrice || 0);

      const totalQty   = d.totalQuantity > 0 ? d.totalQuantity : 200;
      const unitsAvail = d.unitsAvailable >= 0 ? d.unitsAvailable : Math.floor(totalQty * 0.4);

      return {
        id:             id,
        name:           item.name || item.Name || '—',
        rap:            rap,
        value:          value,
        totalQuantity:  totalQty,
        unitsAvailable: unitsAvail,
        thumbnail:      thumbMap[id] || item.thumbnail || null,
        creatorName:    d.creatorName    || item.creatorName    || 'UGC Creator',
        creatorType:    d.creatorType    || 'User',
        creatorId:      d.creatorId      || 0,
        assetType:      d.assetType      || assetTypeName(item.assetType) || 'Accessory',
        description:    d.description    || item.description    || '',
        favorites:      d.favorites      || item.favoriteCount  || 0,
        price:          d.price          || item.price          || 0,
        lowestPrice:    d.lowestPrice    || 0,
        saleLocation:   d.saleLocation   || 'Everywhere',
        saleStatus:     d.saleStatus     || 'For Sale',
        purchaseLimit:  d.purchaseLimit  || 1,
        priceInRobux:   d.price          || 0,
        robloxUrl:      'https://www.roblox.com/catalog/' + id,
        roliUrl:        'https://www.rolimons.com/item/' + id,
        tryOnUrl:       'https://www.roblox.com/catalog/' + id + '?tryOn=true'
      };
    }).filter(i => i.name !== '—');

    cacheData = result;
    cacheTime = Date.now();
    console.log('Resultado final:', result.length, 'items');
    res.json({ success: true, data: result, total: result.length });

  } catch (e) {
    console.error('Error principal:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', cached: !!cacheData, total: cacheData ? cacheData.length : 0 });
});

app.listen(PORT, () => console.log('✅ Puerto ' + PORT));
