// Plugin de Kino multi-fuente para leer cómics y manga EN ESPAÑOL,
// para todas las edades.
//
// Fuentes (elegidas por acceso fácil: sin Cloudflare, con API o HTML
// sencillo — la misma arquitectura del plugin «Lectura +18» de
// Hotaru Yume, basado en Yuri Online / ZonaTM0 / MangaTrack):
//
//   1. MangaDex (mangadex.org) — API pública oficial, sin scraping:
//      - Listados y secciones: /manga?…&availableTranslatedLanguage[]=es
//        (secciones por tag: Acción, Aventura, Comedia, Drama,
//        Fantasía, Romance, Sci-Fi, Vida Cotidiana — los UUID se
//        resuelven en caliente con /manga/tag y se cachean).
//      - Búsqueda:             /manga?title=<q>…
//      - Metadatos:            /manga/{id}?includes[]=cover_art
//      - Capítulos en español: /manga/{id}/feed?translatedLanguage[]=es
//      - Páginas:              /at-home/server/{chapterId} →
//        baseUrl/data/{hash}/{página} (imágenes en uploads.mangadex.org)
//
//   2. WEBTOON en español (www.webtoons.com/es) — HTML público:
//      - Secciones:  /es/originals?genre=<género> (romance, drama,
//        fantasy, comedy, action, thriller, sports, slice-of-life)
//      - Búsqueda:   /es/search?keyword=<q>
//      - Serie:      página /list?title_no=N (metadatos og:* + lista
//        de episodios /viewer?title_no=N&episode_no=M)
//      - Episodio:   imágenes del visor (data-url de las _images)
//
// Interfaz (idéntica al plugin base): Inicio, Biblioteca, Favoritos,
// Historial, detalle y lector vertical, con FUENTES conmutables por
// chips. Nada bloquea la pantalla: todo llega en segundo plano por el
// temporizador «every». Lector SIEMPRE a pantalla completa. Las
// páginas viven en kino.storage.
//
// Requiere Kino 0.9.74 o superior (apiVersion 14, capabilities
// "screen" y "shared").
//
// v2.0.0 — fuentes para todas las edades: MangaDex y WEBTOON es.

const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const PER_PAGE = 18; // cómics por página de listado
const LIB_MAX = 144; // tope de cómics acumulados en la Biblioteca
const PAGES_MAX = 300; // tope de páginas por capítulo
const FEED_MAX = 500; // capítulos por serie (tope de la API)

// Las fuentes. «type» decide la capa de datos:
//   - "md": MangaDex, todo por la API oficial.
//   - "wt": WEBTOON es, todo por HTML.
const SITES = [
  {
    id: "md", name: "MangaDex", type: "md",
    base: "https://api.mangadex.org",
    web: "https://mangadex.org",
    sections: [
      { key: "mdAc", tag: "Acción", label: "Acción", labelEn: "Action" },
      { key: "mdAv", tag: "Aventura", label: "Aventura", labelEn: "Adventure" },
      { key: "mdCo", tag: "Comedia", label: "Comedia", labelEn: "Comedy" },
      { key: "mdDr", tag: "Drama", label: "Drama", labelEn: "Drama" },
      { key: "mdFa", tag: "Fantasía", label: "Fantasía", labelEn: "Fantasy" },
      { key: "mdRo", tag: "Romance", label: "Romance", labelEn: "Romance" },
      { key: "mdCi", tag: "Sci-Fi", label: "Ciencia Ficción", labelEn: "Sci-Fi" },
      { key: "mdVi", tag: "Slice of Life", label: "Vida Cotidiana", labelEn: "Slice of Life" },
    ],
  },
  {
    id: "wt", name: "WEBTOON", type: "wt",
    base: "https://www.webtoons.com",
    web: "https://www.webtoons.com",
    sections: [
      { key: "wtRo", pathHtml: "/es/originals?genre=romance", label: "Romance", labelEn: "Romance" },
      { key: "wtDr", pathHtml: "/es/originals?genre=drama", label: "Drama", labelEn: "Drama" },
      { key: "wtFa", pathHtml: "/es/originals?genre=fantasy", label: "Fantasía", labelEn: "Fantasy" },
      { key: "wtCo", pathHtml: "/es/originals?genre=comedy", label: "Comedia", labelEn: "Comedy" },
      { key: "wtAc", pathHtml: "/es/originals?genre=action", label: "Acción", labelEn: "Action" },
      { key: "wtTh", pathHtml: "/es/originals?genre=thriller", label: "Suspenso", labelEn: "Thriller" },
      { key: "wtSp", pathHtml: "/es/originals?genre=sports", label: "Deportes", labelEn: "Sports" },
      { key: "wtSl", pathHtml: "/es/originals?genre=slice-of-life", label: "Vida Cotidiana", labelEn: "Slice of Life" },
    ],
  },
];

function siteDe(state) {
  const id = state && state.fuente;
  return SITES.find((s) => s.id === id) || SITES[0];
}

function siteOfId(id) {
  return SITES.find((s) => s.id === id) || SITES[0];
}

// ------------------------------------------------------------- red

// Petición JSON a una API. Lanza «network» si no responde.
async function getApi(site, path, timeoutMs) {
  const r = await kino.fetch(site.base + path, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "es",
      Referer: site.web + "/",
      "User-Agent": UA,
    },
    timeoutMs: timeoutMs || 20000,
  });
  if (!r.ok) throw kino.error("network", "HTTP " + r.status, {
    userMessage: "No se pudo conectar con el sitio. Inténtalo de nuevo.",
  });
  let data;
  try { data = JSON.parse(r.text()); } catch (e) {
    throw kino.error("network", "bad json", {
      userMessage: "El sitio devolvió una respuesta inesperada. Inténtalo de nuevo.",
    });
  }
  return data;
}

// Petición HTML a una página del sitio.
async function getHtml(site, path, timeoutMs) {
  const r = await kino.fetch(site.base + path, {
    headers: {
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "es",
      Referer: site.base + "/",
      "User-Agent": UA,
    },
    timeoutMs: timeoutMs || 20000,
  });
  if (!r.ok) throw kino.error("network", "HTTP " + r.status, {
    userMessage: "No se pudo conectar con el sitio. Inténtalo de nuevo.",
  });
  return r.text();
}

// ---------------------------------------------------- MangaDex (API)

// tags de MangaDex (nombre en → UUID), cacheados 24 h. Las secciones
// por género los necesitan y la lista oficial puede cambiar.
async function mdTags(site) {
  const ck = "mdtags";
  try {
    const c = getJson(ck, null);
    if (c && c.map && Date.now() - (c.ts || 0) < 86400000) return c.map;
  } catch (e) { /* caché rota: se recarga */ }
  const j = await getApi(site, "/manga/tag?limit=100", 20000);
  const map = {};
  for (const t of (j.data || [])) {
    if (t && t.id && t.attributes && t.attributes.name && t.attributes.name.en) {
      map[t.attributes.name.en] = t.id;
    }
  }
  setJson(ck, { map: map, ts: Date.now() });
  return map;
}

function mdTitle(m) {
  const t = (m.attributes && m.attributes.title) || {};
  return decode(t.es || t.en || t["ja-ro"] || t.ja ||
    (Object.keys(t).length ? t[Object.keys(t)[0]] : "")) || "";
}

function mdDesc(m) {
  const d = (m.attributes && m.attributes.description) || {};
  return decode(d.es || d.en || (Object.keys(d).length ? d[Object.keys(d)[0]] : "")).slice(0, 600);
}

function mdCover(m, site, size) {
  const rels = (m.relationships || []);
  for (const r of rels) {
    if (r.type === "cover_art" && r.attributes && r.attributes.fileName) {
      return site.web.replace("//mangadex.org", "//uploads.mangadex.org") +
        "/covers/" + m.id + "/" + r.attributes.fileName + (size || ".256.jpg");
    }
  }
  return "";
}

// resultados de la API → tarjetas
function mdToCards(j, site) {
  const out = [];
  for (const m of (j.data || [])) {
    if (!m || !m.id) continue;
    out.push({
      slug: m.id,
      url: site.web + "/title/" + m.id,
      title: mdTitle(m) || m.id,
      poster: mdCover(m, site, ".256.jpg"),
    });
  }
  return out;
}

