const DEPENDENCY_ALLOWLIST = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'three',
]);

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

export function resolveAllowedDependency(specifier: string): string {
  if (!DEPENDENCY_ALLOWLIST.has(specifier)) {
    throw new Error(`Dependency "${specifier}" is not allowed in Preview Project.`);
  }
  return specifier;
}

export function listAllowedDependencies(): string[] {
  return Array.from(DEPENDENCY_ALLOWLIST).sort();
}
