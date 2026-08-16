/**
 * Takes the ghost suggestion without a keyboard.
 *
 * `Tab` is the only way to accept a suggestion, and phones have no Tab key, so
 * on mobile the whole feature was unreachable: the text was painted behind the
 * caret with no way to take it. This button is that missing key.
 *
 * It renders only while a suggestion exists — an always-present control that
 * does nothing on most turns reads as broken, and its appearance is what tells
 * the user there is something to take.
 *
 * The pointer guards are the same ones PermissionAutoAcceptButton documents:
 * on Android's resizes-content viewport, letting the tap steal focus closes the
 * soft keyboard, the relayout moves the button mid-tap and the click never
 * lands. Accepting a suggestion and losing the keyboard would be worse than not
 * offering the button at all.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerGhostAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    /** Only true while there is a suggestion waiting behind the caret. */
    canAccept: boolean;
    onAccept: () => void;
    withTooltip?: boolean;
};

export const ComposerGhostAcceptButton = React.memo(function ComposerGhostAcceptButton(
    props: ComposerGhostAcceptButtonProps,
) {
    const { t } = useI18n();
    const { footerIconButtonClass, iconSizeClass, canAccept, onAccept, withTooltip = false } = props;

    if (!canAccept) {
        return null;
    }

    // The ghost widget itself is aria-hidden — it is a hint, not content — so
    // this label is the only thing a screen reader has to go on.
    const label = t('chat.chatInput.ghost.accept');

    const button = (
        <button
            type="button"
            onClick={onAccept}
            className={cn(footerIconButtonClass, 'rounded-md hover:bg-transparent')}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-label={label}
            title={label}
            data-composer-ghost-accept="true"
        >
            <Icon
                name="corner-down-left"
                className={cn(iconSizeClass)}
                style={{ color: 'var(--status-info)' }}
            />
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {label}
            </TooltipContent>
        </Tooltip>
    );
});
