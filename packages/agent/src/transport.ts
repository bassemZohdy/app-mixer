import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { validateRunInput, type LangGraphAGUIAdapter, type RunInput } from './index.js';

function reply(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify({error}));
}
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const expected=Buffer.from(`Bearer ${token}`), received=Buffer.from(req.headers.authorization ?? '');
  return expected.length === received.length && timingSafeEqual(expected,received);
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Error('CONTENT_TYPE');
  let size=0; const parts:Buffer[]=[];
  for await(const chunk of req) {
    const part=Buffer.from(chunk); size+=part.length;
    if(size > 1024*1024) throw Error('TOO_LARGE');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
  catch { throw Error('INVALID_JSON'); }
}
function parseInput(raw: unknown): RunInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).some(key => !['threadId','runId','messages','protocolVersion','tools','context','state'].includes(key))) throw Error('UNSUPPORTED_INPUT');
  const parsed=RunAgentInputSchema.safeParse(raw);
  if (!parsed.success) throw Error('INVALID_INPUT');
  const value=parsed.data;
  // Do not silently ignore privileged protocol features which this adapter cannot execute.
  if ((value.protocolVersion && value.protocolVersion !== '1.0') || value.parentRunId || value.resume?.length ||
      value.tools.length || value.context.length || value.forwardedProps !== undefined ||
      (value.state !== undefined && (typeof value.state !== 'object' || Array.isArray(value.state) || Object.keys(value.state).length))) throw Error('UNSUPPORTED_INPUT');
  const messages = value.messages.map(message => {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' ||
        (message.role === 'assistant' && message.toolCalls?.length)) throw Error('UNSUPPORTED_INPUT');
    return {role:message.role,content:message.content};
  });
  const input:RunInput={threadId:value.threadId,runId:value.runId,messages};
  validateRunInput(input);
  return input;
}
/** Local-development AG-UI SSE endpoint. Bind to loopback; production auth is not implemented. */
export function createAGUIServer(agent: LangGraphAGUIAdapter, token: string): Server {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Token must contain at least 32 characters');
  return createServer(async (req,res) => {
    if (!isAuthorized(req,token)) { reply(res,401,'Unauthorized'); return; }
    if(req.method !== 'POST' || req.url !== '/agent') { reply(res,404,'Not found'); return; }
    let input:RunInput;
    try { input=parseInput(await readBody(req)); }
    catch(error) {
      const code=error instanceof Error ? error.message : '';
      reply(res,code==='CONTENT_TYPE'?415:code==='TOO_LARGE'?413:400,code==='UNSUPPORTED_INPUT'?'Unsupported run input':'Invalid run input'); return;
    }
    const controller = new AbortController();
    res.once('close', () => { if(!res.writableEnded) controller.abort(); });
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    try {
      for await(const event of agent.run(input,{signal:controller.signal})) {
        if(controller.signal.aborted || res.destroyed) break;
        if(!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res,'drain',{signal:controller.signal});
      }
      if(!res.destroyed) res.end();
    } catch { if(!res.destroyed) res.destroy(); }
  });
}
