// Shared pieces of the bun:test + happy-dom behaviour tests of dialogs: the DOM
// install/restore, the renderer pre-import, and the form-kit mocks. Import it
// first in the test file; every call is explicit so a test reads top to bottom.
import React, { act } from 'react';
import { mock } from 'bun:test';
import { Window } from 'happy-dom';

const swapGlobals = (names: readonly string[], values: Record<string, unknown>) => {
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const restoreRendererGlobals = swapGlobals(['window', 'document'], { window: rendererWindow, document: rendererWindow.document });
export const { createRoot } = await import('react-dom/client');
restoreRendererGlobals();
rendererWindow.close();

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
  'KeyboardEvent', 'Event', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;

/** A happy-dom window installed as the globals, plus a mounted container; `restore` undoes both. */
export const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const restoreGlobals = swapGlobals(DOM_GLOBAL_NAMES, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    Event: happyWindow.Event,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      restoreGlobals();
    },
  };
};

export const buttonByText = (container: HTMLElement, text: string) => {
  const found = [...container.querySelectorAll('button')].find((button) => button.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};

export const wait = async (ms = 25) => {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
};

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

/**
 * Replaces the dialog, button and select kit with plain elements. Radix's Select
 * needs a real popover; a native select drives the same `onValueChange` the
 * component uses and keeps the test about the pick.
 */
export const mockDialogKit = async () => {
  const actualDialog = await import('@/components/ui/dialog');
  mock.module('@/components/ui/dialog', () => ({
    ...actualDialog,
    Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => (open ? <>{children}</> : null),
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
  }));
  mock.module('@/components/ui/button', () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  }));
  mock.module('@/components/ui/select', () => ({
    Select: ({ value, onValueChange, children }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) => (
      <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
    ),
    SelectTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
  }));
};
