import { tool } from '@langchain/core/tools';
import { z } from 'zod';

type Scalar = string | number | boolean;
type CapabilityInput = {path?:Record<string,Scalar>;query?:Record<string,Scalar>};
/** Host binds a single explicitly authorized capability; identity stays outside model-controlled input. */
export function createCapabilityTool(options:{name:string; description:string; invoke:(input:CapabilityInput,context?:{toolCallId?:string})=>Promise<unknown>}) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(options.name)||typeof options.description!=='string'||!options.description.trim()||typeof options.invoke!=='function') throw Error('Invalid capability tool');
  const scalar=z.union([z.string(),z.number().finite(),z.boolean()]);
  const schema=z.object({path:z.record(z.string(),scalar).optional(),query:z.record(z.string(),scalar).optional()}).strict();
  return tool(async (input,config) => {
    const callId=config?.configurable?.app_mixer_tool_call_id;
    const result=await options.invoke(input,{...(typeof callId==='string'?{toolCallId:callId}:{})});
    return JSON.stringify(result ?? null);
  },{name:options.name,description:options.description,schema});
}
