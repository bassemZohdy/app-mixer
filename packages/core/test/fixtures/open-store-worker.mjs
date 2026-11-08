import {SqliteApplicationStore} from '../../dist/index.js';
const [path]=process.argv.slice(2);
// Everything is loaded; wait for the start signal so that several processes open the same new file together.
process.send({type:'loaded'});
process.on('message',()=>{try{const store=new SqliteApplicationStore(path,{id:'demo',schemaVersion:1,revision:0,pages:[]});store.close?.();process.send({type:'opened'});}catch(error){process.send({type:'failed',message:String(error.message)});}finally{setImmediate(()=>process.exit(0));}});
