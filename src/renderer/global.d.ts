import type { AppApi } from "../common/types.js";

declare global {
  interface Window {
    abrarImporter: AppApi;
  }
}

export {};
