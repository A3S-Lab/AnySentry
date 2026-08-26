#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');

const router = read('apps/web/src/router.tsx');
const assetRoutes = read('apps/web/src/lib/asset-routes.ts');
const assetsPage = read('apps/web/src/pages/AssetsPage.tsx');
const filterRulesPage = read('apps/web/src/pages/FilterRulesPage.tsx');
const filterRulesApi = read('apps/web/src/lib/api/filter-rules.ts');
const filterRuleCategoryTree = read('apps/web/src/components/filter-rules/filter-rule-category-tree.tsx');
const filterRuleDetail = read('apps/web/src/components/filter-rules/filter-rule-detail.tsx');
const filterRuleExplain = read('apps/web/src/components/filter-rules/filter-rule-explain.tsx');
const filterRuleWizard = read('apps/web/src/components/filter-rules/filter-rule-wizard.tsx');
const sidebar = read('apps/web/src/components/custom/security-sidebar.tsx');
const mobileNavigation = read('apps/web/src/components/custom/mobile-security-navigation.tsx');
const adminToken = read('apps/web/src/components/custom/admin-token-control.tsx');
const header = read('apps/web/src/components/custom/security-console-header.tsx');
const eventsPage = read('apps/web/src/pages/AgentEventsPage.tsx');
const agentsPage = read('apps/web/src/pages/AgentsPage.tsx');

// Canonical routes preserve old deep links without retaining a second rule page.
assert.match(router, /path: "\/assets"/u);
assert.match(router, /path: "\/assets\/:assetId"/u);
assert.match(router, /path: "\/filter-rules"/u);
assert.match(router, /path: "\/capture-rules"/u);
assert.match(router, /<FilterRulesPage \/>/u);
assert.match(router, /LegacyCaptureRulesRedirect/u);
assert.match(router, /Navigate replace to=\{`\/filter-rules\$\{location\.search\}\$\{location\.hash\}`\}/u);

// Asset IDs are always encoded as one path segment; pages must not hand-build dynamic routes.
assert.match(assetRoutes, /encodeURIComponent\(normalized\)/u);
assert.match(assetRoutes, /export function assetHref/u);
assert.match(assetRoutes, /export function assetsHref/u);
assert.match(assetsPage, /to=\{assetHref\(asset\.subjectAssetId, query\)\}/u);
assert.match(eventsPage, /assetHref\(resolvedAssetId, assetQs\)/u);

// Unified asset foundation remains intact.
assert.match(assetsPage, /securityCenterApi\.observedAssets/u);
assert.match(assetsPage, /securityCenterApi\.observedAsset/u);
assert.match(assetsPage, /当前观测覆盖/u);
assert.match(assetsPage, /身份审核与影响/u);
assert.match(assetsPage, /资产目录加载失败/u);
assert.match(assetsPage, /当前没有匹配资产/u);
assert.match(assetsPage, /解释过滤规则/u);
assert.match(assetsPage, /查找并复用全局规则/u);
assert.match(assetsPage, /创建安全规则草稿/u);
assert.match(assetsPage, /view: "asset", mode: "explain", assetId: asset\.subjectAssetId/u);
assert.match(assetsPage, /SERVICE_ASSET_TYPES = \["service", "infrastructure", "workload"\]/u);
assert.match(assetsPage, /readAssetPage\(listQuery, tab, nextCursor\)/u);
assert.doesNotMatch(assetsPage, /mock|fixture|fake data/iu);

