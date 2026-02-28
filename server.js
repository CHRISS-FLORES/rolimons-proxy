const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cacheData = null;
let cacheTime = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 min

app.get('/api/free-ugc', async function(req, res) {
  const force = req.query.refresh === '1';
  if (!force && cacheData && (Date.now() - cacheTime) < CACHE_MS) {
    return res.json({ success: true, data: cacheData, total: cacheData.length, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;

    const roliRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!roliRes.ok) throw new Error('Rolimons HTTP ' + roliRes.status);
    const roliJson = await roliRes.json();
    const allRoli = roliJson.items || {};

    // Solo UGC (ID >= 1 billion), más nuevos primero
    const ugcList = [];
    for (const id in allRoli) {
      if (Number(id) < 1000000000) continue;
      const i = allRoli[id];
      if (!i[0]) continue;
      ugcList.push({
        id,
        name:      i[0],
        value:     i[2],
        demand:    i[3],
        trend:     i[4],
        projected: i[5] === 1,
        hyped:     i[6] === 1,
        rap:       i[7] > 0 ? i[7] : null
      });
    }

    ugcList.sort((a, b) => Number(b.id) - Number(a.id));

    // Devolver los 200 más recientes — el browser enriquecerá con datos de Roblox
    const top = ugcList.slice(0, 200);

    cacheData = top;
    cacheTime = Date.now();
    console.log('UGC total:', ugcList.length, '| Devolviendo:', top.length);
    res.json({ success: true, data: top, total: top.length });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.json({
  status: 'ok', cached: !!cacheData, total: cacheData ? cacheData.length : 0
}));

app.listen(PORT, () => console.log('✅ Puerto ' + PORT));
