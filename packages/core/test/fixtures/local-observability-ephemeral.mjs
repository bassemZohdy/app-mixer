// Test-only launcher: let the OS assign ports while each listener is bound.
import {Server} from 'node:net';
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){
 const kind=args[0]===3002?'dataPort':args[0]===3004?'metricsPort':undefined;
 if(kind&&args[1]==='127.0.0.1'){
  args[0]=0;
  this.once('listening',()=>process.send?.({[kind]:this.address().port}));
 }
 return listen.apply(this,args);
};
await import('../../../../deploy/local/service.mjs');
