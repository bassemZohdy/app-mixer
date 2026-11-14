// Preloaded with --import: reports each provider SDK the module loader is asked to resolve, one `PROVIDER-LOADED <specifier>` line each on stderr.
import {registerHooks} from 'node:module';

registerHooks({
 resolve(specifier,context,nextResolve){
  if(/^(@langchain\/openai|openai|twilio)(\/|$)/.test(specifier))console.error('PROVIDER-LOADED '+specifier);
  return nextResolve(specifier,context);
 }
});
