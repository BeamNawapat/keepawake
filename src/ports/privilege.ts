export interface PrivilegePort {
  /** True when elevated commands can run without prompting right now. */
  isElevated(): Promise<boolean>;
  /** Prompt once (sudo -v / UAC) so a later elevated command does not stall. Returns false on refusal. */
  prepare(): Promise<boolean>;
}
