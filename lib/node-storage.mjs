import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function seasonSnapshot(directory = fileURLToPath(new URL('../.fpl-cache/', import.meta.url))) {
  const read = async name => JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
  async function write(name, value) {
    const path = join(directory, `${name}.json`);
    const temporary = join(directory, `${name}-${process.pid}-${crypto.randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  return {
    read: () => read('season'),
    async readHistory(year) {
      const files = await readdir(directory);
      const names = files.filter(file => file.startsWith(`season-${year}-gw`) && file.endsWith('.json'));
      return Promise.all(names.map(file => read(file.slice(0, -5)).catch(() => null)));
    },
    async write(snapshot) {
      await write('season', snapshot);
      await write(`season-${snapshot.dashboard.seasonYear}-gw${snapshot.gameweek ?? 0}`, snapshot);
    },
    readRecord: key => read(`record-${encodeURIComponent(key)}`),
    writeRecord: (key, record) => write(`record-${encodeURIComponent(key)}`, record)
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

