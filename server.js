const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 8 * 60 * 1000;

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

    // ── PASO 1: Lista UGC de Rolimons ─────────────────────────
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
      ugcList.push({
        id, name: i[0], value: i[2], demand: i[3], trend: i[4],
        projected: i[5]===1, hyped: i[6]===1, rap: i[7]>0 ? i[7] : null
      });
    }
    ugcList.sort((a, b) => Number(b.id) - Number(a.id));
    const top = ugcList.slice(0, 120);
    const ids = top.map(i => i.id);
    console.log('UGC total:', ugcList.length, '| Procesando:', top.length);

    // ── PASO 2: Thumbnails en lote ────────────────────────────
    const thumbMap = {};
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
      await sleep(300);
    }

    // ── PASO 3: Detalles en lote via catalog v1 POST ──────────
    // Este endpoint acepta hasta 120 items a la vez
    const detailMap = {};
    for (let i = 0; i < ids.length; i += 120) {
      const chunk = ids.slice(i, i + 120);
      try {
        const body = { items: chunk.map(id => ({ itemType: 'Asset', id: Number(id) })) };
        const r = await fetch('https://catalog.roblox.com/v1/catalog/items/details', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          body: JSON.stringify(body)
        });
        if (r.ok) {
          const j = await r.json();
          console.log('Catalog batch items returned:', (j.data||[]).length, '/', chunk.length);
          (j.data || []).forEach(item => {
            const sid = String(item.id);
            detailMap[sid] = {
              creatorName:    item.creatorName      || null,
              creatorType:    item.creatorType      || 'User',
              creatorId:      item.creatorTargetId  || 0,
              assetType:      assetTypeName(item.assetType),
              description:    item.description      || '',
              favorites:      item.favoriteCount    || 0,
              price:          item.price            || 0,
              lowestPrice:    item.lowestPrice      || item.price || 0,
              unitsAvailable: item.remaining        !== undefined ? item.remaining : null,
              totalQuantity:  item.totalQuantity    || null,
              purchaseLimit:  item.purchaseLimit    || null,
              offSale:        item.offSale          || false,
              saleLocationType: item.saleLocationType || 1
            };
          });
        } else {
          const errText = await r.text();
          console.log('Catalog batch error:', r.status, errText.substring(0, 200));
        }
      } catch(e) { console.log('Catalog POST error:', e.message); }
      await sleep(500);
    }

    // ── PASO 4: Creadores en lote via users/groups API ────────
    // Agrupar por creatorId para pedir nombres en lote
    const userIds = [...new Set(
      Object.values(detailMap)
        .filter(d => d.creatorType === 'User' && d.creatorId > 0)
        .map(d => d.creatorId)
    )];
    const groupIds = [...new Set(
      Object.values(detailMap)
        .filter(d => d.creatorType === 'Group' && d.creatorId > 0)
        .map(d => d.creatorId)
    )];

    const userNameMap = {};
    const groupNameMap = {};

    // Nombres de usuarios en lote
    if (userIds.length > 0) {
      for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        try {
          const r = await fetch('https://users.roblox.com/v1/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ userIds: batch, excludeBannedUsers: false })
          });
          if (r.ok) {
            const j = await r.json();
            (j.data || []).forEach(u => { userNameMap[u.id] = u.displayName || u.name; });
          }
        } catch(e) { console.log('Users API error:', e.message); }
        await sleep(300);
      }
    }

    // Nombres de grupos en lote
    if (groupIds.length > 0) {
      for (let i = 0; i < groupIds.length; i += 50) {
        const batch = groupIds.slice(i, i + 50).join(',');
        try {
          const r = await fetch('https://groups.roblox.com/v2/groups?groupIds=' + batch);
          if (r.ok) {
            const j = await r.json();
            (j.data || []).forEach(g => { groupNameMap[g.id] = g.name; });
          }
        } catch(e) { console.log('Groups API error:', e.message); }
        await sleep(300);
      }
    }

    console.log('Usuarios resueltos:', Object.keys(userNameMap).length, '| Grupos:', Object.keys(groupNameMap).length);

    // ── PASO 5: Construir resultado ───────────────────────────
    const result = top.map(item => {
      const d = detailMap[item.id] || {};

      // Resolver nombre real del creador
      let creatorName = 'UGC Creator';
      if (d.creatorId > 0) {
        if (d.creatorType === 'Group' && groupNameMap[d.creatorId]) {
          creatorName = groupNameMap[d.creatorId];
        } else if (userNameMap[d.creatorId]) {
          creatorName = userNameMap[d.creatorId];
        } else if (d.creatorName) {
          creatorName = d.creatorName;
        }
      }

      const saleLocType = d.saleLocationType || 1;
      const saleLocation = saleLocType === 2 ? 'Game Only' : saleLocType === 4 ? 'Specific Games' : 'Everywhere';

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
        creatorName:    creatorName,
        creatorType:    d.creatorType  || 'User',
        creatorId:      d.creatorId    || 0,
        assetType:      d.assetType    || 'Accessory',
        description:    d.description  || '',
        favorites:      d.favorites    || 0,
        price:          d.price        || 0,
        lowestPrice:    d.lowestPrice  || 0,
        saleLocation:   saleLocation,
        saleStatus:     d.offSale ? 'Off Sale' : 'For Sale',
        purchaseLimit:  d.purchaseLimit || 1,
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
    console.error('Error principal:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  cached: !!cacheData,
  total: cacheData ? cacheData.length : 0
}));

app.listen(PORT, () => console.log('✅ Puerto ' + PORT));