// The Filter Rules page consumes the unified APIs and exposes all three product views.
assert.match(filterRulesApi, /\/security-center\/filter-rules\/catalog/u);
assert.match(filterRulesApi, /filter-rules\/stages\/status/u);
assert.match(filterRulesApi, /filter-rules\/explain/u);
assert.match(filterRulesApi, /filter-rules\/examples\/agent-infrastructure-conflict/u);
assert.match(filterRulesApi, /filter-rules\/simulate/u);
assert.match(filterRulesApi, /drafts\/from-asset/u);
assert.match(filterRulesApi, /\/preview/u);
assert.match(filterRulesPage, /FilterRuleStageStrip/u);
assert.match(filterRulesPage, /FilterRuleCategoryTree/u);
assert.match(filterRulesPage, /FilterRuleList/u);
assert.match(filterRulesPage, /FilterRuleDetailPanel/u);
assert.match(filterRulesPage, /FilterRuleExplainPanel/u);
assert.match(filterRulesPage, /"category" \| "stage" \| "asset"/u);
assert.match(filterRulesPage, /cursor: catalogCursor/u);
assert.match(filterRulesPage, /加载过滤规则/u);
assert.match(filterRulesPage, /过滤规则加载失败/u);
assert.match(filterRulesPage, /当前分类已加载 0 条规则/u);
assert.match(filterRulesPage, /automaticallyExplainedAsset/u);
assert.match(filterRulesPage, /filterRulesApi\.explain\(\{ assetId: linkedAssetId \}\)/u);
assert.match(filterRulesPage, /onCreateSuccessor/u);
assert.match(filterRulesApi, /agent_template/u);
assert.match(filterRuleCategoryTree, /kind\.total === 0/u);
assert.match(filterRuleDetail, /F0\/F1\/F2\/F3 编译影响/u);
assert.match(filterRulesApi, /\| "signal_enablement"/u);
assert.match(filterRuleDetail, /选择性信号启用边界/u);
assert.match(filterRuleDetail, /file_open_read/u);
assert.match(filterRuleDetail, /同 Pod sidecar/u);
assert.match(filterRuleDetail, /Scope TTL 已过期/u);
assert.match(filterRuleDetail, /role="tablist"/u);
assert.match(filterRuleDetail, /event\.key === "ArrowRight"/u);
assert.match(filterRuleDetail, /event\.key === "Home"/u);
assert.match(filterRuleDetail, /模拟样本窗口/u);
assert.match(filterRuleDetail, /last_30m/u);
assert.match(filterRuleDetail, /simulation\.sample\.partial/u);
assert.match(filterRuleExplain, /F0 → F1 → F2 → F3 决策链/u);
assert.match(filterRuleExplain, /encodeURIComponent\(stage\.winner\.ruleId\)/u);
assert.match(filterRuleWizard, /runtime_signature/u);
assert.match(filterRuleWizard, /persistence_retention/u);
assert.match(filterRuleWizard, /investigation_override/u);
assert.match(filterRuleWizard, /predecessorRuleId/u);
assert.match(filterRuleWizard, /正在创建后继草稿/u);
assert.doesNotMatch(`${filterRulesPage}\n${filterRuleDetail}\n${filterRuleWizard}`, /<textarea|replaceAll/u);

// Navigation exposes the new IA while preserving shared responsive/a11y behavior.
assert.match(sidebar, /label: "资产与身份"[\s\S]{0,120}href: "\/assets"/u);
assert.match(sidebar, /label: "过滤规则"[\s\S]{0,140}href: "\/filter-rules"/u);
assert.match(mobileNavigation, /SECURITY_NAVIGATION_GROUPS\.map/u);
assert.match(mobileNavigation, /role="dialog"/u);
assert.match(mobileNavigation, /aria-modal="true"/u);
assert.match(mobileNavigation, /event\.key === "Escape"/u);
assert.match(mobileNavigation, /event\.key !== "Tab"/u);
assert.match(mobileNavigation, /closeButtonRef\.current\?\.focus/u);
assert.match(mobileNavigation, /triggerRef\.current\?\.focus/u);
assert.match(mobileNavigation, /dialog\.querySelectorAll<HTMLElement>/u);
assert.match(mobileNavigation, /AdminTokenControl navigation inlineNavigationPanel/u);
assert.match(adminToken, /inlineNavigationPanel/u);
assert.match(adminToken, /h-11 w-11 sm:h-8 sm:w-8/u);
assert.match(adminToken, /navigation && !inlineNavigationPanel \? createPortal/u);
assert.match(header, /<MobileSecurityNavigation \/>/u);

