"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Model marks are bundled locally under /assets/models so the cards never depend
// on a third-party CDN or a temporary hotlinked URL.
type BrandLogo = { src: string; alt: string; monogram: string };

type LogoModel = {
  id?: string | null;
  displayName?: string | null;
  family?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
  providerModelSlug?: string | null;
};

const zLogo: BrandLogo = { src: "/assets/models/glm.svg", alt: "GLM logo", monogram: "Z" };
const deepseekLogo: BrandLogo = { src: "/assets/models/deepseek.svg", alt: "DeepSeek logo", monogram: "D" };
const qwenLogo: BrandLogo = { src: "/assets/models/qwen.svg", alt: "Qwen logo", monogram: "Q" };
const kimiLogo: BrandLogo = { src: "/assets/models/kimi.svg", alt: "Kimi logo", monogram: "K" };

// Identifier matches run first so a model can never receive another vendor's
// mark, even when display copy overlaps between families.
const byIdentifier: Array<{ test: RegExp; logo: BrandLogo }> = [
  { test: /(^|\/)glm/i, logo: zLogo },
  { test: /deepseek/i, logo: deepseekLogo },
  { test: /qwen/i, logo: qwenLogo },
  { test: /kimi|moonshot/i, logo: kimiLogo },
];

export function modelLogoFor(model: LogoModel | null | undefined): BrandLogo | null {
  if (!model) return null;
  const identifier = `${model.id ?? ""} ${model.providerModelSlug ?? ""}`.trim();
  const match = byIdentifier.find((entry) => entry.test.test(identifier));
  if (match) return match.logo;
  const description = `${model.family ?? ""} ${model.displayName ?? ""} ${model.providerLabel ?? ""}`;
  const byFamily = byIdentifier.find((entry) => entry.test.test(description));
  return byFamily ? byFamily.logo : null;
}

const monogramFor = (model: LogoModel | null | undefined, logo: BrandLogo | null) => {
  if (logo) return logo.monogram;
  const source = (model?.family || model?.displayName || model?.providerLabel || model?.provider || "").trim();
  return source ? source.slice(0, 1).toUpperCase() : "\u00b7";
};

// The tile keeps a fixed square footprint, so the card never reflows while the
// mark decodes. A failed or unmapped asset degrades to a neutral monogram.
export default function ModelLogo({ model, className }: { model: LogoModel | null | undefined; className?: string }) {
  const logo = modelLogoFor(model);
  const monogram = monogramFor(model, logo);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // A cached image can error before React attaches its handler; re-check on mount.
  useEffect(() => {
    setFailed(false);
    const image = imageRef.current;
    if (image && image.complete && image.naturalWidth === 0) setFailed(true);
  }, [logo?.src]);

  const onError = useCallback(() => setFailed(true), []);
  const showImage = Boolean(logo) && !failed;

  return (
    <span className={`model-logo-tile ${className ?? ""}`.trim()}>
      {showImage && logo
        ? <img
            ref={imageRef}
            className="model-logo-image"
            src={logo.src}
            alt={logo.alt}
            width={38}
            height={38}
            decoding="async"
            draggable={false}
            onError={onError}
          />
        : <span className="model-logo-monogram" role="img" aria-label={`${monogram} monogram`}>{monogram}</span>}
    </span>
  );
}
