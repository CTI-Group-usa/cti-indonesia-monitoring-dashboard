// ─────────────────────────────────────────────────────────────
//  CONFIGURATION — CTI Indonesia Monitoring Dashboard
//  Fill in the ⚠️ TODO values before deploying.
// ─────────────────────────────────────────────────────────────
const CONFIG = {

  // ── Cloudflare Worker proxy (dedicated to this project) ──────
  //   This worker holds the Zoho refresh token as a secret and
  //   proxies both Zoho Recruit and Zoho Sheet. See worker.js.
  //   ⚠️ TODO: after deploying the worker, paste its URL here.
  PROXY: 'https://cti-indo-proxy.putu-astra.workers.dev',

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
    seafarerId:       'Candidate_ID',          // Auto Number ("Seafarer ID")
    crewIdNumber:     'Crew_ID_Number',        // "Seafarer ID Number" — joins Cruise sheet
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
    rescheduledDate:  'Rescheduled_Date',
    delayReason:      'Reasons_for_Delayed_Assignment_or_Resignation',
    mistralStatus:    'Mistral_Status',

    // Role / placement
    department:       'Department',
    position:         'Position_Applied',      // "Position Hired"
    currentJobTitle:  'Current_Job_Title',
    cruiseLine:       'Cruise_Line',
    joiningShip:      'Joining_Ship',
    signOnDate:       'Sign_On_Date',
    signOffDate:      'Sign_Off_Date',
    signOnPort:       'Sign_On_Port',
    hiredDate:        'Hired_Date',
    contractNumber:   'Contract_Number',
    source:           'Source',

    // People
    owner:            'Candidate_Owner',       // Lookup
    recruiter:        'Client_Interviewer',    // "Recruiter"

    // Documents / readiness
    passportStatus:   'Passport_Status',
    passportNumber:   'Passport_Number',
    passportExpiry:   'Passport_Expired_Date',
    medicalStatus:    'Medical_Status',
    medicalExpiry:    'Medical_Expiration_Date',
    bstStatus:        'BST_Status',
    bstNumber:        'BST_Certificate_Number',
    bstExpiry:        'BST_Expiration_Date',
    seamanBookStatus: 'Seaman_Book_Status',
    seamanBookNumber: 'Seaman_Book_Number',
    seamanBookExpiry: 'Seaman_Book_Expiration_Date',
    sdbStatus:        'Bermuda_Seaman_Status',   // "SDB Status"
    sdbExpiry:        'SDB_Expiration_Date',
    sdbRequestedDate: 'SDB_Requested_Date',
    bidStatus:        'BID_Status',
    bidExpiry:        'BID_Expiration_Date',
    bidRequestedDate: 'BID_Requested_Date',
    vaccinesStatus:   'Vaccines_Status',       // "Completed Vaccination"

    // Per-visa-type fields (for the VISA page sub-tabs)
    c1dVisaStatus:       'C1_D_Visa_Status',
    c1dVisaNumber:       'C1_D_Visa_Number',
    c1dVisaAppointment:  'C1_D_Visa_Appointment_Date',
    c1dVisaExpiry:       'C1_D_Visa_Expiration_Date',
    mcvStatus:           'MCV_Status',
    mcvNumber:           'MCV_Number',
    mcvExpiry:           'MCV_Expiration_Date',
    mcvPassportNumber:   'MCV_s_Passport_Number',
    oktbStatus:          'OKTB',
    // Schengen is tracked via the "Other Visa" fields (Other Visa Name = Schengen)
    otherVisaStatus:     'Other_Visa_Status',
    otherVisaName:       'Other_Visa_Name',
    otherVisaNumber:     'Other_Visa_Number',
    otherVisaAppointment:'Other_Visa_Appointment_Date',
    otherVisaExpiry:     'Other_Visa_Expiration_Date',
    otherVisaIssuedDate: 'Other_Visa_Issued_Date',

    // "Expected ready" dates the admin records when a document isn't ready yet
    // (drives the Pending Action section).
    passportExpectedDate:   'Passport_Expected_Date',
    bstExpectedDate:        'BST_Expected_Date',
    seamanBookExpectedDate: 'Seaman_Book_Expected_Date',
    medicalExpectedDate:    'Medical_Expected_Date',
    c1dExpectedDate:        'C1_D_Visa_Expected_Date',
    otherVisaExpectedDate:  'Other_Visa_Expected_Date',
    mcvExpectedDate:        'MCV_Expected_Date',
    oktbRequestedDate:      'OKTB_Requested_Date',

    // Timestamps  (NOTE: Modified Time API name is Updated_On)
    createdDate:      'Created_Time',
    modifiedDate:     'Updated_On',
  },

  // ─────────────────────────────────────────────────────────────
  //  ZOHO SHEETS  — additional data sources, merged into each
  //  seafarer record. Each sheet's rows are joined to a Recruit
  //  record by matching `keyColumn` (in the sheet) against the
  //  record field named by `matchOn` (case-insensitive).
  // ─────────────────────────────────────────────────────────────
  SHEETS: [
    {
      key:        'visa',                       // internal id (keep unique)
      label:      'Visa Registration Log',
      resourceId: 'vpzkvba5ae0adfc1247a8b7383dbef6ea3d8d',
      worksheet:  'VISA APPLICATIONS',
      headerRow:  1,

      // Join: sheet's "Email Address" == record email.
      matchOn:    'email',
      keyColumn:  'Email Address',

      // app field  ->  exact Sheet column header text.
      columns: {
        visaType:        'Please select the type of visa you want to process',
        visaStatus:      'Visa Status',
        visaPayment:     'Payment Status',
        visaAppointment: 'Appointment Date',
        visaAppId:       'Visa Application ID',
        visaRegDate:     'Added Time',
      },
      // Columns editable from the dashboard (pushed back). [] = read-only.
      editable: [],
    },
    {
      key:        'cruise',
      label:      'Cruise Line Deployment Report',
      resourceId: 'begbjf0b04d7026534b328e36baa0a9d82df7',
      worksheet:  'Deployment',
      headerRow:  1,

      // Join: sheet's "Crew ID" == record crewIdNumber (Crew_ID_Number).
      // NOTE: this sheet is deployment HISTORY — a seafarer can appear many
      // times. Last matching row wins (see zoho.js). Ask if you want "latest
      // by Sign On Date" instead.
      matchOn:    'crewIdNumber',
      keyColumn:  'Crew ID',

      columns: {
        deployCruiseLine: 'Cruise Line',
        deployShip:       'Joining Ship',
        deployStatus:     'Onboarding Status',
        deployDate:       'Sign On Date',
        deployPosition:   'Position Hired',
        deployPort:       'Sign On Port',
        deployEmployment: 'Employment Status',
      },
      editable: [],
    },
  ],

  // ─────────────────────────────────────────────────────────────
  //  J1 PROGRAM  (separate Recruit module + its own Zoho Sheet)
  //  Not merged into the Seafarer records — used only by the J1 page.
  // ─────────────────────────────────────────────────────────────
  J1_MODULE: 'J1_Participants',
  J1_FIELDS: {
    fullName:          'Full_Name',
    email:             'Email',
    programSources:    'J1_Program_Sources',
    hostingCompany:    'Hosting_Company_2',
    programStart:      'Program_Start_Date',
    visaStatus:        'J1_Visa_Status',
    applicationStatus: 'J1_Application_Status',         // Stage 1 / Stage 2 / Stage 3 / Stage 4
    appt1:             'J1_Visa_Appointment_Date',        // 1st appointment
    appt2:             'J1_Visa_2nd_Appointment_Date',
    appt3:             'J1_Visa_3rd_Appointment_Date',
  },
  // J1 Visa Log sheet (drives the J1 Visa Processing chart).
  J1_SHEET: {
    resourceId: '2lr3n52a29b81f88c47618df49092afd2b286',
    worksheet:  'J1 Visa Log',
    headerRow:  1,
  },

  // ─────────────────────────────────────────────────────────────
  //  Login: Microsoft 365 SSO (worker.js /api/auth/*) — replaced the local
  //  username/password login 2026-08-12. Access is restricted server-side
  //  to @cti-usa.com accounts; there is nothing to configure here.
  // ─────────────────────────────────────────────────────────────

  // ── Branding ─────────────────────────────────────────────────
  APP_NAME:     'Indonesia Monitoring',
  ORG_NAME:     'CTI Group Worldwide Services, Inc.',
  ACCENT_COLOR: '#B01A18',
};
