import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatMessage, OpenAIModelConfig, StreamingModel } from './index.js';
import type { createCapabilityTool } from './capability-tool.js';

type CapabilityTool = ReturnType<typeof createCapabilityTool>;
export interface ToolModel {
  invoke(messages:BaseMessage[], options?:{signal?:AbortSignal}):Promise<BaseMessage>;
}
const State=Annotation.Root({
  messages:Annotation<BaseMessage[],BaseMessage[]>({reducer:(previous,next)=>previous.concat(next),default:()=>[]}),
  turns:Annotation<number>()
});
/** Bind only tools supplied by trusted host code. The model cannot supply identities or register tools. */
export function createOpenAIToolModel(config:OpenAIModelConfig, tools:CapabilityTool[]):ToolModel {
  if(!config.model||!config.apiKey) throw Error('Model and API key are required');
  const model=new ChatOpenAI({model:config.model,apiKey:config.apiKey,...(config.baseURL?{configuration:{baseURL:config.baseURL}}:{})}).bindTools(tools);
  return {invoke:async(messages,options)=>model.invoke(config.systemPrompt?[new SystemMessage(config.systemPrompt),...messages]:messages,{signal:options?.signal})};
}
/** Runs a bounded LangGraph model/tool loop, yielding only the final text response. */
export function createToolCallingModel(model:ToolModel, tools:CapabilityTool[], options:{systemPrompt?:string;maxTurns?:number}={}):StreamingModel {
  const maxTurns=options.maxTurns??4;
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
            const result=await selected.invoke(call.args,{signal:config.signal});
            if(typeof result!=='string'||result.length>100000)throw Error('Invalid tool result');
            output.push(new ToolMessage({tool_call_id:call.id,content:result}));
          }
          return {messages:output};
        })
        .addEdge(START,'model')
        .addConditionalEdges('model',state=>{const last=state.messages.at(-1);return last&&isAIMessage(last)&&(last.tool_calls?.length??0)>0?'tools':END;},['tools',END])
        .addEdge('tools','model').compile();
      const result=await graph.invoke({messages:initial,turns:0},{signal});
      const last=result.messages.at(-1);
      if(!last||!isAIMessage(last)||typeof last.content!=='string')throw Error('Invalid final response');
      if(last.content)yield last.content;
    }
  };
}
