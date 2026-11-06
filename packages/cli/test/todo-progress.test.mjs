import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {render,ranges} from '../../../scripts/todo-progress.mjs';

const sample=`# TODO

## Overall progress

**0 / 0 tasks complete (0%)**

\`░░░░░░░░░░░░░░░░░░░░\`

| Phase | Done | Remaining |
| --- | --- | --- |
| P0 foundation | 0 / 0 | 0 |
| P2 portability | 0 / 0 | 0 |

## P0
- [x] P0-01 First
- [x] P0-02 Second

## P2
- [ ] P2-01 Open one
  - [x] a nested checkbox is not a task
- [x] P2-02 Done
- [ ] P2-03 Open two
- [ ] P2-04 Open three
`;

test('the progress section is derived from the task checkboxes',()=>{
 const output=render(sample);
 assert.match(output,/\*\*3 \/ 6 tasks complete \(50%\)\*\*/);
 assert.match(output,/`██████████░░░░░░░░░░`/);
 assert.match(output,/\| P0 foundation \| 2 \/ 2 \| 0 \|/);
 assert.match(output,/\| P2 portability \| 1 \/ 4 \| 3 \(P2-01, P2-03, P2-04\) \|/);
 assert.equal(render(output),output,'rendering is idempotent');
 assert.equal(ranges('P4',[1,2,3,5,7,8]),'P4-01..P4-03, P4-05, P4-07, P4-08');
});

test('the repository TODO is up to date',()=>{
 const text=readFileSync(new URL('../../../TODO.md',import.meta.url),'utf8');
 assert.equal(render(text),text,'run node scripts/todo-progress.mjs');
});
