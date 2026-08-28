export const SANDBOX_PROFILES: Record<string, string> = {
  default: `; sandbox-exec is deprecated on macOS but still functional on macOS 15/26.
(version 1)
(deny default)
(allow process*)
(allow file-read* (literal "/usr") (literal "/System") (literal "/Library"))
(allow file-write* (param "WORKSPACE_HOME") (literal "/tmp"))
(allow network-outbound (remote tcp4 "localhost:6379"))
`,
  'no-network': `; sandbox-exec is deprecated on macOS but still functional on macOS 15/26.
(version 1)
(deny default)
(allow process*)
(allow file-read* (literal "/usr") (literal "/System") (literal "/Library"))
(allow file-write* (param "WORKSPACE_HOME") (literal "/tmp"))
(deny network-outbound)
`,
};
