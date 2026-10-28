import {A2UIRenderer, type ActionMessage} from './index.js';

type ReactRuntime = {
  createElement: (type: string, props: any) => any;
  useRef: <T>(value:T) => {current:T};
  useEffect: (effect:()=>void|(()=>void), deps:unknown[])=>void;
};
export type A2UISubscribe = (receive:(message:unknown)=>void)=>void|(()=>void);
export type ReactA2UIProps = {
  subscribe:A2UISubscribe;
  onAction:(message:ActionMessage)=>void;
  onError:(error:unknown)=>void;
};

/** Bind the existing DOM renderer to React without bundling a second React runtime. */
export function createReactA2UIComponent(React:ReactRuntime): (props:ReactA2UIProps)=>any {
  return function ReactA2UI({subscribe,onAction,onError}:ReactA2UIProps):any {
    const host=React.useRef<HTMLElement|null>(null);
    const actions=React.useRef(onAction),errors=React.useRef(onError);
    actions.current=onAction;errors.current=onError;
    React.useEffect(()=>{
      if(!host.current)return;
      const element=host.current;
      const renderer=new A2UIRenderer(element,undefined,message=>actions.current(message));
      let active=true;
      let unsubscribe:void|(()=>void);
      try{
        unsubscribe=subscribe(message=>{
          if(!active)return;
          try{renderer.apply(message);}catch(error){errors.current(error);}
        });
      }catch(error){errors.current(error);}
      return ()=>{active=false;try{if(typeof unsubscribe==='function')unsubscribe();}finally{element.replaceChildren();}};
    },[subscribe]);
    return React.createElement('div',{ref:host});
  };
}
