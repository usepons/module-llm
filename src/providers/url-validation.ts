/**
 * Security: validate LLM provider base URLs to prevent SSRF attacks.
 * Blocks cloud metadata endpoints, private IP ranges, and non-HTTP protocols.
 *
 * Note: localhost/127.0.0.1 are intentionally ALLOWED because local LLM
 * providers (Ollama, llama.cpp) bind to localhost by default.
 */

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',          // AWS/GCP metadata
  'metadata.google.internal', // GCP metadata
  '100.100.100.200',          // Alibaba Cloud metadata
  'fd00:ec2::254',            // AWS IMDSv2 IPv6
  '0.0.0.0',
]);

/**
 * Check if an IPv4 address belongs to a private/reserved range
 * that should not be reachable from LLM provider configs.
 *
 * Allows 127.0.0.0/8 (localhost) intentionally for local providers.
 */
function isBlockedPrivateIP(hostname: string): boolean {
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4Match) return false;

  const [, a, b] = ipv4Match.map(Number);

  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
  if (a === 0) return true;                           // 0.0.0.0/8

  return false;
}

/**
 * Check if an IPv6 address is a blocked private/reserved address.
 * Allows ::1 (loopback) intentionally for local providers.
 */
function isBlockedPrivateIPv6(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  // Block ULA (fc00::/7) and link-local (fe80::/10)
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true;
  if (bare.startsWith('fe80')) return true;
  return false;
}

export function validateProviderBaseUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for LLM provider: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked SSRF target: ${hostname}`);
  }

  if (isBlockedPrivateIP(hostname)) {
    throw new Error(`Blocked private IP range: ${hostname}`);
  }

  if (isBlockedPrivateIPv6(hostname)) {
    throw new Error(`Blocked private IPv6 address: ${hostname}`);
  }

  return parsed.toString().replace(/\/$/, '');
}
