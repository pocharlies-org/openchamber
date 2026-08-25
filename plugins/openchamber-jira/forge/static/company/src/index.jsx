import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Text, Strong, Stack, Inline, Lozenge, SectionMessage, Heading, Button, Select,
  Label, DynamicTable, Code, Box, Tabs, TabList, Tab, TabPanel, xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const STATE_APPEARANCE = { busy: 'inprogress', idle: 'default', closed: 'success', unknown: 'moved' };
const STATE_LABEL = { busy: 'trabajando', idle: 'en reposo', closed: 'cerrada', unknown: 'sin estado' };

const money = (value) => `$${(Number(value) || 0).toFixed(4)}`;
const minutes = (ms) => (Number.isFinite(ms) ? `${Math.floor(ms / 60000)} min` : '—');
const when = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('es-ES') : '—');

const card = xcss({
  backgroundColor: 'elevation.surface.raised',
  boxShadow: 'elevation.shadow.raised',
  borderRadius: 'border.radius.200',
});

const Stat = ({ value, label }) => (
  <Box xcss={card} padding="space.200">
    <Stack space="space.050">
      <Heading as="h3">{value}</Heading>
      <Text>{label}</Text>
    </Stack>
  </Box>
);

const table = (head, rows) => (
  <DynamicTable
    head={{ cells: head.map((label, i) => ({ key: `h${i}`, content: label })) }}
    rows={rows.map((cells, r) => ({
      key: `r${r}`,
      cells: cells.map((content, c) => ({ key: `c${c}`, content })),
    }))}
    rowsPerPage={15}
    emptyView="Nada que mostrar todavía."
  />
);

/** Silence is not health: a state that stopped arriving says so, loudly. */
const Freshness = ({ state, ageMs }) => {
  if (state === 'never_reported') {
    return (
      <SectionMessage appearance="warning" title="El despacho no ha reportado nunca">
        <Text>
          Esta vista la alimenta el despachador en cada ciclo. Si no llega nada, el servicio
          está parado o el secreto no coincide: aquí no se ve la empresa, se ve su último parte.
        </Text>
      </SectionMessage>
    );
  }
  if (state === 'stale') {
    return (
      <SectionMessage appearance="warning" title={`Último parte hace ${minutes(ageMs)}`}>
        <Text>Lo de abajo puede estar desfasado. El despachador puede estar caído.</Text>
      </SectionMessage>
    );
  }
  return <Text>Último parte hace {minutes(ageMs)}.</Text>;
};

const Live = ({ live }) => (
  <Stack space="space.100">
    <Heading as="h3">Actividad en curso</Heading>
    {live.length === 0 ? <Text>No hay agentes trabajando ahora.</Text> : null}
    {live.length > 0 ? table(
      ['Ticket', 'Rol', 'Estado', 'En curso', 'Coste', 'Sesión'],
      live.map((row) => [
        <Text><Strong>{row.ticketKey}</Strong></Text>,
        <Text>{row.role ?? '—'}</Text>,
        <Lozenge appearance={STATE_APPEARANCE[row.state] ?? 'default'}>
          {STATE_LABEL[row.state] ?? row.state}
        </Lozenge>,
        <Text>{minutes(row.runningForMs)}</Text>,
        <Text>{money(row.cost ?? row.costUsd)}</Text>,
        <Code text={String(row.sessionId ?? '').slice(0, 24)} />,
      ]),
    ) : null}
  </Stack>
);

