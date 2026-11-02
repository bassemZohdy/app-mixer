import {isAIMessage,isHumanMessage,isSystemMessage,isToolMessage,type BaseMessage} from '@langchain/core/messages';
import {z} from 'zod';
import {createOpenAIPricedCostModel,type OpenAIPricedCostModelOptions} from './openai-priced-cost-model.js';
import type {createCapabilityTool} from './capability-tool.js';
import type {CostLimitedToolModel} from './tool-model.js';

type CapabilityTool=ReturnType<typeof createCapabilityTool>;
type CountingRequest={model:string;messages:Record<string,unknown>[];tools?:Record<string,unknown>[]};
type ModelOptions=OpenAIPricedCostModelOptions extends infer T?T extends unknown?Omit<T,'prepare'>:never:never;
type Options=ModelOptions&{tools:CapabilityTool[];systemPrompt?:string;estimateInputTokens:(request:CountingRequest,signal?:AbortSignal)=>number|Promise<number>};
const validName=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const validCallId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
function wireMessage(message:BaseMessage):Record<string,unknown>{
 if(!message||typeof message.content!=='string'||!object(message.additional_kwargs)||Object.keys(message.additional_kwargs).length)throw Error('Unsupported OpenAI message');const named=message.name===undefined?{}:validName(message.name)?{name:message.name}:undefined;if(!named)throw Error('Unsupported OpenAI message');
 if(isSystemMessage(message))return {role:'system',content:message.content,...named};if(isHumanMessage(message))return {role:'user',content:message.content,...named};if(isToolMessage(message)){if(!validCallId(message.tool_call_id))throw Error('Unsupported OpenAI message');return {role:'tool',content:message.content,tool_call_id:message.tool_call_id,...named};}
 if(isAIMessage(message)){if((message.invalid_tool_calls?.length??0)>0||(message.tool_calls?.length??0)>10)throw Error('Unsupported OpenAI message');const ids=new Set<string>(),calls=(message.tool_calls??[]).map(call=>{if(!validCallId(call.id)||!validName(call.name)||!object(call.args)||ids.has(call.id))throw Error('Unsupported OpenAI message');ids.add(call.id);let args:string;try{args=JSON.stringify(call.args);}catch{throw Error('Unsupported OpenAI message');}if(typeof args!=='string'||args.length>100000)throw Error('Unsupported OpenAI message');try{if(!object(JSON.parse(args)))throw Error('Invalid');}catch{throw Error('Unsupported OpenAI message');}return {id:call.id,type:'function',function:{name:call.name,arguments:args}};});return {role:'assistant',content:message.content,...named,...(calls.length?{tool_calls:calls}:{})};}
 throw Error('Unsupported OpenAI message');
}
/** Bind the runtime's text messages and capability tools to a priced OpenAI model. */
export function createOpenAICapabilityPricedModel(options:Options):CostLimitedToolModel{
 if(!options||!Array.isArray(options.tools)||options.tools.length>50||typeof options.estimateInputTokens!=='function'||(options.systemPrompt!==undefined&&(typeof options.systemPrompt!=='string'||options.systemPrompt.length>100000)))throw Error('Invalid OpenAI capability model');const {tools,systemPrompt,estimateInputTokens,...modelOptions}=options,seen=new Set<string>();let toolSpecs:Record<string,unknown>[];try{toolSpecs=tools.map(tool=>{if(!tool||!validName(tool.name)||seen.has(tool.name)||typeof tool.description!=='string'||!tool.description.trim()||tool.description.length>4000)throw Error('Invalid');seen.add(tool.name);const schema=z.toJSONSchema(tool.schema),{$schema:_schema,...parameters}=schema;return {type:'function',function:{name:tool.name,description:tool.description,parameters}};});toolSpecs=JSON.parse(JSON.stringify(toolSpecs));}catch{throw Error('Invalid OpenAI capability model');}
 const model=modelOptions.model;return createOpenAIPricedCostModel({...modelOptions,prepare:async(messages,signal)=>{if(!Array.isArray(messages)||messages.length>999)throw Error('Unsupported OpenAI message');const wire=[...(systemPrompt===undefined?[]:[{role:'system',content:systemPrompt}]),...messages.map(wireMessage)],request={model,messages:wire,...(toolSpecs.length?{tools:toolSpecs}:{})};let encoded:string;try{encoded=JSON.stringify(request);if(Buffer.byteLength(encoded,'utf8')>1000000)throw Error('Invalid');}catch{throw Error('Unsupported OpenAI message');}const counting=JSON.parse(encoded) as CountingRequest;freeze(counting);const maxInputTokens=await estimateInputTokens(counting,signal);return {messages:wire,...(toolSpecs.length?{tools:toolSpecs}:{}),maxInputTokens};}});
}
export type {Options as OpenAICapabilityPricedModelOptions,CountingRequest as OpenAICapabilityCountingRequest};
