// Vercel 서버리스 함수 — Yahoo Finance 데이터 수집 + CNN 뉴스 번역
// 파일 위치: api/quote.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('No result');
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(v => v != null);
    const current = validCloses[validCloses.length - 1];
    if (!current) throw new Error('No price');
    const ma200arr = validCloses.slice(-200);
    const ma200 = ma200arr.reduce((a, b) => a + b, 0) / ma200arr.length;
    const timestamps = result.timestamp ?? [];
    const currentYear = new Date().getFullYear();
    let ytdBase = null;
    for (let i = 0; i < timestamps.length; i++) {
      if (new Date(timestamps[i] * 1000).getFullYear() === currentYear) { ytdBase = validCloses[i]; break; }
    }
    const ytd = ytdBase ? ((current - ytdBase) / ytdBase * 100) : null;
    const meta = result.meta ?? {};
    const high52 = meta.fiftyTwoWeekHigh ?? Math.max(...validCloses);
    const low52  = meta.fiftyTwoWeekLow  ?? Math.min(...validCloses);
    const recentCloses = validCloses.slice(-7);
    const recentTs = timestamps.slice(-7);
    const history = recentCloses.map((v, i) => {
      const d = recentTs[i] ? new Date(recentTs[i] * 1000) : new Date();
      return { date: `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`, val: parseFloat(v.toFixed(3)) };
    });
    return {
      current: parseFloat(current.toFixed(2)), ma200: parseFloat(ma200.toFixed(2)),
      ytd: ytd ? parseFloat(ytd.toFixed(1)) : null,
      high52: parseFloat(high52.toFixed(2)), low52: parseFloat(low52.toFixed(2)), history,
    };
  }

  async function fetchFearGreed() {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json', 'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com',
    };
    try {
      const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers });
      if (r.ok) { const j = await r.json(); const s = j?.fear_and_greed?.score ?? j?.score ?? null; if (s !== null) return Math.round(Number(s)); }
    } catch {}
    return null;
  }

  // CNN 이란·중동·전쟁 관련 뉴스 수집
  async function fetchCNNNews() {
    const KEYWORDS = [
      'iran', 'tehran', 'hormuz', 'middle east', 'nuclear',
      'sanction', 'irgc', 'israel', 'war', 'military strike',
      'crude oil', 'persian gulf', 'trump iran', 'hezbollah', 'hamas',
    ];
    const feeds = [
      'https://rss.cnn.com/rss/edition_world.rss',
      'https://rss.cnn.com/rss/edition.rss',
      'https://rss.cnn.com/rss/money_news_international.rss',
    ];
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; newsbot/1.0)', 'Accept': 'application/rss+xml, text/xml' };

    const matched = [];
    for (const feedUrl of feeds) {
      try {
        const r = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const xml = await r.text();
        const itemRe = /<item[\s\S]*?<\/item>/gi;
        const items = [...xml.matchAll(itemRe)];
        for (const [itemStr] of items) {
          const title   = (itemStr.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ?? itemStr.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1]?.trim() ?? '';
          const desc    = (itemStr.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ?? itemStr.match(/<description[^>]*>([\s\S]*?)<\/description>/))?.[1]?.replace(/<[^>]+>/g,'').trim().slice(0,200) ?? '';
          const link    = (itemStr.match(/<link[^>]*>([\s\S]*?)<\/link>/) ?? itemStr.match(/<guid[^>]*>([\s\S]*?)<\/guid>/))?.[1]?.trim() ?? '';
          const pubDate = (itemStr.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/))?.[1]?.trim() ?? '';
          if (!title) continue;
          const text = (title + ' ' + desc).toLowerCase();
          if (KEYWORDS.some(k => text.includes(k)) && !matched.find(m => m.title === title)) {
            matched.push({ title, desc, link, pubDate });
          }
        }
      } catch {}
    }
    matched.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return matched.slice(0, 6);
  }

  // Claude API로 한글 번역
  async function translateNews(articles) {
    if (!articles || articles.length === 0) return [];
    const toTranslate = articles.map((a, i) => `[${i+1}] 제목: ${a.title}\n요약: ${a.desc || ''}`).join('\n\n');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `다음 CNN 뉴스들을 한국어로 번역해주세요. 고유명사는 한국 언론 표기를 따르고, 자연스러운 뉴스 문체로 번역하세요.
반드시 아래 JSON 배열 형식으로만 응답하세요. 다른 텍스트 없이 JSON만:
[{"title":"번역된 제목","desc":"번역된 요약"},...]

${toTranslate}`
          }]
        })
      });
      if (!r.ok) throw new Error(`Claude API ${r.status}`);
      const j = await r.json();
      const text = j?.content?.[0]?.text?.trim() ?? '';
      // JSON 부분만 추출
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const translations = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      return articles.map((a, i) => ({
        ...a,
        titleKo: translations[i]?.title ?? a.title,
        descKo:  translations[i]?.desc  ?? a.desc,
      }));
    } catch {
      return articles.map(a => ({ ...a, titleKo: a.title, descKo: a.desc }));
    }
  }

  try {
    const [marketResults, rawNews] = await Promise.all([
      Promise.allSettled([...symbols.map(s => fetchQuote(s)), fetchFearGreed()]),
      fetchCNNNews(),
    ]);

    const [sp500, ndx, tqqq, fngu, soxl, vix, gold, tnx, wti, fg] =
      marketResults.map(r => r.status === 'fulfilled' ? r.value : null);

    const news = rawNews.length > 0 ? await translateNews(rawNews) : [];

    res.status(200).json({
      sp500, ndx, tqqq, fngu, soxl, vix, gold, tnx, wti, fg, news,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
