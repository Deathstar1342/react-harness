/** Fixed privileged-helper locations. Never grant these as project/file roots. */
export const helperProtectedPaths = ['/usr/lib/abyssus-helper', '/etc/abyssus-helper', '/var/lib/abyssus-helper', '/run/abyssus-helper'] as const;
