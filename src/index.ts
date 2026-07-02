interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Germany public procurement MCP — official German government tenders (keyless).
 *
 * Wraps the "Datenservice Öffentliche Beschaffung" open-data feed published by
 * the German federal Bekanntmachungsservice at https://oeffentlichevergabe.de.
 * The feed is Open Contracting Data Standard (OCDS), CC0-licensed, publisher
 * scheme `ocds-mnwr74`.
 *
 * The ONLY endpoint the service exposes is a bulk export:
 *   GET /api/notice-exports?pubDay=YYYY-MM-DD&format=ocds.zip
 *   GET /api/notice-exports?pubMonth=YYYY-MM&format=ocds.zip
 * It returns a ZIP archive containing one OCDS release-package JSON per notice
 * (there is no server-side keyword/value search). This pack fetches the daily
 * ZIP(s) for the requested date range, unzips them in-memory (Workers-native
 * DecompressionStream, no deps), and applies keyword/date filtering + shaping
 * client-side. To keep latency and payload bounded, a date range is capped to a
 * small number of days per call.
 *
 * All tools return shaped, LLM-friendly objects (not raw OCDS passthrough) and
 * never throw — fetch/parse failures resolve to { error }.
 */


const BASE = 'https://oeffentlichevergabe.de';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
// Cap how many daily ZIPs we fetch per call — each ZIP is ~1-3MB / ~50 notices.
const MAX_DAYS = 7;
const DEFAULT_DAYS = 30; // default lookback window (clamped to MAX_DAYS of fetches, most-recent-first)

