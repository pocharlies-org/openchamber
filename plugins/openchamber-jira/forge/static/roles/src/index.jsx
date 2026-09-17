import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Text, Strong, Stack, Inline, Lozenge, SectionMessage, Heading, Button, Select,
  Label, DynamicTable, Box, xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const panel = xcss({
  backgroundColor: 'elevation.surface.raised',
  boxShadow: 'elevation.shadow.raised',
  borderRadius: 'border.radius.200',
});
const routeField = xcss({
  width: '240px',
  minWidth: '240px',
});
const ACTIONS = [
  ['plan', 'Planificar'], ['design', 'Diseñar'], ['implement', 'Implementar'], ['review', 'Revisar'],
  ['validate', 'Validar'], ['deploy', 'Desplegar'], ['approve', 'Aprobar'], ['observe', 'Observar'],
];
const PRESET = [
  { issueType: 'Epic', status: 'Backlog', role: 'po', action: 'plan' },
  { issueType: 'Epic', status: 'In Progress', role: 'cto', action: 'design' },
  { issueType: '*', status: 'In Progress', role: 'dev', action: 'implement' },
  { issueType: '*', status: 'Review', role: 'qa', action: 'review' },
  { issueType: '*', status: 'QA', role: 'qa', action: 'validate' },
  { issueType: '*', status: 'Sign-off', role: 'po', action: 'approve' },
];

const table = (head, rows, emptyView) => (
  <DynamicTable
    head={{ cells: head.map((label, index) => ({ key: `h${index}`, content: label })) }}
    rows={rows.map((cells, row) => ({ key: `r${row}`, cells: cells.map((content, column) => ({ key: `c${column}`, content })) }))}
    emptyView={emptyView}
  />
);