// capítulo legible de la API → entrada de la lista de capítulos
function mdChapter(c) {
  const a = c.attributes || {};
  if (a.externalUrl) return null; // capítulos externos: no se pueden leer aquí
  const nch = a.chapter && String(a.chapter).length ? "Cap. " + a.chapter : "";
  const ti = decode(a.title || "");
  const title = nch && ti ? nch + " · " + ti : (nch || ti || "Capítulo");
  return { url: c.id, ch: a.chapter || "0", title: title };
}

// Listado de cómics. Devuelve SIEMPRE una lista o lanza «network».
async function getCards(site, page, q, sec) {
  const p = parseInt(page, 10) || 1;
  if (site.type === "md") {
    const base = "/manga?limit=" + PER_PAGE + "&offset=" + ((p - 1) * PER_PAGE) +
      "&includes%5B%5D=cover_art&contentRating%5B%5D=safe&contentRating%5B%5D=suggestive" +
      "&availableTranslatedLanguage%5B%5D=es";
    let path;
    if (q) {
      path = base + "&title=" + encodeURIComponent(q);
    } else if (sec && sec.tag) {
      const map = await mdTags(site);
      const uuid = map[sec.tag];
      if (!uuid) return [];
      path = base + "&includedTags%5B%5D=" + uuid + "&order%5BlatestUploadedChapter%5D=desc";
    } else {
      path = base + "&order%5BlatestUploadedChapter%5D=desc";
    }
    const j = await getApi(site, path, 25000);
    return mdToCards(j, site);
  }
  // WEBTOON (HTML)
  let htmlPath;
  if (q) htmlPath = "/es/search?keyword=" + encodeURIComponent(q);
  else if (sec && sec.pathHtml) htmlPath = sec.pathHtml;
  else htmlPath = "/es/originals";
  const html = await getHtml(site, htmlPath, 20000);
  return wtCards(html, 40);
}

// ---------------------------------------------------- WEBTOON (HTML)

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => {
      const c = parseInt(n, 10);
      return c > 0 && c < 65536 ? String.fromCharCode(c) : "";
    })
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

// Tarjetas desde el HTML de WEBTOON: enlaces de serie
// /es/<género>/<serie>/list?title_no=N. El slug de estado es
// "wt" + title_no (estable y único); la URL de la serie se guarda en
// kino.storage para poder abrirla desde favoritos/historial.
const WT_LIST_RE = 'href="(https:\\/\\/www\\.webtoons\\.com\\/es\\/[a-z0-9-]+\\/[a-z0-9-]+\\/list\\?title_no=(\\d+)[^"]*)"';

function wtCards(html, max) {
  const out = [];
  const seen = {};
  const re = new RegExp(WT_LIST_RE, "g");
  let m;
  while ((m = re.exec(html)) !== null && out.length < (max || 40)) {
    const url = m[1], tn = m[2];
    const slug = "wt" + tn;
    if (seen[slug]) continue;
    seen[slug] = true;
    const win = html.slice(m.index, m.index + 2500);
    const im = win.match(/(?:data-src|src)="(https?:\/\/[^"\s]+?\.(?:jpe?g|png|webp))"/);
    let title = "";
    const tre = new RegExp('href="' + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>([^<]{1,150})<');
    const t = tre.exec(win);
    if (t && decode(t[1]).length > 1) title = decode(t[1]);
    out.push({
      slug: slug, url: url,
      title: title || "",
      poster: im ? im[1] : "",
    });
    wtStoreUrl(slug, url, title, im ? im[1] : "");
  }
  return out;
}

// URL de una serie WEBTOON (para abrir el detalle desde favoritos o
// historial aunque la sesión anterior se haya cerrado)
function wtStoreUrl(slug, url, title, poster) {
  try {
    setJson("wtu:" + slug, { url: url, title: title || "", poster: poster || "" });
  } catch (e) { /* sin memoria */ }
}
function wtUrlDe(slug) {
  if (!slugValido(slug) || slug.indexOf("wt") !== 0) return null;
  const c = getJson("wtu:" + slug, null);
  return c && c.url ? c : null;
}

// Metadatos desde el HTML de la página de la serie (og:*)
function seriesMetaHtml(html, slug) {
  const pick = (re) => { const m = html.match(re); return m ? decode(m[1]) : ""; };
  return {
    title: pick(/property="og:title"[^>]*content="([^"]+)"/) || pick(/content="([^"]+)"[^>]*property="og:title"/) || slug,
    poster: pick(/property="og:image"[^>]*content="([^"]+)"/) || pick(/content="([^"]+)"[^>]*property="og:image"/),
    overview: (pick(/property="og:description"[^>]*content="([^"]+)"/) || pick(/content="([^"]+)"[^>]*property="og:description"/)).slice(0, 600),
  };
}

// Episodios de una serie WEBTOON desde el HTML de la página de la
// serie: enlaces /viewer?title_no=N&episode_no=M con su texto. La
// página los trae del más nuevo al más viejo; se devuelven del más
// viejo al más nuevo (orden de lectura).
function wtEpisodes(html, titleNo) {
  const out = [];
  const seen = {};
  const re = /href="(https?:\/\/www\.webtoons\.com\/es\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/viewer\?title_no=(\d+)&episode_no=(\d+)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1], tn = m[2], ep = m[3];
    if (tn !== String(titleNo) || seen[ep]) continue;
    seen[ep] = true;
    const win = html.slice(m.index, m.index + 800);
    let title = "";
    const tre = new RegExp('href="' + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>([^<]{1,150})<');
    const t = tre.exec(win);
    if (t && decode(t[1]).length > 1) title = decode(t[1]);
    out.push({ url: url, ch: ep, title: title || "Episodio " + ep });
  }
  return out.reverse();
}

// Páginas de un episodio WEBTOON: las imágenes del visor (data-url).
async function wtPages(site, url) {
  const html = await getHtml(site, url.replace(site.base, ""), 30000);
  const out = [], seen = {};
  const re = /(?:data-url|data-src)="(https?:\/\/[^"\s]+?\.(?:jpe?g|png|webp)[^"\s]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < PAGES_MAX) {
    if (seen[m[1]]) continue;
    if (/(?:logo|icon|avatar|badge|banner|sprite|favicon|placeholder)/i.test(m[1])) continue;
    seen[m[1]] = true;
    out.push(m[1]);
  }
  if (!out.length) {
    // respaldo: cualquier imagen grande del visor
    for (const x of readerImages(html)) {
      if (out.length >= PAGES_MAX) break;
      out.push(x.url);
    }
  }
  return out;
}

// Páginas de un capítulo de MangaDex: /at-home/server/{id} trae el
// servidor y los nombres de archivo, ya en orden de lectura.
async function mdPages(site, chapterId) {
  const j = await getApi(site, "/at-home/server/" + chapterId, 30000);
  const ch = j.chapter || {};
  const files = ch.data || [];
  const base = j.baseUrl;
  if (!base || !files.length) return [];
  const out = [];
  for (const f of files) {
    if (out.length >= PAGES_MAX) break;
    out.push(base + "/data/" + ch.hash + "/" + f);
  }
  return out;
}

// Imágenes de un contenido o página (respaldo genérico).
function readerImages(content) {
  const html = String(content || "");
  const out = [], seen = {};
  const re = /(?:src|data-src|data-lazy-src|data-full|data-original|data-url)="?(https?:\/\/[^"\s>]+\.(?:webp|jpe?g|png|gif)(?:\?[^"\s>]*)?)"?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (seen[u]) continue;
    if (/(?:^|[^a-z])(?:logo|icon|avatar|emoji|badge|button|flag|sprite|smiley|banner|favicon|placeholder|spinner)(?:[^a-z]|$)|\/(?:ads?|banners?)\b|wp-includes|gravatar|loading\.gif/i.test(u)) continue;
    seen[u] = true;
    const win = html.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
    const w = parseInt((win.match(/\bwidth="(\d+)"/) || [])[1], 10) || 0;
    const h = parseInt((win.match(/\bheight="(\d+)"/) || [])[1], 10) || 0;
    if (w > 0 && h > 0 && w < 120 && h < 120) continue;
    out.push({ url: u, w: w, h: h });
  }
  return out;
}

// (receta de MangaTrack, como ZonaTM0): las páginas ya no se miden.
// Con fit "width" + aspect "2:3", Kino le da a cada página su
// proporción real en cuanto la imagen carga — sin descargar cabeceras.
function pageNodes(p, i, pre) {
  return [{
    type: "Image", key: (pre || "") + "p" + i, url: typeof p === "string" ? p : p.url,
    alt: "Página " + (i + 1), altEn: "Page " + (i + 1),
    fill: true, fit: "width", aspect: "2:3",
    fallback: { type: "Column", padding: 16, children: [
      { type: "Text", text: "Página " + (i + 1), textEn: "Page " + (i + 1), color: "muted" } ] },
  }];
}

