/**
 * security.js — 11 tool handlers.
 *
 *   - get_code_quality_finding
 *   - get_code_scanning_alert
 *   - list_code_scanning_alerts
 *   - get_secret_scanning_alert
 *   - list_secret_scanning_alerts
 *   - get_dependabot_alert
 *   - list_dependabot_alerts
 *   - get_global_security_advisory
 *   - list_global_security_advisories
 *   - list_org_repository_security_advisories
 *   - list_repository_security_advisories
 *
 * Ported from pkg/github/code_quality.go, pkg/github/code_scanning.go,
 * pkg/github/secret_scanning.go, pkg/github/dependabot.go and
 * pkg/github/security_advisories.go; the response projections mirror
 * pkg/github/security_outputs.go.
 *
 * Every output field upstream is a pointer with `omitempty`, so a key
 * disappears when the API omits it while `false` and `0` survive. The filters
 * the upstream handlers build with `if args.X != ""` are only sent when
 * present: the advertised schema defaults (`state: "open"`, `type: "reviewed"`)
 * are documentation, not arguments — the upstream compatibility tests assert
 * that an omitted filter is not sent.
 */

import { asArray, clampPerPage, fail, optionalString, seg, toolError, toPositiveInt } from '../util.js';

/** Upstream guards reject a missing string argument with this exact wording. */
function requireParameter(args, name) {
  const value = optionalString(args, name);
  if (value === undefined) fail(`missing required parameter: ${name}`);
  return value;
}

/** `alertNumber` and `findingNumber` are rejected the same way when absent or zero. */
function requireNumber(args, name) {
  const value = toPositiveInt(args?.[name], 0);
  if (value === 0) fail(`missing required parameter: ${name}`);
  return value;
}

/** `securityPagination`: the page-based security lists always send page/per_page. */
function pageQuery(args) {
  return {
    page: toPositiveInt(args?.page, 1),
    per_page: clampPerPage(args?.perPage ?? args?.per_page, 30),
  };
}

