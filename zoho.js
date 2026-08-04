// ─────────────────────────────────────────────────────────────
//  ZOHO API CLIENT — Recruit (pull) + Zoho Sheet (merge + push)
//  All auth is handled server-side by the Cloudflare Worker
//  (CONFIG.PROXY). No tokens are ever handled in the browser.
// ─────────────────────────────────────────────────────────────
const Zoho = (() => {

  const PROXY = CONFIG.PROXY;

  // ═══════════════════════════════════════════════════════════
  //  ZOHO RECRUIT
  // ═══════════════════════════════════════════════════════════

  async function recruitGet(endpoint, params = {}) {
    const url = new URL(`${PROXY}/recruit/v2/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    // no-store: never let the browser serve a stale proxy response from its
    // HTTP cache — data freshness is the whole point of this dashboard.
    const resp = await fetch(url.toString(), { cache: 'no-store' });
    // Zoho returns 204 (no content) for a page past the last one.
    if (resp.status === 204) return { data: [], info: { more_records: false } };
    if (!resp.ok) throw new Error(`RECRUIT_API_ERROR_${resp.status}`);
    const text = await resp.text();
    return text ? JSON.parse(text) : { data: [], info: { more_records: false } };
  }

  async function recruitPut(endpoint, body) {
    const resp = await fetch(`${PROXY}/recruit/v2/${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`RECRUIT_PUT_ERROR_${resp.status}`);
    return resp.json();
  }

  // Pull every record from the custom Recruit module (paginated).
  // onProgress(fraction 0..1) is called after each page so the UI can show a
  // determinate load bar. The total is unknown up front, so we estimate it from
  // the last known record count (persisted in localStorage).
  async function getRecruitRecords(onProgress) {
    const module = CONFIG.RECRUIT_MODULE;
    const F      = CONFIG.FIELDS;
    const fields = Object.values(F).join(',');
    const PER_PAGE = 200;
    const known = Number(localStorage.getItem('cti_indo_reccount')) || 0;
    const estPages = known ? Math.max(1, Math.ceil(known / PER_PAGE)) : 0;
    // Sequential paging — reliable (concurrent paging silently truncated
    // the result). Speed on refresh comes from the IndexedDB cache instead.
    let all = [], page = 1, more = true;
    while (more) {
      const data = await recruitGet(module, { fields, page, per_page: PER_PAGE });
      all  = all.concat(data.data || []);
      more = data.info?.more_records === true;
      // Report progress: real fraction vs. the estimate, capped below 1 so the
      // bar never claims "done" before the fetch actually finishes.
      if (onProgress && estPages) onProgress(Math.min(page / estPages, 0.95));
      page++;
      if (all.length > 50000) break;   // safety cap
    }
    localStorage.setItem('cti_indo_reccount', String(all.length));

    const val = v => {
      if (v == null || v === '') return '—';
      // Multi-select fields (e.g. Vaccines_Status) come back as arrays.
      if (Array.isArray(v)) {
        const s = v.filter(x => x != null && x !== '').join(', ');
        return s || '—';
      }
      return (typeof v === 'object' ? (v.name ?? v.value ?? '—') : v);
    };

    return all.map(r => ({
      _source:          'recruit',
      id:               r.id,
      name:             [r[F.firstName], r[F.lastName]].filter(Boolean).join(' ') || '—',
      firstName:        val(r[F.firstName]),
      lastName:         val(r[F.lastName]),
      email:            val(r[F.email]),
      mobile:           val(r[F.mobile]),
      gender:           val(r[F.gender]),
      dateOfBirth:      r[F.dateOfBirth]  || null,
      age:              val(r[F.age]),
      seafarerId:       val(r[F.seafarerId]),
      crewIdNumber:     val(r[F.crewIdNumber]),
      // Location
      country:          val(r[F.country]),
      city:             val(r[F.city]),
      state:            val(r[F.state]),
      ctiOffice:        val(r[F.ctiOffice]),
      origin:           val(r[F.origin]),
      // Pipeline
      status:           val(r[F.status]),
      crewStatus:       val(r[F.crewStatus]),
      crewMemberStatus: val(r[F.crewMemberStatus]),
      employmentStatus: val(r[F.employmentStatus]),
      onboardingStatus: val(r[F.onboardingStatus]),
      rescheduledDate:  r[F.rescheduledDate] || null,
      delayReason:      val(r[F.delayReason]),
      // Role / placement
      department:       val(r[F.department]),
      position:         val(r[F.position]),
      currentJobTitle:  val(r[F.currentJobTitle]),
      cruiseLine:       val(r[F.cruiseLine]),
      joiningShip:      val(r[F.joiningShip]),
      signOnDate:       r[F.signOnDate]   || null,
      signOffDate:      r[F.signOffDate]  || null,
      signOnPort:       val(r[F.signOnPort]),
      hiredDate:        r[F.hiredDate]    || null,
      contractNumber:   val(r[F.contractNumber]),
      source:           val(r[F.source]),
      // People
      owner:            val(r[F.owner]),
      recruiter:        val(r[F.recruiter]),
      // Documents
      passportStatus:   val(r[F.passportStatus]),
      passportNumber:   val(r[F.passportNumber]),
      passportExpiry:   r[F.passportExpiry] || null,
      medicalStatus:    val(r[F.medicalStatus]),
      medicalExpiry:    r[F.medicalExpiry]  || null,
      bstStatus:        val(r[F.bstStatus]),
      bstNumber:        val(r[F.bstNumber]),
      bstExpiry:        r[F.bstExpiry]        || null,
      seamanBookStatus: val(r[F.seamanBookStatus]),
      seamanBookNumber: val(r[F.seamanBookNumber]),
      seamanBookExpiry: r[F.seamanBookExpiry] || null,
      vaccinesStatus:   val(r[F.vaccinesStatus]),
      // Per-visa-type (VISA page)
      c1dVisaStatus:      val(r[F.c1dVisaStatus]),
      c1dVisaNumber:      val(r[F.c1dVisaNumber]),
      c1dVisaAppointment: r[F.c1dVisaAppointment] || null,
      c1dVisaExpiry:      r[F.c1dVisaExpiry]      || null,
      mcvStatus:          val(r[F.mcvStatus]),
      mcvNumber:          val(r[F.mcvNumber]),
      mcvExpiry:          r[F.mcvExpiry]          || null,
      mcvPassportNumber:  val(r[F.mcvPassportNumber]),
      oktbStatus:         val(r[F.oktbStatus]),
      otherVisaStatus:      val(r[F.otherVisaStatus]),
      otherVisaName:        val(r[F.otherVisaName]),
      otherVisaNumber:      val(r[F.otherVisaNumber]),
      otherVisaAppointment: r[F.otherVisaAppointment] || null,
      otherVisaExpiry:      r[F.otherVisaExpiry]      || null,
      otherVisaIssuedDate:  r[F.otherVisaIssuedDate]  || null,
      // Expected-ready dates (Pending Action section).
      passportExpectedDate:   r[F.passportExpectedDate]   || null,
      bstExpectedDate:        r[F.bstExpectedDate]        || null,
      seamanBookExpectedDate: r[F.seamanBookExpectedDate] || null,
      medicalExpectedDate:    r[F.medicalExpectedDate]    || null,
      c1dExpectedDate:        r[F.c1dExpectedDate]        || null,
      otherVisaExpectedDate:  r[F.otherVisaExpectedDate]  || null,
      mcvExpectedDate:        r[F.mcvExpectedDate]        || null,
      oktbRequestedDate:      r[F.oktbRequestedDate]      || null,
      // Timestamps
      createdDate:      r[F.createdDate]  || null,
      modifiedDate:     r[F.modifiedDate] || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  ZOHO SHEET  (form-encoded POST API v2)
  //  Docs: https://www.zoho.com/sheet/help/api/v2-data-api.html
  //  Every call targets ONE sheet config from CONFIG.SHEETS.
  // ═══════════════════════════════════════════════════════════

  async function sheetCall(sheet, method, extra = {}) {
    const body = new URLSearchParams({
      method,
      worksheet_name: sheet.worksheet,
      header_row: String(sheet.headerRow ?? 1),
      ...extra,
    });
    const resp = await fetch(`${PROXY}/sheet/v2/${sheet.resourceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`SHEET_API_ERROR_${resp.status}`);
    const json = await resp.json();
    if (json.status && json.status !== 'success') {
      throw new Error(`SHEET_${json.error_code || 'ERR'}: ${json.error_message || 'unknown'}`);
    }
    return json;
  }

  // Read all rows of a sheet as objects keyed by column header.
  async function getSheetRecords(sheet) {
    const json = await sheetCall(sheet, 'worksheet.records.fetch');
    return json.records || [];
  }

  // The value on a record used to join to a given sheet.
  // '—' (our empty placeholder) is treated as no key, so blank records
  // never collide on a shared key.
  function matchValue(rec, sheet) {
    const v = String(rec[sheet.matchOn] ?? '').trim();
    return (v === '—') ? '' : v.toLowerCase();
  }

  // ═══════════════════════════════════════════════════════════
  //  MERGE — Recruit records + every sheet in CONFIG.SHEETS
  // ═══════════════════════════════════════════════════════════

  async function getAllRecords(onProgress) {
    const sheets = CONFIG.SHEETS || [];
    const [recruitRes, ...sheetRes] = await Promise.allSettled([
      getRecruitRecords(onProgress),
      ...sheets.map(s => getSheetRecords(s)),
    ]);

    const recruit = recruitRes.status === 'fulfilled' ? recruitRes.value : [];
    if (recruitRes.status === 'rejected')
      console.error('❌ Recruit fetch failed:', recruitRes.reason?.message);

    // Build a per-sheet index: sheet.key -> { matchValue -> row }.
    const indexes = {};
    sheets.forEach((sheet, i) => {
      const res = sheetRes[i];
      if (res.status === 'rejected') {
        console.error(`❌ Sheet "${sheet.label}" fetch failed:`, res.reason?.message);
        indexes[sheet.key] = {};
        return;
      }
      const byKey = {};
      for (const row of res.value) {
        const k = String(row[sheet.keyColumn] ?? '').trim().toLowerCase();
        if (k) byKey[k] = row;
      }
      indexes[sheet.key] = byKey;
      console.log(`✅ Sheet "${sheet.label}": ${res.value.length} rows`);
    });

    const merged = recruit.map(rec => {
      const out = { ...rec, _sheetRows: {} };
      for (const sheet of sheets) {
        const row = indexes[sheet.key][matchValue(rec, sheet)];
        out._sheetRows[sheet.key] = !!row;
        for (const [appKey, colName] of Object.entries(sheet.columns)) {
          out[appKey] = (row && row[colName] != null && row[colName] !== '')
            ? row[colName] : '—';
        }
      }
      return out;
    });

    console.log(`✅ Loaded: ${recruit.length} Recruit records across ${sheets.length} sheet(s)`);
    return merged;
  }

  // ═══════════════════════════════════════════════════════════
  //  PUSH — write updates back to Recruit and/or a Sheet
  // ═══════════════════════════════════════════════════════════

  // recruitFields: { Zoho_Api_Name: value, ... } (already mapped)
  async function updateRecruit(record, recruitFields) {
    return recruitPut(`${CONFIG.RECRUIT_MODULE}/${record.id}`, { data: [recruitFields] });
  }

  // Write to a specific sheet (by key). sheetData: { "Header": value }.
  // Updates the row matched on this record's key, or appends one.
  async function updateSheet(record, sheetKey, sheetData) {
    const sheet = (CONFIG.SHEETS || []).find(s => s.key === sheetKey);
    if (!sheet) throw new Error(`UNKNOWN_SHEET_${sheetKey}`);
    const keyValue = record[sheet.matchOn];
    if (record._sheetRows && record._sheetRows[sheetKey]) {
      return sheetCall(sheet, 'worksheet.records.update', {
        criteria: `"${sheet.keyColumn}" == "${keyValue}"`,
        data: JSON.stringify(sheetData),
      });
    }
    return sheetCall(sheet, 'worksheet.records.add', {
      data: JSON.stringify([{ [sheet.keyColumn]: keyValue, ...sheetData }]),
    });
  }

  // ── Derived helpers ────────────────────────────────────────
  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key] || 'Unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  }

  // Raw rows of one configured sheet (by CONFIG.SHEETS[].key).
  async function getSheetRows(key) {
    const sheet = (CONFIG.SHEETS || []).find(s => s.key === key);
    if (!sheet) throw new Error(`UNKNOWN_SHEET_${key}`);
    return getSheetRecords(sheet);
  }

  return {
    getAllRecords,
    getSheetRows,
    updateRecruit,
    updateSheet,
    groupBy,
  };
})();
