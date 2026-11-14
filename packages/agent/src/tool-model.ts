import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { openAIChat } from './openai-chat.js';
import {type BaseCheckpointSaver} from '@langchain/langgraph-checkpoint';
import type { ChatMessage, OpenAIModelConfig, StreamingModel } from './index.js';
import type { createCapabilityTool } from './capability-tool.js';
import {convertToOpenAITool} from '@langchain/core/utils/function_calling';
import {markNoEffect} from './action-journal.js';

type CapabilityTool = ReturnType<typeof createCapabilityTool>;
export interface ToolModel {
  invoke(messages:BaseMessage[], options?:{signal?:AbortSignal}):Promise<BaseMessage>;
}
export interface LimitedToolModel extends ToolModel {
  invokeLimited(messages:BaseMessage[], options:{signal?:AbortSignal;maxTotalTokens:number;callId:string}):Promise<{message:BaseMessage;usedTokens:number}>;
}
export interface CostLimitedToolModel extends ToolModel {
  invokeLimitedCost(messages:BaseMessage[], options:{signal?:AbortSignal;maxTotalTokens:number;maxCostMicros:number;currency:string;callId:string}):Promise<{message:BaseMessage;usedTokens:number;usedCostMicros:number}>;
}
const State=Annotation.Root({
  messages:Annotation<BaseMessage[],BaseMessage[]>({reducer:(previous,next)=>previous.concat(next),default:()=>[]}),
  turns:Annotation<number>()
});
/** Bind only tools supplied by trusted host code. The model cannot supply identities or register tools. */
export function createOpenAIToolModel(config:OpenAIModelConfig, tools:CapabilityTool[]):ToolModel {
  if(!config.model||!config.apiKey) throw Error('Model and API key are required');
  const fields={model:config.model,apiKey:config.apiKey,...(config.baseURL?{configuration:{baseURL:config.baseURL}}:{})};
  return {invoke:async(messages,options)=>(await openAIChat(fields)).bindTools(tools).invoke(config.systemPrompt?[new SystemMessage(config.systemPrompt),...messages]:messages,{signal:options?.signal})};
}
export type OpenAIPricing={currency:string;inputMicrosPerMillionTokens:number;outputMicrosPerMillionTokens:number};
export type OpenAILimitedOptions={
  /** Prices in integer millionths of the currency per million tokens. Required for `invokeLimitedCost`. */
  pricing?:OpenAIPricing|undefined;
  /** Tokens added to the prompt bound for the provider's chat template. Default 64. */
  promptOverheadTokens?:number|undefined;
};
const bytes=(value:unknown):number=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??''),'utf8');
/**
 * A conservative upper bound for the prompt's tokens: every token a tokenizer emits covers at least one byte, so the
 * UTF-8 size of everything sent (messages, tool calls, tool definitions) bounds the count. The bound is far above the
 * real count for ordinary text, which is the price of enforcing the limit without the provider's tokenizer.
 */
function promptTokenBound(messages:BaseMessage[], systemPrompt:string|undefined, tools:CapabilityTool[], overhead:number):number {
  let total=overhead+(systemPrompt?bytes(systemPrompt)+16:0);
  for(const message of messages)total+=16+bytes(message.content)+bytes((message as {tool_calls?:unknown}).tool_calls??'')+bytes(message.getType());
  for(const tool of tools)total+=bytes(convertToOpenAITool(tool));
  return total;
}
const usageOf=(message:BaseMessage):{input:number;output:number;total:number}=>{
  const usage=(message as {usage_metadata?:{input_tokens?:unknown;output_tokens?:unknown;total_tokens?:unknown}}).usage_metadata;
  const input=usage?.input_tokens,output=usage?.output_tokens,total=usage?.total_tokens;
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||!Number.isSafeInteger(total)||(input as number)<0||(output as number)<0||(total as number)<0)throw Error('Provider did not report token usage');
  return {input:input as number,output:output as number,total:total as number};
};
/**
 * An OpenAI-compatible model that enforces the host's token (and optionally cost) limit itself:
 * - the output allowance sent to the provider (`max_tokens`) is the limit minus a conservative prompt bound, so the
 *   provider stops generating at the cap, and a prompt that cannot fit is refused before anything is sent;
 * - the SDK's automatic retries are off, because a retry after an ambiguous failure could use the budget twice;
 * - usage comes from the provider's response and a response without it is an error (the reservation stays held).
 * A refusal before dispatch carries the no-effect marker, so the runtime releases the reservation.
 * Use it as the model of an agent with `tokenBudget`; `invokeLimitedCost` needs `options.pricing`.
 */
