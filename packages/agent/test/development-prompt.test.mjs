import test from 'node:test';
import assert from 'node:assert/strict';
import {DevelopmentAgent} from '../dist/index.js';

async function promptFor(schemaVersion){
 let prompt;
 const model={async *stream(messages){prompt=messages[0].content;yield '{"patches":[{"op":"removePage","pageId":"home"}]}';}};
 const agent=new DevelopmentAgent(model,async(baseRevision,patches)=>({id:'00000000-0000-0000-0000-000000000000',baseRevision,status:'pending',preview:{patches}}));
 await agent.propose('Fix the draft',{id:'demo',schemaVersion,revision:3,pages:[]});
 return prompt;
}

test('FEAT-040 the prompt names the repair operations with their fields',async()=>{
 for(const version of [1,2]){
  const prompt=await promptFor(version);
  assert.match(prompt,/removeComponent with pageId and componentId/,`v${version}`);
  assert.match(prompt,/setComponentProps with pageId, componentId and props \(replaces all props of the component\)/,`v${version}`);
  assert.match(prompt,/removePage with pageId/,`v${version}`);
  assert.match(prompt,/addComponent with pageId and component \{id,type,props\}/,'the add operations stay');
 }
});
