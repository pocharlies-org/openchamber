import { Window } from 'happy-dom';

/**
 * Installs a happy-dom window as the globals a React render needs and returns
 * what to undo it with. `extra` adds globals one test needs beyond the common set.
 */
export const installWindowGlobals = (windowInstance: Window, extra: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    Node: windowInstance.Node,
    Element: windowInstance.Element,
    HTMLElement: windowInstance.HTMLElement,
    MutationObserver: windowInstance.MutationObserver,
    ResizeObserver: windowInstance.ResizeObserver,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    IS_REACT_ACT_ENVIRONMENT: true,
    ...extra,
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};
