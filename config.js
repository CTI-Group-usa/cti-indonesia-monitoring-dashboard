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
  //   Recruit module API name = "Candidates" (shown as "Seafarers").
  RECRUIT_MODULE: 'Candidates',

  //   Field API names — from the "Candidates" (Seafarers) module.
  //   Left side = the name used throughout the app (keep these).
  //   Right side = the exact Zoho Recruit API field name.
  //   `email` is the merge key joined against the Zoho Sheet.
  FIELDS: {
    // Identity
    firstName:        'First_Name',
    lastName:         'Last_Name',
    email:            'Email',                 // ← merge key against the Sheet
    mobile:           'Mobile',
    gender:           'Gender',
    dateOfBirth:      'Date_of_Birth',
    age:              'Ages',                  // Formula
    seafarerId:       'Candidate_ID',          // Auto Number
    salutation:       'Salutation',
    maritalStatus:    'Marital_Status',

    // Location
    country:          'Country',
    city:             'City',
    state:            'State',                 // "Province"
    ctiOffice:        'CTI_Office',            // Pick List (e.g. Indonesia)
    origin:           'Origin',

    // Pipeline / status
    status:           'Candidate_Status',      // "Seafarer Status" — primary
    crewStatus:       'Crew_Status',
    crewMemberStatus: 'Crew_Member_Status',    // "Seafarers Status"
    employmentStatus: 'Employment_Status',
    onboardingStatus: 'Onboarding_Status',
    complianceNotes:  'Compliance_Notes',

    // Role / placement
    department:       'Department',
    position:         'Position_Applied',      // "Position Hired"
    currentJobTitle:  'Current_Job_Title',
    cruiseLine:       'Cruise_Line',
    joiningShip:      'Joining_Ship',
    signOnDate:       'Sign_On_Date',
    signOffDate:      'Sign_Off_Date',
    hiredDate:        'Hired_Date',
    contractNumber:   'Contract_Number',
    source:           'Source',

    // People
    owner:            'Candidate_Owner',       // Lookup
    recruiter:        'Client_Interviewer',    // "Recruiter"

    // Documents / readiness
    passportStatus:   'Passport_Status',
    passportExpiry:   'Passport_Expired_Date',
    medicalStatus:    'Medical_Status',
    medicalExpiry:    'Medical_Expiration_Date',

    // Timestamps  (NOTE: Modified Time API name is Updated_On)
    createdDate:      'Created_Time',
    modifiedDate:     'Updated_On',
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
