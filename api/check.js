import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
});

const { OPENSEA_API_KEY, DISCORD_WEBHOOK_URL, COLLECTION_SLUG, CRON_SECRET } = process.env;
const TS_KEY = 'lil-trenchers:lastTs';

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'unknown');
const eventTs = (e) => e.event_timestamp ?? e.closing_date;

function formatPrice(p) {
  if (!p) return 'n/a';
  const v = Number(p.quantity) / 10 ** p.decimals;
  return `${Number(v.toFixed(4))} ${p.symbol}`;
}

async function fetchSales(after) {
  const url =
    `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}` +
    `?event_type=sale&after=${after}&limit=50`;
  const res = await fetch(url, {
    headers: { 'x-api-key': OPENSEA_API_KEY, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status}`);
  const data = await res.json();
  return data.asset_events ?? [];
}

async function postSale(e) {
  const nft = e.nft ?? {};
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Lil Trenchers',
      embeds: [
        {
          title: `${nft.name ?? `Lil Trencher #${nft.identifier}`} sold`,
          url: nft.opensea_url,
          color: 0x2ecc71,
          image: { url: nft.display_image_url ?? nft.image_url },
          fields: [
            { name: 'Price', value: formatPrice(e.payment), inline: true },
            { name: 'Buyer', value: short(e.buyer), inline: true },
            { name: 'Seller', value: short(e.seller), inline: true },
          ],
          timestamp: new Date(eventTs(e) * 1000).toISOString(),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!OPENSEA_API_KEY || !DISCORD_WEBHOOK_URL || !COLLECTION_SLUG) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const lastTs = await redis.get(TS_KEY);

    // First run: start from now so old sales are never posted.
    if (!lastTs) {
      await redis.set(TS_KEY, now);
      return res.status(200).json({ initialized: true });
    }

    const events = (await fetchSales(Number(lastTs))).sort((a, b) => eventTs(a) - eventTs(b));
    let posted = 0;
    let newest = Number(lastTs);

    for (const e of events) {
      const key = `lil-trencher:seen:${e.transaction}:${e.nft?.identifier}`;
      const isNew = await redis.set(key, 1, { nx: true, ex: 172800 });
      if (!isNew) continue;
      try {
        await postSale(e);
        posted++;
        newest = Math.max(newest, eventTs(e));
      } catch (err) {
        await redis.del(key); // let the next run retry this sale
        throw err;
      }
    }

    await redis.set(TS_KEY, newest);
    return res.status(200).json({ checked: events.length, posted });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
}
