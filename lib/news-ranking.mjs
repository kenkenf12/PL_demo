const ambiguousWords = new Set('ball banks black brown burn cash cook gray green grey hall james king long love march more pope rice son steel steele stones ward white wood woods young'.split(' '));
const unnamedBylines = new Set(['staff', 'staff writer', 'press association staff', 'sports staff', 'sky sports', 'bbc sport', 'the guardian']);

const positiveSignals = [
  { weight: 3, reason: 'Recommended as a fantasy pick or captaincy option.',
    pattern: /\b(?:top picks?|best (?:fpl |fantasy )?(?:captain(?:cy)?(?: (?:pick|option|choice))?|picks?|options?)|captaincy (?:pick|choice|contender|option)|strong captain(?:cy)? (?:pick|option)|must[- ]have|essential pick|players? to (?:buy|target|consider)|recommend(?:s|ed|ing)|stands? out|standout (?:pick|option)|tipp?ed (?:him |for )?to (?:score|haul|impress)|tipp?ed for (?:big )?success|i would (?:buy|pick|captain)|worth (?:buying|targeting))\b/i },
  { weight: 2, reason: 'Praised for form, influence or recent performance.',
    pattern: /\b(?:impress(?:es|ed|ive|ively)|outstanding|excellent|brilliant|superb|exceptional|sensational|in (?:fine|great|excellent|good|superb) form|stand[- ]out|starred|shone|growing in stature|standing ovation|instrumental|has been decisive|proved decisive|dazzl(?:ed|ing)|excel(?:led|s)|thriv(?:es|ed|ing)|talisman|influential|commanding)\b/i },
  { weight: 2, reason: 'Highlighted for attacking threat, scoring potential or value.',
    pattern: /\b(?:great value|good value|excellent value|appeal(?:ing|s) (?:pick|option|target)|tempting (?:pick|option)|strong (?:pick|option|candidate)|worth (?:considering|investing)|attack(?:ing)? threat|goal threat|can make hay|offers (?:real )?upside|high ceiling|in the goals|top[- ]scoring|leading scorer|goal[- ]scoring form|could (?:shine|thrive|flourish)|potential boon|(?:will|should) (?:score|find the net|keep scoring)|by scoring past)\b/i }
];

const negative = /\b(?:injur(?:ed|y)|doubtful|ruled out|suspend(?:ed|sion)|banned|avoid|sell|selling|struggl(?:es|ed|ing)|poor form|far from|not\b(?:\s+\w+){0,3}\s+(?:a pick|worth|convincing|good|impressive|outstanding|excellent|recommended|score)|no longer|unconvincing|unlikely|could miss|rotation risk)\b/i;
const reporting = /\b(?:said|says|told|believes|argues|argued|claimed|warned|praised|backed|insists|described)\b/i;
const shortlist = /\b(?:top picks?|best (?:fpl|fantasy) (?:team|picks?|options?)|scout selection|players? to (?:buy|target)|recommended picks)\b/i;

