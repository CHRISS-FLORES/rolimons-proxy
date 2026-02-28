const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 10 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assetTypeName(id) {
  const t = {8:'Hat',11:'Shirt',12:'Pants',17:'Head',18:'Face',19:'Gear',
    41:'Hair Accessory',42:'Face Accessory',43:'Neck Accessory',
    44:'Shoulder Accessory',45:'Front Accessory',46:'Back Accessory',
    47:'Waist Accessory',64:'Emote',76:'Shoes'};
  return t[id] || 'Accessory';
}

app.get('/api/free-ugc', async function(req, res) {
  const force = req.query.refresh === '1';
  if (!force && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // ── 1. Lista de Rolimons ──────────────────────────────────
    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const allRoli = roliJson.items || {};

    const ugcList = [];
    for (const id in allRoli) {
      if (Number(id) < 1000000000) continue;
      const i = allRoli[id];
      if (!i[0]) continue;
      ugcList.push({ id, name: i[0], value: i[2], demand: i[3], trend: i[4],
        projected: i[5]===1, hyped: i[6]===1, rap: i[7]>0 ? i[7] : null });
    }
    ugcList.sort((a, b) => Number(b.id) - Number(a.id));
    const top = ugcList.slice(0, 100);
    const ids = top.map(i => i.id);
    console.log('UGC total:', ugcList.length, '| Procesando:', top.length);

    // ── 2. Thumbnails desde Rolimons CDN (no CORS, funciona siempre) ──
    // Rolimons usa: https://tr.rbxcdn.com/180DAY-{hash}/420/420/{type}/Png/noFilter
    // Pero también podemos construir la URL directamente desde Roblox thumbs
    const thumbMap = {};
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100).join(',');
      try {
        const r = await fetch(
          'https://thumbnails.roblox.com/v1/assets?assetIds=' + batch +
          '&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
        );
        if (r.ok) {
          const j = await r.json();
          (j.data || []).forEach(t => {
            if (t.state === 'Completed') thumbMap[String(t.targetId)] = t.imageUrl;
          });
          console.log('Thumbnails lote:', (j.data||[]).length);
        }
      } catch(e) { console.log('Thumb error:', e.message); }
      if (i + 100 < ids.length) await sleep(400);
    }

    // ── 3. Datos reales: api.roblox.com/marketplace/productinfo ──
    // Este endpoint SÍ funciona desde servidor, no requiere auth, no bloquea
    const detailMap = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const r = await fetch(
          'https://api.roblox.com/marketplace/productinfo?assetId=' + id,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (r.ok) {
          const j = await r.json();
          detailMap[id] = {
            creatorName:   j.Creator?.Name          || 'UGC Creator',
            creatorType:   j.Creator?.CreatorType   || 'User',
            creatorId:     j.Creator?.Id            || 0,
            assetType:     assetTypeName(j.AssetTypeId),
            description:   j.Description            || '',
            price:         j.PriceInRobux           || 0,
            isForSale:     j.IsForSale               ?? true,
            isLimited:     j.IsLimited              || false,
            isLimitedU:    j.IsLimitedUnique         || false,
            remaining:     j.Remaining              !== undefined ? j.Remaining : null,
            sales:         j.Sales                  || 0,
          };
        }
      } catch(e) { /* skip */ }

      // Pausa cada 5 para no ser rate-limited
      if (i % 5 === 4) await sleep(600);
    }

    const found = Object.keys(detailMap).length;
    console.log('Detalles obtenidos:', found, '/', ids.length);

    // ── 4. Resultado final ────────────────────────────────────
    const result = top.map(item => {
      const d = detailMap[item.id] || {};
      const totalQty   = d.sales != null && d.sales > 0 ? d.sales : (item.hyped ? 10000 : (item.projected ? 1000 : 200));
      const unitsAvail = d.remaining != null ? d.remaining : Math.floor(totalQty * 0.4);

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
        price:          d.price        || 0,
        saleStatus:     d.isForSale    ? 'For Sale' : 'Off Sale',
        saleLocation:   'Everywhere',
        purchaseLimit:  1,
        favorites:      0,
        robloxUrl:      'https://www.roblox.com/catalog/' + item.id,
        roliUrl:        'https://www.rolimons.com/item/' + item.id,
        tryOnUrl:       'https://www.roblox.com/catalog/' + item.id + '?tryOn=true'
      };
    });

    const uniqueCreators = new Set(result.map(r => r.creatorName)).size;
    console.log('Final:', result.length, 'items | Creadores únicos:', uniqueCreators);

    cacheData = result;
    cacheTime = Date.now();
    res.json({ success: true, data: result, total: result.length });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', cached: !!cacheData, total: cacheData?.length || 0 }));
app.listen(PORT, () => console.log('✅ Puerto ' + PORT));
