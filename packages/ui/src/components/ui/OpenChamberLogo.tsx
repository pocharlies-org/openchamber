import React, { useId } from 'react';
import { BRAND_MARK_VIEW_BOX, brandMarkBody } from '@/lib/brandMark';
import { useI18n } from '@/lib/i18n';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

// The mark is drawn by `scripts/brand-sync.mjs` from the brand's icon master (`brand/icons`): its colours are
// the brand's, not the theme's, so one drawing serves light and dark. Nothing here owns geometry.
const GLOW_STYLE = '@keyframes oc-logo-glow{0%,100%{filter:drop-shadow(0 0 0 transparent)}50%{filter:drop-shadow(0 0 40px currentColor)}}.oc-logo-glow{animation:oc-logo-glow 1.8s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.oc-logo-glow{animation:none}}';

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const { t } = useI18n();
  // Gradient and mask ids must be unique per inlined copy: a copy inside a hidden subtree does not paint for the others.
  const idPrefix = `brand-${useId().replace(/:/g, '')}-`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={BRAND_MARK_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={t('openChamberLogo.aria.logo')}
    >
      {isAnimated ? <style>{GLOW_STYLE}</style> : null}
      <g className={isAnimated ? 'oc-logo-glow' : undefined} dangerouslySetInnerHTML={{ __html: brandMarkBody(idPrefix) }} />
    </svg>
  );
};
