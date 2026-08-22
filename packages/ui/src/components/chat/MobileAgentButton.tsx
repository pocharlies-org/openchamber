import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getAgentDisplayName } from './mobileControlsUtils';
import { getAgentColor } from '@/lib/agentColors';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAllLiveSessions } from '@/sync/sync-context';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className }) => {
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionAgentName = useSelectionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );

    // Nivel de razonamiento de la sesion abierta. Se enseña pegado al agente
    // porque son la misma pregunta —"con que esta corriendo esto"— y en el movil
    // no hay sitio para dos controles. `default` no se pinta: no dice nada.
    //
    // Se mira PRIMERO el store en vivo y solo despues el global: en la app movil
    // el store global se llena al abrir el cajon de sesiones, asi que quien
    // entra directo a una sesion lo tiene vacio y el nivel salia en blanco.
    const liveSessions = useAllLiveSessions();
    const liveVariant = React.useMemo(() => {
        if (!currentSessionId) return null;
        const session = liveSessions.find((entry) => entry.id === currentSessionId) as
            { model?: { variant?: string } } | undefined;
        return session?.model?.variant ?? null;
    }, [currentSessionId, liveSessions]);
    const globalVariant = useGlobalSessionsStore((state) => {
        if (!currentSessionId) return null;
        const session = state.activeSessions.find((entry) => entry.id === currentSessionId)
            ?? state.archivedSessions.find((entry) => entry.id === currentSessionId);
        return (session as { model?: { variant?: string } } | undefined)?.model?.variant ?? null;
    });
    const resolvedVariant = liveVariant ?? globalVariant;
    const sessionVariant = resolvedVariant && resolvedVariant !== 'default' ? resolvedVariant : null;

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const agentColor = getAgentColor(uiAgentName);

    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLongPressRef = React.useRef(false);

    const handlePointerDown = (event: React.PointerEvent) => {
        // Same pattern as PermissionAutoAcceptButton: block the focus transfer
        // iOS performs on touch so cycling the agent keeps the keyboard open.
        if (event.pointerType === 'touch') {
            event.preventDefault();
        }
        isLongPressRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
            isLongPressRef.current = true;
            onOpenAgentPanel();
        }, LONG_PRESS_MS);
    };

    // Use onPointerUp (not onClick) to prevent focus transfer that closes mobile keyboard
    const handlePointerUp = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (!isLongPressRef.current) {
            onCycleAgent();
        }
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    return (
        <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp} // Don't use onClick - it closes mobile keyboard
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
                'inline-flex min-w-0 items-stretch select-none',
                'rounded-lg',
                'typography-micro font-medium',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                'touch-none',
                className
            )}
            style={{
                height: '26px',
                maxHeight: '26px',
                minHeight: '26px',
                color: `var(${agentColor.var})`,
            }}
            title={sessionVariant ? `${agentLabel} · ${sessionVariant}` : agentLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center gap-1">
                <span className="truncate">{agentLabel}</span>
                {sessionVariant ? (
                    <span className="shrink-0 rounded px-1 opacity-70">{sessionVariant}</span>
                ) : null}
            </span>
        </button>
    );
};
