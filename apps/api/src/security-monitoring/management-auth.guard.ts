import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';

const REQUIRE_MANAGEMENT_AUTH = 'anysentry:require-management-auth';

type HeaderBag = Record<string, string | string[] | undefined>;
type RequestLike = { headers?: HeaderBag };

export const RequireManagementAuth = () => SetMetadata(REQUIRE_MANAGEMENT_AUTH, true);

export function managementAuthConfigured(): boolean {
  return Boolean(expectedToken());
}

function expectedToken(): string | undefined {
  const token = process.env.ANYSENTRY_ADMIN_TOKEN?.trim() || process.env.ANYSENTRY_MANAGEMENT_TOKEN?.trim();
  return token || undefined;
}

function headerValue(headers: HeaderBag | undefined, key: string): string | undefined {
  const value = headers?.[key] ?? headers?.[key.toLowerCase()];
  if (Array.isArray(value)) return value.find(Boolean);
  return value;
}

function bearerToken(headers: HeaderBag | undefined): string | undefined {
  const authorization = headerValue(headers, 'authorization');
  const match = authorization?.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function presentedToken(headers: HeaderBag | undefined): string | undefined {
  return headerValue(headers, 'x-anysentry-admin-token')?.trim() || headerValue(headers, 'x-anysentry-management-token')?.trim() || bearerToken(headers);
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const presentedHash = createHash('sha256').update(presented).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

@Injectable()
export class ManagementAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_MANAGEMENT_AUTH, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const expected = expectedToken();
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<RequestLike>();
    if (tokenMatches(presentedToken(request.headers), expected)) return true;
    throw new UnauthorizedException('management token required');
  }
}