const AiopsConfiguration = () => {
  const [view, setView] = useState({ loading: true });
  const [projects, setProjects] = useState([]);
  const [mode, setMode] = useState('preset');
  const [routes, setRoutes] = useState(PRESET);
  const [draft, setDraft] = useState({ issueType: null, status: null, role: null, action: null });
  const [result, setResult] = useState(null);

  const load = () => invoke('configurationGet')
    .then((data) => {
      setView({ loading: false, data });
      setProjects(data?.aiops?.enabledProjectKeys ?? []);
      setMode(data?.aiops?.mode ?? 'preset');
      setRoutes(data?.aiops?.routes ?? PRESET);
    })
    .catch((error) => setView({ loading: false, error: String(error?.message ?? error) }));

  useEffect(() => { load(); }, []);
  if (view.loading) return <Text>Cargando configuración de AIOPS…</Text>;
  if (view.error) return <SectionMessage appearance="error" title="No se pudo cargar AIOPS"><Text>{view.error}</Text></SectionMessage>;

  const data = view.data ?? {};
  const roles = data.roles ?? [];
  const selected = new Set(projects);
  const workflows = (data.workflows ?? []).filter((workflow) => selected.has(workflow.projectKey));
  const unique = (values) => [...new Set(values)].sort();
  const issueTypes = unique(workflows.flatMap((workflow) => workflow.issueTypes.map((entry) => entry.name)));
  const statuses = unique(workflows.flatMap((workflow) => workflow.statuses.map((entry) => entry.name)));
  const issueTypeOptions = [{ label: 'Cualquier tipo', value: '*' }, ...issueTypes.map((value) => ({ label: value, value }))];
  const statusOptions = [{ label: 'Cualquier estado', value: '*' }, ...statuses.map((value) => ({ label: value, value }))];
  const roleOptions = roles.map((role) => ({ label: `${role.title ?? role.id} (${role.id})`, value: role.id }));
  const actionOptions = ACTIONS.map(([value, label]) => ({ value, label }));
  const projectOptions = (data.projects ?? []).map((project) => ({ label: `${project.name} (${project.key})`, value: project.key }));
  const invalidRoutes = routes.filter((route) =>
    (route.issueType !== '*' && !issueTypes.includes(route.issueType)) || (route.status !== '*' && !statuses.includes(route.status)));
  const covered = routes.filter((route) => !invalidRoutes.includes(route)).length;

  const changeProjects = (options) => {
    setProjects((options ?? []).map((option) => option.value));
    setResult({ reload: true });
  };
  const reloadInventory = () => {
    setResult({ pendingInventory: true });
    invoke('workflowInventoryGet', { projectKeys: projects })
      .then((inventory) => {
        if (!inventory?.ok) {
          setResult({ ok: false, error: inventory?.error ?? 'workflow_inventory_failed' });
          return;
        }
        setView((current) => ({
          ...current,
          data: { ...current.data, workflows: inventory.workflows ?? [] },
        }));
        setResult(null);
      })
      .catch((error) => setResult({ ok: false, error: String(error?.message ?? error) }));
  };
  const changeMode = (option) => {
    const next = option?.value ?? 'preset';
    setMode(next);
    if (next === 'preset') setRoutes(PRESET);
  };
  const addRoute = () => {
    if (Object.values(draft).some((value) => !value)) return;
    setRoutes((current) => [...current.filter((route) => !(route.issueType === draft.issueType && route.status === draft.status)), draft]);
    setDraft({ issueType: null, status: null, role: null, action: null });
  };
  const save = () => {
    setResult({ pending: true });
    invoke('configurationSet', { schemaVersion: 2, mode, enabledProjectKeys: projects, routes })
      .then(setResult)
      .catch((error) => setResult({ ok: false, error: String(error?.message ?? error) }));
  };

  return (
    <Stack space="space.300">
      <Stack space="space.050">
        <Heading as="h2">AIOPS</Heading>
        <Text>Asigna cada fase de Jira al agente responsable y valida la cobertura antes de activar el despacho.</Text>
      </Stack>

      <Inline space="space.300" alignBlock="start" shouldWrap>
        <Box xcss={panel} padding="space.300">
          <Stack space="space.150">
            <Heading as="h3">1. Spaces y esquema</Heading>
            <Label labelFor="projects">Spaces de Jira</Label>
            <Select id="projects" isMulti options={projectOptions}
              value={projectOptions.filter((option) => projects.includes(option.value))}
              onChange={changeProjects} placeholder="Selecciona los spaces" />
            {result?.reload || result?.pendingInventory ? (
              <Button onClick={reloadInventory} isDisabled={Boolean(result?.pendingInventory) || projects.length === 0}>
                {result?.pendingInventory ? 'Cargando workflow…' : 'Cargar workflow seleccionado'}
              </Button>
            ) : null}
            <Label labelFor="mode">Esquema</Label>
            <Select id="mode" options={[{ label: 'AIOPS recomendado', value: 'preset' }, { label: 'Personalizado', value: 'custom' }]}
              value={{ label: mode === 'preset' ? 'AIOPS recomendado' : 'Personalizado', value: mode }} onChange={changeMode} />
          </Stack>
        </Box>

        <Box xcss={panel} padding="space.300">
          <Stack space="space.150">
            <Heading as="h3">2. Diagnóstico</Heading>
            <Text><Strong>{roles.length}</Strong> roles · <Strong>{issueTypes.length}</Strong> tipos · <Strong>{statuses.length}</Strong> estados</Text>
            <Text><Strong>{covered}</Strong> reglas válidas · <Strong>{invalidRoutes.length}</Strong> incompatibles</Text>
            {projects.length === 0 ? <Lozenge appearance="moved">desactivado: sin spaces</Lozenge> : null}
            {projects.length > 0 && invalidRoutes.length === 0 ? <Lozenge appearance="success">configuración coherente</Lozenge> : null}
            {invalidRoutes.length > 0 ? <Lozenge appearance="removed">requiere corrección</Lozenge> : null}
          </Stack>
        </Box>
      </Inline>

      {invalidRoutes.length > 0 ? (
        <SectionMessage appearance="warning" title="El workflow no contiene todas las fases del esquema">
          <Text>Corrige o elimina: {invalidRoutes.map((route) => `${route.issueType} + ${route.status}`).join(', ')}.</Text>
        </SectionMessage>
      ) : null}

      <Box xcss={panel} padding="space.300">
        <Stack space="space.150">
          <Heading as="h3">3. Enrutado por fase</Heading>
          <Text>Prioridad: tipo + estado exactos, cualquier tipo + estado, y tipo + cualquier estado.</Text>
          {table(
            ['Tipo', 'Estado', 'Agente', 'Acción', ''],
            routes.map((route) => [
              <Text><Strong>{route.issueType === '*' ? 'Cualquiera' : route.issueType}</Strong></Text>,
              <Text>{route.status === '*' ? 'Cualquiera' : route.status}</Text>,
              <Text>{roles.find((role) => role.id === route.role)?.title ?? route.role}</Text>,
              <Lozenge appearance={invalidRoutes.includes(route) ? 'removed' : 'inprogress'}>{ACTIONS.find(([value]) => value === route.action)?.[1] ?? route.action}</Lozenge>,
              <Button appearance="subtle" onClick={() => { setMode('custom'); setRoutes((current) => current.filter((item) => item !== route)); }}>Quitar</Button>,
            ]),
            'No hay reglas. AIOPS no despachará trabajo.',
          )}
          <Inline space="space.200" rowSpace="space.200" alignBlock="end" shouldWrap grow="fill">
            <Box xcss={routeField}><Stack space="space.050"><Label labelFor="type">Tipo</Label><Select id="type" options={issueTypeOptions} value={issueTypeOptions.find((o) => o.value === draft.issueType) ?? null} onChange={(o) => setDraft({ ...draft, issueType: o?.value ?? null })} /></Stack></Box>
            <Box xcss={routeField}><Stack space="space.050"><Label labelFor="status">Estado</Label><Select id="status" options={statusOptions} value={statusOptions.find((o) => o.value === draft.status) ?? null} onChange={(o) => setDraft({ ...draft, status: o?.value ?? null })} /></Stack></Box>
            <Box xcss={routeField}><Stack space="space.050"><Label labelFor="role">Agente</Label><Select id="role" options={roleOptions} value={roleOptions.find((o) => o.value === draft.role) ?? null} onChange={(o) => setDraft({ ...draft, role: o?.value ?? null })} /></Stack></Box>
            <Box xcss={routeField}><Stack space="space.050"><Label labelFor="action">Acción</Label><Select id="action" options={actionOptions} value={actionOptions.find((o) => o.value === draft.action) ?? null} onChange={(o) => setDraft({ ...draft, action: o?.value ?? null })} /></Stack></Box>
            <Button onClick={addRoute} isDisabled={Object.values(draft).some((value) => !value)}>Añadir</Button>
          </Inline>
        </Stack>
      </Box>

      <Inline space="space.100" alignBlock="center">
        <Button appearance="primary" onClick={save} isDisabled={Boolean(result?.pending) || projects.length === 0 || routes.length === 0 || invalidRoutes.length > 0}>
          {result?.pending ? 'Validando…' : 'Validar y guardar'}
        </Button>
        {result?.ok ? <Text>Configuración validada y guardada.</Text> : null}
        {result && result.ok === false ? <Text>Error: {result.error}</Text> : null}
      </Inline>
    </Stack>
  );
};

ForgeReconciler.render(<React.StrictMode><AiopsConfiguration /></React.StrictMode>);
