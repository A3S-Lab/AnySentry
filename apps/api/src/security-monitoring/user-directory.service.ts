import { ConflictException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  PlatformRoleDefinition,
  PlatformUserItem,
  PlatformUserList,
  PlatformUserQuery,
  PlatformUserRecord,
  PlatformUserRole,
  PlatformUserStatus,
  PlatformUserUpdateRequest,
} from './types';

const RETAIN_LIMIT = 5_000;
const REFRESH_INTERVAL_MS = 15_000;

const ROLE_DEFINITIONS: ReadonlyArray<Omit<PlatformRoleDefinition, 'userCount'>> = [
  {
    role: 'administrator',
    label: '管理员',
    description: '管理平台目录、策略和治理配置。',
    permissions: ['platform.manage', 'security.review', 'incident.respond', 'data.read'],
  },
  {
    role: 'security_analyst',
    label: '安全分析员',
    description: '研判风险、调查 Incident 并维护证据。',
    permissions: ['security.review', 'incident.respond', 'data.read'],
  },
  {
    role: 'operator',
    label: '运营人员',
    description: '执行告警确认、处置和日常运营。',
    permissions: ['incident.respond', 'data.read'],
  },
  {
    role: 'viewer',
    label: '只读观察员',
    description: '查看 Dashboard、资产和安全证据。',
    permissions: ['data.read'],
  },
];

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function cleanRole(value: unknown): PlatformUserRole {
  if (value === 'administrator' || value === 'security_analyst' || value === 'operator' || value === 'viewer') return value;
  return 'viewer';
}

function cleanStatus(value: unknown): PlatformUserStatus {
  return value === 'disabled' ? 'disabled' : 'active';
}

function hashId(parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const part of parts) h.update(String(part ?? '')).update('\0');
  return `usr_${h.digest('hex').slice(0, 18)}`;
}

@Injectable()
export class UserDirectoryService implements OnModuleInit, OnModuleDestroy {
  private readonly users = new Map<string, PlatformUserRecord>();
  private persistTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private initialized = false;

  constructor(private readonly relational: RelationalBusinessStore) {}

