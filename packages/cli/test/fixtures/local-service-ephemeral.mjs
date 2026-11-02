// Test-only launcher: reserve each local service listener atomically.
import {Server} from 'node:net';
const role=process.argv[2],expected=role==='data'?3002:role==='control'?3001:undefined;
if(expected===undefined)throw Error('Unsupported test service role');
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){
 if(args[0]===expected&&args[1]==='127.0.0.1'){
  args[0]=0;
  this.once('listening',()=>process.send?.({port:this.address().port}));
 }
 return listen.apply(this,args);
};
await import('../../../../deploy/local/service.mjs');
