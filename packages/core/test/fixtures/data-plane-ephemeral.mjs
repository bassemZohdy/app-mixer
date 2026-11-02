// Test-only launcher: let the OS reserve the publication listener port atomically.
import {Server} from 'node:net';
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){
 if(args[0]===3002&&args[1]==='0.0.0.0'){
  args[0]=0;
  this.once('listening',()=>process.send?.({dataPlanePort:this.address().port}));
 }
 return listen.apply(this,args);
};
await import('../../../../deploy/kubernetes/data-plane.mjs');