// Carga una serie: título, portada, sinopsis y lista COMPLETA de
// capítulos (ambas fuentes son por capítulos). Con caché de 15
// minutos (force=true la salta). Lo pesado se guarda en kino.storage
// («serie:<slug>»); del estado de la pantalla solo viaja el meta.
async function loadSeries(site, slug, force) {
  if (!slugValido(slug)) throw kino.error("arguments", "slug");
  const ck = "serie:" + site.id + ":" + slug;
  if (!force) {
    try {
      const c = getJson(ck, null);
      if (c && c.meta && Array.isArray(c.chapters) && c.chapters.length &&
          Date.now() - (c.ts || 0) < 900000) {
        return { slug: slug, meta: c.meta, chapters: c.chapters };
      }
    } catch (e) { /* caché rota: se recarga */ }
  }
  let meta = null, chapters = [];
  if (site.type === "md") {
    const j = await getApi(site, "/manga/" + encodeURIComponent(slug) +
      "?includes%5B%5D=cover_art", 30000);
    const m = j.data;
    if (!m) throw kino.error("not_found", "comic", {
      userMessage: "No se encontró esa serie.",
    });
    meta = { title: mdTitle(m), poster: mdCover(m, site, ".512.jpg"), overview: mdDesc(m) };
    const feed = await getApi(site, "/manga/" + encodeURIComponent(slug) +
      "/feed?translatedLanguage%5B%5D=es&order%5Bchapter%5D=asc&limit=" + FEED_MAX +
      "&offset=0&contentRating%5B%5D=safe&contentRating%5B%5D=suggestive", 30000);
    for (const c of (feed.data || [])) {
      const e = mdChapter(c);
      if (e) chapters.push(e);
    }
  } else {
    // WEBTOON: la URL de la serie viene de la tarjeta/favorito o del
    // mapa persistente «wtu:»
    const st = wtUrlDe(slug);
    const info = CARDINFO[slug] || st || {};
    const listUrl = info.url || (st && st.url);
    if (!listUrl) throw kino.error("not_found", "comic", {
      userMessage: "No se encontró la dirección de esa serie. Ábrela de nuevo desde Inicio o Búsqueda.",
    });
    const html = await getHtml(site, listUrl.replace(site.base, ""), 30000);
    meta = seriesMetaHtml(html, slug);
    if (!meta.poster && info.poster) meta.poster = info.poster;
    const tn = String(slug).replace(/^wt/, "");
    chapters = wtEpisodes(html, tn);
  }
  if (!chapters.length) throw kino.error("not_found", "comic", {
    userMessage: site.type === "md"
      ? "No hay capítulos en español de esta serie (todavía)."
      : "No se encontraron episodios de esta serie.",
  });
  try {
    setJson(ck, { meta: meta, chapters: chapters, ts: Date.now() });
    const ks = kino.storage.keys().filter((k) => k.indexOf("serie:") === 0);
    if (ks.length > 10) for (const k of ks.slice(0, ks.length - 10)) kino.storage.remove(k);
  } catch (e) { kino.log("cache", e.message); }
  return { slug: slug, meta: meta, chapters: chapters };
}

// capítulos de una serie desde kino.storage. null si no está en caché.
function chaptersDe(site, slug) {
  if (!slugValido(slug)) return null;
  const c = getJson("serie:" + site.id + ":" + slug, null);
  return (c && Array.isArray(c.chapters)) ? c.chapters : null;
}

// Carga el cómic para el detalle: si falla (web caída, sin red, tiempo
// límite), deja el cómic en estado de error — con botón «Reintentar».
// Al estado solo va el meta — los capítulos quedan en kino.storage y
// detailTree los lee de ahí.
async function cargarDetalle(state, slug, force) {
  const site = siteOfId(state.detail && state.detail.siteId) || siteDe(state);
  const prev = (state.detail && state.detail.slug === slug) ? state.detail : null;
  const meta0 = (prev && prev.meta) || {};
  try {
    const d = await loadSeries(site, slug, force);
    return { state: { detail: { slug: slug, siteId: site.id, meta: d.meta } } };
  } catch (e) {
    kino.log("detalle", e.message);
    return { state: { detail: { slug: slug, siteId: site.id, error: true, meta: meta0 } } };
  }
}

// ------------------------------------------------------------ almacen

