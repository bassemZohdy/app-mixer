import type {ChatOpenAI} from '@langchain/openai';

type Fields=ConstructorParameters<typeof ChatOpenAI>[0];
let module:Promise<typeof import('@langchain/openai')>|undefined;

/**
 * The OpenAI chat client, loaded on first use. Importing the package entry therefore does not load the OpenAI SDK (about 0.4 s and 40 MB), which a host that
 * never calls an OpenAI model, or that only wants webhooks and stores, would pay for. A failed load is not remembered, so a later call can try again.
 */
export async function openAIChat(fields:Fields):Promise<ChatOpenAI> {
  module??=import('@langchain/openai');
  try{const {ChatOpenAI:Client}=await module;return new Client(fields);}
  catch(error){module=undefined;throw error;}
}
