import { SqliteAgentRuns } from '../../dist/index.js';
const [path] = process.argv.slice(2);
// Everything is loaded; wait for the start signal so that several processes open the same new file together.
process.send({ type: 'loaded' });
process.on('message', () => {
  const started = Date.now();
  try {
    const store = new SqliteAgentRuns(path);
    store.close();
    process.send({ type: 'opened' });
  } catch (error) {
    // Name the call that failed and how long it waited, so that a failure on a loaded machine says which lock timed out.
    const frame = String(error.stack ?? '')
      .split('\n')
      .find(line => /[\\/]dist[\\/]/.test(line));
    process.send({ type: 'failed', message: `${error.message} (errcode ${error.errcode ?? 'none'}, after ${Date.now() - started} ms, ${frame?.trim() ?? 'no frame'})` });
  } finally {
    setImmediate(() => process.exit(0));
  }
});