function getJson(key, fallback) {
  try {
    const v = kino.storage.get(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) { return fallback; }
}
function setJson(key, val) {
  try { kino.storage.set(key, JSON.stringify(val)); } catch (e) { kino.log("storage", e.message); }
}
function favs() { return getJson("favs", []); }
function isFav(slug) { return favs().some((f) => f.slug === slug); }
function progress() { return getJson("prog", {}); }

function markRead(slug, title, poster, chTitle, url, siteId) {
  const p = progress();
  p[slug] = { title: title, poster: poster, chTitle: chTitle, url: url, ts: Date.now(), s: siteId || "" };
  setJson("prog", p);
  syncPush("prog", p);
}

// quita UN cómic de «Seguir leyendo»/Historial
function borrarProgreso(slug) {
  const p = progress();
  if (!p[slug]) return false;
  delete p[slug];
  setJson("prog", p);
  syncPush("prog", p);
  return true;
}

// vacía todo «Seguir leyendo»/Historial
function borrarTodoProgreso() {
  setJson("prog", {});
  syncPush("prog", {});
}

// ---------------------------------------------- sincronización (kino.shared)

function syncPush(key, val) {
  try {
    if (typeof kino.shared === "object" && kino.shared !== null) kino.shared.set(key, val);
  } catch (e) { kino.log("sync", e.message); }
}

function slugValido(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(s) && s.indexOf("..") < 0;
}

function syncPull() {
  try {
    if (typeof kino.shared !== "object" || kino.shared === null) return;
    const sf = kino.shared.get("favs");
    if (Array.isArray(sf)) {
      const local = favs();
      const have = {};
      for (const f of local) have[f.slug] = true;
      let changed = false;
      for (const f of sf.slice(0, 200)) {
        if (!f || typeof f !== "object" || !slugValido(f.slug)) continue;
        if (have[f.slug]) continue;
        local.push({ slug: f.slug, title: String(f.title || f.slug).slice(0, 200),
          poster: typeof f.poster === "string" ? f.poster.slice(0, 500) : "",
          u: typeof f.u === "string" ? f.u.slice(0, 500) : "" });
        have[f.slug] = true; changed = true;
      }
      if (changed) { setJson("favs", local); syncPush("favs", local); }
    }
    const sp = kino.shared.get("prog");
    if (sp && typeof sp === "object" && !Array.isArray(sp)) {
      const p = progress();
      let changed = false;
      for (const k of Object.keys(sp).slice(0, 200)) {
        if (!slugValido(k)) continue;
        const e = sp[k];
        if (!e || typeof e !== "object" || typeof e.url !== "string" || typeof e.ts !== "number") continue;
        if (p[k] && (p[k].ts || 0) >= e.ts) continue;
        p[k] = { title: String(e.title || k).slice(0, 200),
          poster: typeof e.poster === "string" ? e.poster.slice(0, 500) : "",
          chTitle: String(e.chTitle || e.url).slice(0, 200),
          url: e.url.slice(0, 500), ts: e.ts };
        changed = true;
      }
      if (changed) { setJson("prog", p); syncPush("prog", p); }
    }
  } catch (e) { kino.log("sync", e.message); }
}

// caché de lector (últimos capítulos abiertos), para no volver a pedir
function readerCache(url) { return getJson("rc:" + url, null); }
function readerCachePut(url, urls) {
  try {
    const keys = kino.storage.keys().filter((k) => k.indexOf("rc:") === 0);
    if (keys.length > 4) for (const k of keys.slice(0, keys.length - 4)) kino.storage.remove(k);
  } catch (e) { /* la app vieja no lista */ }
  setJson("rc:" + url, urls);
}

// ----------------------------------------------------------- interfaz

const TABS = [
  { value: "inicio", label: "Inicio", labelEn: "Home" },
  { value: "biblioteca", label: "Biblioteca", labelEn: "Library" },
  { value: "favoritos", label: "Favoritos", labelEn: "Favourites" },
  { value: "historial", label: "Historial", labelEn: "History" },
];

// Título partido en dos filas
function twoLines(t) {
  const s = (t || "").trim();
  if (s.length <= 26) return [s];
  const mid = Math.ceil(s.length / 2);
  let cut = -1, best = 999;
  for (let i = 8; i < s.length - 3; i++) {
    if (s[i] === " ") { const d = Math.abs(i - mid); if (d < best) { best = d; cut = i; } }
  }
  if (cut < 0) cut = mid;
  let a = s.slice(0, cut).trim(), b = s.slice(cut).trim();
  if (a.length > 34) a = a.slice(0, 33).trim() + "…";
  if (b.length > 34) b = b.slice(0, 33).trim() + "…";
  return [a, b];
}

// Título/portada de las tarjetas vistas, para pintar el detalle al
// instante (antes de que llegue la página de la serie).
const CARDINFO = {};
function rememberCard(it, siteId) {
  try {
    if (it && it.slug && CARDINFO[it.slug] === undefined) {
      CARDINFO[it.slug] = { title: it.title || "", poster: it.poster || "", s: siteId || "", u: it.url || "" };
      const ks = Object.keys(CARDINFO);
      if (ks.length > 300) delete CARDINFO[ks[0]];
    }
  } catch (e) { /* sin memoria */ }
}

function posterCard(it, prefix, rail, siteId) {
  rememberCard(it, siteId);
  const img = {
    type: "Image", url: it.poster || "", aspect: "2:3",
    alt: it.title, altEn: it.title,
    fallback: { type: "Column", padding: 16, crossAxisAlignment: "center", children: [
      { type: "Icon", name: "list", color: "muted" } ] },
  };
  if (rail) img.width = 120;
  return {
    type: "Card", key: prefix + it.slug.replace(/[^a-z0-9]/gi, "-"), flush: true,
    onTap: { event: "openSeries", arg: it.slug },
    children: [img].concat(twoLines(it.title).map((ln) => (
      { type: "Text", text: ln, textEn: ln, style: "caption", padding: 8 }))),
  };
}

const EMPTY_LIB = { type: "emptyState", icon: "list", title: "Nada por aquí todavía.", titleEn: "Nothing here yet." };
const EMPTY_FAV = { type: "emptyState", icon: "heart", title: "Marca series con el corazón para verlas aquí.", titleEn: "Mark series with the heart to see them here." };

// Esqueletos (receta MangaTrack): lo que se pinta mientras los datos
// llegan en segundo plano.
let skelSeq = 0;
function skelCard() {
  return { type: "Card", key: "sk" + skelSeq++, flush: true, children: [
    { type: "Skeleton", shape: "block", height: 180 },
    { type: "Skeleton", shape: "line", padding: 8 },
    { type: "Skeleton", shape: "line", padding: 8 },
  ] };
}

function skelGridNode(n) {
  const cards = [];
  for (let i = 0; i < (n || 12); i++) cards.push(skelCard());
  return {
    type: "ListView", key: "skel",
    columns: { compact: 3, medium: 4, expanded: 6 },
    items: cards,
  };
}

// estado de error con reintentar, en tamaño de fila/sección
function filaError(mensaje, evento) {
  return { type: "Card", key: "err-" + evento + "-" + skelSeq++, padding: 12, gap: 8,
    children: [{ type: "Row", gap: 8, crossAxisAlignment: "center", children: [
      { type: "Icon", name: "wifi_off", color: "muted" },
      { type: "Text", text: mensaje, textEn: mensaje, color: "muted", style: "caption", flex: 1 },
      { type: "TextButton", icon: "refresh", labelText: "Reintentar", labelTextEn: "Retry",
        onPressed: { event: evento } },
    ] }] };
}

function titleGridOf(items, eventMore, loading, done, emptyNode, siteId) {
  if (!items || !items.length) return emptyNode || EMPTY_LIB;
  const list = {
    type: "ListView", key: "grid",
    columns: { compact: 3, medium: 4, expanded: 6 },
    items: items.map((it) => posterCard(it, "c-", false, siteId || it.s)),
  };
  if (eventMore && !done) {
    list.onEndReached = { event: eventMore };
    list.loadingMore = loading === true;
  } else {
    list.done = true;
  }
  return list;
}

// Historial con dos formas de borrar el «Seguir leyendo»: mantener
// pulsada una entrada para quitar solo esa serie, y el botón «Borrar
// todo» (pide confirmar con un segundo toque).
function historyList(state) {
  const p = progress();
  const rows = Object.keys(p).map((slug) => ({ slug: slug, p: p[slug] }))
    .sort((a, b) => b.p.ts - a.p.ts).slice(0, 50);
  const conf = state && state.confBorrar === true;
  if (!rows.length) {
    return { type: "emptyState", icon: "schedule", title: "Todavía no has leído nada.", titleEn: "You have not read anything yet." };
  }
  const items = [{
    type: "Row", key: "histHead", gap: 8, padding: 16,
    children: [
      { type: "Text", text: "Mantén pulsado un cómic para quitarlo del historial.",
        textEn: "Long-press a comic to remove it from history.",
        style: "caption", color: "muted", flex: 1 },
      { type: "ElevatedButton", key: "clearHist", icon: "delete",
        labelText: conf ? "¿Seguro? Toca otra vez" : "Borrar todo",
        labelTextEn: conf ? "Sure? Tap again" : "Clear all",
        onPressed: { event: "clearHist" } },
    ],
  }];
  for (const r of rows) {
    items.push({
      type: "ListTile", key: "h-" + r.slug.replace(/[^a-z0-9]/gi, "-"),
      title: r.p.title || r.slug,
      subtitle: r.p.chTitle || "", subtitleEn: r.p.chTitle || "",
      leading: { type: "CircleAvatar", image: r.p.poster, icon: "list" },
      onTap: { event: "openSeries", arg: r.slug },
      onLongPress: { event: "borrarProg", arg: r.slug },
    });
  }
  return { type: "ListView", key: "hist", items: items };
}

// Tope de series por sección en el estado (que viaja en la pantalla):
// 18 al abrir + hasta 72 más con «Ver más».
const GENERO_MAX = 72;

// Selector de fuente (patrón de pestañas de MangaTrack): chips de
// selección única de Kino — la fuente activa queda resaltada y se
// cambia con un toque.
function chipsRow(state) {
  return {
    type: "SingleChildScrollView",
    key: "fuenteScroll",
    direction: "horizontal",
    padding: 8,
    children: [{
      type: "Chips", key: "fuente",
      options: SITES.map((s) => ({ value: s.id, label: s.name, labelEn: s.name })),
      value: siteDe(state).id,
      onChanged: { event: "fuenteSel" },
    }],
  };
}

// Una sección por género: tarjetas + «Ver más» al final. «usados» es
// el mapa compartido entre secciones: una serie que ya salió en una
// sección anterior NO se repite.
function railGenero(state, g, usados, siteId) {
  const cats = state.cats || {};
  const cat = cats[g.key] || null;
  if (!cat) {
    // aún sin cargar: esqueletos de la sección mientras llega el tick
    const sk = [];
    for (let i = 0; i < 6; i++) sk.push({
      type: "Card", key: g.key + "sk" + i, flush: true, children: [
        { type: "Skeleton", shape: "block", width: 120, height: 180 }] });
    return [
      { type: "Text", text: g.label, textEn: g.labelEn, style: "h3", padding: 16 },
      { type: "SingleChildScrollView", key: g.key + "skr", direction: "horizontal", padding: 16,
        children: [{ type: "Row", gap: 8, children: sk }] },
    ];
  }
  const items = Array.isArray(cat.items) ? cat.items : [];
  // la carga falló por completo: error VISIBLE con reintentar — nunca
  // una sección vacía ni esqueletos eternos
  if (cat.error && !items.length) {
    return [
      { type: "Text", text: g.label, textEn: g.labelEn, style: "h3", padding: 16 },
      filaError("No se pudo cargar esta sección.", "reintentarSeccion"),
    ];
  }
  const cards = [];
  for (const it of items.slice(0, 60)) {
    if (usados[it.slug]) continue;
    usados[it.slug] = true;
    cards.push(posterCard(it, "g" + g.key + "-", true, siteId));
  }
  if (!cards.length) return [];
  if (items.length < GENERO_MAX && !cat.error) {
    // botón «Ver más» al final de la sección
    cards.push({ type: "ElevatedButton", key: "vm-" + g.key, icon: "expand_more",
      labelText: "Ver más", labelTextEn: "See more",
      onPressed: { event: "verMas", arg: g.key } });
  }
  return [
    { type: "Text", text: g.label, textEn: g.labelEn, style: "h3", padding: 16 },
    { type: "SingleChildScrollView", key: "r-" + g.key, direction: "horizontal", padding: 16,
      children: [{ type: "Row", gap: 8, children: cards }] },
  ];
}

// El cuerpo de las pestañas ya NUNCA espera a la red. Pinta lo que
// haya en el estado y, si falta, esqueletos: el temporizador
// «cargarRoot» trae los datos en segundo plano.
function tabBody(state) {
  const tab = state.tab || "inicio";
  if (tab === "favoritos") return titleGridOf(favs(), null, false, true, EMPTY_FAV);
  if (tab === "historial") return historyList(state);
  if (tab === "biblioteca") {
    if (state.libError) {
      return filaError("No se pudo cargar la biblioteca. Comprueba tu conexión.", "reintentarLib");
    }
    const items = Array.isArray(state.libItems) ? state.libItems : null;
    if (!items) return skelGridNode(12);
    return titleGridOf(items, "libMore", state.libLoading === true, state.libDone === true);
  }
  // inicio
  const site = siteDe(state);
  const rail = (title, titleEn, key, list) => list.length ? [
    { type: "Text", text: title, textEn: titleEn, style: "h3", padding: 16 },
    { type: "SingleChildScrollView", key: key, direction: "horizontal", padding: 16,
      children: [{ type: "Row", gap: 8, children: list.slice(0, 60).map((it) => posterCard(it, key + "-", true, it.s)) }] },
  ] : [];
  const prog = progress();
  const leyendo = Object.keys(prog)
    .map((slug) => ({ slug: slug, title: prog[slug].title, poster: prog[slug].poster, ts: prog[slug].ts || 0 }))
    .filter((x) => x.title)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
  // secciones por género de la fuente activa, sin repetidos entre ellas
  const usados = {};
  let secciones = [];
  for (const g of site.sections) secciones = secciones.concat(railGenero(state, g, usados, site.id));
  return {
    type: "SingleChildScrollView", key: "home", flex: 1,
    children: [{
      type: "Column", children: [
        { type: "ListTile", key: "searchTile", leading: { type: "Icon", name: "search" },
          title: "Buscar cómic", titleEn: "Search a comic",
          subtitle: "Por título", subtitleEn: "By title",
          trailing: { type: "Icon", name: "arrow_forward" },
          onTap: { event: "goSearch" } },
        chipsRow(state),
      ].concat(rail("Seguir leyendo", "Continue reading", "leyendo", leyendo))
        .concat(rail("Mis favoritos", "My favourites", "favs", favs()))
        .concat(secciones),
    }],
  };
}

// Biblioteca: las series más recientes de la fuente activa, paginadas
async function fetchLibrary(site, page) {
  return getCards(site, page, "", null);
}

// ------------------------------------------------------------- rutas

function routeSlug(r) {
  if (!r) return "";
  return String((r.args && r.args.slug) || (r.params && r.params.slug) || r.slug || "");
}

function loadingTree(msg) {
  return { type: "Column", padding: 32, gap: 12, crossAxisAlignment: "center", children: [
    { type: "CircularProgressIndicator" },
    { type: "Text", text: msg || "Cargando…", textEn: "Loading…", color: "muted" },
  ] };
}

// Pantalla de error con reintentar: para fallos de red con tiempo límite
function errorTree(msg, retryEvent, extra) {
  const children = [
    { type: "Icon", name: "error", color: "muted" },
    { type: "Text", text: msg, textEn: msg, color: "muted", padding: { left: 16, right: 16 } },
    { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", labelTextEn: "Retry",
      onPressed: { event: retryEvent || "retry" } },
  ];
  if (extra) children.push(extra);
  return { type: "Column", padding: 32, gap: 12, crossAxisAlignment: "center", children: children };
}

// Detalle mientras la serie llega en segundo plano: esqueletos
// (receta MangaTrack) + temporizador «cargarSerie» + un botón
// «Cargar ahora» por si el Kino del teléfono no tuviera
// temporizadores de pantalla.
function detailLoadingTree(d) {
  const info = CARDINFO[d.slug] || {};
  const title = (d.meta && d.meta.title) || info.title || d.slug;
  const poster = (d.meta && d.meta.poster) || info.poster || "";
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ type: "Skeleton", key: "skr" + i, shape: "line", padding: 12 });
  }
  return {
    type: "Scaffold",
    every: { ms: 1000, event: "cargarSerie" },
    appBar: {
      title: title,
      leading: { type: "IconButton", key: "backHome", icon: "arrow_back",
        labelText: "Atrás", labelTextEn: "Back",
        onPressed: { event: "popBack" } },
      actions: [],
    },
    body: { type: "SingleChildScrollView", key: "detailLoading", children: [
      { type: "Column", children: [
        { type: "Row", gap: 16, padding: 16, crossAxisAlignment: "start", stackOnNarrow: true,
          children: [
            poster ? { type: "Image", url: poster, width: { compact: 120, expanded: 160 },
              aspect: "2:3", alt: title, fallback: { type: "Skeleton", shape: "block" } }
              : { type: "Skeleton", shape: "block", width: { compact: 120, expanded: 160 } },
            { type: "Column", gap: 6, flex: 2, crossAxisAlignment: "start", children: [
              { type: "Text", text: title, style: "h2" },
              { type: "Skeleton", shape: "line" },
              { type: "Skeleton", shape: "line" },
              { type: "Skeleton", shape: "line" },
              { type: "Text", text: "Cargando cómic…", textEn: "Loading comic…",
                color: "muted", style: "caption" },
              { type: "ElevatedButton", key: "loadNow", icon: "download",
                labelText: "Cargar ahora", labelTextEn: "Load now",
                onPressed: { event: "cargarSerieAhora" } },
            ] },
          ] },
        { type: "Skeleton", shape: "line", padding: 16 },
      ].concat(rows) },
    ] },
  };
}

