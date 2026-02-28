const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 8 * 60 * 1000; // 8 min cache

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assetTypeName(id) {
  const t = {8:'Hat',11:'Shirt',12:'Pants',17:'Head',18:'Face',19:'Gear',
    41:'Hair Accessory',42:'Face Accessory',43:'Neck Accessory',
    44:'Shoulder Accessory',45:'Front Accessory',46:'Back Accessory',
    47:'Waist Accessory',64:'Emote',76:'Shoes'};
  return t[id] || 'Accessory';
}

function formatDate(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  } catch(e) { return '—'; }
}

app.get('/api/free-ugc', async function(req, res) {
  const force = req.query.refresh === '1';
  if (!force && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // ── PASO 1: Lista UGC de Rolimons ─────────────────────────
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const allRoli = roliJson.items || {};

    // Solo UGC (ID >= 1 billion), ordenados más nuevos primero
    const ugcList = [];
    for (const id in allRoli) {
      if (Number(id) < 1000000000) continue;
      const i = allRoli[id];
      if (!i[0]) continue;
      ugcList.push({ id, name: i[0], value: i[2], demand: i[3], trend: i[4], projected: i[5]===1, hyped: i[6]===1, rap: i[7]>0 ? i[7] : null });
    }
    ugcList.sort((a, b) => Number(b.id) - Number(a.id));
    const top = ugcList.slice(0, 100); // 100 items más recientes
    console.log('UGC total:', ugcList.length, '| Procesando:', top.length);

    // ── PASO 2: Thumbnails en lote ────────────────────────────
    const thumbMap = {};
    const ids = top.map(i => i.id);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100).join(',');
      try {
        const r = await fetch('https://thumbnails.roblox.com/v1/assets?assetIds=' + batch + '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false');
        if (r.ok) {
          const j = await r.json();
          (j.data || []).forEach(t => { if (t.state === 'Completed') thumbMap[String(t.targetId)] = t.imageUrl; });
        }
      } catch(e) { console.log('Thumb error:', e.message); }
    }

    // ── PASO 3: Datos reales de cada item desde economy API ───
    const detailMap = {};
    for (let i = 0; i < top.length; i++) {
      const id = top[i].id;
      try {
        const r = await fetch('https://economy.roblox.com/v2/assets/' + id + '/details', {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.ok) {
          const j = await r.json();
          detailMap[id] = {
            creatorName:    j.Creator?.Name       || 'UGC Creator',
            creatorType:    j.Creator?.CreatorType || 'User',
            creatorId:      j.Creator?.CreatorTargetId || 0,
            assetType:      assetTypeName(j.AssetTypeId),
            description:    j.Description || '',
            price:          j.PriceInRobux || 0,
            lowestPrice:    j.LowestPrice  || j.PriceInRobux || 0,
            unitsAvailable: j.Remaining    !== undefined ? j.Remaining : null,
            totalQuantity:  j.SaleCount    !== undefined ? j.SaleCount : null,
            purchaseLimit:  j.CollectiblesItemDetails?.CollectibleLowestResalePrice || null,
            saleStatus:     j.IsForSale ? 'For Sale' : 'Off Sale',
            created:        formatDate(j.Created),
            updated:        formatDate(j.Updated),
            favorites:      j.FavoriteCount || 0,
            saleLocation:   'Everywhere'
          };
        }
      } catch(e) { /* skip */ }

      // Pausa cada 5 items para no ser bloqueados
      if (i % 5 === 4) await sleep(500);
    }

    // ── PASO 4: Intentar obtener sale location desde catalog ──
    // catalog.roblox.com/v2/assets?assetIds= devuelve saleLocationType
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50).join('&assetIds=');
        const r = await fetch('https://catalog.roblox.com/v2/assets?assetIds=' + batch, {
          headers: { 'Accept': 'application/json' }
        });
        if (r.ok) {
          const j = await r.json();
          (j.data || []).forEach(item => {
            const sid = String(item.id);
            if (detailMap[sid]) {
              const loc = item.saleLocationType;
              detailMap[sid].saleLocation = loc === 2 ? 'Game Only' : loc === 4 ? 'Specific Games' : 'Everywhere';
              // Si tiene gameId, intentar usar el gameName
              if (item.gameId) detailMap[sid].gameId = item.gameId;
            }
          });
        }
        await sleep(300);
      }
    } catch(e) { console.log('Catalog v2 error:', e.message); }

    // ── PASO 5: Construir resultado ───────────────────────────
    const result = top.map(item => {
      const d = detailMap[item.id] || {};
      const totalQty   = d.totalQuantity  != null ? d.totalQuantity  : (item.hyped ? 10000 : (item.projected ? 1000 : 200));
      const unitsAvail = d.unitsAvailable != null ? d.unitsAvailable : Math.floor(totalQty * 0.4);

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
        creatorName:    d.creatorName  || 'UGC Creator',
        creatorType:    d.creatorType  || 'User',
        creatorId:      d.creatorId    || 0,
        assetType:      d.assetType    || 'Accessory',
        description:    d.description  || '',
        favorites:      d.favorites    || 0,
        price:          d.price        || 0,
        lowestPrice:    d.lowestPrice  || 0,
        saleLocation:   d.saleLocation || 'Everywhere',
        saleStatus:     d.saleStatus   || 'For Sale',
        purchaseLimit:  d.purchaseLimit || 1,
        created:        d.created      || '—',
        updated:        d.updated      || '—',
        robloxUrl:      'https://www.roblox.com/catalog/' + item.id,
        roliUrl:        'https://www.rolimons.com/item/' + item.id,
        tryOnUrl:       'https://www.roblox.com/catalog/' + item.id + '?tryOn=true'
      };
    });

    cacheData = result;
    cacheTime = Date.now();
    console.log('Resultado:', result.length, 'items | Creadores únicos:', new Set(result.map(r => r.creatorName)).size);
    res.json({ success: true, data: result, total: result.length });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', cached: !!cacheData, total: cacheData?.length || 0 }));
app.listen(PORT, () => console.log('✅ Puerto ' + PORT));
