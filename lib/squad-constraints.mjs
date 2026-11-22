// Successive shortest augmenting paths enforce the position and club caps.
export function constrainedSquad(candidates, positionLimits, clubIds, { positionOf, clubOf, weight, allowPartial = false }) {
  const positionNodes = new Map([...positionLimits.keys()].map((position, index) => [position, index + 1]));
  const firstClub = positionNodes.size + 1;
  const clubNodes = new Map([...clubIds].map((id, index) => [id, firstClub + index]));
  const sink = firstClub + clubNodes.size;
  const graph = Array.from({ length: sink + 1 }, () => []);
  function edge(from, to, capacity, cost) {
    const link = { to, capacity, cost, reverse: graph[to].length };
    graph[to].push({ to: from, capacity: 0, cost: -cost, reverse: graph[from].length });
    graph[from].push(link);
    return link;
  }
  for (const [position, limit] of positionLimits) edge(0, positionNodes.get(position), limit, 0);
  for (const club of clubNodes.values()) edge(club, sink, 3, 0);
  const roster = candidates.map(candidate => edge(positionNodes.get(positionOf(candidate)), clubNodes.get(clubOf(candidate)), 1, -weight(candidate)));

  const squadSize = [...positionLimits.values()].reduce((total, limit) => total + limit, 0);
  for (let flow = 0; flow < squadSize; flow += 1) {
    const distance = graph.map(() => Infinity);
    const prior = [];
    const queue = [0];
    const queued = new Set(queue);
    distance[0] = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const from = queue[index];
      queued.delete(from);
      for (const link of graph[from]) {
        const next = distance[from] + link.cost;
        if (!link.capacity || next + 1e-8 >= distance[link.to]) continue;
        distance[link.to] = next;
        prior[link.to] = { from, link };
        if (!queued.has(link.to)) {
          queued.add(link.to);
          queue.push(link.to);
        }
      }
    }
    if (!prior[sink]) {
      if (!allowPartial) return null;
      break;
    }
    for (let node = sink; node !== 0;) {
      const { from, link } = prior[node];
      link.capacity -= 1;
      graph[node][link.reverse].capacity += 1;
      node = from;
    }
  }
  return candidates.filter((_, index) => roster[index].capacity === 0);
}