// la sinopsis, plegada si es larga, con botón para extenderla
function sinopsisNode(state, overview) {
  const o = overview || "";
  const completa = state.sinopsisCompleta === true;
  if (o.length <= 240 || completa) {
    const children = [{ type: "Text", key: "sinopsisTxt", text: o, textEn: o, style: "p", color: "muted" }];
    if (o.length > 240) {
      children.push({ type: "TextButton", key: "sinMenos", icon: "expand_less",
        labelText: "Menos", labelTextEn: "Less", onPressed: { event: "toggleSinopsis" } });
    }
    return { type: "Column", key: "sinopsis", gap: 4, crossAxisAlignment: "start", children: children };
  }
  return { type: "Column", key: "sinopsis", gap: 4, crossAxisAlignment: "start", children: [
    { type: "Text", key: "sinopsisTxt",
      text: o.slice(0, 240).trim() + "…", textEn: o.slice(0, 240).trim() + "…",
      style: "p", color: "muted" },
    { type: "TextButton", key: "sinMas", icon: "expand_more",
      labelText: "Ver toda la sinopsis", labelTextEn: "Full synopsis",
      onPressed: { event: "toggleSinopsis" } },
  ] };
}

// lista de capítulos: hasta 300, cada uno abre el lector
function chapterList(site, slug) {
  const chapters = chaptersDe(site, slug) || [];
  if (!chapters.length) return null;
  const items = [];
  for (let i = 0; i < chapters.length && i < 300; i++) {
    const c = chapters[i];
    items.push({
      type: "ListTile", key: "ch-" + String(c.ch).replace(/[^a-z0-9]/gi, "-") + "-" + i,
      title: c.title || c.ch,
      leading: { type: "Icon", name: "menu_book" },
      trailing: { type: "Icon", name: "play_arrow" },
      onTap: { event: "openChapter", arg: c.url },
    });
  }
  return { type: "Column", key: "chapters", children: [
    { type: "Text", text: "Capítulos (" + chapters.length + ")", textEn: "Chapters (" + chapters.length + ")",
      style: "h3", padding: 16 },
  ].concat(items) };
}

