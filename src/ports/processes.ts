export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Executable name or path as the OS reports it (ps comm, Win32 Name). */
  comm: string;
  /** Full command line. Never log this: it can contain secrets. */
  args?: string;
  /** Full executable path when the OS provides it (Windows). */
  exePath?: string;
}

export interface ProcessLister {
  list(): Promise<ProcessInfo[]>;
}
