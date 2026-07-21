// ─────────────────────────────────────────────────────────────
//  CONFIGURATION — CTI Indonesia Monitoring Dashboard
//  Fill in the ⚠️ TODO values before deploying.
// ─────────────────────────────────────────────────────────────
const CONFIG = {

  // ── Cloudflare Worker proxy (dedicated to this project) ──────
  //   This worker holds the Zoho refresh token as a secret and
  //   proxies both Zoho Recruit and Zoho Sheet. See worker.js.
  //   ⚠️ TODO: after deploying the worker, paste its URL here.
  PROXY: 'https://cti-indo-proxy.putuastrawijaya.workers.dev',

  // ─────────────────────────────────────────────────────────────
  //  ZOHO RECRUIT  — primary "pull" source
  // ─────────────────────────────────────────────────────────────
  //   ⚠️ TODO: the API name of your custom Recruit module.
  //   Zoho Recruit → Settings → Developer Space → Modules → API Name
  RECRUIT_MODULE: 'CustomModuleX',

  //   ⚠️ TODO: field API names for the custom module.
  //   Zoho Recruit → Settings → Developer Space → API Names.
  //   Left side = the name used throughout the app (keep these).
  //   Right side = the exact Zoho API field name (edit these).
  //   `mergeKey` MUST also exist as a column in the Zoho Sheet so
  //   the two sources can be joined (see SHEET.mergeKey below).
  FIELDS: {
    name:        'Full_Name',
    firstName:   'First_Name',
    lastName:    'Last_Name',
    email:       'Email',            // ← used as the default merge key
    phone:       'Phone',
    country:     'Country',
    city:        'City',
    status:      'Status',           // pipeline / application status
    position:    'Position',
    department:  'Department',
    owner:       'Owner',            // recruiter / handler
    createdDate: 'Created_Time',
    modifiedDate:'Modified_Time',
  },

  // ─────────────────────────────────────────────────────────────
  //  ZOHO SHEET  — supplementary monitoring data (merged in)
  // ─────────────────────────────────────────────────────────────
  //   ⚠️ TODO: fill in your Zoho Sheet details.
  SHEET: {
    // The workbook resource id — from the sheet URL:
    //   https://sheet.zoho.com/sheet/open/<RESOURCE_ID>/...
    resourceId: 'PASTE_ZOHO_SHEET_RESOURCE_ID',

    // The worksheet (tab) name to read/write.
    worksheet: 'Sheet1',

    // Which row holds the column headers (usually 1).
    headerRow: 1,

    // The Sheet column whose value matches FIELDS.email on a Recruit
    // record. Records are joined on this key (case-insensitive).
    mergeKey: 'Email',

    // Sheet columns surfaced in the dashboard. Left = app name,
    // right = exact Sheet column header text.
    columns: {
      monitorStatus: 'Monitoring Status',
      lastContact:   'Last Contact',
      notes:         'Notes',
      handledBy:     'Handled By',
      followUpDate:  'Follow Up Date',
    },
  },

  // ─────────────────────────────────────────────────────────────
  //  Local dashboard users (SHA-256 hashed passwords)
  // ─────────────────────────────────────────────────────────────
  //   Generate a hash in the browser console:
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
  //     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
  USERS: {
    // Default password below is "changeme" — ⚠️ TODO: replace the hashes.
    admin: { hash: '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', role: 'admin' },
    staff: { hash: '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', role: 'staff' },
  },

  // ── Branding ─────────────────────────────────────────────────
  APP_NAME:     'Indonesia Monitoring',
  ORG_NAME:     'CTI Group Worldwide Services, Inc.',
  ACCENT_COLOR: '#B01A18',
};