// 390px uses route-level composition rather than shrinking a desktop matrix.
assert.match(assetsPage, /assetId && "hidden lg:flex"/u);
assert.match(assetsPage, /!assetId && "hidden lg:block"/u);
assert.match(filterRulesPage, /focused \? "hidden xl:flex" : "flex"/u);
assert.match(filterRulesPage, /!focused && "hidden xl:block"/u);
assert.match(filterRulesPage, /返回规则目录/u);
assert.doesNotMatch(assetsPage, /min-w-\[(?:8|9|1[0-9])\d{2}px\]/u);
assert.doesNotMatch(filterRulesPage, /min-w-\[(?:8|9|1[0-9])\d{2}px\]/u);

// Event page responsive behavior remains intact.
assert.match(eventsPage, /aria-controls="event-advanced-filters"/u);
assert.match(eventsPage, /更多筛选/u);
assert.match(eventsPage, /id="event-advanced-filters"/u);
assert.match(eventsPage, /hidden md:contents/u);
assert.match(eventsPage, /max-h-\[45dvh\][^\n]*overflow-y-auto/u);
assert.match(eventsPage, /placeholder="subjectAssetId"/u);

// Intrinsic names cannot push content outside narrow panels; touch targets stay at least 44px.
assert.match(eventsPage, /grid min-w-0 w-full[\s\S]{0,220}grid-cols-\[68px_54px_minmax\(0,1fr\)_48px\]/u);
assert.match(filterRuleDetail, /break-words[^\"]*\[overflow-wrap:anywhere\]/);
assert.match(filterRulesPage, /order-last[^\"]*basis-full[^\"]*sm:order-none/);
assert.match(filterRulesPage, /min-h-11[^\"]*sm:min-h-9/);

// Request failures differ from valid empty states and critical copy uses the locale provider.
assert.match(eventsPage, /data: incomingSnapshot, loading, error, refresh/u);
assert.match(eventsPage, /error && !visibleData \? \([\s\S]{0,500}t\("事件加载失败"\)[\s\S]{0,500}暂无事件/u);
assert.match(assetsPage, /const \{ t \} = useI18n\(\)/u);
assert.match(filterRulesPage, /const \{ t \} = useI18n\(\)/u);

// Live polling never mutates the visible review snapshot or rewrites query filters on selection.
assert.match(eventsPage, /selectedEventSnapshot/u);
assert.match(eventsPage, /pendingData/u);
assert.match(eventsPage, /检查模式/u);
assert.match(eventsPage, /快照已变化/u);
assert.match(eventsPage, /CoverageBanner/u);
const eventListQuery = eventsPage.slice(eventsPage.indexOf('const query = useMemo<AgentEventQuery>'), eventsPage.indexOf('const queryKey ='));
assert.doesNotMatch(eventListQuery, /eventId:/u);
const eventSelection = eventsPage.slice(eventsPage.indexOf('const selectEvent ='), eventsPage.indexOf('const loadPendingEvents ='));
assert.match(eventSelection, /new URLSearchParams\(searchParams\)/u);
assert.match(eventSelection, /next\.set\("eventId", event\.eventId\)/u);
assert.doesNotMatch(eventSelection, /set(?:TraceId|RunId|EventKind|SourceId|CollectorId|AgentAssetId|SubjectAssetId)\(/u);
const timelineRequest = eventsPage.slice(eventsPage.indexOf('const { data: timeline'), eventsPage.indexOf('const selectEvent ='));
assert.doesNotMatch(timelineRequest, /pollingInterval/u);

// The Agent page is a logical durable directory; actions are product-neutral and evidence is lazy.
assert.match(agentsPage, /logicalAgentRows/u);
assert.match(agentsPage, /securityCenterApi\.agentDirectory/u);
assert.match(agentsPage, /智能体资产目录/u);
assert.match(agentsPage, /行为窗口只影响统计，不决定资产是否存在/u);
assert.match(agentsPage, /ASSET_RANGE_OPTIONS/u);
assert.match(agentsPage, /当前资产/u);
assert.match(agentsPage, /历史资产/u);
assert.match(agentsPage, /Agent 行为追踪/u);
assert.match(agentsPage, /securityCenterApi\.agentActions/u);
assert.match(agentsPage, /securityCenterApi\.agentToolEvidence/u);
assert.match(agentsPage, /ready: semanticAction/u);
assert.match(agentsPage, /InventoryCoverageBanner/u);

console.log('Phase E UI foundation and unified Filter Rules contracts passed');
