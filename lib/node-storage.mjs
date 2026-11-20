import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function seasonSnapshot() {
  const directory = new URL('../.fpl-cache/', import.meta.url);
  const path = new URL('season.json', directory);
  const temporary = new URL(`season-${process.pid}.tmp`, directory);
  return {
    async read() {
      return JSON.parse(await readFile(path, 'utf8'));
    },
    async write(snapshot) {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(snapshot));
      await rename(temporary, path);
    }
  };
}

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