  async onModuleInit(): Promise<void> {
    for (const record of await this.relational.loadPlatformUsers()) this.mergePersisted(record);
    this.migrateLegacyLocalOperator();
    if (this.users.size === 0) this.seedLocalOperator();
    this.initialized = true;
    await this.persist();
    this.refreshTimer = setInterval(() => void this.refreshRelationalState(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.persist();
  }

  stateStatus() {
    return {
      userCount: this.users.size,
      postgresqlBacked: this.relational.isReady(),
      authenticationRequired: false,
      authorizationEnforced: false,
    };
  }

  has(userId: string): boolean {
    return this.users.has(userId);
  }

  list(query: PlatformUserQuery = {}): PlatformUserList {
    const q = clean(query.q, 200)?.toLowerCase();
    const items = [...this.users.values()]
      .filter((record) =>
        (!query.role || query.role === 'all' || record.role === query.role) &&
        (!query.status || query.status === 'all' || record.status === query.status) &&
        (!q || [record.username, record.displayName, record.email, record.team, record.role, record.note]
          .some((value) => (value ?? '').toLowerCase().includes(q))),
      )
      .sort((a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        a.displayName.localeCompare(b.displayName, 'zh-CN') ||
        a.username.localeCompare(b.username),
      );
    const all = [...this.users.values()];
    const limit = Math.max(1, Math.min(RETAIN_LIMIT, query.limit ?? 500));
    const roles = ROLE_DEFINITIONS.map((definition) => ({
      ...definition,
      userCount: all.filter((user) => user.role === definition.role).length,
    }));
    return {
      items: items.slice(0, limit).map((record) => this.item(record)),
      roles,
      total: items.length,
      summary: {
        totalUsers: all.length,
        activeUsers: all.filter((record) => record.status === 'active').length,
        disabledUsers: all.filter((record) => record.status === 'disabled').length,
        administratorUsers: all.filter((record) => record.role === 'administrator').length,
      },
      authenticationRequired: false,
      authorizationEnforced: false,
      updateTime: iso(),
    };
  }

  upsert(userId: string | undefined, input: PlatformUserUpdateRequest, actorId = 'operator'): PlatformUserItem {
    const at = Date.now();
    const current = userId ? this.users.get(userId) : undefined;
    const username = clean(input.username, 80) ?? current?.username;
    if (!username) throw new ConflictException('username is required');
    const duplicate = [...this.users.values()].find((record) =>
      record.userId !== userId && record.username.toLowerCase() === username.toLowerCase(),
    );
    if (duplicate) throw new ConflictException(`username already exists: ${username}`);

    const id = userId ?? hashId([username.toLowerCase(), at]);
    const next: PlatformUserRecord = {
      schemaVersion: 'anysentry.platform_user.v1',
      userId: id,
      username,
      displayName: clean(input.displayName, 120) ?? current?.displayName ?? username,
      email: 'email' in input ? clean(input.email, 240) : current?.email,
      team: 'team' in input ? clean(input.team, 120) : current?.team,
      role: input.role ? cleanRole(input.role) : current?.role ?? 'viewer',
      status: input.status ? cleanStatus(input.status) : current?.status ?? 'active',
      source: 'local',
      note: 'note' in input ? clean(input.note, 1_000) : current?.note,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
      updatedBy: clean(actorId, 160) ?? 'operator',
    };
    this.users.set(id, next);
    this.trim();
    this.persistSoon();
    return this.item(next);
  }

  private seedLocalOperator(): void {
    const at = Date.now();
    const record: PlatformUserRecord = {
      schemaVersion: 'anysentry.platform_user.v1',
      userId: 'usr_local_operator',
      username: 'admin',
      displayName: 'admin',
      role: 'administrator',
      status: 'active',
      source: 'local',
      note: '默认本地治理用户；当前控制台无需登录。',
      createdAt: at,
      updatedAt: at,
      updatedBy: 'system',
    };
    this.users.set(record.userId, record);
  }

  private migrateLegacyLocalOperator(): void {
    const record = this.users.get('usr_local_operator');
    if (
      !record
      || record.username !== 'operator'
      || record.displayName !== '本地管理员'
      || record.updatedBy !== 'system'
      || [...this.users.values()].some((user) =>
        user.userId !== record.userId && user.username.toLowerCase() === 'admin')
    ) return;
    this.users.set(record.userId, {
      ...record,
      username: 'admin',
      displayName: 'admin',
      updatedAt: Date.now(),
      updatedBy: 'system',
    });
  }

  private normalize(record: PlatformUserRecord): PlatformUserRecord | undefined {
    const userId = clean(record.userId, 120);
    const username = clean(record.username, 80);
    if (!userId || !username) return undefined;
    const createdAt = Number(record.createdAt) || Date.now();
    return {
      schemaVersion: 'anysentry.platform_user.v1',
      userId,
      username,
      displayName: clean(record.displayName, 120) ?? username,
      email: clean(record.email, 240),
      team: clean(record.team, 120),
      role: cleanRole(record.role),
      status: cleanStatus(record.status),
      source: 'local',
      note: clean(record.note, 1_000),
      createdAt,
      updatedAt: Number(record.updatedAt) || createdAt,
      updatedBy: clean(record.updatedBy, 160) ?? 'system',
    };
  }

  private item(record: PlatformUserRecord): PlatformUserItem {
    return { ...record, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
  }

  private mergePersisted(record: PlatformUserRecord): void {
    const normalized = this.normalize(record);
    if (!normalized) return;
    const current = this.users.get(normalized.userId);
    if (!current || normalized.updatedAt > current.updatedAt) this.users.set(normalized.userId, normalized);
  }

  private trim(): void {
    if (this.users.size <= RETAIN_LIMIT) return;
    const keep = [...this.users.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.users.clear();
    for (const record of keep) this.users.set(record.userId, record);
  }

  private persistSoon(): void {
    if (!this.initialized || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    await this.relational.savePlatformUsers([...this.users.values()]);
  }

  private async refreshRelationalState(): Promise<void> {
    for (const record of await this.relational.loadPlatformUsers()) this.mergePersisted(record);
  }
}
