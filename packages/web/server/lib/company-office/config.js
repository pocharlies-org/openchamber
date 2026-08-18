const CONFIG_SCHEMA_VERSION = 1;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const requiredString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid Company Office config: ${field}`);
  }
  return value.trim();
};

const parseIssueTypes = (value) => {
  if (value === undefined) return ['Story'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid Company Office config: workTracker.jira.initiativeIssueTypes');
  }
  const types = value.map((entry) => requiredString(entry, 'workTracker.jira.initiativeIssueTypes'));
  if (new Set(types.map((type) => type.toLowerCase())).size !== types.length) {
    throw new Error('Invalid Company Office config: duplicate workTracker.jira.initiativeIssueTypes');
  }
  return types;
};

const parseJira = (value) => {
  if (!isRecord(value)) throw new Error('Invalid Company Office config: workTracker.jira');
  const baseUrl = new URL(requiredString(value.baseUrl, 'workTracker.jira.baseUrl'));
  if (baseUrl.protocol !== 'https:') {
    throw new Error('Invalid Company Office config: workTracker.jira.baseUrl must use HTTPS');
  }
  const projectKey = requiredString(value.projectKey, 'workTracker.jira.projectKey');
  if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey)) {
    throw new Error('Invalid Company Office config: workTracker.jira.projectKey');
  }
  return {
    baseUrl: baseUrl.origin,
    projectKey,
    email: requiredString(value.email, 'workTracker.jira.email'),
    tokenFile: requiredString(value.tokenFile, 'workTracker.jira.tokenFile'),
    initiativeIssueTypes: parseIssueTypes(value.initiativeIssueTypes),
  };
};

export const parseCompanyOfficeConfig = (value) => {
  if (!isRecord(value) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error('Invalid Company Office config');
  }

  const nested = isRecord(value.company) || isRecord(value.roster) || isRecord(value.intake) || isRecord(value.workTracker);
  const company = nested ? value.company : { id: value.companyId, displayName: value.displayName };
  const roster = nested ? value.roster : { manifestPath: value.manifestPath, registryPath: value.registryPath };
  const intake = nested ? value.intake : { employeeId: value.ctoEmployeeId, sessionTitle: value.intakeSessionTitle };
  const workTracker = nested ? value.workTracker : { provider: 'jira', jira: value.jira };

  if (!isRecord(company) || !isRecord(roster) || !isRecord(intake) || !isRecord(workTracker)) {
    throw new Error('Invalid Company Office config');
  }
  if (workTracker.provider !== 'jira') {
    throw new Error(`Unsupported Company Office work tracker: ${String(workTracker.provider)}`);
  }

  return {
    company: {
      id: requiredString(company.id, 'company.id'),
      displayName: requiredString(company.displayName, 'company.displayName'),
    },
    roster: {
      manifestPath: requiredString(roster.manifestPath, 'roster.manifestPath'),
      registryPath: requiredString(roster.registryPath, 'roster.registryPath'),
    },
    intake: {
      employeeId: requiredString(intake.employeeId, 'intake.employeeId'),
      sessionTitle: requiredString(intake.sessionTitle, 'intake.sessionTitle'),
    },
    workTracker: {
      provider: 'jira',
      jira: parseJira(workTracker.jira),
    },
  };
};