const tools: McpToolExport['tools'] = [
  {
    name: 'germany_search_tenders',
    description:
      'Search official GERMAN government public-procurement tenders (Öffentliche Vergabe / Ausschreibungen) from the federal Bekanntmachungsservice open-data feed (oeffentlichevergabe.de), Open Contracting Data Standard (OCDS). Returns each notice shaped: ocid, title, buyer/Vergabestelle, contract value in EUR, procurement category, CPV code, procurement method, submission deadline, and publish date. Filter by publish-date range and/or a keyword (matched against title, description, buyer, and CPV description — German text). Defaults to the most recent days if no dates given. Data covers Germany only.',
    inputSchema: {
      type: 'object',
      properties: {
        date_from: {
          type: 'string',
          description: 'Earliest PUBLISH date to include, YYYY-MM-DD. Defaults to ~30 days ago (only the most recent 7 days of that window are fetched per call — narrow the range for older notices).',
        },
        date_to: {
          type: 'string',
          description: 'Latest PUBLISH date to include, YYYY-MM-DD. Defaults to today.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword to filter on (case-insensitive substring match against title, description, buyer name, and CPV description — German). Omit to return all notices in the date range. E.g. "Bauarbeiten", "Software", "Reinigung".',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Max number of tenders to return (default 25, max 100). Results are newest-first.',
        },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'germany_search_tenders':
        return await searchTenders(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const now = new Date();
  const dateTo = parseDate(strArg(args.date_to)) ?? now;
  const dateFrom = parseDate(strArg(args.date_from)) ?? new Date(now.getTime() - DEFAULT_DAYS * 86400000);
  if (dateFrom.getTime() > dateTo.getTime()) {
    return { error: 'date_from must be on or before date_to.' };
  }
  const query = strArg(args.query)?.toLowerCase();
  const limit = Math.min(Math.max(intArg(args.limit) ?? 25, 1), 100);

  // Build the list of days to fetch, newest-first, capped at MAX_DAYS.
  const days = enumerateDays(dateFrom, dateTo).reverse().slice(0, MAX_DAYS);
  const fetchedDays: string[] = [];
  const errors: string[] = [];
  const tenders: ShapedTender[] = [];

  for (const day of days) {
    if (tenders.length >= limit) break;
    let releases: OcdsRelease[];
    try {
      releases = await fetchDayReleases(day);
      fetchedDays.push(day);
    } catch (e) {
      errors.push(`${day}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const rel of releases) {
      const shaped = shapeRelease(rel);
      if (!shaped) continue;
      if (query && !matchesQuery(shaped, query)) continue;
      tenders.push(shaped);
    }
  }

  // Sort newest publish date first, then trim to limit.
  tenders.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  const trimmed = tenders.slice(0, limit).map(({ _description, ...rest }) => rest);

  const truncatedRange = enumerateDays(dateFrom, dateTo).length > MAX_DAYS;
  return {
    source: 'oeffentlichevergabe.de (Bekanntmachungsservice, OCDS, CC0)',
    country: 'Germany',
    date_from: fmtDate(dateFrom),
    date_to: fmtDate(dateTo),
    days_fetched: fetchedDays,
    ...(query ? { query: strArg(args.query) } : {}),
    count: trimmed.length,
    tenders: trimmed,
    ...(truncatedRange
      ? { note: `Only the most recent ${MAX_DAYS} day(s) of the requested range were fetched (per-call cap). Narrow date_from/date_to to reach older notices.` }
      : {}),
    ...(errors.length ? { fetch_errors: errors } : {}),
  };
}

interface ShapedTender {
  ocid: string;
  title?: string;
  buyer?: string;
  buyer_location?: string;
  value_eur?: number;
  currency?: string;
  category?: string;
  cpv?: string;
  cpv_description?: string;
  procurement_method?: string;
  status?: string;
  published?: string;
  deadline?: string;
  _description?: string; // internal, for query matching only (stripped from output)
}

function shapeRelease(rel: OcdsRelease): ShapedTender | null {
  if (!rel?.ocid) return null;
  const t = rel.tender ?? {};
  const buyer = rel.buyer ?? t.procuringEntity ?? {};
  const value = t.value ?? firstLotValue(t);
  const cpv = firstCpv(t);
  const buyerLocation = buyer.address
    ? [buyer.address.locality, buyer.address.countryName].filter(Boolean).join(', ') || undefined
    : undefined;
  // Build with only the fields that are present, for a clean payload.
  const shaped: ShapedTender = { ocid: rel.ocid };
  const set = <K extends keyof ShapedTender>(k: K, v: ShapedTender[K]): void => {
    if (v !== undefined && v !== null && (v as unknown) !== '') shaped[k] = v;
  };
  set('title', t.title);
  set('buyer', buyer.name);
  set('buyer_location', buyerLocation);
  set('value_eur', value?.currency === 'EUR' ? value.amount : undefined);
  set('currency', value?.currency);
  set('category', t.mainProcurementCategory);
  set('cpv', cpv?.id);
  set('cpv_description', cpv?.description);
  set('procurement_method', t.procurementMethodDetails ?? t.procurementMethod);
  set('status', t.status);
  set('published', rel.date);
  set('deadline', t.tenderPeriod?.endDate);
  // _description is kept only for query matching; stripped before output.
  set('_description', t.description);
  return shaped;
}

function matchesQuery(s: ShapedTender, q: string): boolean {
  const hay = [s.title, s._description, s.buyer, s.cpv_description, s.cpv].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function firstLotValue(t: OcdsTender): OcdsValue | undefined {
  for (const lot of t.lots ?? []) if (lot.value) return lot.value;
  return undefined;
}

function firstCpv(t: OcdsTender): OcdsClassification | undefined {
  for (const it of t.items ?? []) {
    const c = it.classification;
    if (c && (c.scheme === 'CPV' || c.scheme === 'cpv') && c.id) return c;
  }
  // fall back to any classification with an id
  for (const it of t.items ?? []) {
    if (it.classification?.id) return it.classification;
  }
  return undefined;
}

// --- Fetch + unzip a single day's OCDS export ------------------------------

async function fetchDayReleases(day: string): Promise<OcdsRelease[]> {
  const url = `${BASE}/api/notice-exports?pubDay=${encodeURIComponent(day)}&format=ocds.zip`;
  const res = await fetch(url, { headers: { Accept: '*/*', 'User-Agent': UA } });
  if (!res.ok) {
    const body = await res.text().then((b) => b.slice(0, 200)).catch(() => '');
    throw new Error(`notice-exports ${res.status} ${body}`.trim());
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const files = await unzipAll(bytes);
  const releases: OcdsRelease[] = [];
  for (const raw of files) {
    let pkg: OcdsPackage;
    try {
      pkg = JSON.parse(raw) as OcdsPackage;
    } catch {
      continue; // skip malformed entries rather than fail the whole day
    }
    for (const rel of pkg.releases ?? []) releases.push(rel);
  }
  return releases;
}

// --- Minimal, dependency-free multi-file ZIP reader (CF Workers-native) -----
// Parses the End-of-Central-Directory + Central Directory to enumerate every
// entry, then inflates each via DecompressionStream('deflate-raw'). Handles
// stored (0) + deflate (8); skips directories and anything unexpected.

async function unzipAll(bytes: Uint8Array): Promise<string[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find End Of Central Directory record (sig 0x06054b50), searching backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP: no End Of Central Directory record found');
  const total = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  const out: string[] = [];
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(cdOffset, true) !== 0x02014b50) break; // central dir file header sig
    const method = dv.getUint16(cdOffset + 10, true);
    const compSize = dv.getUint32(cdOffset + 20, true);
    const fnLen = dv.getUint16(cdOffset + 28, true);
    const extraLen = dv.getUint16(cdOffset + 30, true);
    const commentLen = dv.getUint16(cdOffset + 32, true);
    const localOffset = dv.getUint32(cdOffset + 42, true);
    const nameBytes = bytes.subarray(cdOffset + 46, cdOffset + 46 + fnLen);
    const name = dec.decode(nameBytes);
    cdOffset += 46 + fnLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (compSize === 0 && method === 0) continue;

    // Read the local file header to find where the payload actually starts
    // (local extra length can differ from central extra length).
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lFnLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lFnLen + lExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compSize);

    let text: string;
    if (method === 0) {
      text = dec.decode(payload);
    } else if (method === 8) {
      text = await inflateRaw(payload, dec);
    } else {
      continue; // unsupported method
    }
    out.push(text);
  }
  return out;
}

async function inflateRaw(payload: Uint8Array, dec: TextDecoder): Promise<string> {
  // Wrap the bytes in a one-shot ReadableStream and inflate via the
  // Workers-native DecompressionStream (same pattern as workers/data-pipeline).
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const stream = src.pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return dec.decode(merged);
}

// --- OCDS types (partial, only the fields we shape) ------------------------

interface OcdsPackage {
  releases?: OcdsRelease[];
}
interface OcdsRelease {
  ocid?: string;
  date?: string;
  tender?: OcdsTender;
  buyer?: OcdsParty;
}
interface OcdsTender {
  title?: string;
  description?: string;
  status?: string;
  value?: OcdsValue;
  mainProcurementCategory?: string;
  procurementMethod?: string;
  procurementMethodDetails?: string;
  procuringEntity?: OcdsParty;
  items?: { classification?: OcdsClassification }[];
  lots?: { value?: OcdsValue }[];
  tenderPeriod?: { endDate?: string };
}
interface OcdsParty {
  name?: string;
  address?: { locality?: string; countryName?: string };
}
interface OcdsValue {
  amount?: number;
  currency?: string;
}
interface OcdsClassification {
  scheme?: string;
  id?: string;
  description?: string;
}

// --- helpers ---------------------------------------------------------------

function enumerateDays(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cur.getTime() <= end) {
    out.push(fmtDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function intArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && v.trim() && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return undefined;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
