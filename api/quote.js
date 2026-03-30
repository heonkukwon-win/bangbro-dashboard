// Vercel 서버리스 함수 — Yahoo Finance 데이터 수집
// 파일 위치: api/quote.js

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate'); // 5분 캐시

  const symbols = ['^GSPC', '^NDX', 'TQQQ', 'FNGU', 'SOXL', '^VIX', 'GLD', '^TNX', 'CL=F'];

  async function fetchQuote(symbol) {
    const range = symbol === '^VIX' ? '3mo' : '1y';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} for ${symbol}`);
    const json = await response.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No result for ${symbol}`);

    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(v => v != null);
    const current = validCloses[validCloses.length - 1];
    if (!current) throw new Error(`No price for ${symbol}`);

    // 200일 이동평균
    const ma200arr = validCloses.slice(-200);
    const ma200 = ma200arr.reduce((a, b) => a + b, 0) / ma200arr.length;

    // YTD
    const timestamps = result.timestamp ?? [];
    const currentYear = new Date().getFullYear();
    let ytdBase = null;
    for (let i = 0; i < timestamps.length; i++) {
      if (new Date(timestamps[i] * 1000).getFullYear() === currentYear) {
        ytdBase = validCloses[i];
        break;
      }
    }
    const ytd = ytdBase ? ((current - ytdBase) / ytdBase * 100) : null;

    // 52주 고저
    const meta = result.meta ?? {};
    const high52 = meta.fiftyTwoWeekHigh ?? Math.max(...validCloses);
    const low52  = meta.fiftyTwoWeekLow  ?? Math.min(...validCloses);

    // 최근 7일 히스토리
    const recentCloses = validCloses.slice(-7);
    const recentTs     = timestamps.slice(-7);
    const history = recentCloses.map((v, i) => {
      const d = recentTs[i] ? new Date(recentTs[i] * 1000) : new Date();
      return {
        date: `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`,
        val:  parseFloat(v.toFixed(3))
      };
    });

    return {
      current: parseFloat(current.toFixed(2)),
      ma200:   parseFloat(ma200.toFixed(2)),
      ytd:     ytd ? parseFloat(ytd.toFixed(1)) : null,
      high52:  parseFloat(high52.toFixed(2)),
      low52:   parseFloat(low52.toFixed(2)),
      history,
    };
  }

  // Fear & Greed (다중 엔드포인트 폴백)
  async function fetchFearGreed() {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://edition.cnn.com/',
      'Origin': 'https://edition.cnn.com',
    };

    // 엔드포인트 1: 기본 CNN API
    try {
      const r = await fetch(
        'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
        { headers }
      );
      if (r.ok) {
        const j = await r.json();
        const score = j?.fear_and_greed?.score ?? j?.score ?? null;
        if (score !== null) return Math.round(Number(score));
      }
    } catch {}

    // 엔드포인트 2: 대체 CNN URL
    try {
      const r = await fetch(
        'https://fear-and-greed-index.p.rapidapi.com/v1/fgi',
        { headers }
      );
      if (r.ok) {
        const j = await r.json();
        const score = j?.fgi?.now?.value ?? null;
        if (score !== null) return Math.round(Number(score));
      }
    } catch {}

    return null;
  }

  // 뉴스 RSS 파싱 (이란·중동 관련 키워드 필터)
  async function fetchNews() {
    const KEYWORDS = ['iran','tehran','hormuz','middle east','nuclear','sanction',
                      '이란','호르무즈','중동','핵','제재','원유','oil'];
    const feeds = [
      { src: 'CNN',  url: 'https://rss.cnn.com/rss/edition_world.rss' },
      { src: 'WSJ',  url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
    ];
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; newsbot/1.0)',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    };

    const news = [];
    for (const feed of feeds) {
      try {
        const r = await fetch(feed.url, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const xml = await r.text();
        // <item> 파싱
        const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)];
        for (const [itemStr] of items) {
          const title   = (itemStr.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
                        ?? itemStr.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1]?.trim() ?? '';
          const desc    = (itemStr.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
                        ?? itemStr.match(/<description[^>]*>([\s\S]*?)<\/description>/))?.[1]
                           ?.replace(/<[^>]+>/g, '').trim().slice(0, 120) ?? '';
          const link    = (itemStr.match(/<link[^>]*>([\s\S]*?)<\/link>/)
                        ?? itemStr.match(/<link[^>]*\/?>([^<]+)/))?.[1]?.trim() ?? '';
          const pubDate = (itemStr.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/))?.[1]?.trim() ?? '';

          const text = (title + ' ' + desc).toLowerCase();
          const match = KEYWORDS.some(k => text.includes(k));
          if (match && title) {
            news.push({ src: feed.src, title, desc, link, pubDate });
            if (news.filter(n => n.src === feed.src).length >= 4) break;
          }
        }
      } catch {}
    }
    return news.slice(0, 8);
  }

  try {
    const results = await Promise.allSettled([
      ...symbols.map(s => fetchQuote(s)),
      fetchFearGreed(),
      fetchNews(),
    ]);

    const [sp500, ndx, tqqq, fngu, soxl, vix, gold, tnx, wti, fg, news] =
      results.map(r => r.status === 'fulfilled' ? r.value : null);

    res.status(200).json({
      sp500, ndx, tqqq, fngu, soxl, vix, gold, tnx, wti,
      fg,
      news: news ?? [],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
