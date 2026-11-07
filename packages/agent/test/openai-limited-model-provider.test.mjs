// The OpenAI-compatible limited model against a real model server. Opt-in: set APP_MIXER_TEST_OLLAMA_URL (for
// example http://127.0.0.1:11434) and APP_MIXER_TEST_OLLAMA_CHAT_MODEL (a pulled chat model, for example qwen2.5:0.5b).
// It checks what the unit tests can only assume about a provider: the output cap is honoured, the reported usage adds
// up, and the conservative prompt bound is never below the prompt tokens the provider counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {HumanMessage} from '@langchain/core/messages';
import {createOpenAILimitedToolModel} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_OLLAMA_URL,chat=process.env.APP_MIXER_TEST_OLLAMA_CHAT_MODEL;
const skip=!url||!chat?'set APP_MIXER_TEST_OLLAMA_URL and APP_MIXER_TEST_OLLAMA_CHAT_MODEL to run against a model server':false;
const config={model:chat,apiKey:'local',baseURL:`${url}/v1`};
const prompt='Write a very long story about a dragon, a knight and a lighthouse. Keep going for many chapters.';

test('the provider stops at the output cap and the reported usage stays within the limit',{skip,timeout:300000},async t=>{
  const model=createOpenAILimitedToolModel(config,[],{promptOverheadTokens:0});
  // The prompt bound is deliberately far above the real prompt (117 against about 50 tokens here), so the limits leave room.
  for(const limit of [200,300]){
    const {message,usedTokens}=await model.invokeLimited([new HumanMessage(prompt)],{maxTotalTokens:limit,callId:'call'});
    const usage=message.usage_metadata;
    assert.equal(usedTokens,usage.total_tokens);assert.equal(usage.input_tokens+usage.output_tokens,usage.total_tokens);
    assert.ok(usedTokens<=limit,`the provider used ${usedTokens} tokens against a limit of ${limit}`);
    assert.equal(message.response_metadata.finish_reason,'length','the long story was cut at the cap');
    t.diagnostic(`limit ${limit}: provider used ${usedTokens} (${usage.input_tokens} in, ${usage.output_tokens} out)`);
  }
});

test('the prompt bound is never below the provider\'s own prompt token count',{skip,timeout:300000},async t=>{
  // Text that tokenizes densely (many short words, digits, punctuation, non-Latin text) is the hard case for a bound.
  const texts=[prompt,'1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20','a,b;c.d!e?f-g_h+i=j','日本語のテキストをここに書きます。','🙂🙂🙂🙂🙂🙂 emoji and symbols ©®™ ±×÷'];
  // The provider's chat template adds tokens of its own (Ollama's Qwen template injects a default system prompt and role
  // markers, about 28 here), which is why the bound carries `promptOverheadTokens` (default 64).
  const model=createOpenAILimitedToolModel(config,[]);
  for(const text of texts){
    // With the limit equal to the bound plus one output token, the allowance is exactly one token.
    const bound=64+16+Buffer.byteLength(text)+5,{message}=await model.invokeLimited([new HumanMessage(text)],{maxTotalTokens:bound+1,callId:'call'});
    const counted=message.usage_metadata.input_tokens;
    assert.ok(counted<=bound,`the provider counted ${counted} prompt tokens, above the bound ${bound}, for ${JSON.stringify(text.slice(0,30))}`);
    t.diagnostic(`${JSON.stringify(text.slice(0,24))}: provider ${counted} tokens (${counted-Buffer.byteLength(text)} above the text's bytes), bound ${bound}`);
  }
});
