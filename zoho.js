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
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`RECRUIT_API_ERROR_${resp.status}`);
    return resp.json();
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
  async function getRecruitRecords() {
    const module = CONFIG.RECRUIT_MODULE;
    const F      = CONFIG.FIELDS;
    const fields = Object.values(F).join(',');
    let all = [], page = 1, more = true;

    while (more) {
      const data = await recruitGet(module, { fields, page, per_page: 200 });
      all  = all.concat(data.data || []);
      more = data.info?.more_records === true;
      page++;
    }

    const val = v => (v == null || v === '') ? '—'
      : (typeof v === 'object' ? (v.name ?? v.value ?? '—') : v);

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
      // Role / placement
      department:       val(r[F.department]),
      position:         val(r[F.position]),
      currentJobTitle:  val(r[F.currentJobTitle]),
      cruiseLine:       val(r[F.cruiseLine]),
      joiningShip:      val(r[F.joiningShip]),
      signOnDate:       r[F.signOnDate]   || null,
      signOffDate:      r[F.signOffDate]  || null,
      hiredDate:        r[F.hiredDate]    || null,
      contractNumber:   val(r[F.contractNumber]),
      source:           val(r[F.source]),
      // People
      owner:            val(r[F.owner]),
      recruiter:        val(r[F.recruiter]),
      // Documents
      passportStatus:   val(r[F.passportStatus]),
      passportExpiry:   r[F.passportExpiry] || null,
      medicalStatus:    val(r[F.medicalStatus]),
      medicalExpiry:    r[F.medicalExpiry]  || null,
      // Timestamps
      createdDate:      r[F.createdDate]  || null,
      modifiedDate:     r[F.modifiedDate] || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  ZOHO SHEET  (form-encoded POST API v2)
  //  Docs: https://www.zoho.com/sheet/help/api/v2-data-api.html
  // ═══════════════════════════════════════════════════════════

  async function sheetCall(method, extra = {}) {
    const S = CONFIG.SHEET;
    const body = new URLSearchParams({
      method,
      worksheet_name: S.worksheet,
      header_row: String(S.headerRow),
      ...extra,
    });
    const resp = await fetch(`${PROXY}/sheet/v2/${S.resourceId}`, {
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

  // Read all rows as objects keyed by column header.
  async function getSheetRecords() {
    const json = await sheetCall('worksheet.records.fetch');
    return json.records || [];
  }

  // Update the row whose mergeKey column === keyValue.
  async function updateSheetRow(keyValue, sheetData) {
    const S = CONFIG.SHEET;
    return sheetCall('worksheet.records.update', {
      criteria: `"${S.mergeKey}" == "${keyValue}"`,
      data: JSON.stringify(sheetData),
    });
  }

  // Append a brand-new row.
  async function addSheetRow(sheetData) {
    return sheetCall('worksheet.records.add', {
      data: JSON.stringify([sheetData]),
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  MERGE — Recruit records + Sheet supplementary data
  // ═══════════════════════════════════════════════════════════

  async function getAllRecords() {
    const [recruitRes, sheetRes] = await Promise.allSettled([
      getRecruitRecords(),
      getSheetRecords(),
    ]);

    const recruit = recruitRes.status === 'fulfilled' ? recruitRes.value : [];
    const sheet   = sheetRes.status   === 'fulfilled' ? sheetRes.value   : [];

    if (recruitRes.status === 'rejected')
      console.error('❌ Recruit fetch failed:', recruitRes.reason?.message);
    if (sheetRes.status === 'rejected')
      console.error('❌ Sheet fetch failed:', sheetRes.reason?.message);

    // Index Sheet rows by the merge-key column (case-insensitive).
    const S = CONFIG.SHEET;
    const sheetByKey = {};
    for (const row of sheet) {
      const k = String(row[S.mergeKey] ?? '').trim().toLowerCase();
      if (k) sheetByKey[k] = row;
    }

    const blankSheet = () =>
      Object.fromEntries(Object.keys(S.columns).map(k => [k, '—']));

    const merged = recruit.map(rec => {
      const key = String(rec.email ?? '').trim().toLowerCase();
      const row = sheetByKey[key];
      const extra = {};
      for (const [appKey, colName] of Object.entries(S.columns)) {
        extra[appKey] = (row && row[colName] != null && row[colName] !== '')
          ? row[colName] : '—';
      }
      return { ...rec, ...(row ? extra : blankSheet()), _hasSheetRow: !!row };
    });

    console.log(`✅ Loaded: ${recruit.length} Recruit records, ${sheet.length} Sheet rows`);
    return merged;
  }

  // ═══════════════════════════════════════════════════════════
  //  PUSH — write updates back to Recruit and/or the Sheet
  // ═══════════════════════════════════════════════════════════

  // recruitFields: { Zoho_Api_Name: value, ... } (already mapped)
  async function updateRecruit(record, recruitFields) {
    return recruitPut(`${CONFIG.RECRUIT_MODULE}/${record.id}`, { data: [recruitFields] });
  }

  // sheetData: { "Column Header": value, ... } — updates the row
  // matched on this record's merge key, appending one if absent.
  async function updateSheet(record, sheetData) {
    const S = CONFIG.SHEET;
    const keyValue = record.email;
    if (record._hasSheetRow) return updateSheetRow(keyValue, sheetData);
    return addSheetRow({ [S.mergeKey]: keyValue, ...sheetData });
  }

  // ── Derived helpers ────────────────────────────────────────
  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key] || 'Unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  }

  return {
    getAllRecords,
    updateRecruit,
    updateSheet,
    groupBy,
  };
})();