/** Go `omitempty`: absent, null and empty collections all drop the key. */
function omitEmpty(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `dependabotErrMsg` — a 403/404 on the Dependabot endpoints usually means the
 * token cannot see the alerts, which the bare GitHub message does not say.
 */
function dependabotHint(base, owner, repo, status) {
  if (status !== 403 && status !== 404) return base;
  return (
    `${base}. Your token may not have access to Dependabot alerts on ${owner}/${repo}. ` +
    "To access Dependabot alerts, the token needs the 'security_events' scope or, for fine-grained tokens, " +
    'Dependabot alerts read permission for this specific repository.'
  );
}

/** Read one cursor out of a `Link` target (go-github parses the same query). */
function cursorParam(target, name) {
  if (typeof target !== 'string' || target.length === 0) return '';
  try {
    return new URL(target).searchParams.get(name) ?? '';
  } catch {
    return '';
  }
}

/** `buildPageInfo(resp)` — go-github fills `After`/`Before` from the `Link` header. */
function pageInfoFromResponse(response) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('link') : null;
  const links = {};
  for (const segment of String(header ?? '').split(',')) {
    const match = /<([^>]*)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(segment.trim());
    if (match !== null) links[match[2].trim().toLowerCase()] = match[1];
  }
  const after = cursorParam(links.next, 'after');
  const before = cursorParam(links.prev ?? links.previous, 'before');
  return {
    hasNextPage: after !== '',
    hasPreviousPage: before !== '',
    ...(after !== '' ? { nextCursor: after } : {}),
    ...(before !== '' ? { prevCursor: before } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Response projections (pkg/github/security_outputs.go)                       */
/* -------------------------------------------------------------------------- */

/** `CodeQualityFindingOutput` — the raw finding is decoded into this shape. */
function codeQualityFindingOutput(finding) {
  if (finding == null) return null;
  return omitEmpty({
    number: finding.number,
    state: finding.state,
    rule: finding.rule == null ? null : omitEmpty({
      id: finding.rule.id,
      title: finding.rule.title,
      description: finding.rule.description,
      help: finding.rule.help,
      severity: finding.rule.severity,
      category: finding.rule.category,
    }),
    location: finding.location == null ? null : omitEmpty({
      path: finding.location.path,
      start_line: finding.location.start_line,
      start_column: finding.location.start_column,
      end_line: finding.location.end_line,
      end_column: finding.location.end_column,
    }),
    // `text` and `markdown` are plain strings upstream (no `omitempty`), so both
    // keys are present whenever the finding carries a message.
    message: finding.message == null ? null : {
      text: typeof finding.message.text === 'string' ? finding.message.text : '',
      markdown: typeof finding.message.markdown === 'string' ? finding.message.markdown : '',
    },
    created_at: finding.created_at,
  });
}

/** `codeScanningAlertOutput`. */
function codeScanningAlertOutput(alert) {
  if (alert == null) return null;
  const instance = alert.most_recent_instance;
  return omitEmpty({
    number: alert.number,
    state: alert.state,
    html_url: alert.html_url,
    rule: alert.rule == null ? null : omitEmpty({
      id: alert.rule.id,
      severity: alert.rule.severity,
      description: alert.rule.description,
      name: alert.rule.name,
      security_severity_level: alert.rule.security_severity_level,
      help: alert.rule.help,
    }),
    most_recent_instance: instance == null ? null : omitEmpty({
      ref: instance.ref,
      state: instance.state,
      commit_sha: instance.commit_sha,
      // Upstream collapses the instance message to its text.
      message: instance.message == null ? null : instance.message.text,
      location: instance.location == null ? null : omitEmpty({
        path: instance.location.path,
        start_line: instance.location.start_line,
        end_line: instance.location.end_line,
        start_column: instance.location.start_column,
        end_column: instance.location.end_column,
      }),
      html_url: instance.html_url,
    }),
    dismissed_reason: alert.dismissed_reason,
    dismissed_comment: alert.dismissed_comment,
  });
}

/** `secretScanningAlertOutput` — `start_line` comes from the API's `start_line`. */
function secretScanningAlertOutput(alert) {
  if (alert == null) return null;
  const location = alert.first_location_detected;
  return omitEmpty({
    number: alert.number,
    state: alert.state,
    resolution: alert.resolution,
    secret_type: alert.secret_type,
    secret_type_display_name: alert.secret_type_display_name,
    secret: alert.secret,
    html_url: alert.html_url,
    first_location_detected: location == null ? null : omitEmpty({
      path: location.path,
      start_line: location.start_line,
      end_line: location.end_line,
      commit_sha: location.commit_sha,
      start_column: location.start_column,
      end_column: location.end_column,
    }),
    validity: alert.validity,
    resolution_comment: alert.resolution_comment,
    push_protection_bypassed: alert.push_protection_bypassed,
    is_base64_encoded: alert.is_base64_encoded,
    has_more_locations: alert.has_more_locations,
  });
}

/** `securityPackageOutput`. */
function securityPackageOutput(pkg) {
  if (pkg == null) return null;
  return omitEmpty({ ecosystem: pkg.ecosystem, name: pkg.name });
}

/** `securityVulnerabilityOutput` — `first_patched_version` flattens to its identifier. */
function securityVulnerabilityOutput(vulnerability) {
  if (vulnerability == null) return null;
  return omitEmpty({
    package: securityPackageOutput(vulnerability.package),
    severity: vulnerability.severity,
    vulnerable_version_range: vulnerability.vulnerable_version_range,
    first_patched_version: vulnerability.first_patched_version?.identifier,
  });
}

/** `securityAdvisoryVulnerabilityOutput`. */
function securityAdvisoryVulnerabilityOutput(vulnerability) {
  if (vulnerability == null) return null;
  return omitEmpty({
    ...securityVulnerabilityOutput(vulnerability),
    patched_versions: vulnerability.patched_versions,
    vulnerable_functions: vulnerability.vulnerable_functions,
  });
}

/** `globalAdvisoryVulnerabilityOutput` — global entries carry no severity. */
function globalAdvisoryVulnerabilityOutput(vulnerability) {
  if (vulnerability == null) return null;
  return omitEmpty({
    package: securityPackageOutput(vulnerability.package),
    first_patched_version: vulnerability.first_patched_version,
    vulnerable_version_range: vulnerability.vulnerable_version_range,
    vulnerable_functions: vulnerability.vulnerable_functions,
  });
}

/** `dependabotAlertOutput`. */
function dependabotAlertOutput(alert) {
  if (alert == null) return null;
  const dependency = alert.dependency;
  const advisory = alert.security_advisory;
  return omitEmpty({
    number: alert.number,
    state: alert.state,
    dependency: dependency == null ? null : omitEmpty({
      package: securityPackageOutput(dependency.package),
      manifest_path: dependency.manifest_path,
      scope: dependency.scope,
    }),
    security_advisory: advisory == null ? null : omitEmpty({
      ghsa_id: advisory.ghsa_id,
      cve_id: advisory.cve_id,
      summary: advisory.summary,
      description: advisory.description,
      severity: advisory.severity,
      classification: advisory.classification,
    }),
    security_vulnerability: securityVulnerabilityOutput(alert.security_vulnerability),
    html_url: alert.html_url,
    dismissed_reason: alert.dismissed_reason,
    dismissed_comment: alert.dismissed_comment,
  });
}

/** `securityAdvisoryOutput`. */
function securityAdvisoryOutput(advisory) {
  if (advisory == null) return null;
  const output = omitEmpty({
    ghsa_id: advisory.ghsa_id,
    cve_id: advisory.cve_id,
    summary: advisory.summary,
    description: advisory.description,
    severity: advisory.severity,
    state: advisory.state,
    html_url: advisory.html_url,
    cwe_ids: advisory.cwe_ids,
    published_at: advisory.published_at,
    updated_at: advisory.updated_at,
    withdrawn_at: advisory.withdrawn_at,
  });
  // Upstream replaces the list only when the API sent one (an empty array stays).
  if (Array.isArray(advisory.vulnerabilities)) {
    output.vulnerabilities = advisory.vulnerabilities.map(securityAdvisoryVulnerabilityOutput);
  }
  return output;
}

/** `globalSecurityAdvisoryOutput` — adds `type`/`source_code_location` and the CWE fallback. */
function globalSecurityAdvisoryOutput(advisory) {
  if (advisory == null) return null;
  const base = securityAdvisoryOutput(advisory);
  if (base.cwe_ids === undefined && Array.isArray(advisory.cwes)) {
    const ids = advisory.cwes.filter((cwe) => cwe != null && cwe.cwe_id != null).map((cwe) => cwe.cwe_id);
    if (ids.length > 0) base.cwe_ids = ids;
  }
  const output = omitEmpty({
    ...base,
    type: advisory.type,
    source_code_location: advisory.source_code_location,
  });
  if (Array.isArray(advisory.vulnerabilities)) {
    output.vulnerabilities = advisory.vulnerabilities.map(globalAdvisoryVulnerabilityOutput);
  }
  return output;
}

/* -------------------------------------------------------------------------- */
/* Tool handlers                                                               */
/* -------------------------------------------------------------------------- */

/** `get_code_quality_finding` — GET /repos/{owner}/{repo}/code-quality/findings/{n}. */
async function getCodeQualityFinding(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const findingNumber = requireNumber(args, 'findingNumber');
  const finding = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/code-quality/findings/${findingNumber}`,
    { signal: ctx.signal },
  );
  return codeQualityFindingOutput(finding);
}

/** `get_code_scanning_alert` — GET /repos/{owner}/{repo}/code-scanning/alerts/{n}. */
async function getCodeScanningAlert(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const alertNumber = requireNumber(args, 'alertNumber');
  const alert = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/code-scanning/alerts/${alertNumber}`,
    { signal: ctx.signal },
  );
  return codeScanningAlertOutput(alert);
}

/** `list_code_scanning_alerts` — GET /repos/{owner}/{repo}/code-scanning/alerts. */
async function listCodeScanningAlerts(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const query = {
    ...pageQuery(args),
    ref: optionalString(args, 'ref'),
    state: optionalString(args, 'state'),
    severity: optionalString(args, 'severity'),
    tool_name: optionalString(args, 'tool_name'),
  };
  const alerts = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/code-scanning/alerts`,
    { query, signal: ctx.signal },
  );
  return asArray(alerts).map(codeScanningAlertOutput);
}

/** `get_secret_scanning_alert` — GET /repos/{owner}/{repo}/secret-scanning/alerts/{n}. */
async function getSecretScanningAlert(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const alertNumber = requireNumber(args, 'alertNumber');
  const alert = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/secret-scanning/alerts/${alertNumber}`,
    { signal: ctx.signal },
  );
  return secretScanningAlertOutput(alert);
}

/** `list_secret_scanning_alerts` — GET /repos/{owner}/{repo}/secret-scanning/alerts. */
async function listSecretScanningAlerts(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const query = {
    ...pageQuery(args),
    state: optionalString(args, 'state'),
    secret_type: optionalString(args, 'secret_type'),
    resolution: optionalString(args, 'resolution'),
  };
  const alerts = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/secret-scanning/alerts`,
    { query, signal: ctx.signal },
  );
  return asArray(alerts).map(secretScanningAlertOutput);
}

/** `get_dependabot_alert` — GET /repos/{owner}/{repo}/dependabot/alerts/{n}. */
async function getDependabotAlert(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const alertNumber = requireNumber(args, 'alertNumber');
  let alert;
  try {
    alert = await ctx.client.get(
      `/repos/${seg(owner)}/${seg(repo)}/dependabot/alerts/${alertNumber}`,
      { signal: ctx.signal },
    );
  } catch (error) {
    const base = `failed to get alert with number '${alertNumber}'`;
    if (error?.status === 403 || error?.status === 404) throw toolError(dependabotHint(base, owner, repo, error.status));
    throw error;
  }
  return dependabotAlertOutput(alert);
}

/** `list_dependabot_alerts` — GET /repos/{owner}/{repo}/dependabot/alerts (cursor paged). */
async function listDependabotAlerts(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const query = {
    state: optionalString(args, 'state'),
    severity: optionalString(args, 'severity'),
    per_page: clampPerPage(args?.perPage ?? args?.per_page, 30),
    after: optionalString(args, 'after'),
  };
  let response;
  try {
    // The `Link` header carries the cursors, so this one goes through `request`.
    response = await ctx.client.request('GET', `/repos/${seg(owner)}/${seg(repo)}/dependabot/alerts`, {
      query,
      signal: ctx.signal,
    });
  } catch (error) {
    const base = `failed to list alerts for repository '${owner}/${repo}'`;
    if (error?.status === 403 || error?.status === 404) throw toolError(dependabotHint(base, owner, repo, error.status));
    throw error;
  }
  return {
    alerts: asArray(response.json).map(dependabotAlertOutput),
    pageInfo: pageInfoFromResponse(response.response),
  };
}

/** `get_global_security_advisory` — GET /advisories/{ghsa_id}. */
async function getGlobalSecurityAdvisory(args, ctx) {
  const ghsaId = optionalString(args, 'ghsaId');
  if (ghsaId === undefined) fail('invalid ghsaId: missing required parameter: ghsaId');
  const advisory = await ctx.client.get(`/advisories/${seg(ghsaId)}`, { signal: ctx.signal });
  return globalSecurityAdvisoryOutput(advisory);
}

/** `list_global_security_advisories` — GET /advisories. */
async function listGlobalSecurityAdvisories(args, ctx) {
  const cwes = asArray(args?.cwes).filter((value) => typeof value === 'string' && value.length > 0);
  const query = {
    ghsa_id: optionalString(args, 'ghsaId'),
    type: optionalString(args, 'type'),
    cve_id: optionalString(args, 'cveId'),
    ecosystem: optionalString(args, 'ecosystem'),
    severity: optionalString(args, 'severity'),
    cwes: cwes.length > 0 ? cwes : undefined,
    is_withdrawn: args?.isWithdrawn === true ? true : undefined,
    affects: optionalString(args, 'affects'),
    published: optionalString(args, 'published'),
    updated: optionalString(args, 'updated'),
    modified: optionalString(args, 'modified'),
  };
  const advisories = await ctx.client.get('/advisories', { query, signal: ctx.signal });
  return asArray(advisories).map(globalSecurityAdvisoryOutput);
}

/** `list_org_repository_security_advisories` — GET /orgs/{org}/security-advisories. */
async function listOrgRepositorySecurityAdvisories(args, ctx) {
  const org = requireParameter(args, 'org');
  const query = {
    direction: optionalString(args, 'direction'),
    sort: optionalString(args, 'sort'),
    state: optionalString(args, 'state'),
  };
  const advisories = await ctx.client.get(`/orgs/${seg(org)}/security-advisories`, { query, signal: ctx.signal });
  return asArray(advisories).map(securityAdvisoryOutput);
}

/** `list_repository_security_advisories` — GET /repos/{owner}/{repo}/security-advisories. */
async function listRepositorySecurityAdvisories(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const query = {
    direction: optionalString(args, 'direction'),
    sort: optionalString(args, 'sort'),
    state: optionalString(args, 'state'),
  };
  const advisories = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/security-advisories`,
    { query, signal: ctx.signal },
  );
  return asArray(advisories).map(securityAdvisoryOutput);
}

export default {
  get_code_quality_finding: getCodeQualityFinding,
  get_code_scanning_alert: getCodeScanningAlert,
  list_code_scanning_alerts: listCodeScanningAlerts,
  get_secret_scanning_alert: getSecretScanningAlert,
  list_secret_scanning_alerts: listSecretScanningAlerts,
  get_dependabot_alert: getDependabotAlert,
  list_dependabot_alerts: listDependabotAlerts,
  get_global_security_advisory: getGlobalSecurityAdvisory,
  list_global_security_advisories: listGlobalSecurityAdvisories,
  list_org_repository_security_advisories: listOrgRepositorySecurityAdvisories,
  list_repository_security_advisories: listRepositorySecurityAdvisories,
};