const Roles = ({ roles, defaultModel }) => (
  <Stack space="space.100">
        <Heading as="h3">Roles de AIOPS</Heading>
    <Text>Modelo efectivo y límites operativos de cada rol.</Text>
    {table(
      ['Rol', 'Modelo', 'MCPs off', 'bash', 'edit', 'Reglas', 'Estado'],
      roles.map((role) => [
        <Stack space="space.025">
          <Text><Strong>{role.title ?? role.id}</Strong></Text>
          <Text>{role.id}</Text>
        </Stack>,
        <Text>{role.model
          ? `${role.model.providerID}/${role.model.modelID}`
          : (defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID} (predeterminado)` : (role.fileModel ?? '—'))}</Text>,
        <Text>{role.agent?.disabledTools?.length ?? '—'}</Text>,
        <Text>{role.agent?.bashDefault ?? '—'}</Text>,
        <Text>{role.agent?.edit ?? '—'}</Text>,
        <Text>{role.rules ?? 0}</Text>,
        role.unconfigured
          ? <Lozenge appearance="removed">sin configurar en el plugin</Lozenge>
          : (role.agent?.loaded
            ? <Lozenge appearance="success">listo</Lozenge>
            : <Lozenge appearance="removed">{role.agent?.reason ?? 'sin fichero'}</Lozenge>),
      ]),
    )}
  </Stack>
);

const ModelForm = ({ roles, models, defaultModel, onSaved }) => {
  const [roleId, setRoleId] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [result, setResult] = useState(null);
  const [defaultResult, setDefaultResult] = useState(null);

  const roleOptions = roles
    .filter((role) => !role.unconfigured)
    .map((role) => ({ label: `${role.title ?? role.id} (${role.id})`, value: role.id }));
  const modelOptions = (models ?? []).map((model) => ({
    label: `${model.name}${model.status === 'active' ? '' : ` (${model.status})`}`,
    value: `${model.providerID}/${model.modelID}`,
  }));

  const save = () => {
    if (!roleId) { setResult({ ok: false, error: 'elige un rol' }); return; }
    setResult({ pending: true });
    const model = (models ?? []).find(
      (entry) => `${entry.providerID}/${entry.modelID}` === selectedModel,
    );
    if (!model) { setResult({ ok: false, error: 'elige un modelo' }); return; }
    invoke('setRoleModel', { roleId, providerID: model.providerID, modelID: model.modelID })
      .then((res) => { setResult(res); if (res?.ok) onSaved(); })
      .catch((error) => setResult({ ok: false, error: String(error?.message ?? error) }));
  };

  const saveDefault = () => {
    const model = (models ?? []).find(
      (entry) => `${entry.providerID}/${entry.modelID}` === selectedModel,
    );
    if (!model) { setDefaultResult({ ok: false, error: 'elige un modelo' }); return; }
    setDefaultResult({ pending: true });
    invoke('setDefaultModel', { providerID: model.providerID, modelID: model.modelID })
      .then((res) => { setDefaultResult(res); if (res?.ok) onSaved(); })
      .catch((error) => setDefaultResult({ ok: false, error: String(error?.message ?? error) }));
  };

  return (
    <Box xcss={card} padding="space.300">
      <Stack space="space.150">
      <Heading as="h3">Modelos de los agentes</Heading>
      <Text>
        Modelo predeterminado actual: <Strong>{defaultModel
          ? `${defaultModel.providerID}/${defaultModel.modelID}`
          : 'sin configurar'}</Strong>. Cada rol puede sobrescribirlo.
      </Text>
      <Label labelFor="role">Rol</Label>
      <Select id="role" options={roleOptions} onChange={(option) => setRoleId(option?.value ?? null)} />
      <Label labelFor="model">Modelo</Label>
      {models === null || models === undefined
        ? <Text>El despachador todavía no ha podido consultar el catálogo de LiteLLM.</Text>
        : <Select id="model" options={modelOptions}
          placeholder={`Selecciona uno de ${modelOptions.length} modelos`}
          onChange={(option) => setSelectedModel(option?.value ?? null)} />}
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Button onClick={saveDefault} isDisabled={Boolean(defaultResult?.pending)}>
          {defaultResult?.pending ? 'Guardando…' : 'Usar como predeterminado'}
        </Button>
        {defaultResult?.ok ? <Text>Modelo predeterminado guardado.</Text> : null}
        {defaultResult && defaultResult.ok === false ? <Text>Error: {defaultResult.error}</Text> : null}
      </Inline>
      <Heading as="h4">Sobrescribir por rol</Heading>
      <Text>Si asignas uno aquí, ese rol no usará el modelo predeterminado.</Text>
      <Inline space="space.100" alignBlock="center">
        <Button appearance="primary" onClick={save} isDisabled={Boolean(result?.pending)}>
          {result?.pending ? 'Guardando…' : 'Guardar'}
        </Button>
        {result?.ok ? <Text>Guardado. Entra en el siguiente ciclo del despachador.</Text> : null}
        {result && result.ok === false ? <Text>Error: {result.error}</Text> : null}
      </Inline>
      </Stack>
    </Box>
  );
};

/**
 * Skills are company-wide, not per role: OpenCode serves one catalogue and
 * every agent sees all of it. Listing them under each role would invent a
 * separation that does not exist, so they get their own section that says so.
 */
const Skills = ({ skills }) => (
  <Stack space="space.100">
    <Heading as="h3">Skills de la empresa</Heading>
    {skills === null || skills === undefined
      ? <Text>El despacho no reportó las skills en este parte.</Text>
      : (
        <Stack space="space.100">
          <Text>
            <Strong>{skills.length}</Strong> procedimientos disponibles. No están acotados por
            rol: los ve cualquier agente. El manual del despacho dice quién hace qué; una skill
            dice cómo se hace, y se carga sólo cuando el agente la necesita.
          </Text>
          {table(
            ['Skill', 'Para qué'],
            skills.map((skill) => [
              <Text><Strong>{skill.name}</Strong></Text>,
              <Text>{skill.description ?? '—'}</Text>,
            ]),
          )}
        </Stack>
      )}
  </Stack>
);

const Usage = ({ usage }) => (
  <Stack space="space.100">
    <Heading as="h3">Uso</Heading>
    <Text>Coste acumulado de las sesiones con ticket: <Strong>{money(usage?.totalCost)}</Strong></Text>
    {table(
      ['Rol', 'Sesiones', 'Coste', 'Tokens'],
      (usage?.byRole ?? []).map((row) => [
        <Text>{row.role}</Text>,
        <Text>{row.sessions}</Text>,
        <Text>{money(row.cost)}</Text>,
        <Text>{row.tokens ?? 0}</Text>,
      ]),
    )}
  </Stack>
);

const Audit = ({ history }) => (
  <Stack space="space.100">
    <Heading as="h3">Auditoría — qué agente trabajó qué ticket</Heading>
    {table(
      ['Ticket', 'Rol', 'Terminó', 'Coste', 'Sesión'],
      history.map((row) => [
        <Text><Strong>{row.ticketKey}</Strong></Text>,
        <Text>{row.role ?? '—'}</Text>,
        <Text>{when(row.endedAt)}</Text>,
        <Text>{money(row.cost ?? row.costUsd)}</Text>,
        <Code text={String(row.sessionId ?? '').slice(0, 24)} />,
      ]),
    )}
  </Stack>
);

const CompanyView = () => {
  const [view, setView] = useState({ loading: true });

  const load = () => invoke('companyGet')
    .then((data) => setView({ loading: false, data }))
    .catch((error) => setView({ loading: false, error: String(error?.message ?? error) }));

  useEffect(() => { load(); }, []);

  if (view.loading) return <Text>Cargando la empresa…</Text>;
  if (view.error) {
    return (
      <SectionMessage appearance="error" title="No se pudo leer el estado">
        <Text>{view.error}</Text>
      </SectionMessage>
    );
  }

  const { state, ageMs, company } = view.data ?? {};
  const roles = company?.roles ?? [];

  return (
    <Stack space="space.300">
      <Freshness state={state} ageMs={ageMs} />

      {company ? (
        <Stack space="space.300">
          <Inline space="space.150" spread="space-between" shouldWrap>
            <Stat value={company.counts?.rolesConfigured ?? 0} label="Roles configurados" />
            <Stat value={company.counts?.agentsLoaded ?? 0} label="Agentes disponibles" />
            <Stat value={company.counts?.live ?? 0} label="Trabajando ahora" />
            <Stat value={company.models?.length ?? 0} label="Modelos disponibles" />
          </Inline>
          <Live live={company.live ?? []} />
          <Tabs id="company-office-tabs" shouldUnmountTabPanelOnChange>
            <TabList>
              <Tab>Equipo</Tab>
              <Tab>Modelos</Tab>
              <Tab>Skills</Tab>
              <Tab>Uso y auditoría</Tab>
            </TabList>
            <TabPanel>
               <Box paddingBlock="space.300"><Roles roles={roles} defaultModel={company.defaultModel} /></Box>
            </TabPanel>
            <TabPanel>
              <Box paddingBlock="space.300">
                 <ModelForm roles={roles} models={company.models} defaultModel={company.defaultModel} onSaved={load} />
              </Box>
            </TabPanel>
            <TabPanel>
              <Box paddingBlock="space.300"><Skills skills={company.skills} /></Box>
            </TabPanel>
            <TabPanel>
              <Box paddingBlock="space.300">
                <Stack space="space.300">
                  <Usage usage={company.usage} />
                  <Audit history={company.history ?? []} />
                </Stack>
              </Box>
            </TabPanel>
          </Tabs>
        </Stack>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <CompanyView />
  </React.StrictMode>,
);
