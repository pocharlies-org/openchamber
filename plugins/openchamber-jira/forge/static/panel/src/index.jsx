import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Strong, Lozenge, Stack, Inline, SectionMessage } from '@forge/react';
import { invoke } from '@forge/bridge';

const APPEARANCE = { busy: 'inprogress', idle: 'success', stale: 'moved', missing: 'default', unknown: 'default' };

const LABEL = {
  busy: 'Trabajando',
  idle: 'En reposo',
  stale: 'Sin señal',
  missing: 'Sin sesión',
  unknown: 'Sin datos',
};

const runningFor = (ms) => {
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.floor(ms / 60000);
  return minutes < 1 ? 'menos de un minuto' : `${minutes} min`;
};

const Panel = () => {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    invoke('panel')
      .then((data) => { if (!cancelled) setState({ loading: false, data }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error: String(error?.message ?? error) }); });
    return () => { cancelled = true; };
  }, []);

  if (state.loading) return <Text>Cargando el estado del despacho…</Text>;

  // A failed read is never presented as an empty result: an operator must be able
  // to tell "no agent is working" from "we could not find out".
  if (state.error) {
    return (
      <SectionMessage appearance="error" title="No se pudo leer el estado">
        <Text>{state.error}</Text>
      </SectionMessage>
    );
  }

  const heartbeat = state.data ?? { state: 'unknown' };
  const status = heartbeat.state ?? 'unknown';

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={APPEARANCE[status] ?? 'default'}>{LABEL[status] ?? status}</Lozenge>
        {heartbeat.agent ? <Text><Strong>{heartbeat.agent}</Strong></Text> : null}
      </Inline>

      {heartbeat.sessionId ? <Text>Sesión: {heartbeat.sessionId}</Text> : null}
      {runningFor(heartbeat.runningForMs) ? <Text>Lleva {runningFor(heartbeat.runningForMs)}</Text> : null}

      {status === 'stale' ? (
        <SectionMessage appearance="warning" title="El latido dejó de llegar">
          <Text>El último estado conocido tiene más de 24 h. El despachador puede estar parado.</Text>
        </SectionMessage>
      ) : null}

      {status === 'missing' ? (
        <Text>Este ticket todavía no tiene una sesión asignada.</Text>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
