import {SqliteApplicationStore} from '../../dist/index.js';
const [path,title]=process.argv.slice(2),initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
const store=new SqliteApplicationStore(path,initial);
process.send({type:'ready'});
process.on('message',()=>{try{store.apply(0,[{op:'addPage',page:{id:'home',route:'/',title,components:[]}}]);store.publish(1);process.send({type:'won',title});}catch(error){process.send({type:'lost',message:String(error.message)});}});
