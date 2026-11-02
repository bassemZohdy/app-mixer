// Test-only launcher: let the OS reserve publication and metrics ports atomically.
import {Server} from 'node:net';
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){
 if(args[0]===3002&&args[1]==='0.0.0.0'){
  args[0]=0;
  this.once('listening',()=>process.send?.({dataPlanePort:this.address().port}));
 }else if(args[0]===3003&&args[1]==='127.0.0.1'){
  args[0]=0;
  this.once('listening',()=>process.send?.({metricsPort:this.address().port}));
 }
 return listen.apply(this,args);
};
await import('../../../../deploy/kubernetes/data-plane.mjs');
