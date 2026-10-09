export interface NetworkPort {
  /** TCP connect to a public address; true when the internet is reachable. */
  isOnline(): Promise<boolean>;
  /**
   * Ask the OS to join a saved Wi-Fi profile. Resolves true when the command
   * was accepted; callers confirm with `isOnline` because SSID reads are
   * redacted on recent macOS.
   */
  connectWifi(ssid: string): Promise<boolean>;
}
