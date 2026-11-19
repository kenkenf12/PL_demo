import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function predictionHistory(directory = process.env.FPL_HISTORY_DIR ?? fileURLToPath(new URL('../.fpl-data/', import.meta.url))) {
  const path = join(directory, 'predictions.json');
  const temporary = join(directory, `predictions-${process.pid}.tmp`);
  let queue = Promise.resolve();

  async function read() {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function update(transform) {
    const operation = queue.then(async () => {
      const old = await read();
      const updated = transform(old);
      if (updated === old) return;
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(updated, null, 2));
      await rename(temporary, path);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { read, update };
}

export function scorePrediction(prediction, live, scoredAt) {
  const results = new Map(live.players.filter(player => Number.isInteger(player.total_points)).map(player => [player.id, player.total_points]));
  const actual = prediction.players.map(player => ({ id: player.id, points: results.get(player.id) ?? null }));
  const known = actual.filter(record => record.points != null);
  if (!known.length) return null;
  const comparable = prediction.players.filter(player => player.predicted != null && results.has(player.id));
  const delta = comparable.reduce((sum, player) => sum + Math.abs(player.predicted - results.get(player.id)), 0);
  return { actual, actualCount: known.length, actualTotal: known.reduce((sum, result) => sum + result.points, 0),
    comparedCount: comparable.length, meanAbsoluteError: comparable.length ? delta / comparable.length : null,
    predictedComparableTotal: comparable.reduce((sum, player) => sum + player.predicted, 0),
    actualComparableTotal: comparable.reduce((sum, player) => sum + results.get(player.id), 0),
    scoredAt, sources: live.sources };
}
