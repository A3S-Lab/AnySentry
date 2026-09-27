# AnySentry User Management v1

## Purpose

User Management v1 is a local governance directory. It records people, teams,
status and fixed responsibilities without introducing login, passwords,
sessions or request-time RBAC.

The existing console access model remains unchanged:

- no login page;
- no password storage;
- no browser session;
- no user impersonation;
- no user-role access interception.

Existing optional management-token protection still applies to management
mutations when it is configured.

## Reference decision

The implementation combines:

- SkyWalking's small, fixed role model;
- DataBuff's dense user table, filters and side-panel editing pattern.

DataBuff's organization tree, management domains, password reset, force logout
and login flow are intentionally excluded from v1.

## Roles

| Role | Purpose |
|---|---|
| `administrator` | Platform and governance management |
| `security_analyst` | Risk review and incident investigation |
| `operator` | Alert acknowledgement and remediation operations |
| `viewer` | Read-only monitoring |

The permission labels returned by the API are descriptive metadata in v1.
`authorizationEnforced` is always `false`.

## Persistence

The authoritative mutable record is stored in PostgreSQL table
`anysentry_platform_users`. If PostgreSQL is unavailable, the API keeps the
directory in memory for the current process and exposes that degraded state
through the health endpoint.

The first empty directory receives one seed record:

```text
username: operator
displayName: 本地管理员
role: administrator
status: active
```

## API

```text
POST /security-center/users/list
POST /security-center/users
PUT  /security-center/users/:userId
```

Create and update operations append `user.updated` audit records. Users are
disabled instead of deleted so historical ownership references remain stable.

## Future boundary

If login is introduced later, authentication and authorization must be a
separate phase. It must map an authenticated principal to `userId`, enforce
permissions server-side, support bootstrap/recovery, and migrate the current
directory without changing its stable IDs.
