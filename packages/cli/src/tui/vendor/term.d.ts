// Vendored from dsh-oc-tui, MIT. Loose type declarations for the JS engine.
export function hexToAnsi(hex: string): string;
export function makeStyle(partial?: any): any;
export function mergeStyle(base: any, over: any): any;
export class Screen {
  constructor(cols: number, rows: number);
  cols: number;
  rows: number;
  resize(cols: number, rows: number): boolean;
  clear(style?: any): void;
  set(x: number, y: number, ch: string, style?: any): void;
  text(x: number, y: number, str: string, style?: any): number;
  fill(x: number, y: number, width: number, ch: string, style?: any): void;
  fillToEnd(x: number, y: number, style?: any): void;
  defaultBackground(hex: string): void;
}
export function decodeKey(input: Buffer): any;
export class Terminal {
  constructor(opts?: { input?: any; output?: any });
  raw: boolean;
  cols: number;
  rows: number;
  isTTY(): boolean;
  start(): void;
  stop(): void;
  write(s: string): void;
  paint(screen: Screen): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  requestClipboard(): void;
  copyToClipboard(text: string): void;
}