async function detailTree(state) {
  const d = state.detail;
  if (!d) return loadingTree();
  if (d.loading) return detailLoadingTree(d);
  const fav = isFav(d.slug);
  // la carga falló (web caída, sin red, tiempo límite agotado): se
  // ofrece reintentar en vez del cargado eterno de antes
  if (d.error) {
    return errorTree("No se pudo cargar el cómic. Comprueba tu conexión e inténtalo de nuevo.", "reloadSeries",
      { type: "ElevatedButton", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back",
        onPressed: { event: "popBack" } });
  }
  // la lista de capítulos vive en kino.storage, no en el estado
  const site = siteOfId(d.siteId) || siteDe(state);
  const chapters = chaptersDe(site, d.slug) || [];
  if (!chapters.length) {
    return { type: "Column", padding: 32, gap: 12, crossAxisAlignment: "center", children: [
      { type: "Icon", name: "error", color: "muted" },
      { type: "Text", text: "No se encontraron capítulos para esta serie.", textEn: "No chapters found for this series.", color: "muted" },
      { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", labelTextEn: "Retry",
        onPressed: { event: "reloadSeries" } },
      { type: "ElevatedButton", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back",
        onPressed: { event: "popBack" } },
    ] };
  }
  const cover = d.meta.poster
    ? { type: "Image", url: d.meta.poster, width: { compact: 120, expanded: 160 },
        aspect: "2:3", alt: d.meta.title,
        fallback: { type: "Icon", name: "list" } }
    : { type: "Icon", name: "list" };
  const pg = progress()[d.slug];
  // botones en dos filas limpias, sin huecos (como ZonaTM0):
  //  - fila principal: Leer/Continuar a todo el ancho
  //  - fila secundaria compacta SOLO con iconos: Favoritos ·
  //    Actualizar · Olvidar lo leído (solo si hay progreso)
  const filaPrincipal = pg
    ? { type: "ElevatedButton", key: "cont", icon: "play",
        labelText: "Seguir leyendo", labelTextEn: "Continue reading",
        flex: 1, onPressed: { event: "read" } }
    : { type: "ElevatedButton", key: "start", icon: "play",
        labelText: "Leer primer capítulo", labelTextEn: "Read first chapter",
        flex: 1, onPressed: { event: "read" } };
  // fila secundaria SOLO con iconos (sin texto): el labelText queda
  // como etiqueta accesible/mando de TV, no se dibuja.
  const filaSecundaria = [
    { type: "IconButton", key: "fav", icon: fav ? "heart" : "star",
      labelText: fav ? "Quitar de favoritos" : "Añadir a favoritos",
      labelTextEn: fav ? "Remove favourite" : "Add favourite",
      onPressed: "fav" },
    // Actualizar: salta el caché y trae los capítulos de nuevo
    { type: "IconButton", key: "refresh", icon: "refresh",
      labelText: "Actualizar", labelTextEn: "Refresh",
      onPressed: "reloadSeries" },
  ];
  if (pg) {
    filaSecundaria.push({ type: "IconButton", key: "olvidar", icon: "delete",
      labelText: "Olvidar lo leído", labelTextEn: "Forget read progress",
      onPressed: { event: "borrarProg", arg: d.slug } });
  }
  const head = {
    type: "Row", gap: 16, padding: 16, crossAxisAlignment: "start", stackOnNarrow: true,
    children: [
      cover,
      { type: "Column", gap: 6, flex: 2, crossAxisAlignment: "start", children: [
        { type: "Text", text: d.meta.title || d.slug, style: "h2" },
        d.meta.overview ? sinopsisNode(state, d.meta.overview) : null,
        { type: "Text", key: "nchaps", text: chapters.length + " capítulos",
          textEn: chapters.length + " chapters", color: "muted", style: "caption" },
        // fila principal — leer, sin huecos
        { type: "Row", key: "filaLeer", gap: 8, children: [filaPrincipal] },
        // fila secundaria — gestión, sin huecos
        { type: "Row", key: "filaGestion", gap: 8,
          mainAxisAlignment: "center", children: filaSecundaria },
      ].filter(Boolean) },
    ],
  };
  const bodyChildren = [head];
  const cl = chapterList(site, d.slug);
  if (cl) bodyChildren.push(cl);
  return {
    type: "Scaffold",
    appBar: {
      title: d.meta.title || d.slug,
      leading: { type: "IconButton", key: "backHome", icon: "arrow_back",
        labelText: "Atrás", labelTextEn: "Back",
        onPressed: { event: "popBack" } },
      actions: [],
    },
    body: { type: "SingleChildScrollView", key: "detailBody", children: bodyChildren },
  };
}

// contador de aperturas del lector (claves únicas por apertura)
let navSeq = 0;

// Modo páginas (Kino 0.9.81, receta de MangaTrack)
function pagesDisponible() {
  try {
    return typeof kino === "object" && kino !== null &&
      typeof kino.screen === "object" && kino.screen !== null &&
      Array.isArray(kino.screen.widgets) &&
      kino.screen.widgets.indexOf("pages") >= 0;
  } catch (e) { return false; }
}

function modoLectorPref() {
  return getJson("modoLector", "tira") === "paginas" ? "paginas" : "tira";
}

function modoLectorEfectivo(n) {
  const puede = pagesDisponible() && n >= 2 && n <= 250;
  return puede && modoLectorPref() === "paginas" ? "paginas" : "tira";
}

function paginaFit(p, i, pre) {
  const k = (pre || "") + "p" + i;
  return { type: "SingleChildScrollView", key: k + "z", zoom: true, children: [
    { type: "Image", key: k, url: typeof p === "string" ? p : p.url,
      alt: "Página " + (i + 1), altEn: "Page " + (i + 1),
      fill: true, fit: "width", aspect: "2:3" } ] };
}

// barra fina SOLO para el modo páginas (no hay final de tira donde
// poner la tarjeta). Una sola fila: Volver.
function barraPaginas(r, n) {
  return {
    type: "Card", key: "panelLectura", margin: 8, padding: 8, gap: 8,
    children: [
      { type: "Row", gap: 8, children: [
        { type: "IconButton", key: "pbBack", icon: "arrow_back",
          labelText: "Volver al detalle", labelTextEn: "Back to details",
          onPressed: { event: "popBack" } },
        { type: "Text", key: "lblPos", flex: 1,
          text: "Página " + Math.min((r.pag || 0) + 1, n) + " de " + n,
          textEn: "Page " + Math.min((r.pag || 0) + 1, n) + " of " + n,
          style: "caption", color: "muted" },
      ] },
    ],
  };
}

// la ÚNICA barra de navegación del lector en modo tira — la tarjeta al
// final del capítulo. «Volver al detalle» y el cambio de modo si tu
// Kino admite el modo páginas.
function finCapNode(r, modo) {
  const children = [
    { type: "Row", gap: 8, children: [
      { type: "IconButton", key: "finBack", icon: "arrow_back",
        labelText: "Volver al detalle", labelTextEn: "Back to details",
        onPressed: { event: "popBack" } },
      { type: "Text", key: "finFin",
        text: "Fin del capítulo", textEn: "End of chapter",
        style: "caption", color: "muted", flex: 1 },
    ] },
  ];
  if (pagesDisponible()) {
    children.push({ type: "Row", gap: 8, mainAxisAlignment: "center", children: [
      { type: "TextButton", key: "finModo",
        labelText: modo === "paginas" ? "Modo páginas" : "Modo tira",
        labelTextEn: modo === "paginas" ? "Page mode" : "Strip mode",
        onPressed: "modoLector" },
    ] });
  }
  return { type: "Card", key: "finCap", margin: 16, padding: 12, gap: 8, children: children };
}

async function readerTree(state) {
  const r = state.reader;
  if (!r) return loadingTree();
  const pages = Array.isArray(r.imgs) ? r.imgs : [];
  if (!pages.length) {
    return { type: "Column", padding: 32, gap: 12, crossAxisAlignment: "center", children: [
      { type: "Icon", name: "error", color: "muted" },
      { type: "Text", text: "No se pudieron cargar las páginas de este capítulo.", textEn: "Could not load this chapter's pages.", color: "muted" },
      { type: "ElevatedButton", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back",
        onPressed: { event: "popBack" } },
    ] };
  }
  const chKey = String(r.slug).replace(/[^a-z0-9]/gi, "").slice(-16);
  const scrollKey = "pages-" + chKey + "-" + (r.tk || 0);
  const pre = "r" + (r.tk || 0) + "-"; // claves únicas por apertura
  const modo = modoLectorEfectivo(pages.length);
  // el lector es SIEMPRE pantalla completa — sin barra propia (queda
  // la de Kino con Cerrar/Atrás), sin botón flotante y sin panel
  // inferior. La navegación vive en la tarjeta del final.
  const body = [];
  if (modo === "paginas") {
    body.push({
      // clave única por apertura — el paginador arranca en la
      // página 1, sin restaurar la última vista.
      type: "pages", key: "pgs-" + (r.tk || 0), flex: 1, progress: "bar",
      children: pages.map((p, i) => paginaFit(p, i, pre)),
    });
    body.push(barraPaginas(r, pages.length));
  } else {
    body.push({
      type: "SingleChildScrollView", key: scrollKey, flex: 1, zoom: true,
      children: [{
        type: "Column", gap: 4, crossAxisAlignment: "center", fill: true,
        children: pages.flatMap((p, i) => pageNodes(p, i, pre))
          // la tarjeta del final es la ÚNICA barra de navegación.
          .concat([finCapNode(r, modo)]),
      }],
    });
  }
  return {
    type: "Scaffold",
    body: { type: "Column", children: body },
  };
}

