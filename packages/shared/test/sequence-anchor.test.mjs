// TASK-047.2.1: the anchor check every anchored store makes lives in @app-mixer/shared so the agent stores can use it without depending on core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceAnchor, agentAnchorKey, checkAgainstAnchor, reportAnchorError } from '../dist/index.js';
import * as core from '../../core/dist/file-sequence-anchor.js';

const map = () => {
  const marks = new Map();
  return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
};
const options = (anchor, stored, extra = {}) => ({ anchor, key: 'k', stored: async () => stored, unavailable: 'unavailable', rolledBack: 'rolled back', ...extra });

test('TASK-047.2.1 the check refuses a database behind its anchor, catches a lagging anchor up and fails closed on a bad anchor', async () => {
  const { marks, anchor } = map();
  await checkAgainstAnchor(options(anchor, 0));
  assert.equal(marks.size, 0, 'an equal value moves nothing');
  await checkAgainstAnchor(options(anchor, 7));
  assert.equal(marks.get('k'), 7, 'a database ahead of the anchor catches it up');
  await assert.rejects(checkAgainstAnchor(options(anchor, 6)), /rolled back/);
  assert.equal(marks.get('k'), 7, 'a refusal never lowers the anchor');
  for (const bad of [-1, 1.5, NaN, '3', undefined]) await assert.rejects(checkAgainstAnchor(options({ read: () => bad, advance: () => {} }, 9)), /unavailable/, String(bad));
  await assert.rejects(
    checkAgainstAnchor(
      options(
        {
          read: () => {
            throw Error('disk gone');
          },
          advance: () => {}
        },
        1
      )
    ),
    /unavailable/
  );
});

test('TASK-047.2.1 an advance that fails is reported, never thrown, and a failing handler changes nothing', async () => {
  const errors = [],
    broken = {
      read: () => 0,
      advance: () => {
        throw Error('cannot write anchor');
      }
    };
  await advanceAnchor(broken, 'k', 3, error => errors.push(error.message));
  assert.deepEqual(errors, ['cannot write anchor']);
  await advanceAnchor(broken, 'k', 3);
  await advanceAnchor(broken, 'k', 3, () => {
    throw Error('handler failed');
  });
  reportAnchorError(undefined, Error('ignored'));
  await checkAgainstAnchor(options(broken, 4, { onError: error => errors.push(error.message) }));
  assert.deepEqual(errors, ['cannot write anchor', 'cannot write anchor'], 'a lagging anchor that cannot move is reported and the check goes on');
});

test('TASK-047.2.1 core re-exports the same functions, so its stores behave as before', () => {
  assert.equal(core.checkAgainstAnchor, checkAgainstAnchor);
  assert.equal(core.advanceAnchor, advanceAnchor);
  assert.equal(core.reportAnchorError, reportAnchorError);
});

test('TASK-047.2.2 the agent anchor key names a store and its scope, is stable and cannot collide across scopes', () => {
  const key = agentAnchorKey('agent-runs', 'tenant', 'agent');
  assert.match(key, /^agent-runs-[0-9a-f]{64}$/);
  assert.equal(key, agentAnchorKey('agent-runs', 'tenant', 'agent'));
  assert.notEqual(key, agentAnchorKey('agent-runs', 'tenant', 'other'));
  assert.notEqual(key, agentAnchorKey('agent-memory', 'tenant', 'agent'));
  assert.notEqual(agentAnchorKey('agent-runs', 'ab', 'c'), agentAnchorKey('agent-runs', 'a', 'bc'), 'the parts cannot be re-split');
});
