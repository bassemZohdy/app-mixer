import {isAIMessage,type BaseMessage} from '@langchain/core/messages';
import type {CostLimitedToolModel} from './tool-model.js';
import {isIdentifier,isNonNegativeInteger} from './validation.js';

type Prepared={request:unknown;maxInputTokens:number};
type Response={message:BaseMessage;inputTokens:number;outputTokens:number};
type Options={currency:string;inputMicrosPerMillionTokens:number;outputMicrosPerMillionTokens:number;fixedMicrosPerCall:number;maxOutputTokens:number;prepare:(messages:BaseMessage[],signal?:AbortSignal)=>Prepared|Promise<Prepared>;dispatch:(request:unknown,options:{signal?:AbortSignal;maxOutputTokens:number;callId:string})=>Response|Promise<Response>};
const integer=isNonNegativeInteger;
const id=isIdentifier;
const MILLION=1000000n,MAX_COST=100000000000;
/** Price a host-prepared model request and pass a conservative output cap to a trusted provider adapter. */
export function createPricedCostLimitedToolModel(options:Options):CostLimitedToolModel{
 if(!options)throw Error('Invalid priced model configuration');const {currency,inputMicrosPerMillionTokens,outputMicrosPerMillionTokens,fixedMicrosPerCall,maxOutputTokens,prepare,dispatch}=options;if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)||!integer(inputMicrosPerMillionTokens)||inputMicrosPerMillionTokens>MAX_COST||!integer(outputMicrosPerMillionTokens)||outputMicrosPerMillionTokens>MAX_COST||!integer(fixedMicrosPerCall)||fixedMicrosPerCall>MAX_COST||!integer(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>10000000||typeof prepare!=='function'||typeof dispatch!=='function')throw Error('Invalid priced model configuration');
 const inputRate=BigInt(inputMicrosPerMillionTokens),outputRate=BigInt(outputMicrosPerMillionTokens);
 return {invoke:async()=>{throw Error('Model cost limit required');},invokeLimitedCost:async(messages,limits)=>{
  if(!limits)throw Error('Invalid priced model limit');const {callId,currency:requestedCurrency,maxTotalTokens,maxCostMicros,signal}=limits;if(!Array.isArray(messages)||!id(callId)||requestedCurrency!==currency||!integer(maxTotalTokens)||maxTotalTokens<1||maxTotalTokens>10000000||!integer(maxCostMicros)||maxCostMicros<1||maxCostMicros>MAX_COST||(signal!==undefined&&!(signal instanceof AbortSignal)))throw Error('Invalid priced model limit');
  if(signal?.aborted)throw Error('Model call aborted');const prepared=await prepare([...messages],signal);if(signal?.aborted)throw Error('Model call aborted');if(!prepared||typeof prepared!=='object')throw Error('Invalid priced model request');const {maxInputTokens,request:preparedRequest}=prepared;if(!integer(maxInputTokens)||maxInputTokens>maxTotalTokens||!preparedRequest||typeof preparedRequest!=='object'||Array.isArray(preparedRequest))throw Error('Invalid priced model request');
  let request:unknown;try{const encoded=JSON.stringify(preparedRequest);if(typeof encoded!=='string'||Buffer.byteLength(encoded,'utf8')>1000000)throw Error('Invalid');request=JSON.parse(encoded);if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Invalid');}catch{throw Error('Invalid priced model request');}
  const inputTokens=maxInputTokens,available=(BigInt(maxCostMicros)-BigInt(fixedMicrosPerCall))*MILLION-BigInt(inputTokens)*inputRate;if(available<0n)throw Error('Model cost limit insufficient');let allowed=Math.min(maxOutputTokens,maxTotalTokens-inputTokens);if(outputRate>0n){const affordable=available/outputRate;if(affordable<BigInt(allowed))allowed=Number(affordable);}if(allowed<1)throw Error('Model cost limit insufficient');if(signal?.aborted)throw Error('Model call aborted');
  const result=await dispatch(request,{signal,maxOutputTokens:allowed,callId});if(!result||typeof result!=='object')throw Error('Invalid priced model usage');const {message,inputTokens:actualInputTokens,outputTokens:actualOutputTokens}=result;if(!isAIMessage(message)||!integer(actualInputTokens)||!integer(actualOutputTokens)||actualInputTokens+actualOutputTokens>1000000000)throw Error('Invalid priced model usage');if(actualInputTokens>inputTokens||actualOutputTokens>allowed)throw Error('Priced model provider limit violated');const units=BigInt(actualInputTokens)*inputRate+BigInt(actualOutputTokens)*outputRate,cost=(units+MILLION-1n)/MILLION+BigInt(fixedMicrosPerCall);if(cost>BigInt(MAX_COST))throw Error('Invalid priced model usage');return {message,usedTokens:actualInputTokens+actualOutputTokens,usedCostMicros:Number(cost)};
 }};
}
export type {Options as PricedCostLimitedToolModelOptions};
