import {SqliteApplicationStore} from '../../dist/index.js';
const [path,mode]=process.argv.slice(2),initial=id=>({id,schemaVersion:1,revision:0,pages:[]}),page={id:'home',route:'/',title:'Home',components:[]};
process.on('message',()=>{});
const store=new SqliteApplicationStore(path,initial('demo'));
store.apply(0,[{op:'addPage',page}]);store.publish(1);
store.apply(1,[{op:'setPageTitle',pageId:'home',title:'Changed'}]);store.publish(2);
if(mode==='rolledback')store.rollback(1,2);
process.send({type:mode});
await new Promise(()=>{});
