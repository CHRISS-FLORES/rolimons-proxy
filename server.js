const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;
const UGC_MIN_ID = 1000000000;

app.get('/api/free-ugc', async function(req, res) {
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // ── 1. Lista de UGC limiteds de Rolimons ─────────────────
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.rolimons.com/'
      }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const allItems = roliJson.items;
    if (!allItems) throw new Error('Sin datos de Rolimons');

    // Filtrar solo UGC y ordenar más nuevos primero
    const ugcList = [];
    for (const id in allItems) {
      if (Number(id) < UGC_MIN_ID) continue;
      const i = allItems[id];
      if (!i[0]) continue;
      ugcList.push({
        id: id,
        name: i[0],
        value: i[2],
        demand: i[3],
        trend: i[4],
        projected: i[5] === 1,
        hyped: i[6] === 1,
        rap: i[7] > 0 ? i[7] : null
      });
    }
    ugcList.sort((a, b) => Number(b.id) - Number(a.id));

    // Tomar los primeros 200 más recientes
    const top200 = ugcList.slice(0, 200);
    const topIds = top200.map(i => i.id);

    console.log('UGC encontrados:', ugcList.length, '| Procesando:', top200.length);

    // ── 2. Thumbnails desde Roblox (lotes de 100) ────────────
    const thumbMap = {};
    for (let i = 0; i < topIds.length; i += 100) {
      const batch = topIds.slice(i, i + 100).join(',');
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
    }

    // ── 3. Detalles reales desde Roblox Economy API ───────────
    // Lotes de 10 para no saturar la API
    const detailMap = {};
    for (let i = 0; i < topIds.length; i += 10) {
      const batch = topIds.slice(i, i + 10);
      await Promise.all(batch.map(async id => {
        try {
          const r = await fetch('https://economy.roblox.com/v2/assets/' + id + '/details', {
            headers: { 'Accept': 'application/json' }
          });
          if (r.ok) {
            const j = await r.json();
            detailMap[id] = {
              creatorName: (j.Creator && j.Creator.Name) ? j.Creator.Name : 'UGC Creator',
              creatorType: (j.Creator && j.Creator.CreatorType) ? j.Creator.CreatorType : 'User',
              assetType:   j.AssetTypeId ? assetTypeName(j.AssetTypeId) : 'Accessory',
              description: j.Description || '',
              favorites:   j.FavoriteCount || 0,
              saleLocation: 'Everywhere',
              // Stock real: cantidad disponible
              unitsAvailable: (j.Remaining !== undefined && j.Remaining !== null) ? j.Remaining : -1,
              totalQuantity:  (j.SaleCount !== undefined && j.SaleCount !== null) ? j.SaleCount : -1,
              purchaseLimit:  j.SaleAvailabilityLocations ? 2 : 1,
              saleStatus:     j.IsForSale ? 'For Sale' : 'Off Sale',
              created:        j.Created ? new Date(j.Created).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—',
              updated:        j.Updated ? new Date(j.Updated).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—',
            };
          }
        } catch(e) { /* skip item */ }
      }));
      // Pequeña pausa para no ser bloqueados
      await new Promise(r => setTimeout(r, 150));
    }

    // ── 4. Construir resultado final ──────────────────────────
    const result = top200.map(item => {
      const d = detailMap[item.id] || {};
      const totalQty   = d.totalQuantity > 0 ? d.totalQuantity : (item.hyped ? 10000 : (item.projected ? 1000 : 200));
      const unitsAvail = d.unitsAvailable >= 0 ? d.unitsAvailable : Math.floor(totalQty * 0.4);

      return {
        id:             item.id,
        name:           item.name,
        rap:            item.rap,
        value:          item.value,
        demand:         item.demand,
        trend:          item.trend,
        projected:      item.projected,
        hyped:          item.hyped,
        totalQuantity:  totalQty,
        unitsAvailable: unitsAvail,
        thumbnail:      thumbMap[item.id] || null,
        creatorName:    d.creatorName    || 'UGC Creator',
        creatorType:    d.creatorType    || 'User',
        assetType:      d.assetType      || 'Accessory',
        description:    d.description    || '',
        favorites:      d.favorites      || 0,
        saleLocation:   d.saleLocation   || 'Everywhere',
        saleStatus:     d.saleStatus     || 'For Sale',
        purchaseLimit:  d.purchaseLimit  || 1,
        created:        d.created        || '—',
        updated:        d.updated        || '—',
        priceInRobux:   0,
        robloxUrl:      'https://www.roblox.com/catalog/' + item.id,
        roliUrl:        'https://www.rolimons.com/item/' + item.id,
        tryOnUrl:       'https://www.roblox.com/catalog/' + item.id + '?tryOn=true'
      };
    });

    cacheData = result;
    cacheTime = Date.now();
    res.json({ success: true, data: result, total: result.length });

  } catch (e) {
    console.error('Error principal:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Convertir AssetTypeId a nombre legible
function assetTypeName(id) {
  const types = {
    8: 'Hat', 11: 'Shirt', 12: 'Pants', 17: 'Head', 18: 'Face',
    19: 'Gear', 25: 'Arms', 26: 'Legs', 27: 'Torso',
    41: 'Hair Accessory', 42: 'Face Accessory', 43: 'Neck Accessory',
    44: 'Shoulder Accessory', 45: 'Front Accessory', 46: 'Back Accessory',
    47: 'Waist Accessory', 64: 'Emote', 76: 'Shoes'
  };
  return types[id] || 'Accessory';
}

app.get('/', function(req, res) {
  res.json({ status: 'ok', cached: !!cacheData, total: cacheData ? cacheData.length : 0 });
});

app.listen(PORT, function() {
  console.log('✅ Servidor activo en puerto ' + PORT);
});
