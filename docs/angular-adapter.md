# Angular DOM host bridge: prototype

`adapters/angular` contains an Angular standalone component that hosts the existing App Mixer web renderer. Build it with the Angular compiler alongside matching Angular and `@app-mixer/web` dependencies, then import `A2UIComponent` into an Angular application:

```html
<app-mixer-a2ui [subscribe]="subscribe" (action)="onAction($event)" (error)="onError($event)" />
```

`subscribe(receive)` connects an ordered A2UI message source and may return an unsubscribe function. Keep it stable across change detection; when it changes the old subscription is disconnected, its DOM is cleared, and a new renderer starts. The source must replay the current surface and data to each new subscriber. On destruction the component unsubscribes and ignores late messages. Unsubscribe failures are emitted as errors without blocking a replacement source. Action and error events are emitted inside Angular's zone; the host must authorize and route actions. The component schedules DOM work after Angular's next render and never compiles incoming content as an Angular template.

The bridge supports the same limited six-component catalog as the [web renderer](a2ui-renderer.md). CI builds it with Angular's partial compiler and exercises mounting, output events, subscription changes and cleanup in Angular 19 TestBed. It is an initial DOM integration; React Native and Flutter adapters and cross-platform parity remain unimplemented. The component does not render on the server. Production packaging and a broader Angular compatibility matrix remain future work. See also the [React bridge](react-adapter.md).