export function createOpenAILimitedToolModel(config:OpenAIModelConfig, tools:CapabilityTool[], options:OpenAILimitedOptions={}):ToolModel&LimitedToolModel&Partial<CostLimitedToolModel> {
  if(!config.model||!config.apiKey) throw Error('Model and API key are required');
  const overhead=options.promptOverheadTokens??64,pricing=options.pricing;
  if(!Number.isSafeInteger(overhead)||overhead<0)throw Error('Invalid prompt overhead');
  if(pricing!==undefined&&(!/^[A-Z]{3}$/.test(pricing.currency)||!Number.isSafeInteger(pricing.inputMicrosPerMillionTokens)||pricing.inputMicrosPerMillionTokens<0||!Number.isSafeInteger(pricing.outputMicrosPerMillionTokens)||pricing.outputMicrosPerMillionTokens<1))throw Error('Invalid pricing');
  const build=async(maxTokens?:number)=>(await openAIChat({model:config.model,apiKey:config.apiKey,maxRetries:0,...(maxTokens===undefined?{}:{maxTokens}),...(config.baseURL?{configuration:{baseURL:config.baseURL}}:{})})).bindTools(tools);
  const withSystem=(messages:BaseMessage[])=>config.systemPrompt?[new SystemMessage(config.systemPrompt),...messages]:messages;
  const refuse=(reason:string)=>markNoEffect(Error(reason));
  const run=async(messages:BaseMessage[], maxOutput:number, signal:AbortSignal|undefined)=>{
    const message=await (await build(maxOutput)).invoke(withSystem(messages),signal?{signal}:{});
    return {message,usage:usageOf(message)};
  };
  const outputAllowance=(messages:BaseMessage[], maxTotalTokens:number)=>{
    if(!Number.isSafeInteger(maxTotalTokens)||maxTotalTokens<1)throw refuse('Invalid token limit');
    const bound=promptTokenBound(messages,config.systemPrompt,tools,overhead),allowance=maxTotalTokens-bound;
    if(allowance<1)throw refuse('Prompt does not fit the token limit');
    return {bound,allowance};
  };
  const model:ToolModel&LimitedToolModel&Partial<CostLimitedToolModel>={
    invoke:async(messages,callOptions)=>(await build()).invoke(withSystem(messages),callOptions?.signal?{signal:callOptions.signal}:{}),
    invokeLimited:async(messages,{signal,maxTotalTokens})=>{
      const {allowance}=outputAllowance(messages,maxTotalTokens),{message,usage}=await run(messages,allowance,signal);
      return {message,usedTokens:usage.total};
    }
  };
  if(pricing)model.invokeLimitedCost=async(messages,{signal,maxTotalTokens,maxCostMicros,currency})=>{
    if(currency!==pricing.currency)throw refuse('Currency does not match the configured pricing');
    if(!Number.isSafeInteger(maxCostMicros)||maxCostMicros<1)throw refuse('Invalid cost limit');
    const {bound,allowance:byTokens}=outputAllowance(messages,maxTotalTokens);
    // Cost of the worst case: the whole prompt bound at the input price plus the output allowance at the output price.
    const promptCost=Math.ceil(bound*pricing.inputMicrosPerMillionTokens/1e6),byCost=Math.floor((maxCostMicros-promptCost)*1e6/pricing.outputMicrosPerMillionTokens);
    const allowance=Math.min(byTokens,byCost);
    if(allowance<1)throw refuse('Prompt does not fit the cost limit');
    const {message,usage}=await run(messages,allowance,signal);
    const usedCostMicros=Math.ceil((usage.input*pricing.inputMicrosPerMillionTokens+usage.output*pricing.outputMicrosPerMillionTokens)/1e6);
    return {message,usedTokens:usage.total,usedCostMicros};
  };
  return model;
}
/** Runs a bounded LangGraph model/tool loop, yielding only the final text response. */
export function createToolCallingModel(model:ToolModel, tools:CapabilityTool[], options:{systemPrompt?:string;maxTurns?:number;checkpoint?:{saver:BaseCheckpointSaver;threadId:string;resume:boolean}}={}):StreamingModel {
  const maxTurns=options.maxTurns??4,checkpoint=options.checkpoint;
  if(checkpoint&&(!checkpoint.saver||typeof checkpoint.saver.getTuple!=='function'||typeof checkpoint.threadId!=='string'||!checkpoint.threadId||typeof checkpoint.resume!=='boolean'))throw Error('Invalid checkpoint configuration');
  if(!Number.isSafeInteger(maxTurns)||maxTurns<1||maxTurns>10||tools.length>50) throw Error('Invalid tool configuration');
  const allowed=new Map<string,CapabilityTool>();
  for(const entry of tools){if(allowed.has(entry.name))throw Error('Duplicate tool');allowed.set(entry.name,entry);}
  return {
    async *stream(messages:ChatMessage[], signal?:AbortSignal) {
      const initial:BaseMessage[]=[];
      if(options.systemPrompt)initial.push(new SystemMessage(options.systemPrompt));
      for(const m of messages)initial.push(m.role==='user'?new HumanMessage(m.content):new AIMessage(m.content));
      const graph=new StateGraph(State)
        .addNode('model',async(state,config)=>{
          if(state.turns>=maxTurns)throw Error('Tool turn limit reached');
          const response=await model.invoke(state.messages,{signal:config.signal});
          if(!isAIMessage(response))throw Error('Invalid model response');
          if((response.invalid_tool_calls?.length??0)>0)throw Error('Invalid tool call');
          if((response.tool_calls?.length??0)>10)throw Error('Too many tool calls');
          if((response.tool_calls?.length??0)>0 && state.turns+1>=maxTurns)throw Error('Tool turn limit reached');
          return {messages:[response],turns:state.turns+1};
        })
        .addNode('tools',async(state,config)=>{
          const response=state.messages.at(-1);
          if(!response||!isAIMessage(response))throw Error('Invalid tool state');
          const output:BaseMessage[]=[];
          for(const call of response.tool_calls??[]){
            const selected=allowed.get(call.name);
            if(!selected||!call.id)throw Error('Unregistered tool call');
            const result=await selected.invoke(call.args,{signal:config.signal,configurable:{app_mixer_tool_call_id:call.id}});
            if(typeof result!=='string'||result.length>100000)throw Error('Invalid tool result');
            output.push(new ToolMessage({tool_call_id:call.id,content:result}));
          }
          return {messages:output};
        })
        .addEdge(START,'model')
        .addConditionalEdges('model',state=>{const last=state.messages.at(-1);return last&&isAIMessage(last)&&(last.tool_calls?.length??0)>0?'tools':END;},['tools',END])
        .addEdge('tools','model').compile(checkpoint?{checkpointer:checkpoint.saver}:{});
      // Wait for each checkpoint before advancing: async stores can otherwise
      // lose a completed tool step when a later graph step fails or the worker exits.
      const config=checkpoint?{signal,durability:'sync' as const,configurable:{thread_id:checkpoint.threadId}}:{signal};
      if(checkpoint){const existing=await checkpoint.saver.getTuple(config);if(checkpoint.resume&&!existing)throw Error('Checkpoint unavailable');if(!checkpoint.resume&&existing)throw Error('Checkpoint already exists');}
      const result=await graph.invoke(checkpoint?.resume?null:{messages:initial,turns:0},config);
      const last=result.messages.at(-1);
      if(!last||!isAIMessage(last)||typeof last.content!=='string')throw Error('Invalid final response');
      if(last.content)yield last.content;
    }
  };
}
