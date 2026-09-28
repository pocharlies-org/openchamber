import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isTodoTool, latestTodos, todoProgress, type TodoItem } from '@/lib/claudeTodos';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionMessageRecords } from '@/sync/sync-context';

/** A to-do list as a checklist: done, in progress (its active form), pending. */
export const TodoChecklist: React.FC<{ items: readonly TodoItem[]; className?: string }> = ({ items, className }) => (
    <ul className={cn('space-y-1', className)} data-todo-list="true">
        {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 min-w-0" data-todo-status={item.status}>
                <Icon
                    name={item.status === 'completed' ? 'checkbox-circle' : item.status === 'in_progress' ? 'loader-4' : 'checkbox-blank'}
                    className={cn(
                        'mt-0.5 size-3.5 flex-shrink-0',
                        item.status === 'completed' && 'text-[var(--status-success)]',
                        item.status === 'in_progress' && 'text-primary animate-spin',
                        item.status === 'pending' && 'text-muted-foreground',
                    )}
                />
                <span
                    className={cn(
                        'typography-meta min-w-0 break-words',
                        item.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground',
                        item.status === 'in_progress' && 'font-medium',
                    )}
                >
                    {item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content}
                </span>
            </li>
        ))}
    </ul>
);

/**
 * Claude's latest to-do list, kept in reach in the composer footer as the VS
 * Code extension keeps it visible: progress on the pill, the list on click.
 */
export const ClaudeTodoPill: React.FC<{ sessionId: string; directory?: string; className?: string }> = ({ sessionId, directory, className }) => {
    const { t } = useI18n();
    const records = useSessionMessageRecords(sessionId, directory);
    const items = React.useMemo(() => {
        const parts = [];
        for (const record of records) {
            for (const part of record.parts) {
                if (part.type === 'tool' && isTodoTool(part.tool)) parts.push(part);
            }
        }
        return parts.length > 0 ? latestTodos(parts) : null;
    }, [records]);

    if (!items || items.length === 0) return null;
    const { done, total, current } = todoProgress(items);
    const label = t('chat.todo.progress', { done: String(done), total: String(total) });

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'typography-meta flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground',
                        className,
                    )}
                    title={current ? (current.activeForm || current.content) : label}
                    aria-label={label}
                    data-claude-todo-pill="true"
                >
                    <Icon name="list-check-2" className="size-3.5 text-current" />
                    <span className="tabular-nums">{done}/{total}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-[min(360px,calc(100vw-2rem))] p-2">
                <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground px-0 pt-0">
                    {t('chat.todo.title')} · {label}
                </DropdownMenuLabel>
                <div className="max-h-[50vh] overflow-y-auto">
                    <TodoChecklist items={items} />
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