async function searchTree(state) {
  const q = typeof state.resultsQ === "string" ? state.resultsQ : "";
  const results = Array.isArray(state.results) ? state.results : null;
  return {
    type: "Scaffold",
    appBar: { title: "Buscar cómic", titleEn: "Search a comic", actions: [] },
    body: {
      type: "SingleChildScrollView", key: "searchBody",
      children: [{
        type: "Column", children: [
          { type: "Form", key: "search", onSubmitted: "search", gap: 8, padding: 16, children: [
            { type: "TextField", key: "q", kind: "search", value: q,
              labelText: "Título", labelTextEn: "Title",
              hintText: "P. ej. Batman", hintEn: "e.g. Batman",
              required: true },
            { type: "ElevatedButton", icon: "search", labelText: "Buscar", labelTextEn: "Search", submit: true },
          ] },
          chipsRow(state),
          state.searchError
            ? filaError("No se pudo buscar. Comprueba tu conexión.", "reintentarSearch")
            : (results
              ? (results.length ? titleGridOf(results) : { type: "emptyState", icon: "search", title: "Sin resultados para «" + q + "».", titleEn: "No results." })
              : { type: "Text", text: "Escribe un título y pulsa Buscar.", textEn: "Type a title and press Search.", color: "muted", padding: 16 }),
        ].filter(Boolean),
      }],
    },
  };
}

// --------------------------------------------------------- los exports

export async function screen({ state, route }) {
  const r = route || { name: "home" };
  try {
    if (r.name === "detail") {
      const slug = routeSlug(r);
      if (!state.detail || state.detail.slug !== slug) {
        // el detalle del estado no es el de esta ruta; se pinta la
        // vista de esqueletos y el temporizador corrige el estado.
        return detailLoadingTree(detailLoadingDe(slug, state));
      }
      return await detailTree(state);
    }
    if (r.name === "read") return await readerTree(state);
    if (r.name === "search") return searchTree(state);
  } catch (e) {
    return errorTree("No se pudo cargar (" + (e.code || "error") + ").", "retry");
  }
  // ruta raíz: pestañas. Se pintan AL INSTANTE (caché o esqueletos) y
  // el temporizador «cargarRoot» trae lo que falte en segundo plano.
  return {
    type: "Scaffold",
    every: { ms: 1500, event: "cargarRoot" },
    appBar: {
      title: siteDe(state).name,
      actions: [
        { type: "IconButton", icon: "search", key: "goSearch", labelText: "Buscar", labelTextEn: "Search", onPressed: { event: "goSearch" } },
      ],
      bottom: {
        type: "TabBar", key: "tabs", tabs: TABS,
        value: state.tab || "inicio", onChanged: { event: "tab" },
      },
    },
    body: tabBody(state),
  };
}

// El detalle en carga: arranca en segundo plano y evita que dos cargas
// se pisen (temporizador + botón «Cargar ahora»).
let serieEnCarga = null;

// la serie que se está viendo AHORA. Un tick del temporizador que
// termine de cargar una serie anterior ya no debe sobrescribir el
// detalle: se compara contra esta variable al terminar la carga.
let slugDetalleActivo = null;

// un solo intento de carga de la raíz a la vez: si un tick tarda, los
// siguientes no se apilan (antes podían pisarse entre sí).
let rootEnCarga = false;

function detailLoadingDe(slug, state) {
  const info = CARDINFO[slug] || {};
  slugDetalleActivo = slug;
  return { slug: slug, siteId: (info && info.s) || (siteDe(state).id), loading: true,
    meta: { title: info.title || "", poster: info.poster || "" } };
}

