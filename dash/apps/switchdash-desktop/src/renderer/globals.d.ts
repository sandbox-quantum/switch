declare module 'react-syntax-highlighter';
declare module 'react-syntax-highlighter/dist/esm/styles/prism';

declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        /**
         * Electron's `<webview>` tag, used by the embedded room view. React
         * has no built-in typing for it, and only the attributes we actually
         * set are declared — adding one means adding it here first.
         */
        webview: React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement> & {
            src?: string;
            partition?: string;
            preload?: string;
            useragent?: string;
          },
          HTMLElement
        >;
      }
    }
  }

  interface Window {
    electronAPI: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      eventSend: (channel: string, data: unknown) => void;
      eventOn: (channel: string, cb: (data: unknown) => void) => () => void;
      getPathForFile: (file: File) => string;
    };
  }
}

export {};