function normalize(value) {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[øØłŁđĐðÐß]/g, ch => ({ ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', ß: 'ss' })[ch])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function playerMatcher(players) {
  const names = new Map();
  for (const player of players) {
    const full = [player.first_name, player.second_name].filter(Boolean).join(' ');
    for (const candidate of [full, player.known_name, player.web_name, player.second_name]) {
      const alias = normalize(candidate).toLowerCase();
      if (!alias || (!alias.includes(' ') && (alias.length < 4 || ambiguousWords.has(alias)))) continue;
      if (!names.has(alias)) names.set(alias, new Set());
      names.get(alias).add(player.id);
    }
  }
  const choices = [...names.entries()].filter(([, ids]) => ids.size === 1).sort(([a], [b]) => b.length - a.length);
  if (!choices.length) return () => [];
  const aliases = new Map(choices.map(([name, ids]) => [name, ids.values().next().value]));
  const expression = new RegExp(`(?:^| )(${[...aliases.keys()].join('|')})(?= |$)`, 'giu');
  return text => {
    const found = new Set();
    for (const [, match] of normalize(text).matchAll(expression)) {
      const lower = match.toLowerCase();
      if (match.includes(' ') || match !== lower) found.add(aliases.get(lower));
    }
    return [...found];
  };
}

function positives(article, identify) {
  const best = new Map();
  function keep(id, signal, passage) {
    if (!best.has(id) || signal.weight > best.get(id).weight) best.set(id, { ...signal, passage });
  }
  let sectionPlayer;
  const sections = [{ text: article.title }, { text: article.description }, ...article.sections];
  for (const section of sections) {
    if (!section.text) continue;
    if (section.heading) {
      const ids = identify(section.text);
      sectionPlayer = ids.length === 1 && !negative.test(section.text) ? ids[0] : undefined;
      const headingName = normalize(section.text.replace(/\([^)]*\)|£[\d.]+m/gi, ''));
      if (sectionPlayer != null && !section.text.includes('?') && headingName.split(' ').length <= 4 && shortlist.test(article.title)) {
        keep(sectionPlayer, positiveSignals[0], `${article.title} ${section.text}`);
      }
    }
    for (const sentence of section.text.split(/(?<=[.!?])\s+/u)) {
      if (sentence.endsWith('?') || negative.test(sentence)) continue;
      const ids = identify(sentence);
      const id = ids.length === 1 ? ids[0] : ids.length === 0 ? sectionPlayer : undefined;
      if (id == null) continue;
      const signal = positiveSignals.find(item => item.pattern.test(sentence));
      if (!signal) continue;
      const attribution = reporting.exec(sentence);
      if (attribution && signal.pattern.exec(sentence).index > attribution.index
        && identify(sentence.slice(0, attribution.index)).includes(id)
        && !identify(sentence.slice(attribution.index + attribution[0].length)).includes(id)) continue;
      keep(id, signal, sentence);
    }
  }
  return best;
}

function chunks(text) {
  const words = normalize(text).toLowerCase().split(' ');
  return new Set(words.slice(6).map((_, index) => words.slice(index, index + 7).join(' ')));
}

function samePassage(candidate, prior) {
  const overlap = [...candidate].filter(chunk => prior.has(chunk)).length;
  return overlap >= 2 && overlap >= 0.4 * Math.min(candidate.size, prior.size);
}

export function rankNews(articles, players, windowStart, asOf) {
  const identify = playerMatcher(players);
  const byId = new Map(players.map(player => [player.id, player]));
  const byPlayer = new Map();
  for (const article of articles) {
    if (!Number.isFinite(article.published) || article.published < windowStart || article.published > asOf) continue;
    for (const [id, mention] of positives(article, identify)) {
      if (!byPlayer.has(id)) byPlayer.set(id, []);
      byPlayer.get(id).push({ article, ...mention, shingles: chunks(mention.passage) });
    }
  }

  const ranked = [];
  for (const [id, mentions] of byPlayer) {
    const accepted = [];
    for (const mention of mentions.sort((a, b) => b.weight - a.weight || b.article.published - a.article.published)) {
      const authors = mention.article.authors.map(name => normalize(name).toLowerCase()).filter(name => name && !unnamedBylines.has(name));
      if (accepted.some(prior => prior.article.publisher === mention.article.publisher
        || authors.some(author => prior.authors.includes(author)) || samePassage(mention.shingles, prior.shingles))) continue;
      accepted.push({ ...mention, authors });
    }
    const player = byId.get(id);
    const sentiment = accepted.reduce((total, mention) => total + mention.weight, 0) / accepted.length;
    ranked.push({ playerId: id, name: [player.first_name, player.second_name].filter(Boolean).join(' ') || player.web_name,
      count: accepted.length, sentiment: sentiment >= 2.5 ? 'Strong positive' : 'Positive', explanation: accepted[0].reason,
      strength: sentiment, latest: Math.max(...accepted.map(mention => mention.article.published)),
      sources: accepted.map(({ article, reason }) => ({ publisher: article.publisherName, title: article.title,
        url: article.url, publishedAt: new Date(article.published).toISOString(), retrievedAt: article.retrievedAt, reason })) });
  }
  return ranked.sort((a, b) => b.count - a.count || b.strength - a.strength || b.latest - a.latest || a.name.localeCompare(b.name))
    .map(({ strength, latest, ...result }) => result);
}
