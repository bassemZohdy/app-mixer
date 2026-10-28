import {afterNextRender, Component, ElementRef, EventEmitter, inject, Injector, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges} from '@angular/core';
import {A2UIRenderer, type ActionMessage} from '@app-mixer/web';

export type A2UISubscribe = (receive:(message:unknown)=>void)=>void|(()=>void);

/** Angular host for the existing browser DOM renderer; incoming content is not Angular template code. */
@Component({selector:'app-mixer-a2ui', standalone:true, template:''})
export class A2UIComponent implements OnChanges, OnDestroy {
  @Input({required:true}) subscribe!:A2UISubscribe;
  @Output() readonly action = new EventEmitter<ActionMessage>();
  @Output() readonly error = new EventEmitter<unknown>();
  private readonly element=inject(ElementRef<HTMLElement>).nativeElement;
  private readonly injector=inject(Injector);
  private readonly zone=inject(NgZone);
  private generation=0;
  private unsubscribe?:()=>void;
  private destroyed=false;

  ngOnChanges(changes:SimpleChanges):void {
    if(!changes['subscribe'])return;
    const generation=++this.generation;
    afterNextRender(()=>{
      if(this.destroyed||generation!==this.generation)return;
      this.disconnect();
      const renderer=new A2UIRenderer(this.element,undefined,message=>this.zone.run(()=>this.action.emit(message)));
      try {
        if(typeof this.subscribe!=='function')throw Error('A2UI subscribe is required');
        const stop=this.subscribe(message=>{
          if(this.destroyed||generation!==this.generation)return;
          try{renderer.apply(message);}catch(error){this.zone.run(()=>this.error.emit(error));}
        });
        if(typeof stop==='function')this.unsubscribe=stop;
      }catch(error){this.zone.run(()=>this.error.emit(error));}
    },{injector:this.injector});
  }
  ngOnDestroy():void {this.destroyed=true;this.generation++;this.disconnect();}
  private disconnect():void {
    const stop=this.unsubscribe;this.unsubscribe=undefined;
    try{stop?.();}finally{this.element.replaceChildren();}
  }
}
