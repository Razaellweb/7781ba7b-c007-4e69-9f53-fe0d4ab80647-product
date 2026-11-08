import type { CSSProperties } from "react";
import type { Metadata } from "next";

/**
 * Single source of truth for the Openweight brand mark.
 *
 * This is the exact circular ring/outline logo asset that is rendered to the
 * left of the "OPENWEIGHT" wordmark in the landing-page header and the
 * workspace (dashboard) sidebar. The favicon metadata, both header usages, and
 * the CSS `--ow-brand-asset` custom property all read from this module, so the
 * browser tab icon can never drift from the logo shown in the product.
 *
 * Do not redraw, re-trace, or substitute another icon here — swap the file at
 * `BRAND_LOGO_PATH` and bump `BRAND_LOGO_VERSION` to invalidate cached favicons.
 */
export const BRAND_LOGO_PATH =
  "/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png";

/**
 * Cache-busting token. Browsers cache favicons aggressively (and outside the
 * normal HTTP cache in places), so the URL carries a version query. Increment
 * this whenever the asset at `BRAND_LOGO_PATH` changes.
 */
export const BRAND_LOGO_VERSION = "2";

/** Versioned, cache-busted URL for the shared brand mark. */
export const BRAND_LOGO_SRC = `${BRAND_LOGO_PATH}?v=${BRAND_LOGO_VERSION}`;

/** CSS custom property that stylesheets read the mark from. */
export const BRAND_LOGO_CSS_VAR = "--ow-brand-asset";

/** Inline style object that publishes the mark to CSS (set on <html>). */
export const BRAND_LOGO_CSS_VARS: CSSProperties = {
  [BRAND_LOGO_CSS_VAR]: `url("${BRAND_LOGO_SRC}")`,
} as CSSProperties;

/**
 * Browser tab / home-screen icon declarations.
 *
 * Every entry points at the same source asset, so the mark is pixel-identical
 * at every size; the `sizes` hints only tell the browser which slot each
 * declaration serves. Browsers that cannot use a PNG declaration fall back to
 * `<link rel="shortcut icon">`.
 */
export const BRAND_ICONS: NonNullable<Metadata["icons"]> = {
  icon: [
    { url: BRAND_LOGO_SRC, type: "image/png", sizes: "16x16" },
    { url: BRAND_LOGO_SRC, type: "image/png", sizes: "32x32" },
    { url: BRAND_LOGO_SRC, type: "image/png", sizes: "48x48" },
  ],
  shortcut: [{ url: BRAND_LOGO_SRC, type: "image/png" }],
  apple: [{ url: BRAND_LOGO_SRC, type: "image/png", sizes: "180x180" }],
};
