export interface AutostartPort {
  install(args: string[]): Promise<{ path: string }>;
  remove(): Promise<boolean>;
  isInstalled(): Promise<boolean>;
}
