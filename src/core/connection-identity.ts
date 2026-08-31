import { isIPv6 } from 'node:net';
import { domainToASCII, URL } from 'node:url';
import type { FTPConfig, Protocol } from '../types';

type ConnectionEndpoint = Pick<FTPConfig, 'protocol' | 'host' | 'port' | 'username'>;

function effectivePort(protocol: Protocol, configuredPort: number | undefined): number {
  return configuredPort || (protocol === 'sftp' ? 22 : 21);
}

function canonicalHost(configuredHost: string): string {
  const trimmedHost = configuredHost.trim();
  const bracketedHost = trimmedHost.startsWith('[') && trimmedHost.endsWith(']')
    ? trimmedHost.slice(1, -1)
    : undefined;
  const ipv6Host = bracketedHost && isIPv6(bracketedHost)
    ? bracketedHost
    : isIPv6(trimmedHost) ? trimmedHost : undefined;

  if (ipv6Host) {
    // URL's host parser produces a stable compressed IPv6 representation.
    return new URL(`http://[${ipv6Host}]/`).hostname.slice(1, -1).toLowerCase();
  }

  // DNS names are case-insensitive. Preserve punctuation (including a trailing
  // root dot) while using the standard IDNA form when the host is Unicode.
  return (domainToASCII(trimmedHost) || trimmedHost).toLowerCase();
}

/**
 * Stable identity for one authenticated transport endpoint.
 *
 * A JSON tuple avoids delimiter ambiguity for IPv6 literals and usernames.
 * Display names and paths intentionally do not participate in connection
 * ownership, while protocol does so FTP, FTPS, and SFTP never share state.
 */
export function connectionEndpointIdentity(config: ConnectionEndpoint): string {
  return JSON.stringify([
    config.protocol,
    canonicalHost(config.host),
    effectivePort(config.protocol, config.port),
    config.username
  ]);
}
