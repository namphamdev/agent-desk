/**
 * JSX typings for Electrobun's nested <electrobun-webview> custom element.
 * @see electrobun dist/api/browser/webviewtag.ts
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type ElectrobunWebviewAttributes = {
  src?: string;
  html?: string;
  preload?: string;
  partition?: string;
  renderer?: "cef" | "native";
  sandbox?: boolean | string;
  transparent?: boolean | string;
  passthrough?: boolean | string;
  masks?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & ElectrobunWebviewAttributes,
        HTMLElement
      >;
    }
  }

  interface HTMLElementTagNameMap {
    "electrobun-webview": HTMLElement & {
      webviewId?: number;
      src: string | null;
      loadURL(url: string): void;
      goBack(): void;
      goForward(): void;
      reload(): void;
      canGoBack(): Promise<boolean>;
      canGoForward(): Promise<boolean>;
      toggleHidden(hidden?: boolean, bypassState?: boolean): void;
      syncDimensions(force?: boolean): void;
      openDevTools(): void;
      on(event: string, listener: (event: CustomEvent) => void): void;
      off(event: string, listener: (event: CustomEvent) => void): void;
    };
  }
}

export {};