export async function screenEvent(ev) {
  const name = ev.name;
  const state = ev.state || {};
  try {
    if (name === "open") {
      syncPull();
      const r = ev.route || {};
      if (r.name === "detail") {
        const slug = routeSlug(r);
        if (slug && slugValido(slug) && (!state.detail || state.detail.slug !== slug)) {
          // no se bloquea; el detalle se pinta ya con esqueletos y el
          // temporizador «cargarSerie» trae los capítulos.
          return { state: { detail: detailLoadingDe(slug, state) } };
        }
      }
      return null;
    }
    // cambiar de fuente (chips): se limpian Inicio y Biblioteca; el
    // temporizador las vuelve a traer de la fuente nueva.
    if (name === "fuente" || name === "fuenteSel") {
      const raw = ev.value;
      const id = String(typeof raw === "string" ? raw
        : (raw && (raw.fuente || raw.value)) || ev.arg || "");
      if (!SITES.some((s) => s.id === id)) return null;
      if (siteDe(state).id === id) return null;
      return { state: { fuente: id, cats: {}, libItems: null, libPage: 1,
        libError: false, libDone: false, libLoading: false },
        toast: "Fuente: " + siteOfId(id).name };
    }
    if (name === "tab") {
      // cambiar de pestaña no espera a la red; si falta la lista, el
      // temporizador la trae.
      return { state: { tab: ev.value } };
    }
    // temporizador de la raíz: trae Inicio/Biblioteca en segundo plano
    if (name === "cargarRoot") {
      if (rootEnCarga) return null;
      const tab = state.tab || "inicio";
      const site = siteDe(state);
      if (tab === "biblioteca") {
        if (Array.isArray(state.libItems)) return null;
        rootEnCarga = true;
        try {
          const items = await fetchLibrary(site, 1);
          return { state: { libItems: items, libPage: 1, libError: false, libDone: items.length < PER_PAGE } };
        } catch (e) {
          return { state: { libError: true } };
        } finally {
          rootEnCarga = false;
        }
      }
      if (tab === "inicio") {
        // UNA sección por tick — la pantalla nunca se bloquea
        const cats = state.cats || {};
        for (const g of site.sections) {
          if (!cats[g.key] || (cats[g.key] && cats[g.key].error)) {
            rootEnCarga = true;
            let items = [], fallo = false;
            try {
              items = await getCards(site, 1, "", g);
            } catch (e) { fallo = true; } finally { rootEnCarga = false; }
            return { state: { cats: Object.assign({}, cats, { [g.key]: { items: items, page: 1, error: fallo } }) } };
          }
        }
        return null;
      }
      return null;
    }
    // reintentar una sección que falló (borra su estado; el siguiente
    // tick del temporizador la vuelve a cargar)
    if (name === "reintentarSeccion") {
      const cats = state.cats || {};
      const limpio = {};
      for (const k of Object.keys(cats)) {
        if (cats[k] && cats[k].error && !(cats[k].items || []).length) continue;
        limpio[k] = cats[k];
      }
      return { state: { cats: limpio } };
    }
    // reintentar la Biblioteca
    if (name === "reintentarLib") {
      return { state: { libError: false, libItems: null } };
    }
    // reintentar la búsqueda (repite la última consulta)
    if (name === "reintentarSearch") {
      const q = typeof state.resultsQ === "string" ? state.resultsQ : "";
      if (!q) return null;
      try {
        const results = await getCards(siteDe(state), 1, q, null);
        return { state: { results: results, searchError: false },
          toast: results.length ? results.length + " resultados" : "Sin resultados" };
      } catch (e) {
        return { state: { searchError: true }, toast: "Error de conexión. Inténtalo de nuevo." };
      }
    }
    // temporizador del detalle: carga la serie en segundo plano
    if (name === "cargarSerie" || name === "cargarSerieAhora") {
      const d = state.detail;
      if (!d) return null;
      // autocuración — si el detalle del estado no es el que se está
      // viendo (quedó el de la serie anterior), se corrige aquí y el
      // siguiente tick lo carga.
      if (slugDetalleActivo && d.slug !== slugDetalleActivo) {
        return { state: { detail: detailLoadingDe(slugDetalleActivo, state) } };
      }
      if (!d.loading) return null;
      if (serieEnCarga === d.slug && name === "cargarSerie") return null;
      serieEnCarga = d.slug;
      slugDetalleActivo = d.slug;
      try {
        // refresh=true salta el caché (botón «Actualizar»/«Reintentar»)
        const res = await cargarDetalle(state, d.slug, d.refresh === true);
        // mientras cargaba esta serie se abrió otra — el resultado ya
        // no vale y NO se aplica.
        if (slugDetalleActivo !== d.slug) return null;
        return res;
      } finally {
        serieEnCarga = null;
      }
    }
    if (name === "libMore") {
      const page = (state.libPage || 1) + 1;
      const more = await fetchLibrary(siteDe(state), page);
      let merged = (state.libItems || []).concat(more.filter((x) => !(state.libItems || []).some((y) => y.slug === x.slug)));
      if (merged.length > LIB_MAX) merged = merged.slice(0, LIB_MAX);
      return { state: { libItems: merged, libPage: page, libDone: more.length < PER_PAGE || merged.length >= LIB_MAX } };
    }
    if (name === "goSearch") return { route: { push: "search" } };
    if (name === "popBack") return { route: { pop: true } };
    if (name === "search") {
      const q = String(ev.value && ev.value.q || "").trim();
      if (!q) return { toast: "Escribe un título." };
      let results;
      try {
        results = await getCards(siteDe(state), 1, q, null);
      } catch (e) {
        // fallo de conexión: error VISIBLE con reintentar — nunca
        // «sin resultados», que confunde
        return { state: { searchError: true, resultsQ: q },
          toast: "Error de conexión. Inténtalo de nuevo." };
      }
      return { state: { results: results, resultsQ: q, searchError: false },
        toast: results.length ? results.length + " resultados" : "Sin resultados para «" + q + "»" };
    }
    if (name === "retry") return { state: { _r: Date.now() } };
    // «Ver más» al final de una sección — trae más series de esa
    // sección y las añade.
    if (name === "verMas") {
      const key = String(ev.arg || "");
      const site = siteDe(state);
      const g = site.sections.find((x) => x.key === key);
      const cats = state.cats || {};
      const cat = cats[key];
      if (!g || !cat) return null;
      if (cat.items.length >= GENERO_MAX) return { toast: "La sección ya está completa" };
      const page = (cat.page || 1) + 1;
      try {
        const more = await getCards(site, page, "", g);
        const vistos = {};
        for (const it of cat.items) vistos[it.slug] = true;
        const nuevos = more.filter((it) => !vistos[it.slug]);
        if (!nuevos.length) return { toast: "No hay más series en " + g.label };
        let merged = cat.items.concat(nuevos);
        if (merged.length > GENERO_MAX) merged = merged.slice(0, GENERO_MAX);
        return { state: { cats: Object.assign({}, cats, { [key]: { items: merged, page: page } }) },
          toast: "+" + nuevos.length + " en " + g.label };
      } catch (e) {
        return { toast: "No se pudo cargar más. Inténtalo otra vez." };
      }
    }
    // plegar/desplegar la sinopsis del detalle
    if (name === "toggleSinopsis") {
      return { state: { sinopsisCompleta: state.sinopsisCompleta !== true } };
    }
    // quitar UN cómic de «Seguir leyendo»/Historial (botón «Olvidar
    // lo leído» del detalle o pulsación larga en Historial)
    if (name === "borrarProg") {
      let slug = String(ev.arg || "");
      if (!slug && state.detail) slug = state.detail.slug;
      if (!slugValido(slug)) return null;
      if (!borrarProgreso(slug)) return null;
      return { state: { _r: Date.now() },
        toast: "Quitado de «Seguir leyendo»" };
    }
    // vaciar TODO «Seguir leyendo»/Historial (dos toques para
    // confirmar; el primero solo cambia el texto del botón)
    if (name === "clearHist") {
      if (!state.confBorrar) {
        return { state: { confBorrar: true },
          toast: "Toca otra vez para borrar TODO el historial" };
      }
      borrarTodoProgreso();
      return { state: { confBorrar: false },
        toast: "Historial y «Seguir leyendo» borrados" };
    }
    // Reintentar / Actualizar en el detalle: vuelve a la vista de
    // esqueletos (sin bloquear) y el temporizador recarga saltando el
    // caché (refresh=true).
    if (name === "reloadSeries") {
      const d = state.detail;
      if (!d) return null;
      return { state: { detail: { slug: d.slug, loading: true, refresh: true,
        meta: d.meta || {} } } };
    }
    if (name === "fav") {
      const d = state.detail;
      if (!d) return null;
      const f = favs();
      const i = f.findIndex((x) => x.slug === d.slug);
      let added = false;
      if (i >= 0) f.splice(i, 1);
      else { f.unshift({ slug: d.slug, title: d.meta.title || d.slug, poster: d.meta.poster,
        s: d.siteId || siteDe(state).id,
        u: (CARDINFO[d.slug] && CARDINFO[d.slug].u) || "" }); added = true; }
      setJson("favs", f);
      syncPush("favs", f);
      return { toast: added ? "Añadido a favoritos" : "Quitado de favoritos" };
    }
    // abrir un capítulo concreto: carga sus páginas y abre el lector.
    if (name === "openChapter") {
      const d = state.detail;
      if (!d) return null;
      const site = siteOfId(d.siteId) || siteDe(state);
      const arg = String(ev.arg || "");
      try {
        let images = readerCache(arg);
        if (!Array.isArray(images) || !images.length) {
          if (site.type === "md") {
            // arg = UUID del capítulo
            if (!slugValido(arg)) return null;
            images = await mdPages(site, arg);
          } else {
            // arg = URL del episodio
            if (arg.indexOf("http") !== 0) return null;
            images = await wtPages(site, arg);
          }
          if (images.length) readerCachePut(arg, images);
        }
        if (!images.length) return { toast: "No se encontraron páginas en este capítulo." };
        const chapters = chaptersDe(site, d.slug) || [];
        const ch = chapters.find((c) => c.url === arg);
        const chTitle = ch ? ch.title : (site.type === "md" ? "Capítulo" : "Episodio");
        markRead(d.slug, d.meta.title, d.meta.poster, chTitle, arg, site.id);
        const reader = { slug: d.slug, title: d.meta.title, poster: d.meta.poster,
          chUrl: arg, chTitle: chTitle, imgs: images, tk: ++navSeq };
        return { state: { reader: reader }, route: { push: "read" } };
      } catch (e) {
        return { toast: "No se pudo cargar el capítulo. Inténtalo de nuevo." };
      }
    }
    if (name === "read") {
      // abre el lector con TODAS las páginas del capítulo (de
      // kino.storage o de la red). «Seguir leyendo» retoma el último
      // capítulo abierto; si no, el primero.
      const d = state.detail;
      if (!d) return null;
      const site = siteOfId(d.siteId) || siteDe(state);
      const chapters = chaptersDe(site, d.slug) || [];
      if (!chapters.length) return { toast: "No se encontraron capítulos." };
      const pg = progress()[d.slug];
      let target = chapters[0];
      if (pg && pg.url) {
        const i = chapters.findIndex((c) => c.url === pg.url);
        if (i >= 0) target = chapters[i];
      }
      // reutiliza openChapter con el capítulo elegido
      return await screenEvent({ name: "openChapter", state: state, arg: target.url });
    }
    if (name === "modoLector") {
      if (!pagesDisponible()) return null;
      const nuevo = modoLectorPref() === "paginas" ? "tira" : "paginas";
      setJson("modoLector", nuevo);
      return { state: { _r: Date.now() },
        toast: nuevo === "paginas" ? "Modo páginas" : "Modo tira" };
    }
    if (name === "openSeries") {
      const slug = String(ev.arg || "");
      if (!slugValido(slug)) return null;
      // (receta MangaTrack): el detalle se abre AL INSTANTE con
      // esqueletos; los capítulos llegan por el temporizador en
      // segundo plano. La fuente de la serie: la guardada con la
      // tarjeta/favorito/historial; si no, la activa.
      const siteId = (CARDINFO[slug] && CARDINFO[slug].s) ||
        (progress()[slug] && progress()[slug].s) ||
        (favs().find((f) => f.slug === slug) || {}).s || siteDe(state).id;
      return { state: { detail: detailLoadingDe(slug, { fuente: siteId }) },
               route: { push: "detail", params: { slug: slug } } };
    }
  } catch (e) {
    return { toast: "Algo falló: " + (e.code || "error") };
  }
  return null;
}
