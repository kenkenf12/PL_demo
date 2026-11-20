import { DomUtils, parseDocument } from 'htmlparser2';
import { rankNews } from './news-ranking.mjs';

const { findAll, findOne, textContent } = DomUtils;
const windowMs = 7 * 86_400_000;
const newsFeeds = [
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/football/premierleague/rss',
    hosts: ['www.theguardian.com'], articles: /^\/football\/\d{4}\// },
  { id: 'bbc', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml',
    hosts: ['www.bbc.co.uk', 'www.bbc.com'], articles: /^\/sport\/football\/articles\// },
  { id: 'sky', name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040',
    hosts: ['www.skysports.com'], articles: /^\/football\/news\// },
  { id: 'independent', name: 'The Independent', url: 'https://www.independent.co.uk/sport/football/premier-league/rss',
    hosts: ['www.independent.co.uk'], articles: /^\/sport\/football\// },
  { id: 'scout', name: 'Fantasy Football Scout', url: 'https://www.fantasyfootballscout.co.uk/feed',
    hosts: ['www.fantasyfootballscout.co.uk'], articles: /^\/\d{4}\/\d{2}\/\d{2}\// }
];

function compact(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function content(node) {
  return node ? compact(textContent(node)) : '';
}

function withoutMarkup(text) {
  return content(parseDocument(text));
}

function articleUrl(value, feed) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !feed.hosts.includes(url.hostname) || !feed.articles.test(url.pathname)) return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

function rssItems(xml, feed) {
  const doc = parseDocument(xml, { xmlMode: true });
  if (!findOne(node => node.name === 'channel', doc.children)) return null;
  return findAll(node => node.name === 'item', doc.children).flatMap(item => {
    const tag = name => content(item.children.find(node => node.name === name));
    const url = articleUrl(tag('link'), feed);
    const title = tag('title');
    const published = Date.parse(tag('pubDate'));
    if (!url || !title || !Number.isFinite(published)) return [];
    return [{ url, title, published, description: withoutMarkup(tag('description')), sections: [],
      authors: [tag('dc:creator') || tag('author')].filter(Boolean), publisher: feed.id, publisherName: feed.name }];
  });
}

function articleContent(html) {
  const { children } = parseDocument(html);
  const metadata = findAll(node => node.name === 'meta', children);
  const meta = key => metadata.find(node => (node.attribs.property ?? node.attribs.name ?? node.attribs.itemprop) === key)?.attribs.content;
  const structured = findAll(node => node.name === 'script' && node.attribs.type === 'application/ld+json', children).flatMap(node => {
    try {
      const parsed = JSON.parse(textContent(node));
      return Array.isArray(parsed) ? parsed : parsed['@graph'] ?? [parsed];
    } catch {
      return [];
    }
  });
  const details = structured.find(item => item?.datePublished);
  const byline = details?.author ? (Array.isArray(details.author) ? details.author : [details.author]) : [];
  const authors = [meta('author'), ...byline.map(author => typeof author === 'string' ? author : author?.name)]
    .filter(name => typeof name === 'string' && name.trim());
  const published = Date.parse(meta('article:published_time') ?? meta('datePublished') ?? details?.datePublished);
  const body = findOne(node => node.attribs?.itemprop === 'articleBody' || node.attribs?.['data-gu-name'] === 'body'
    || /(?:^|\s)(?:entry-content|sdc-article-body)(?:\s|$)/.test(node.attribs?.class ?? ''), children)
    ?? findOne(node => node.name === 'article', children) ?? findOne(node => node.name === 'main', children);
  const sections = [];
  function read(node) {
    if (sections.length >= 160 || ['aside', 'nav', 'footer', 'script', 'style', 'template', 'figcaption'].includes(node.name)) return;
    if (node.attribs?.['aria-hidden'] === 'true' || /(?:related-content|article__related|comments|paywall)/i.test(node.attribs?.class ?? '')) return;
    if (['p', 'h2', 'h3', 'h4'].includes(node.name)) {
      const text = content(node).slice(0, 1500);
      if (text) sections.push({ text, heading: node.name !== 'p' });
      return;
    }
    for (const child of node.children ?? []) read(child);
  }
  if (body) read(body);
  return { published, authors, sections };
}

function interest(article) {
  const title = article.title;
  if (/\b(?:fantasy|fpl|gameweek|scout squad|top picks?|captaincy)\b/i.test(title)) return 2;
  return /\b(?:pundit|analysis|preview|look out|to watch|verdict|form|best|growing)\b/i.test(title) ? 1 : 0;
}

async function batch(items, load) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    results.push(...await Promise.all(items.slice(offset, offset + 4).map(load)));
  }
  return results;
}

export function createNewsSearch() {
  const cache = new Map();

  function retrieve(url, parse, lifetime) {
    const cached = cache.get(url);
    if (cached?.expiresAt > Date.now()) return cached.result;
    const entry = { expiresAt: Date.now() + lifetime };
    entry.result = (async () => {
      try {
        const response = await fetch(url, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(5500) });
        if (!response.ok || Number(response.headers.get('content-length')) > 2_500_000) throw new Error('Publisher response unavailable');
        const data = parse(await response.text(), response.url);
        if (!data) throw new Error('Publisher content unavailable');
        return { data, retrievedAt: new Date().toISOString() };
      } catch {
        entry.expiresAt = Date.now() + 120_000;
        return null;
      }
    })();
    cache.set(url, entry);
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return entry.result;
  }

  return async (players, asOf) => {
    const since = asOf - windowMs;
    const feeds = await batch(newsFeeds, async feed => ({ feed,
      result: await retrieve(feed.url, xml => rssItems(xml, feed), 15 * 60_000) }));
    const sources = feeds.filter(({ result }) => result).map(({ feed, result }) => ({ publisher: feed.name, url: feed.url, retrievedAt: result.retrievedAt }));
    const articles = new Map();
    const expand = [];
    for (const { feed, result } of feeds) {
      if (!result) continue;
      const items = result.data.filter(article => article.published >= since && article.published <= asOf)
        .sort((a, b) => interest(b) - interest(a) || b.published - a.published);
      for (const article of items) {
        if (!articles.has(article.url)) articles.set(article.url, { ...article, retrievedAt: result.retrievedAt });
      }
      expand.push(...items.slice(0, 6).map(article => ({ feed, article })));
    }

    const fetched = await batch(expand, async ({ feed, article }) => {
      const response = await retrieve(article.url, (html, finalUrl) => articleUrl(finalUrl || article.url, feed) && articleContent(html), 60 * 60_000);
      if (!response) return false;
      const { data, retrievedAt } = response;
      articles.set(article.url, { ...article, sections: data.sections, retrievedAt,
        authors: data.authors.length ? data.authors : article.authors,
        published: Number.isFinite(data.published) ? data.published : article.published });
      return data.sections.length > 0;
    });

    const recent = [...articles.values()].filter(article => article.published >= since && article.published <= asOf);
    return { recommendations: rankNews(recent, players, since, asOf), coverage: { publishers: sources.length,
      expectedPublishers: newsFeeds.length, articles: recent.length, fullArticles: fetched.filter(Boolean).length },
      since: new Date(since).toISOString(), searchedAt: new Date(asOf).toISOString(), sources };
  };
}
