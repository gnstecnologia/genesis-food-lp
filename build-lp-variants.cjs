/**
 * Gera HTMLs de variantes a partir do index.html (LP1).
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const BASE_DOMAIN = "foods.companygenesis.com.br";
const baseHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const { variants } = JSON.parse(
  fs.readFileSync(path.join(ROOT, "lp-variants.json"), "utf8")
);

const HEADLINE_RE =
  /(<div class="elementor-element elementor-element-5e8d05b[\s\S]*?<p class="elementor-heading-title elementor-size-default">)([\s\S]*?)(<\/p><\/div><div class="elementor-element elementor-element-dbac0b5)/;
const SUB_RE =
  /(<div class="elementor-element elementor-element-dbac0b5[\s\S]*?<p class="elementor-heading-title elementor-size-default">)([\s\S]*?)(<\/p><\/div><div class="elementor-element elementor-element-2e785ca)/;
const BANNER_RE =
  /(<div class="gf-top-banner" role="banner">)([\s\S]*?)(<\/div>)/;
const CTA_RE =
  /(<div class="elementor-element elementor-element-2e785ca[\s\S]*?<span class="elementor-button-text">)([\s\S]*?)(<\/span>)/;

function applyVariant(html, variant) {
  let out = html;
  if (!HEADLINE_RE.test(out) || !SUB_RE.test(out)) {
    throw new Error("Hero markers not found in index.html — aborting build");
  }
  HEADLINE_RE.lastIndex = 0;
  SUB_RE.lastIndex = 0;
  BANNER_RE.lastIndex = 0;
  CTA_RE.lastIndex = 0;

  out = out.replace(HEADLINE_RE, (_, a, _b, c) => a + variant.headlineHtml + c);
  out = out.replace(SUB_RE, (_, a, _b, c) => a + variant.subHtml + c);

  if (variant.bannerHtml) {
    if (!BANNER_RE.test(out)) {
      throw new Error("Banner marker not found in index.html — aborting build");
    }
    BANNER_RE.lastIndex = 0;
    out = out.replace(BANNER_RE, (_, a, _b, c) => a + variant.bannerHtml + c);
  }

  if (variant.ctaText) {
    if (!CTA_RE.test(out)) {
      throw new Error("CTA marker not found in index.html — aborting build");
    }
    CTA_RE.lastIndex = 0;
    out = out.replace(CTA_RE, (_, a, _b, c) => a + variant.ctaText + c);
  }

  if (variant.domain && variant.domain !== BASE_DOMAIN) {
    out = out.split(BASE_DOMAIN).join(variant.domain);
  }

  out = out.replace(
    /<title>Marketing para Restaurantes \| Genesis Food<\/title>/,
    `<title>${variant.title}</title>`
  );
  out = out.replace(
    /property="og:title" content="Marketing para Restaurantes \| Genesis Food"/g,
    `property="og:title" content="${variant.title}"`
  );
  out = out.replace(
    /name="twitter:title" content="Marketing para Restaurantes \| Genesis Food"/g,
    `name="twitter:title" content="${variant.title}"`
  );
  out = out.replace(
    'const SOURCE = "Landing Page Genesis Food";',
    `const SOURCE = ${JSON.stringify(variant.source)};`
  );
  if (variant.extraCss) {
    const cssTag = `<style id="gf-variant-css">${variant.extraCss}</style>`;
    if (out.includes("</head>")) {
      out = out.replace("</head>", cssTag + "</head>");
    } else {
      out += cssTag;
    }
  }
  return out;
}

for (const variant of variants) {
  if (variant.id === "foods") {
    console.log("skip foods (source index.html)");
    continue;
  }
  const html = applyVariant(baseHtml, variant);
  fs.writeFileSync(path.join(ROOT, variant.indexOut), html, "utf8");
  const tip = variant.path
    ? `→ https://genesis-food-lp.vercel.app${variant.path}`
    : variant.domain
      ? `→ https://${variant.domain}`
      : "";
  console.log("Wrote", variant.indexOut, tip);
}

console.log("Done.");
